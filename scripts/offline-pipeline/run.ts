#!/usr/bin/env node
/**
 * Offline Pipeline Runner (Pipeline 2)
 *
 * Runs the complete offline knowledge synthesis pipeline:
 * 1. Ingest catalog data (CurseForge/Modrinth metadata)
 * 2. Inspect Forge mods (JAR analysis for technical conflicts)
 *    - Only mods not previously inspected
 *    - Only mods 6+ months old (mature releases)
 * 3. Ingest evidence from multiple sources:
 *    - GitHub issues (incompatibility reports, discussions)
 *    - Community forums (Reddit, Discord, Curse Forums)
 *    - Manually curated rules
 *    - Artifact analysis (mixin overlaps, library conflicts)
 * 4. Synthesize knowledge:
 *    - Promoted compatibility claims
 *    - Pairwise verdict records
 *    - Fragment (3-mod) verdict records
 *    - Technical conflict signatures
 * 5. Build and validate knowledge snapshot
 * 6. Generate candidate pairs for ground-truth testing (Pipeline 1)
 * 7. Persist snapshot to Postgres (if configured)
 *
 * Usage:
 *   npx tsx scripts/offline-pipeline/run.ts [--catalog-file <path>] [--dry-run] [--no-persist]
 *
 * By default the pipeline runs against a real mod catalog. Pass --catalog-file to avoid
 * re-fetching from Modrinth on every run (recommended). Pass --demo to use the small seeded
 * dataset for UI / integration testing only. Offline prediction state is replaced by default
 * so Postgres remains a compact current working set; pass --keep-offline-history to retain old
 * offline prediction snapshots and catalog rows.
 *
 * Environment:
 *   POSTGRES_URL     Optional, Postgres connection for persistence
 *   LOG_LEVEL        Optional, defaults to info
 *
 * Exit codes:
 *   0 = Success
 *   1 = Validation failed
 *   2 = Missing configuration or prerequisites
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createPhase1Platform } from "../../packages/platform-core/src/index.js";
import type {
  ArtifactProfileRecord,
  ModInspectionRecord
} from "../../packages/platform-core/src/index.js";
import { EvidenceFetchCache } from "../../packages/platform-core/src/evidence-fetch-cache.js";
import { createLogger } from "../../packages/observability/src/index.js";
import type { ModCatalogFile } from "../generate-mod-catalog.js";
import { loadLocalEnvFile } from "../load_local_env.ts";

loadLocalEnvFile();

const OFFLINE_CACHE_DIR = path.resolve(process.cwd(), ".offline-cache");
const EVIDENCE_FETCH_CACHE_FILE = path.join(OFFLINE_CACHE_DIR, "evidence-fetch-cache.json");
const JAR_ANALYSIS_CHECKPOINT_FILE = path.join(OFFLINE_CACHE_DIR, "jar-analysis-checkpoint.json");
const PIPELINE_USER_ID = "usr_pipeline";

interface RunOptions {
  dryRun: boolean;
  noPersist: boolean;
  verbose: boolean;
  fresh: boolean;
  demo: boolean;
  allowEphemeral: boolean;
  popularCount: number;
  catalogFile: string | undefined;
}

interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  loaders: string[];
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  name: string;
  loaders: string[];
  game_versions: string[];
  date_published: string;
  files: Array<{ url: string }>;
}

interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  author: string;
  project_type: string;
  downloads: number;
  categories: string[];
  display_categories: string[];
  versions: string[];
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[];
}

interface JarAnalysisCheckpoint {
  schemaVersion: 1;
  updatedAt: string;
  artifactProfiles: ArtifactProfileRecord[];
  inspectionRecords: ModInspectionRecord[];
}

function createOfflineSnapshotVersionLabel(now = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return `offline-pipeline-${iso}`;
}

function parseNumericArg(args: string[], flagName: string, defaultValue: number): number {
  const exactIndex = args.indexOf(flagName);
  if (exactIndex >= 0) {
    const rawValue = args[exactIndex + 1];
    const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  }

  const inlineArg = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (!inlineArg) {
    return defaultValue;
  }

  const parsed = Number.parseInt(inlineArg.slice(flagName.length + 1), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseStringArg(args: string[], flagName: string): string | undefined {
  const exactIndex = args.indexOf(flagName);
  if (exactIndex >= 0) return args[exactIndex + 1];
  const inlineArg = args.find((arg) => arg.startsWith(`${flagName}=`));
  return inlineArg ? inlineArg.slice(flagName.length + 1) : undefined;
}

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    noPersist: args.includes("--no-persist"),
    verbose: args.includes("--verbose") || args.includes("-v"),
    fresh: !args.includes("--keep-offline-history"),
    demo: args.includes("--demo"),
    allowEphemeral: args.includes("--allow-ephemeral"),
    popularCount: parseNumericArg(args, "--popular-count", 1000),
    catalogFile: parseStringArg(args, "--catalog-file")
  };
}

function resetSeededCatalogState(platform: ReturnType<typeof createPhase1Platform>): void {
  platform.repository.canonicalProjects.clear();
  platform.repository.canonicalVersions.clear();
  platform.repository.sourceMappings.clear();
  platform.repository.dependencies.length = 0;
  platform.repository.incompatibilities.length = 0;
  platform.repository.artifactProfiles.clear();
  platform.repository.coverageScopes.clear();
  platform.repository.coverageScopesBySnapshotVersion.clear();
  platform.repository.knowledgeSnapshots.clear();
  platform.repository.knowledgeSnapshotsByVersion.clear();
  platform.repository.snapshotValidationReports.clear();
  platform.repository.snapshotPromotionEvents.clear();
  platform.repository.promotedCompatibilityClaims.clear();
  platform.repository.promotedCompatibilityClaimsBySnapshot.clear();
  platform.repository.technicalConflictSignatures.clear();
  platform.repository.technicalConflictSignaturesBySnapshot.clear();
  platform.repository.pairwiseCompatibilityRecords.clear();
  platform.repository.pairwiseCompatibilityBySnapshot.clear();
  platform.repository.fragmentCompatibilityRecords.clear();
  platform.repository.fragmentCompatibilityBySnapshot.clear();
  platform.repository.packBenchmarkResults.clear();
  platform.repository.packBenchmarkResultsBySnapshot.clear();
  platform.repository.exactPackAnalysisCache.clear();
  platform.repository.exactPackAnalysisCacheBySnapshot.clear();
  platform.repository.pendingArtifactAnalysisQueue.length = 0;
}

function ensurePipelineUser(platform: ReturnType<typeof createPhase1Platform>): void {
  if (platform.repository.users.has(PIPELINE_USER_ID)) {
    return;
  }

  platform.repository.users.set(PIPELINE_USER_ID, {
    userId: PIPELINE_USER_ID,
    email: "pipeline@system.local",
    displayName: "Offline Pipeline",
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  });
}

function ensureOfflineCacheDir(): void {
  if (!fs.existsSync(OFFLINE_CACHE_DIR)) {
    fs.mkdirSync(OFFLINE_CACHE_DIR, { recursive: true });
  }
}

function loadJarAnalysisCheckpoint(
  platform: ReturnType<typeof createPhase1Platform>,
  logger: ReturnType<typeof createLogger>
): void {
  if (!fs.existsSync(JAR_ANALYSIS_CHECKPOINT_FILE)) {
    logger.info("No JAR analysis checkpoint found");
    return;
  }

  try {
    const checkpoint = JSON.parse(
      fs.readFileSync(JAR_ANALYSIS_CHECKPOINT_FILE, "utf8")
    ) as JarAnalysisCheckpoint;
    const knownVersionIds = new Set(platform.repository.canonicalVersions.keys());
    let hydratedProfiles = 0;

    for (const profile of checkpoint.artifactProfiles ?? []) {
      if (!knownVersionIds.has(profile.versionId)) continue;
      platform.repository.artifactProfiles.set(profile.versionId, profile);
      hydratedProfiles++;
    }

    const profilesByVersion = new Set(platform.repository.artifactProfiles.keys());
    const inspectionRecords = (checkpoint.inspectionRecords ?? []).filter((record) =>
      knownVersionIds.has(record.versionId) &&
      (record.inspectionStatus !== "success" || profilesByVersion.has(record.versionId))
    );
    platform.modInspectionTracker.importRecords(inspectionRecords);

    logger.info("Loaded JAR analysis checkpoint", {
      path: JAR_ANALYSIS_CHECKPOINT_FILE,
      artifactProfiles: hydratedProfiles,
      inspectionRecords: inspectionRecords.length,
      updatedAt: checkpoint.updatedAt
    });
  } catch (error) {
    logger.warn("Could not load JAR analysis checkpoint; continuing without it", { error });
  }
}

function saveJarAnalysisCheckpoint(
  platform: ReturnType<typeof createPhase1Platform>,
  logger: ReturnType<typeof createLogger>
): void {
  try {
    ensureOfflineCacheDir();
    const knownVersionIds = new Set(platform.repository.canonicalVersions.keys());
    const checkpoint: JarAnalysisCheckpoint = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      artifactProfiles: [...platform.repository.artifactProfiles.values()].filter((profile) =>
        knownVersionIds.has(profile.versionId)
      ),
      inspectionRecords: platform.modInspectionTracker.getAllRecords().filter((record) =>
        knownVersionIds.has(record.versionId)
      )
    };
    const tmpPath = `${JAR_ANALYSIS_CHECKPOINT_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), "utf8");
    fs.renameSync(tmpPath, JAR_ANALYSIS_CHECKPOINT_FILE);
  } catch (error) {
    logger.warn("Could not persist JAR analysis checkpoint (non-fatal)", { error });
  }
}

/**
 * Fetch up to `limit` popular Forge mods from Modrinth, sorted by download count.
 *
 * Mod selection rationale:
 *   Primary: sorting by downloads acts as a proxy for "commonly used" until we have
 *            real modpack co-occurrence data. Mods with high download counts are the
 *            most likely to appear together in modpacks and the most valuable to analyze.
 *   Secondary: maturity filter — only versions published 6+ months ago are selected,
 *              which ensures the version has enough community exposure for evidence to exist.
 *
 * Future improvement: weight selection by modpack co-occurrence (how often two mods
 * appear together in real modpacks on Modrinth/CurseForge) rather than raw download count.
 * This would require fetching popular modpacks and parsing their manifests.
 */
