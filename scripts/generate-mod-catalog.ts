#!/usr/bin/env node
/**
 * Mod Catalog Generator
 *
 * Ranks Forge mods by modpack co-occurrence: how often a mod appears across
 * popular Forge modpacks, weighted by each modpack's download count. A mod
 * in 10 popular modpacks ranks higher than a mod with high raw downloads but
 * rarely bundled together with others.
 *
 * Strategy:
 *   1. Fetch the top --modpack-count Forge modpacks from Modrinth (by downloads).
 *   2. For each modpack, download its .mrpack and parse modrinth.index.json to
 *      get the list of Modrinth-hosted mods it contains.
 *   3. Score each mod: sum of download counts of all modpacks that include it.
 *   4. Select the top --count mods by score.
 *   5. Fetch project metadata + mature (6+ month old) Forge versions for each.
 *   6. If co-occurrence yields fewer mods than requested, top up with the
 *      download-sorted Modrinth search results.
 *
 * Usage:
 *   npx tsx scripts/generate-mod-catalog.ts
 *   npx tsx scripts/generate-mod-catalog.ts --count 500 --modpack-count 200
 *   npx tsx scripts/generate-mod-catalog.ts --output scripts/mod-catalog.json
 *   npx tsx scripts/generate-mod-catalog.ts --concurrency 5
 *
 * Options:
 *   --count N            Mods to include in catalog (default: 1000)
 *   --modpack-count N    Modpacks to sample for co-occurrence (default: 100)
 *   --max-mrpack-mb N    Skip .mrpack files larger than N MB (default: 50)
 *   --concurrency N      Max parallel HTTP workers (default: 10)
 *   --versions-per-mod N Latest mature Forge versions per mod (default: 3)
 *   --all-eligible-versions Include every mature Forge version found
 *   --output <path>      Output file path (default: scripts/mod-catalog.json)
 */

import { inflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createLogger } from "../packages/observability/src/index.js";

// ---------------------------------------------------------------------------
// Modrinth API types
// ---------------------------------------------------------------------------

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  loaders: string[];
}

export interface ModrinthVersion {
  id: string;
  version_number: string;
  name: string;
  loaders: string[];
  game_versions: string[];
  date_published: string;
  files: Array<{ url: string; primary?: boolean; size?: number }>;
}

interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  downloads: number;
  categories: string[];
  display_categories: string[];
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[];
}

interface ModrinthProjectInfo {
  id: string;
  slug: string;
  title: string;
  loaders: string[];
}

// ---------------------------------------------------------------------------
// Catalog output types
// ---------------------------------------------------------------------------

export interface ModCatalogEntry {
  project: ModrinthProject;
  /** Primary/back-compat version. For new catalogs, this is versions[0]. */
  version: ModrinthVersion;
  /** Mature Forge versions selected for version-specific compatibility testing. */
  versions?: ModrinthVersion[];
}

export interface ModCatalogFile {
  generatedAt: string;
  count: number;
  mods: ModCatalogEntry[];
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  count: number;
  modpackCount: number;
  maxMrpackMb: number;
  concurrency: number;
  versionsPerMod: number;
  allEligibleVersions: boolean;
  output: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const defaultOutput = path.join(process.cwd(), "scripts", "mod-catalog.json");

  function numFlag(name: string, def: number): number {
    const idx = args.indexOf(name);
    if (idx >= 0 && args[idx + 1]) {
      const v = Number.parseInt(args[idx + 1], 10);
      return Number.isFinite(v) && v > 0 ? v : def;
    }
    const inline = args.find((a) => a.startsWith(`${name}=`));
    if (inline) {
      const v = Number.parseInt(inline.slice(name.length + 1), 10);
      return Number.isFinite(v) && v > 0 ? v : def;
    }
    return def;
  }

  function strFlag(name: string, def: string): string {
    const idx = args.indexOf(name);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    const inline = args.find((a) => a.startsWith(`${name}=`));
    return inline ? inline.slice(name.length + 1) : def;
  }