async function fetchPopularForgeModsFromModrinth(
  limit: number,
  logger: ReturnType<typeof createLogger>
): Promise<Array<{ project: ModrinthProject; version: ModrinthVersion }>> {
  const PAGE_SIZE = 100;
  const results: Array<{ project: ModrinthProject; version: ModrinthVersion }> = [];
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const selectedProjectIds = new Set<string>();

  logger.info("Fetching popular Forge mods from Modrinth", { limit, sortedBy: "downloads" });

  let offset = 0;
  while (results.length < limit) {
    const facets = encodeURIComponent(
      JSON.stringify([["categories:forge"], ["project_type:mod"]])
    );
    const searchUrl = `https://api.modrinth.com/v2/search?facets=${facets}&limit=${PAGE_SIZE}&offset=${offset}&index=downloads`;

    let hits: ModrinthSearchHit[];
    try {
      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) {
        logger.warn("Modrinth search page failed", { status: searchResponse.status, offset });
        break;
      }
      const payload = (await searchResponse.json()) as ModrinthSearchResponse;
      hits = payload.hits;
      if (hits.length === 0) break;
    } catch (error) {
      logger.warn("Modrinth search error, stopping pagination", { error, offset });
      break;
    }

    for (const hit of hits) {
      if (results.length >= limit) break;
      if (selectedProjectIds.has(hit.project_id)) continue;

      try {
        const versionsResponse = await fetch(
          `https://api.modrinth.com/v2/project/${hit.project_id}/version`
        );
        if (!versionsResponse.ok) continue;

        const versions = (await versionsResponse.json()) as ModrinthVersion[];
        const selectedVersion = versions.find(
          (v) =>
            v.loaders.includes("forge") &&
            v.files.length > 0 &&
            new Date(v.date_published) < sixMonthsAgo
        );

        if (!selectedVersion) continue;

        const project: ModrinthProject = {
          id: hit.project_id,
          slug: hit.slug,
          title: hit.title,
          loaders: [...(hit.categories ?? []), ...(hit.display_categories ?? [])]
        };

        selectedProjectIds.add(hit.project_id);
        results.push({ project, version: selectedVersion });
        logger.info("Selected Forge mod", {
          project: hit.title,
          version: selectedVersion.version_number,
          downloads: hit.downloads
        });
      } catch (error) {
        logger.warn("Skipping mod after fetch error", { slug: hit.slug, error });
      }
    }

    offset += PAGE_SIZE;
    if (hits.length < PAGE_SIZE) break;
  }

  logger.info("Mod catalog fetch complete", { requested: limit, fetched: results.length });
  return results;
}