  return {
    count: numFlag("--count", 1000),
    modpackCount: numFlag("--modpack-count", 100),
    maxMrpackMb: numFlag("--max-mrpack-mb", 50),
    concurrency: numFlag("--concurrency", 10),
    versionsPerMod: numFlag("--versions-per-mod", 3),
    allEligibleVersions: args.includes("--all-eligible-versions"),
    output: strFlag("--output", defaultOutput)
  };
}

// ---------------------------------------------------------------------------
// Run stats — mutated in-place throughout the run
// ---------------------------------------------------------------------------

interface RunStats {
  rateLimitRetries: number;
  transientErrors: number;
  modpacksAttempted: number;
  modpacksSucceeded: number;
  modpacksSkipped: number;
  modsResolvedFromCoOccurrence: number;
  modsResolvedFromFallback: number;
  modsSkipped: number;
}

function createStats(): RunStats {
  return {
    rateLimitRetries: 0,
    transientErrors: 0,
    modpacksAttempted: 0,
    modpacksSucceeded: 0,
    modpacksSkipped: 0,
    modsResolvedFromCoOccurrence: 0,
    modsResolvedFromFallback: 0,
    modsSkipped: 0
  };
}

// ---------------------------------------------------------------------------
// Network primitives
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with automatic retry on transient failures and 429 rate-limit responses.
 *
 * On 429: respects the Retry-After header if present; otherwise uses
 * exponential backoff with full jitter to avoid thundering-herd when many
 * concurrent workers hit the limit at the same time.
 *
 * On network error: retries with exponential backoff.
 *
 * Returns the last response (including non-retried non-200 codes) so callers
 * can inspect status codes normally.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit | undefined,
  stats: RunStats,
  maxRetries = 4
): Promise<Response> {
  let lastRes: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      stats.transientErrors++;
      if (attempt === maxRetries) throw err;
      await delay(1000 * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5));
      continue;
    }

    if (res.status !== 429) return res;

    // 429 — rate limited
    stats.rateLimitRetries++;
    lastRes = res;
    if (attempt === maxRetries) return res;

    const retryAfterSec = Number.parseInt(res.headers.get("Retry-After") ?? "0", 10);
    const baseBackoff = retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(30_000, 2000 * Math.pow(2, attempt));
    // Full jitter: random between 0 and baseBackoff, avoids coordinated retry bursts
    await delay(baseBackoff * (0.5 + Math.random() * 0.5));
  }

  return lastRes!;
}

/**
 * Run `fn` over `items` with at most `concurrency` tasks active at once.
 * Results are returned in the same order as items.
 * Errors thrown by `fn` leave the corresponding slot as `undefined`.
 */
async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch {
        // slot stays undefined; callers filter
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, worker));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Minimal ZIP parser (no external deps)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  dataOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LF_SIG = 0x04034b50;

function findEocd(buf: Buffer): number {
  const maxScan = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= maxScan; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("ZIP EOCD not found");
}

function parseZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entryCount = buf.readUInt16LE(eocd + 8);
  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CD_SIG) break;
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + fileNameLen);
    const lf = localHeaderOffset;
    if (lf + 30 <= buf.length && buf.readUInt32LE(lf) === LF_SIG) {
      const lfFileNameLen = buf.readUInt16LE(lf + 26);
      const lfExtraLen = buf.readUInt16LE(lf + 28);
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        dataOffset: lf + 30 + lfFileNameLen + lfExtraLen
      });
    }
    pos += 46 + fileNameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const compressed = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression: ${entry.compressionMethod}`);
}

// ---------------------------------------------------------------------------
// modrinth.index.json types
// ---------------------------------------------------------------------------

interface ModrinthIndexFile {
  path: string;
  downloads: string[];
}

interface ModrinthIndex {
  formatVersion: number;
  files: ModrinthIndexFile[];
}

function extractModrinthProjectId(url: string): string | undefined {
  const m = url.match(/cdn\.modrinth\.com\/data\/([^/]+)\/versions\//);
  return m?.[1];
}

// ---------------------------------------------------------------------------
// Modpack processing
// ---------------------------------------------------------------------------

/**
 * Collect up to `modpackCount` search-result hits for Forge modpacks.
 * Pagination is done upfront so concurrent processing can begin immediately.
 */
async function fetchModpackSearchHits(
  modpackCount: number,
  stats: RunStats,
  logger: ReturnType<typeof createLogger>
): Promise<ModrinthSearchHit[]> {
  const PAGE_SIZE = 100;
  const hits: ModrinthSearchHit[] = [];
  let offset = 0;

  logger.info("Fetching Forge modpack search results", { modpackCount });

  while (hits.length < modpackCount) {
    const limit = Math.min(PAGE_SIZE, modpackCount - hits.length);
    const facets = encodeURIComponent(
      JSON.stringify([["categories:forge"], ["project_type:modpack"]])
    );
    const url = `https://api.modrinth.com/v2/search?facets=${facets}&limit=${limit}&offset=${offset}&index=downloads`;

    const res = await fetchWithRetry(url, undefined, stats);
    if (!res.ok) {
      logger.warn("Modpack search page failed", { status: res.status, offset });
      break;
    }

    const payload = (await res.json()) as ModrinthSearchResponse;
    if (payload.hits.length === 0) break;
    hits.push(...payload.hits);
    offset += payload.hits.length;
    if (payload.hits.length < limit) break;
  }

  logger.info("Modpack search complete", { found: hits.length });
  return hits;
}

/**
 * Download a modpack's .mrpack file and return the set of Modrinth project IDs
 * it contains.  Returns an empty set on any failure (wrong size, parse error, etc).
 */
async function fetchModpackModIds(
  modpackId: string,
  modpackTitle: string,
  maxBytes: number,
  stats: RunStats,
  logger: ReturnType<typeof createLogger>
): Promise<Set<string>> {
  // Fetch version list
  const verRes = await fetchWithRetry(
    `https://api.modrinth.com/v2/project/${modpackId}/version`,
    undefined,
    stats
  );
  if (!verRes.ok) return new Set();

  const versions = (await verRes.json()) as ModrinthVersion[];
  const latest = versions[0];
  if (!latest) return new Set();

  const primaryFile = latest.files.find((f) => f.primary) ?? latest.files[0];
  if (!primaryFile) return new Set();

  if (primaryFile.size !== undefined && primaryFile.size > maxBytes) {
    logger.warn("Skipping modpack — .mrpack too large", {
      modpack: modpackTitle,
      sizeMb: Math.round(primaryFile.size / 1024 / 1024)
    });
    return new Set();
  }

  const dlRes = await fetchWithRetry(primaryFile.url, undefined, stats);
  if (!dlRes.ok) return new Set();

  const ab = await dlRes.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    logger.warn("Skipping modpack — downloaded .mrpack exceeded size limit", {
      modpack: modpackTitle,
      sizeMb: Math.round(ab.byteLength / 1024 / 1024)
    });
    return new Set();
  }

  const buf = Buffer.from(ab);

  let entries: ZipEntry[];
  try {
    entries = parseZipEntries(buf);
  } catch {
    logger.warn("Failed to parse .mrpack ZIP", { modpack: modpackTitle });
    return new Set();
  }

  const indexEntry = entries.find((e) => e.name === "modrinth.index.json");
  if (!indexEntry) return new Set();

  let index: ModrinthIndex;
  try {
    index = JSON.parse(readZipEntry(buf, indexEntry).toString("utf8")) as ModrinthIndex;
  } catch {
    return new Set();
  }

  const projectIds = new Set<string>();
  for (const file of index.files) {
    for (const url of file.downloads) {
      const id = extractModrinthProjectId(url);
      if (id) projectIds.add(id);
    }
  }
  return projectIds;
}