async function loadModsFromCatalogFile(
  catalogFilePath: string,
  logger: ReturnType<typeof createLogger>
): Promise<Array<{ project: ModrinthProject; version: ModrinthVersion }>> {
  const resolved = path.resolve(catalogFilePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Catalog file not found: ${resolved}\n` +
      `Run "npx tsx scripts/generate-mod-catalog.ts --output ${catalogFilePath}" first.`
    );
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const catalog = JSON.parse(raw) as ModCatalogFile;
  logger.info("Loaded mod catalog from file", {
    path: resolved,
    modCount: catalog.count,
    generatedAt: catalog.generatedAt
  });
  return catalog.mods;
}

async function ingestCatalogForRun(
  platform: ReturnType<typeof createPhase1Platform>,
  options: RunOptions,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  if (options.demo) {
    logger.warn(
      "Running with seeded demo catalog (5 mods). " +
      "This is NOT a real analysis — suitable only for UI and integration testing."
    );
    return;
  }

  resetSeededCatalogState(platform);

  let mods: Array<{ project: ModrinthProject; version: ModrinthVersion }>;
  if (options.catalogFile) {
    mods = await loadModsFromCatalogFile(options.catalogFile, logger);
  } else {
    logger.info(
      "No --catalog-file provided; fetching live from Modrinth. " +
      "Run scripts/generate-mod-catalog.ts once and pass --catalog-file to avoid re-fetching on every run."
    );
    mods = await fetchPopularForgeModsFromModrinth(options.popularCount, logger);
  }

  if (mods.length === 0) {
    throw new Error("No eligible Forge mods in catalog.");
  }

  for (const { project, version, versions } of mods) {
    const canonicalProjectId = `modrinth_${project.id}`;
    const selectedVersions = versions?.length ? versions : [version];

    platform.catalogIngestion.ingestProject({
      projectId: canonicalProjectId,
      slug: project.slug,
      displayName: project.title,
      aliases: [project.slug]
    });
    platform.catalogIngestion.ingestSourceMapping({
      externalKey: `modrinth:${project.id}`,
      sourceName: "modrinth",
      sourceProjectId: project.id,
      canonicalProjectId
    });
    for (const selectedVersion of selectedVersions) {
      const canonicalVersionId = `modrinth_${selectedVersion.id}`;
      platform.catalogIngestion.ingestVersion({
        versionId: canonicalVersionId,
        projectId: canonicalProjectId,
        versionLabel: selectedVersion.version_number,
        loaders: selectedVersion.loaders,
        minecraftVersions: selectedVersion.game_versions,
        javaVersions: [],
        primaryFileDownloadUrl:
          selectedVersion.files.find((file) => file.primary)?.url ??
          selectedVersion.files[0]?.url,
        releaseDate: selectedVersion.date_published
      });
      platform.catalogIngestion.ingestSourceMapping({
        externalKey: `modrinth:${project.id}:version:${selectedVersion.id}`,
        sourceName: "modrinth",
        sourceProjectId: project.id,
        canonicalProjectId,
        canonicalVersionId
      });
    }
  }
}

async function runOfflinePipeline(options: RunOptions): Promise<void> {
  const logger = createLogger("offline-pipeline");

  logger.info("Starting offline pipeline run", {
    dryRun: options.dryRun,
    persist: !options.noPersist,
    postgresUrl: process.env.POSTGRES_URL ? "configured" : "not configured",
    fresh: options.fresh,
    demo: options.demo,
    allowEphemeral: options.allowEphemeral,
    popularCount: options.popularCount
  });

  // Initialize platform
  const platform = createPhase1Platform();
  ensurePipelineUser(platform);
  logger.info("Platform initialized");

  if (!platform.persistence.isEnabled() && !options.noPersist && !options.dryRun && !options.allowEphemeral) {
    throw new Error(
      "POSTGRES_URL is required for the default offline pipeline workflow. " +
      "Configure a shared/remote Postgres connection in .env or pass --allow-ephemeral " +
      "if you intentionally want a non-persistent in-memory run."
    );
  }

  if (platform.persistence.isEnabled()) {
    await platform.persistence.ensureSchema();
    const hydratedGroundTruth = await platform.groundTruth.hydrateState();
    logger.info("Hydrated persisted empirical state", hydratedGroundTruth);
  } else if (options.allowEphemeral || options.noPersist || options.dryRun) {
    logger.warn(
      "Running without Postgres persistence; this run will not become part of the shared offline knowledge history."
    );
  }

  // =========================================================================
  // Step 1: Catalog Ingestion
  // =========================================================================
  logger.info("Step 1/7: Ingesting catalog data");

  try {
    await ingestCatalogForRun(platform, options, logger);

    const canonicalProjects = [
      ...platform.repository.canonicalProjects.values()
    ];
    const canonicalVersions = [
      ...platform.repository.canonicalVersions.values()
    ];

    logger.info("Catalog data available", {
      projectCount: canonicalProjects.length,
      versionCount: canonicalVersions.length,
      source: options.catalogFile ? "catalog-file" : options.demo ? "seeded" : "modrinth-live"
    });

    if (platform.persistence.isEnabled()) {
      const inspectionRecords = await platform.persistence.readModInspectionRecords();
      platform.modInspectionTracker.importRecords(inspectionRecords);
      const hydratedProfiles = await platform.persistence.hydrateJarArtifactProfiles(
        canonicalVersions.map((version) => version.versionId)
      );
      logger.info("Hydrated durable offline inspection state", {
        inspectionRecords: inspectionRecords.length,
        artifactProfiles: hydratedProfiles.hydrated
      });
    }

    loadJarAnalysisCheckpoint(platform, logger);
  } catch (error) {
    logger.error("Catalog ingestion failed", { error });
    throw error;
  }

  // =========================================================================
  // Step 2: Inspect Forge Mods (JAR Analysis)
  // =========================================================================
  logger.info("Step 2/7: Inspecting Forge mods for technical conflicts");

  try {
    // Get candidates: mods that haven't been inspected, are 6+ months old, have download URLs
    const candidates = platform.modInspectionTracker.getCandidatesForInspection();
    logger.info("Mod inspection candidates identified", {
      candidates: candidates.candidates.length,
      alreadyInspected: candidates.skippedAlready,
      tooNew: candidates.skippedTooNew,
      noDownload: candidates.skippedNoDownload
    });

    if (candidates.candidates.length > 0) {
      let analyzed = 0;
      let skipped = 0;
      let failed = 0;

      for (const candidate of candidates.candidates) {
        const inspectionResult = await platform.jarAnalysis.fetchAndIngestProfiles([
          candidate.versionId
        ]);
        analyzed += inspectionResult.analyzed;
        skipped += inspectionResult.skipped;
        failed += inspectionResult.failed;

        if (inspectionResult.failedVersionIds.includes(candidate.versionId)) {
          platform.modInspectionTracker.recordInspection(
            candidate.versionId,
            candidate.projectId,
            "failed"
          );
        } else {
          platform.modInspectionTracker.recordInspection(
            candidate.versionId,
            candidate.projectId,
            "success"
          );
          if (platform.persistence.isEnabled()) {
            await platform.persistence.persistJarArtifactProfile(candidate.versionId);
          }
        }
        if (platform.persistence.isEnabled()) {
          const record = platform.modInspectionTracker.getInspectionRecord(candidate.versionId);
          if (record) {
            await platform.persistence.persistModInspectionRecord(record);
          }
        }
        saveJarAnalysisCheckpoint(platform, logger);
      }

      logger.info("Mod inspection complete", { analyzed, skipped, failed });

      const summary = platform.modInspectionTracker.getSummary();
      logger.info("Mod inspection history", {
        totalInspected: summary.totalInspected,
        successful: summary.totalSuccessful,
        failed: summary.totalFailed
      });
    } else {
      logger.info("No mods to inspect (all are either new or already inspected)");
    }
  } catch (error) {
    logger.error("Mod inspection failed", { error });
    throw error;
  }

  // =========================================================================
  // Step 3: Evidence Ingestion from Multiple Sources
  // =========================================================================
  logger.info("Step 3/7: Ingesting evidence from registries, changelogs, and GitHub");

  // Load persistent fetch-state cache so repeat runs skip unchanged documents.
  let fetchCache: EvidenceFetchCache;
  try {
    if (fs.existsSync(EVIDENCE_FETCH_CACHE_FILE)) {
      const raw = fs.readFileSync(EVIDENCE_FETCH_CACHE_FILE, "utf8");
      fetchCache = EvidenceFetchCache.fromJSON(JSON.parse(raw));
      logger.info("Loaded evidence fetch cache", { entries: fetchCache.size, path: EVIDENCE_FETCH_CACHE_FILE });
    } else {
      fetchCache = new EvidenceFetchCache();
      logger.info("No existing fetch cache — starting fresh");
    }
  } catch {
    fetchCache = new EvidenceFetchCache();
    logger.warn("Could not load fetch cache; starting fresh");
  }

  try {
    // Ingest author/project evidence from registry descriptions, release notes, and GitHub.
    const sourceResults = await platform.evidenceSources.ingestFromAllSources({
      useFixtureFallback: options.demo,
      fetchCache
    });
    const jarRules = platform.jarAnalysis.generateRulesFromJarAnalysis(
      [...platform.repository.canonicalProjects.keys()]
    );
    logger.info("Evidence ingestion complete", {
      githubIssuesFound: sourceResults.githubIssuesFound,
      githubProcessed: sourceResults.githubIssuesProcessed,
      githubIssueSearchQueriesAttempted: sourceResults.githubIssueSearchQueriesAttempted,
      githubIssueSearchQueriesSkipped: sourceResults.githubIssueSearchQueriesSkipped,
      descriptionsFound: sourceResults.descriptionsFound,
      descriptionsProcessed: sourceResults.descriptionsProcessed,
      changelogsFound: sourceResults.changelogsFound,
      changelogsProcessed: sourceResults.changelogsProcessed,
      githubReleasesFound: sourceResults.githubReleasesFound,
      githubReadmesFound: sourceResults.githubReadmesFound,
      linkedDocsFound: sourceResults.linkedDocsFound,
      fetchCacheHits: sourceResults.fetchCacheHits,
      claimsExtracted: sourceResults.claimsExtracted,
      rulesGenerated: sourceResults.rulesGenerated,
      jarRulesGenerated: jarRules.length
    });

    // Persist updated fetch-state cache to disk for the next run.
    try {
      ensureOfflineCacheDir();
      fs.writeFileSync(EVIDENCE_FETCH_CACHE_FILE, JSON.stringify(fetchCache.toJSON(), null, 2), "utf8");
      logger.info("Saved evidence fetch cache", { entries: fetchCache.size, path: EVIDENCE_FETCH_CACHE_FILE });
    } catch (cacheError) {
      logger.warn("Could not persist fetch cache (non-fatal)", { error: cacheError });
    }

    if (options.demo) {
      // Demo fixtures are helpful for seeded runs, but they contaminate real-catalog runs.
      platform.evidence.syncFixtures();
    }

    const verifiedRules = platform.repository.verifiedRules;
    logger.info("All evidence ingestion complete", {
      totalVerifiedRules: verifiedRules.length,
      artifactProfiles: platform.repository.artifactProfiles.size
    });
  } catch (error) {
    logger.error("Evidence ingestion failed", { error });
    throw error;
  }

  // =========================================================================
  // Step 4: Knowledge Synthesis
  // =========================================================================
  logger.info("Step 4/7: Synthesizing knowledge from all evidence");

  try {
    const snapshotVersionLabel = createOfflineSnapshotVersionLabel();
    const { snapshot, validationReport } =
      platform.knowledgeSynthesis.buildAndPromoteSnapshot({
        createdBy: PIPELINE_USER_ID,
        versionLabel: snapshotVersionLabel
      });

    logger.info("Knowledge synthesis complete", {
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
      snapshotStatus: snapshot.status,
      validationStatus: validationReport.status
    });

    // Log synthesis details
    const claimCount =
      platform.repository.promotedCompatibilityClaimsBySnapshot.get(snapshot.snapshotId)?.length ?? 0;
    const pairwiseCount =
      platform.repository.pairwiseCompatibilityBySnapshot.get(snapshot.snapshotId)?.length ?? 0;
    const fragmentCount =
      platform.repository.fragmentCompatibilityBySnapshot.get(snapshot.snapshotId)?.length ?? 0;
    const signatureCount =
      platform.repository.technicalConflictSignaturesBySnapshot.get(snapshot.snapshotId)?.length ?? 0;

    logger.info("Snapshot composition", {
      claimCount,
      pairwiseCount,
      fragmentCount,
      signatureCount
    });

    // Check validation
    if (validationReport.status !== "passed") {
      const failures = validationReport.checks
        .filter((c) => c.status === "failed")
        .map((c) => c.summary);
      logger.warn("Snapshot validation warnings", { failures });
    }

    // =========================================================================
    // Step 5: Generate Candidates for Pipeline 1
    // =========================================================================
    logger.info("Step 5/7: Generating test candidates for Pipeline 1");

    const candidates = platform.knowledgeSynthesis.generateCandidatesForPipeline1(
      snapshot.snapshotId
    );

    const incompatibleCount = candidates.filter(
      (c) => c.verdict === "known_incompatible"
    ).length;
    const likelyIncompatCount = candidates.filter(
      (c) => c.verdict === "likely_incompatible"
    ).length;
    const mixedCount = candidates.filter(
      (c) => c.verdict === "mixed_or_conditional"
    ).length;
    const insufficientCount = candidates.filter(
      (c) => c.verdict === "insufficient_evidence"
    ).length;

    logger.info("Candidates generated for Pipeline 1", {
      totalCandidates: candidates.length,
      knownIncompatible: incompatibleCount,
      likelyIncompatible: likelyIncompatCount,
      mixedOrConditional: mixedCount,
      insufficientEvidence: insufficientCount
    });

    if (candidates.length > 0) {
      const topCandidates = candidates.slice(0, 3);
      logger.info("Top 3 priority candidates:", {
        candidates: topCandidates.map((c) => ({
          pair: c.pair.join(" + "),
          priority: c.priority.toFixed(3),
          verdict: c.verdict
        }))
      });
    }

    // =========================================================================
    // Step 6: Persist to Postgres (optional)
    // =========================================================================
    logger.info("Step 6/7: Persisting snapshot to database");

    if (options.noPersist) {
      logger.info("Persistence skipped (--no-persist flag)");
    } else if (!platform.persistence.isEnabled()) {
      logger.info("Persistence skipped (POSTGRES_URL not configured)");
    } else {
      try {
        if (options.fresh) {
          logger.info("Resetting prior offline pipeline state in Postgres...");
          const resetResult = await platform.persistence.resetOfflinePipelineState({
            deleteOfflineSnapshots: true,
            deleteCatalogProjectPrefixes: options.demo ? [] : ["modrinth_"]
          });
          logger.info("Reset complete", resetResult);
        }

        logger.info("Persisting snapshot and all related data...");

        // Persist catalog state first so referenced projects/versions exist.
        await platform.persistence.persistCatalogState();

        // Temporarily null the validation report ID to avoid circular FK constraint
        const savedValidationReportId = snapshot.validationReportId;
        snapshot.validationReportId = undefined;

        // Persist snapshot
        await platform.persistence.persistKnowledgeSnapshot(snapshot.snapshotId);

        // Restore and persist validation report
        snapshot.validationReportId = savedValidationReportId;
        if (snapshot.validationReportId) {
          await platform.persistence.persistSnapshotValidationReport(
            snapshot.snapshotId,
            snapshot.validationReportId
          );
        }

        // Persist claims
        for (const claimId of [...(platform.repository.promotedCompatibilityClaimsBySnapshot.get(snapshot.snapshotId) ?? [])]) {
          await platform.persistence.persistPromotedCompatibilityClaim(claimId);
        }

        // Persist pairwise records
        for (const recordId of [...(platform.repository.pairwiseCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [])]) {
          await platform.persistence.persistPairwiseCompatibilityRecord(recordId);
        }

        // Persist fragment records
        for (const recordId of [...(platform.repository.fragmentCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [])]) {
          await platform.persistence.persistFragmentCompatibilityRecord(recordId);
        }

        // Persist signatures
        for (const signatureId of [...(platform.repository.technicalConflictSignaturesBySnapshot.get(snapshot.snapshotId) ?? [])]) {
          await platform.persistence.persistTechnicalConflictSignature(signatureId);
        }

        logger.info("Persistence complete", {
          snapshotId: snapshot.snapshotId,
          persisted: true
        });
      } catch (error) {
        logger.error("Persistence failed", { error });
        throw error;
      }
    }

    // =========================================================================
    // Step 7: Summary and Output
    // =========================================================================
    logger.info("Step 7/7: Pipeline complete");

    const summary = {
      status: "success",
      snapshot: {
        id: snapshot.snapshotId,
        version: snapshot.version,
        status: snapshot.status,
        composition: {
          claims: claimCount,
          pairwise: pairwiseCount,
          fragments: fragmentCount,
          signatures: signatureCount
        },
        validation: {
          status: validationReport.status,
          checks: validationReport.checks.length
        }
      },
      candidates: {
        total: candidates.length,
        byVerdict: {
          known_incompatible: incompatibleCount,
          likely_incompatible: likelyIncompatCount,
          mixed_or_conditional: mixedCount,
          insufficient_evidence: insufficientCount
        }
      },
      persistence: {
        enabled: !options.noPersist && platform.persistence.isEnabled(),
        persisted: !options.noPersist && platform.persistence.isEnabled()
      },
      pipeline: {
        duration: "see logs",
        completedAt: new Date().toISOString()
      }
    };

    logger.info("Offline pipeline summary", summary);
    console.log("\n" + "=".repeat(80));
    console.log("OFFLINE PIPELINE EXECUTION SUMMARY");
    console.log("=".repeat(80));
    console.log(JSON.stringify(summary, null, 2));
    console.log("=".repeat(80) + "\n");

    // Exit cleanly
    process.exit(0);
  } catch (error) {
    logger.error("Pipeline failed", { error });
    process.exit(1);
  }
}

// Run pipeline
const options = parseArgs();
runOfflinePipeline(options).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(2);
});