// ---------------------------------------------------------------------------
// Co-occurrence scoring
// ---------------------------------------------------------------------------

async function buildCoOccurrenceScores(
  modpackCount: number,
  maxMrpackBytes: number,
  concurrency: number,
  stats: RunStats,
  logger: ReturnType<typeof createLogger>
): Promise<Map<string, number>> {
  const hits = await fetchModpackSearchHits(modpackCount, stats, logger);

  logger.info("Processing modpacks concurrently", {
    total: hits.length,
    concurrency
  });

  // scores is written from multiple concurrent workers; safe because JS is
  // single-threaded — Map mutations happen between awaits, never mid-statement.
  const scores = new Map<string, number>();
  let done = 0;

  await runConcurrently(hits, concurrency, async (hit) => {
    stats.modpacksAttempted++;
    const modIds = await fetchModpackModIds(
      hit.project_id,
      hit.title,
      maxMrpackBytes,
      stats,
      logger
    );

    done++;
    if (modIds.size === 0) {
      stats.modpacksSkipped++;
      logger.info(`[${done}/${hits.length}] Skipped (no mods extracted): ${hit.title}`);
      return;
    }

    for (const modId of modIds) {
      scores.set(modId, (scores.get(modId) ?? 0) + hit.downloads);
    }
    stats.modpacksSucceeded++;
    logger.info(`[${done}/${hits.length}] ${hit.title}`, {
      mods: modIds.size,
      downloads: hit.downloads
    });
  });

  logger.info("Co-occurrence scoring complete", {
    modpacksProcessed: stats.modpacksSucceeded,
    modpacksSkipped: stats.modpacksSkipped,
    uniqueModsFound: scores.size
  });

  return scores;
}

// ---------------------------------------------------------------------------
// Project metadata + version resolution
// ---------------------------------------------------------------------------

async function fetchProjectInfoBatch(
  projectIds: string[],
  stats: RunStats,
  logger: ReturnType<typeof createLogger>
): Promise<Map<string, ModrinthProjectInfo>> {
  const result = new Map<string, ModrinthProjectInfo>();
  const BATCH = 100;

  for (let i = 0; i < projectIds.length; i += BATCH) {
    const batch = projectIds.slice(i, i + BATCH);
    const idsParam = encodeURIComponent(JSON.stringify(batch));
    try {
      const res = await fetchWithRetry(
        `https://api.modrinth.com/v2/projects?ids=${idsParam}`,
        undefined,
        stats
      );
      if (!res.ok) {
        logger.warn("Batch project fetch failed", { status: res.status, batchStart: i });
        continue;
      }
      const projects = (await res.json()) as ModrinthProjectInfo[];
      for (const p of projects) result.set(p.id, p);
    } catch (err) {
      logger.warn("Batch project fetch error", { batchStart: i, err });
    }
  }

  return result;
}

async function resolveModEntry(
  projectId: string,
  projectInfo: ModrinthProjectInfo,
  sixMonthsAgo: Date,
  versionLimit: number | undefined,
  stats: RunStats
): Promise<ModCatalogEntry | undefined> {
  try {
    const res = await fetchWithRetry(
      `https://api.modrinth.com/v2/project/${projectId}/version`,
      undefined,
      stats
    );
    if (!res.ok) return undefined;
    const versions = (await res.json()) as ModrinthVersion[];
    const selectedVersions = versions.filter(
      (v) =>
        v.loaders.includes("forge") &&
        v.files.length > 0 &&
        new Date(v.date_published) < sixMonthsAgo
    );
    const limitedVersions = versionLimit
      ? selectedVersions.slice(0, versionLimit)
      : selectedVersions;
    const selected = limitedVersions[0];
    if (!selected) return undefined;
    const project: ModrinthProject = {
      id: projectId,
      slug: projectInfo.slug,
      title: projectInfo.title,
      loaders: projectInfo.loaders
    };
    return { project, version: selected, versions: limitedVersions };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Download-count fallback
// ---------------------------------------------------------------------------

/**
 * Collect candidate search hits for the fallback path.
 * Fetches enough pages to have a buffer of `needed * 3` non-excluded candidates.
 */
async function collectFallbackCandidates(
  needed: number,
  exclude: Set<string>,
  stats: RunStats,
  logger: ReturnType<typeof createLogger>
): Promise<ModrinthSearchHit[]> {
  const PAGE_SIZE = 100;
  const candidates: ModrinthSearchHit[] = [];
  let offset = 0;
  const target = needed * 3; // buffer so concurrent resolution can overshoot a bit

  logger.info("Collecting fallback candidates from download-count search", { needed, target });

  while (candidates.length < target) {
    const facets = encodeURIComponent(
      JSON.stringify([["categories:forge"], ["project_type:mod"]])
    );
    const url = `https://api.modrinth.com/v2/search?facets=${facets}&limit=${PAGE_SIZE}&offset=${offset}&index=downloads`;

    const res = await fetchWithRetry(url, undefined, stats);
    if (!res.ok) break;

    const payload = (await res.json()) as ModrinthSearchResponse;
    if (payload.hits.length === 0) break;

    for (const hit of payload.hits) {
      if (!exclude.has(hit.project_id)) {
        candidates.push(hit);
      }
    }

    offset += payload.hits.length;
    if (payload.hits.length < PAGE_SIZE) break;
  }

  return candidates;
}

async function fetchByDownloadCount(
  needed: number,
  exclude: Set<string>,
  sixMonthsAgo: Date,
  versionLimit: number | undefined,
  concurrency: number,
  stats: RunStats,
  logger: ReturnType<typeof createLogger>
): Promise<ModCatalogEntry[]> {
  const candidates = await collectFallbackCandidates(needed, exclude, stats, logger);

  logger.info("Resolving fallback candidates concurrently", {
    candidates: candidates.length,
    needed,
    concurrency
  });

  const results: ModCatalogEntry[] = [];
  let done = 0;

  await runConcurrently(candidates, concurrency, async (hit) => {
    // Short-circuit once we have enough — workers already running will still
    // finish their in-flight request, so results may slightly exceed `needed`.
    if (results.length >= needed) return;

    try {
      const res = await fetchWithRetry(
        `https://api.modrinth.com/v2/project/${hit.project_id}/version`,
        undefined,
        stats
      );
      if (!res.ok) return;

      const versions = (await res.json()) as ModrinthVersion[];
      const selectedVersions = versions.filter(
        (v) =>
          v.loaders.includes("forge") &&
          v.files.length > 0 &&
          new Date(v.date_published) < sixMonthsAgo
      );
      const limitedVersions = versionLimit
        ? selectedVersions.slice(0, versionLimit)
        : selectedVersions;
      const selected = limitedVersions[0];
      if (!selected) {
        stats.modsSkipped++;
        return;
      }

      exclude.add(hit.project_id);
      results.push({
        project: {
          id: hit.project_id,
          slug: hit.slug,
          title: hit.title,
          loaders: hit.categories ?? []
        },
        version: selected,
        versions: limitedVersions
      });
      stats.modsResolvedFromFallback++;
      done++;
      logger.info(`Fallback mod [${done}]: ${hit.title}`, {
        version: selected.version_number
      });
    } catch {
      stats.transientErrors++;
    }
  });

  return results.slice(0, needed);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const logger = createLogger("generate-mod-catalog");
  const {
    count,
    modpackCount,
    maxMrpackMb,
    concurrency,
    versionsPerMod,
    allEligibleVersions,
    output
  } = parseArgs();
  const outputPath = path.resolve(output);
  const maxMrpackBytes = maxMrpackMb * 1024 * 1024;
  const versionLimit = allEligibleVersions ? undefined : versionsPerMod;
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const stats = createStats();

  logger.info("Starting mod catalog generation", {
    count,
    modpackCount,
    maxMrpackMb,
    versionsPerMod: versionLimit ?? "all",
    concurrency,
    outputPath
  });

  // Step 1: build co-occurrence scores from modpack manifests
  const scores = await buildCoOccurrenceScores(
    modpackCount,
    maxMrpackBytes,
    concurrency,
    stats,
    logger
  );

  // Step 2: rank by score, take top `count` project IDs
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([id]) => id);

  logger.info("Top mods by co-occurrence score selected", { selected: ranked.length });

  // Step 3: batch-fetch project metadata for ranked IDs
  const projectInfos = await fetchProjectInfoBatch(ranked, stats, logger);
  logger.info("Project metadata fetched", { resolved: projectInfos.size, requested: ranked.length });

  // Step 4: resolve a mature Forge version for each project — concurrently
  logger.info("Resolving Forge versions concurrently", {
    mods: ranked.length,
    versionsPerMod: versionLimit ?? "all",
    concurrency
  });

  let resolvedCount = 0;
  const mods: ModCatalogEntry[] = [];
  const resolvedIds = new Set<string>();

  const resolvedEntries = await runConcurrently(
    ranked,
    concurrency,
    async (projectId) => {
      const info = projectInfos.get(projectId);
      if (!info) return undefined;
      return resolveModEntry(projectId, info, sixMonthsAgo, versionLimit, stats);
    }
  );

  for (let i = 0; i < resolvedEntries.length; i++) {
    const entry = resolvedEntries[i];
    if (!entry) {
      stats.modsSkipped++;
      continue;
    }
    resolvedCount++;
    mods.push(entry);
    resolvedIds.add(ranked[i]!);
    stats.modsResolvedFromCoOccurrence++;
    logger.info(`Resolved [${resolvedCount}]: ${entry.project.title}`, {
      version: entry.version.version_number,
      versions: entry.versions?.length ?? 1,
      score: scores.get(ranked[i]!)
    });
  }

  logger.info("Co-occurrence resolution complete", {
    resolved: mods.length,
    skipped: stats.modsSkipped,
    requested: count
  });

  // Step 5: top up with download-count sorted mods if needed
  if (mods.length < count) {
    const needed = count - mods.length;
    logger.info("Topping up catalog via download-count fallback", { needed });
    const fallback = await fetchByDownloadCount(
      needed,
      resolvedIds,
      sixMonthsAgo,
      versionLimit,
      concurrency,
      stats,
      logger
    );
    mods.push(...fallback);
  }

  if (mods.length === 0) {
    logger.error("No mods resolved — aborting");
    process.exit(1);
  }

  // Step 6: write catalog
  const catalog: ModCatalogFile = {
    generatedAt: new Date().toISOString(),
    count: mods.length,
    mods
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(catalog, null, 2), "utf8");

  // Final summary
  const summary = {
    catalogPath: outputPath,
    modsWritten: mods.length,
    fromCoOccurrence: stats.modsResolvedFromCoOccurrence,
    fromFallback: stats.modsResolvedFromFallback,
    modsSkipped: stats.modsSkipped,
    modpacksProcessed: stats.modpacksSucceeded,
    modpacksSkipped: stats.modpacksSkipped,
    rateLimitRetries: stats.rateLimitRetries,
    transientErrors: stats.transientErrors
  };

  logger.info("Catalog generation complete", summary);

  console.log("\n" + "=".repeat(72));
  console.log("MOD CATALOG GENERATION COMPLETE");
  console.log("=".repeat(72));
  console.log(JSON.stringify(summary, null, 2));
  console.log("=".repeat(72));
  console.log(`\nRun the offline pipeline with: --catalog-file ${output}\n`);

  if (stats.rateLimitRetries > 0) {
    console.warn(
      `⚠  ${stats.rateLimitRetries} rate-limit retries were needed. ` +
      `If modsWritten is below your --count target, re-run with --concurrency 5 ` +
      `or wait a few minutes before retrying.`
    );
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(2);
});
