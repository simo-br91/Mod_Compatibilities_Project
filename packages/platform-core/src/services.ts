import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { createPlatformId } from "@modcompat/id-generation";
import type {
  AnalysisCounts,
  AnalysisEnvironment,
  ArtifactAnalysisResult,
  ApiKeyRecord,
  ConfidenceInput,
  EvidenceRef,
  ExplanationPath,
  FindingFeatureVector,
  FindingSubject,
  FindingProvenance,
  GraphEdge,
  GraphNeighborhood,
  GraphNode,
  GraphSnapshot,
  GitHubInstallationLink,
  ImportSourceType,
  GroundedCitation,
  GroundedSummarySection,
  ModelRegistryEntry,
  OfflineDataset,
  Organization,
  OrganizationMembership,
  PackDiff,
  PackReviewSummary,
  PackImport,
  PackModReference,
  PackSnapshot,
  Project,
  ReleaseGateDecision,
  Recommendation,
  RecommendationBundle,
  RecommendationFeedback,
  RecommendationOutcome,
  RecommendationStep,
  RecommendationSet,
  CalibratedFindingScore,
  ResolvedPackMod,
  SimulationRun,
  StatusCheckResult,
  WebhookDeliveryAttempt,
  WebhookRegistration,
  Workspace
} from "@modcompat/domain-models";
import type {
  AnalysisReport,
  CreateWebhookRequest,
  Finding,
  LinkGitHubInstallationRequest
} from "@modcompat/api-contracts";
import { isVersionWithinRange, now, stableHash } from "./helpers.js";
import { createDemoJwt, verifyJwt } from "./auth.js";
import { loadPlatformConfig } from "./config.js";
import { InMemoryPlatformRepository } from "./repository.js";
import type { PostgresPlatformPersistence } from "./persistence.js";
import type {
  AnalysisReportRecord,
  CreatePackDiffInput,
  CreateApiKeyInput,
  CreateMembershipInput,
  CreateOrganizationInput,
  CreateProjectInput,
  CreateWorkspaceInput,
  CreateWebhookInput,
  ExportAnalysisReportInput,
  ExportAnalysisReportResult,
  ImportResult,
  LinkGitHubInstallationInput,
  ManifestImportInput,
  ModListImportInput,
  RecommendationGenerationResult,
  RecordRecommendationOutcomeInput,
  ReleaseGateResult,
  RiskScoringResult,
  Session,
  SimulationResult,
  SubmitRecommendationFeedbackInput,
  VerifiedRuleDefinition
} from "./types.js";

function findWorkspace(
  repository: InMemoryPlatformRepository,
  workspaceId: string
): Workspace {
  const workspace = repository.workspaces.get(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return workspace;
}

function findProject(
  repository: InMemoryPlatformRepository,
  projectId: string
): Project {
  const project = repository.projects.get(projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  return project;
}

export class StaticAuthService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  createSession(token = "demo-token"): Session {
    return this.buildSessionForIdentity("usr_demo", "org_demo", token);
  }

  async createSessionFromToken(
    rawToken?: string,
    persistence?: PostgresPlatformPersistence
  ): Promise<Session> {
    const config = loadPlatformConfig();
    const token = rawToken?.trim() || createDemoJwt(config.jwtSecret);

    if (!token.includes(".")) {
      if (token === "demo-token") {
        return this.createSession(createDemoJwt(config.jwtSecret));
      }

      const matchingApiKey = [...this.repository.apiKeys.values()].find(
        (apiKey) => apiKey.secret === token
      );
      if (matchingApiKey) {
        if (persistence?.isEnabled()) {
          await persistence.hydrateSessionIdentity({
            organizationId: matchingApiKey.organizationId,
            userId: matchingApiKey.createdBy
          });
        }
        return this.buildSessionForIdentity(
          matchingApiKey.createdBy,
          matchingApiKey.organizationId,
          token
        );
      }

      throw new Error("Unsupported session token format.");
    }

    const payload = verifyJwt(token, config.jwtSecret);

    if (persistence?.isEnabled()) {
      await persistence.hydrateSessionIdentity({
        organizationId: payload.org,
        userId: payload.sub
      });
    }

    return this.buildSessionForIdentity(payload.sub, payload.org, token);
  }

  private buildSessionForIdentity(
    userId: string,
    organizationId: string,
    token: string
  ): Session {
    const user = this.repository.users.get(userId);
    const organization = this.repository.organizations.get(organizationId);

    if (!user || !organization) {
      throw new Error(
        `Session identity is missing required records for user ${userId} in organization ${organizationId}.`
      );
    }

    return {
      token,
      user,
      organization,
      memberships: [...this.repository.memberships.values()].filter(
        (membership) =>
          membership.userId === user.userId &&
          membership.organizationId === organization.organizationId
      ),
      workspaces: [...this.repository.workspaces.values()].filter(
        (workspace) => workspace.organizationId === organization.organizationId
      ),
      projects: [...this.repository.projects.values()].filter(
        (project) => project.organizationId === organization.organizationId
      ),
      apiKeys: [...this.repository.apiKeys.values()]
        .filter((apiKey) => apiKey.organizationId === organization.organizationId)
        .map(({ secret, ...apiKey }) => apiKey)
    };
  }

  issueApiKey(input: CreateApiKeyInput): ApiKeyRecord & { secret: string } {
    const apiKeyId = createPlatformId("key");
    const secret = `${apiKeyId}.${stableHash(input).slice(0, 24)}`;
    const record: ApiKeyRecord & { secret: string } = {
      apiKeyId,
      organizationId: input.organizationId,
      tenantId: input.organizationId,
      createdBy: input.createdBy,
      name: input.name,
      keyPrefix: secret.slice(0, 12),
      scopes: input.scopes,
      schemaVersion: 1,
      createdAt: now(),
      secret
    };
    this.repository.apiKeys.set(apiKeyId, record);
    return record;
  }
}

export class WorkspaceService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  createOrganization(input: CreateOrganizationInput): Organization {
    const organization: Organization = {
      organizationId: createPlatformId("org"),
      tenantId: input.slug,
      name: input.name,
      slug: input.slug,
      schemaVersion: 1,
      createdAt: now()
    };
    this.repository.organizations.set(organization.organizationId, organization);
    return organization;
  }

  createMembership(input: CreateMembershipInput): OrganizationMembership {
    const membership: OrganizationMembership = {
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      tenantId: input.organizationId,
      schemaVersion: 1,
      createdAt: now()
    };
    this.repository.memberships.set(`${input.organizationId}:${input.userId}`, membership);
    return membership;
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const workspace: Workspace = {
      workspaceId: createPlatformId("wrk"),
      organizationId: input.organizationId,
      tenantId: input.organizationId,
      name: input.name,
      slug: input.slug,
      schemaVersion: 1,
      createdAt: now()
    };
    this.repository.workspaces.set(workspace.workspaceId, workspace);
    return workspace;
  }

  createProject(input: CreateProjectInput): Project {
    const workspace = findWorkspace(this.repository, input.workspaceId);
    const project: Project = {
      projectId: createPlatformId("prj"),
      organizationId: workspace.organizationId,
      tenantId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      name: input.name,
      slug: input.slug,
      visibility: input.visibility ?? "private",
      schemaVersion: 1,
      createdAt: now()
    };
    this.repository.projects.set(project.projectId, project);
    return project;
  }
}

export class SnapshotNormalizationService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  normalizeMods(
    mods: PackModReference[],
    _environment: AnalysisEnvironment
  ): PackSnapshot["mods"] {
    return [...mods]
      .map((mod) => this.resolveMod(mod))
      .sort((left, right) => {
        const leftKey = `${left.canonicalProjectId ?? left.name}:${left.version ?? ""}`;
        const rightKey = `${right.canonicalProjectId ?? right.name}:${right.version ?? ""}`;
        return leftKey.localeCompare(rightKey);
      })
      .map((mod) => ({
        ...mod,
        version: mod.version ?? this.defaultVersionFor(mod.canonicalVersionId),
        source: mod.source ?? "user"
      }));
  }

  createSnapshot(input: {
    projectId: string;
    sourceType: ImportSourceType;
    sourceRef?: string;
    environment: AnalysisEnvironment;
    mods: PackModReference[];
    createdBy: string;
  }): PackSnapshot {
    const project = findProject(this.repository, input.projectId);
    const normalizedMods = this.normalizeMods(input.mods, input.environment);
    const normalizedHash = stableHash({
      environment: input.environment,
      mods: normalizedMods.map((mod) => ({
        projectId: mod.canonicalProjectId ?? mod.name,
        versionId: mod.canonicalVersionId ?? mod.version,
        source: mod.source
      }))
    });

    const snapshot: PackSnapshot = {
      packSnapshotId: createPlatformId("snap"),
      projectId: project.projectId,
      organizationId: project.organizationId,
      tenantId: project.organizationId,
      sourceType: input.sourceType,
      normalizedHash,
      environment: input.environment,
      mods: normalizedMods,
      sourceRef: input.sourceRef,
      createdBy: input.createdBy,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.snapshots.set(snapshot.packSnapshotId, snapshot);
    return snapshot;
  }

  private defaultVersionFor(canonicalVersionId?: string): string | undefined {
    if (!canonicalVersionId) {
      return undefined;
    }

    return this.repository.canonicalVersions.get(canonicalVersionId)?.versionLabel;
  }

  private resolveMod(mod: PackModReference): ResolvedPackMod {
    const sourceKey =
      mod.source && mod.sourceProjectId
        ? `${mod.source}:${mod.sourceProjectId}`
        : undefined;

    if (sourceKey) {
      const sourceMapping = this.repository.sourceMappings.get(sourceKey);

      if (sourceMapping) {
        return {
          ...mod,
          canonicalProjectId: sourceMapping.canonicalProjectId,
          canonicalVersionId: sourceMapping.canonicalVersionId,
          resolutionMethod: "source_mapping",
          confidence: 1
        };
      }
    }

    const bySlug = [...this.repository.canonicalProjects.values()].find(
      (project) => project.slug === mod.name.toLowerCase()
    );

    if (bySlug) {
      return {
        ...mod,
        canonicalProjectId: bySlug.projectId,
        canonicalVersionId: this.findVersionForProject(bySlug.projectId, mod.version),
        resolutionMethod: "slug_match",
        confidence: 0.92
      };
    }

    const byAlias = [...this.repository.canonicalProjects.values()].find((project) =>
      project.aliases.some((alias) => alias.toLowerCase() === mod.name.toLowerCase())
    );

    if (byAlias) {
      return {
        ...mod,
        canonicalProjectId: byAlias.projectId,
        canonicalVersionId: this.findVersionForProject(byAlias.projectId, mod.version),
        resolutionMethod: "alias_match",
        confidence: 0.85
      };
    }

    return {
      ...mod,
      resolutionMethod: "unresolved",
      confidence: 0
    };
  }

  private findVersionForProject(projectId: string, version?: string): string | undefined {
    if (version) {
      const exact = [...this.repository.canonicalVersions.values()].find(
        (candidate) =>
          candidate.projectId === projectId && candidate.versionLabel === version
      );

      if (exact) {
        return exact.versionId;
      }
    }

    return [...this.repository.canonicalVersions.values()].find(
      (candidate) => candidate.projectId === projectId
    )?.versionId;
  }
}

export class ImportService {
  constructor(
    private readonly repository: InMemoryPlatformRepository,
    private readonly normalizationService: SnapshotNormalizationService
  ) {}

  importManifest(input: ManifestImportInput): ImportResult {
    const importRecord = this.beginImport(input.projectId, "manifest", input.environment);
    const mods: PackModReference[] = (input.manifest.files ?? []).map((file) => ({
      name: String(file.slug ?? file.name ?? file.projectID ?? "unknown"),
      version: file.version,
      source: input.manifestFormat === "curseforge" ? "curseforge" : "modrinth",
      sourceProjectId: file.projectID ? String(file.projectID) : file.slug
    }));
    const snapshot = this.normalizationService.createSnapshot({
      projectId: input.projectId,
      sourceType: "manifest",
      sourceRef: input.manifestFormat,
      environment: input.environment,
      mods,
      createdBy: input.createdBy
    });
    this.completeImport(importRecord.importId, snapshot.packSnapshotId);
    return {
      importRecord: this.repository.imports.get(importRecord.importId)!,
      snapshot
    };
  }

  importModList(input: ModListImportInput): ImportResult {
    const importRecord = this.beginImport(input.projectId, "mod_list", input.environment);
    const snapshot = this.normalizationService.createSnapshot({
      projectId: input.projectId,
      sourceType: "mod_list",
      environment: input.environment,
      mods: input.mods,
      createdBy: input.createdBy
    });
    this.completeImport(importRecord.importId, snapshot.packSnapshotId);
    return {
      importRecord: this.repository.imports.get(importRecord.importId)!,
      snapshot
    };
  }

  listImports(projectId: string): PackImport[] {
    return [...this.repository.imports.values()].filter(
      (record) => record.projectId === projectId
    );
  }

  private beginImport(
    projectId: string,
    sourceType: ImportSourceType,
    environment: AnalysisEnvironment
  ): PackImport {
    const project = findProject(this.repository, projectId);
    const importRecord: PackImport = {
      importId: createPlatformId("imp"),
      projectId,
      organizationId: project.organizationId,
      tenantId: project.organizationId,
      sourceType,
      status: "processing",
      environment,
      schemaVersion: 1,
      createdAt: now()
    };
    this.repository.imports.set(importRecord.importId, importRecord);
    return importRecord;
  }

  private completeImport(importId: string, packSnapshotId: string) {
    const current = this.repository.imports.get(importId);

    if (!current) {
      throw new Error(`Import not found: ${importId}`);
    }

    this.repository.imports.set(importId, {
      ...current,
      status: "completed",
      packSnapshotId,
      completedAt: now()
    });
  }
}

export class DeterministicResolverV1 {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  evaluate(snapshot: PackSnapshot): Finding[] {
    const findings: Finding[] = [];
    const byProject = new Map<string, ResolvedPackMod[]>();

    for (const mod of snapshot.mods) {
      if (mod.canonicalProjectId) {
        const items = byProject.get(mod.canonicalProjectId) ?? [];
        items.push(mod);
        byProject.set(mod.canonicalProjectId, items);
      }
    }

    for (const mod of snapshot.mods) {
      if (!mod.canonicalProjectId) {
        findings.push(
          this.createFinding(snapshot, "unresolved_project", "low", 0.65, {
            title: `Unresolved mod reference: ${mod.name}`,
            summary:
              "The import was preserved, but no canonical identity could be resolved for this mod yet.",
            subjects: [],
            evidence: [{ type: "catalog", id: mod.name }],
            recommendedActions: [`Confirm the canonical identity for ${mod.name}.`]
          })
        );
        continue;
      }

      if (mod.canonicalVersionId) {
        const version = this.repository.canonicalVersions.get(mod.canonicalVersionId);

        if (version) {
          if (!version.loaders.includes(snapshot.environment.loader)) {
            findings.push(
              this.createFinding(snapshot, "loader_mismatch", "critical", 1, {
                title: `${mod.name} does not support ${snapshot.environment.loader}`,
                summary: `${mod.name} targets ${version.loaders.join(", ")} but this pack uses ${snapshot.environment.loader}.`,
                subjects: [{ projectId: mod.canonicalProjectId, versionId: mod.canonicalVersionId, relation: "primary" }],
                evidence: [{ type: "catalog", id: mod.canonicalVersionId }],
                recommendedActions: [`Replace ${mod.name} with a ${snapshot.environment.loader}-compatible build.`]
              })
            );
          }

          if (!version.minecraftVersions.includes(snapshot.environment.minecraftVersion)) {
            findings.push(
              this.createFinding(snapshot, "minecraft_version_mismatch", "high", 0.98, {
                title: `${mod.name} targets a different Minecraft version`,
                summary: `${mod.name} supports ${version.minecraftVersions.join(", ")} but the snapshot targets ${snapshot.environment.minecraftVersion}.`,
                subjects: [{ projectId: mod.canonicalProjectId, versionId: mod.canonicalVersionId, relation: "primary" }],
                evidence: [{ type: "catalog", id: mod.canonicalVersionId }],
                recommendedActions: [`Pin ${mod.name} to a build that supports Minecraft ${snapshot.environment.minecraftVersion}.`]
              })
            );
          }

          if (!version.javaVersions.includes(snapshot.environment.javaVersion)) {
            findings.push(
              this.createFinding(snapshot, "java_version_mismatch", "medium", 0.9, {
                title: `${mod.name} expects Java ${version.javaVersions.join(", ")}`,
                summary: `${mod.name} metadata does not include Java ${snapshot.environment.javaVersion}.`,
                subjects: [{ projectId: mod.canonicalProjectId, versionId: mod.canonicalVersionId, relation: "primary" }],
                evidence: [{ type: "catalog", id: mod.canonicalVersionId }],
                recommendedActions: [`Match the pack Java runtime to one of ${version.javaVersions.join(", ")}.`]
              })
            );
          }
        }

        for (const dependency of this.repository.dependencies.filter(
          (candidate) =>
            candidate.versionId === mod.canonicalVersionId &&
            candidate.relationType === "required"
        )) {
          if (!byProject.has(dependency.dependencyProjectId)) {
            const dependencyProject = this.repository.canonicalProjects.get(
              dependency.dependencyProjectId
            );
            findings.push(
              this.createFinding(snapshot, "missing_dependency", "high", 1, {
                title: `${mod.name} is missing a required dependency`,
                summary: `${mod.name} requires ${dependencyProject?.displayName ?? dependency.dependencyProjectId}.`,
                subjects: [
                  { projectId: mod.canonicalProjectId, versionId: mod.canonicalVersionId, relation: "primary" },
                  { projectId: dependency.dependencyProjectId, relation: "secondary" }
                ],
                evidence: [{ type: "catalog", id: mod.canonicalVersionId }],
                recommendedActions: [`Add ${dependencyProject?.displayName ?? dependency.dependencyProjectId} to the pack.`]
              })
            );
          }
        }

        for (const incompatibility of this.repository.incompatibilities.filter(
          (candidate) => candidate.versionId === mod.canonicalVersionId
        )) {
          if (byProject.has(incompatibility.incompatibleProjectId)) {
            const incompatibleProject = this.repository.canonicalProjects.get(
              incompatibility.incompatibleProjectId
            );
            findings.push(
              this.createFinding(snapshot, "declared_incompatibility", "critical", 1, {
                title: `${mod.name} conflicts with ${incompatibleProject?.displayName ?? incompatibility.incompatibleProjectId}`,
                summary: incompatibility.reason,
                subjects: [
                  { projectId: mod.canonicalProjectId, versionId: mod.canonicalVersionId, relation: "primary" },
                  { projectId: incompatibility.incompatibleProjectId, relation: "secondary" }
                ],
                evidence: [{ type: "catalog", id: mod.canonicalVersionId }],
                recommendedActions: [`Remove either ${mod.name} or ${incompatibleProject?.displayName ?? incompatibility.incompatibleProjectId}.`]
              })
            );
          }
        }
      }
    }

    for (const [projectId, mods] of byProject.entries()) {
      if (mods.length > 1) {
        findings.push(
          this.createFinding(snapshot, "duplicate_project", "medium", 0.88, {
            title: "Multiple entries resolved to the same canonical project",
            summary: `The snapshot contains ${mods.length} entries for ${this.repository.canonicalProjects.get(projectId)?.displayName ?? projectId}.`,
            subjects: mods.map((mod) => ({
              projectId,
              versionId: mod.canonicalVersionId,
              relation: "primary"
            })),
            evidence: [{ type: "catalog", id: projectId }],
            recommendedActions: ["Keep only one version of the same project in the pack."]
          })
        );
      }
    }

    return findings;
  }

  private createFinding(
    _snapshot: PackSnapshot,
    type: string,
    severity: Finding["severity"],
    confidence: number,
    input: {
      title: string;
      summary: string;
      subjects: FindingSubject[];
      evidence: Array<{ type: "rule" | "catalog"; id: string }>;
      recommendedActions: string[];
    }
  ): Finding {
    return {
      findingId: createPlatformId("fnd"),
      type,
      severity,
      confidence,
      reproducibility: "confirmed",
      title: input.title,
      summary: input.summary,
      explanation: input.summary,
      evidence: input.evidence,
      subjects: input.subjects,
      recommendedActions: input.recommendedActions
    };
  }
}

export class VerifiedRuleEngine {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  evaluate(snapshot: PackSnapshot): Finding[] {
    const presentProjects = new Set(
      snapshot.mods
        .map((mod) => mod.canonicalProjectId)
        .filter((projectId): projectId is string => Boolean(projectId))
    );

    return this.repository.verifiedRules
      .filter((rule) =>
        rule.conditions.every((condition) => {
          if (condition.type === "project_present") {
            return presentProjects.has(condition.project_id);
          }
          if (condition.type === "loader_is") {
            return snapshot.environment.loader === condition.loader;
          }
          if (condition.type === "minecraft_version_is") {
            return snapshot.environment.minecraftVersion === condition.minecraft_version;
          }

          const matchingMods = snapshot.mods.filter(
            (mod) => mod.canonicalProjectId === condition.project_id
          );
          if (matchingMods.length === 0) {
            return false;
          }

          return matchingMods.some((mod) => {
            const version =
              mod.version ??
              (mod.canonicalVersionId
                ? this.repository.canonicalVersions.get(mod.canonicalVersionId)?.versionLabel
                : undefined);

            return version
              ? isVersionWithinRange(version, condition.min_version, condition.max_version)
              : false;
          });
        })
      )
      .map((rule) => ({
        findingId: createPlatformId("fnd"),
        type: rule.finding_type,
        severity: rule.severity,
        confidence: rule.confidence,
        reproducibility: rule.reproducibility,
        title: rule.title,
        summary: rule.summary,
        explanation: rule.summary,
        evidence: [{ type: "rule", id: rule.rule_id }],
        subjects: [...new Set(
          rule.conditions
            .filter(
              (
                condition
              ): condition is Extract<
                VerifiedRuleDefinition["conditions"][number],
                { project_id: string }
              > => "project_id" in condition
            )
            .map((condition) => condition.project_id)
        )].map((projectId) => ({
          projectId,
          relation: "primary" as const
        })),
        recommendedActions: rule.recommended_actions
      }));
  }
}

export class RecommendationService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  generate(
    analysisId: string,
    snapshot: PackSnapshot,
    findings: Finding[],
    packDiff?: PackDiff
  ): RecommendationGenerationResult {
    const recommendations = findings
      .slice()
      .sort(compareFindingsForRecommendation)
      .flatMap((finding) => this.generateForFinding(snapshot, finding));

    if (recommendations.length === 0 && snapshot.mods.length > 0) {
      recommendations.push(
        this.createHealthyPackRecommendation(snapshot, findings.length > 0 ? "medium" : "low")
      );
    }

    const ranked = recommendations
      .sort(compareRecommendations)
      .map((recommendation, index) => ({
        ...recommendation,
        rank: index + 1
      }));

    const recommendationSetId = createPlatformId("rset");
    const unresolvedFindingCount = findings.filter((finding) =>
      !ranked.some((recommendation) => recommendation.findingIds?.includes(finding.findingId))
    ).length;
    const bundles = this.createBundles(
      recommendationSetId,
      ranked,
      findings,
      packDiff
    );

    const recommendationSet: RecommendationSet = {
      recommendationSetId,
      analysisId,
      generationStrategy: "deterministic-phase4-v1",
      items: ranked,
      bundles,
      summary: {
        recommendationCount: ranked.length,
        bundleCount: bundles.length,
        unresolvedFindingCount,
        minimalUnblockBundleId: bundles.find((bundle) => bundle.strategy === "minimal_unblock")
          ?.bundleId,
        stabilityFirstBundleId: bundles.find((bundle) => bundle.strategy === "stability_first")
          ?.bundleId
      },
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.recommendationSets.set(recommendationSet.recommendationSetId, recommendationSet);
    this.repository.recommendationSetsByAnalysis.set(
      recommendationSet.analysisId,
      recommendationSet.recommendationSetId
    );

    return {
      recommendationSet,
      recommendations: recommendationSet.items,
      bundles: recommendationSet.bundles
    };
  }

  getSetByAnalysis(analysisId: string): RecommendationSet {
    const recommendationSetId = this.repository.recommendationSetsByAnalysis.get(analysisId);

    if (!recommendationSetId) {
      throw new Error(`Recommendation set not found for analysis: ${analysisId}`);
    }

    const recommendationSet = this.repository.recommendationSets.get(recommendationSetId);

    if (!recommendationSet) {
      throw new Error(`Recommendation set not found: ${recommendationSetId}`);
    }

    return recommendationSet;
  }

  submitFeedback(input: SubmitRecommendationFeedbackInput): RecommendationFeedback {
    const recommendationSet = this.findRecommendationSetForRecommendation(input.recommendationId);
    const feedback: RecommendationFeedback = {
      feedbackId: createPlatformId("rfb"),
      recommendationSetId: recommendationSet.recommendationSetId,
      recommendationId: input.recommendationId,
      feedbackType: input.feedbackType,
      note: input.note,
      createdBy: input.createdBy,
      tenantId: recommendationSet.tenantId,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.recommendationFeedback.set(feedback.feedbackId, feedback);
    const ids =
      this.repository.recommendationFeedbackByRecommendation.get(input.recommendationId) ?? [];
    ids.push(feedback.feedbackId);
    this.repository.recommendationFeedbackByRecommendation.set(input.recommendationId, ids);

    this.updateRecommendationStatus(
      recommendationSet.recommendationSetId,
      input.recommendationId,
      input.feedbackType === "accepted"
        ? "accepted"
        : input.feedbackType === "dismissed"
          ? "dismissed"
          : undefined
    );

    return feedback;
  }

  recordOutcome(input: RecordRecommendationOutcomeInput): RecommendationOutcome {
    const recommendationSet = this.repository.recommendationSets.get(input.recommendationSetId);

    if (!recommendationSet) {
      throw new Error(`Recommendation set not found: ${input.recommendationSetId}`);
    }

    const outcome: RecommendationOutcome = {
      outcomeId: createPlatformId("rot"),
      recommendationSetId: recommendationSet.recommendationSetId,
      status: input.status,
      appliedRecommendationIds: input.appliedRecommendationIds,
      validationSummary: input.validationSummary,
      createdBy: input.createdBy,
      tenantId: recommendationSet.tenantId,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.recommendationOutcomes.set(outcome.outcomeId, outcome);
    const ids =
      this.repository.recommendationOutcomesBySet.get(recommendationSet.recommendationSetId) ?? [];
    ids.push(outcome.outcomeId);
    this.repository.recommendationOutcomesBySet.set(
      recommendationSet.recommendationSetId,
      ids
    );

    for (const recommendationId of outcome.appliedRecommendationIds) {
      this.updateRecommendationStatus(
        recommendationSet.recommendationSetId,
        recommendationId,
        outcome.status === "validated" ? "applied" : undefined
      );
    }

    return outcome;
  }

  listFeedback(recommendationSetId: string): RecommendationFeedback[] {
    return [...this.repository.recommendationFeedback.values()].filter(
      (feedback) => feedback.recommendationSetId === recommendationSetId
    );
  }

  getLatestOutcome(recommendationSetId: string): RecommendationOutcome | undefined {
    const outcomeIds = this.repository.recommendationOutcomesBySet.get(recommendationSetId) ?? [];
    const lastOutcomeId = outcomeIds[outcomeIds.length - 1];
    return lastOutcomeId
      ? this.repository.recommendationOutcomes.get(lastOutcomeId)
      : undefined;
  }

  private generateForFinding(
    snapshot: PackSnapshot,
    finding: Finding
  ): Recommendation[] {
    switch (finding.type) {
      case "declared_incompatibility":
      case "community_verified_incompatibility":
      case "loader_mismatch":
      case "minecraft_version_mismatch":
      case "java_version_mismatch":
        return this.buildReplacementRecommendations(snapshot, finding);
      case "missing_dependency":
        return this.buildDependencyRecommendation(finding);
      case "mixin_overlap":
      case "resource_collision":
      case "embedded_library_divergence":
      case "class_overlap":
        return [this.buildStabilityPlan(finding)];
      default:
        return [];
    }
  }

  private buildReplacementRecommendations(
    snapshot: PackSnapshot,
    finding: Finding
  ): Recommendation[] {
    const primary = finding.subjects.find((subject) => subject.relation !== "secondary")
      ?? finding.subjects[0];

    if (!primary?.projectId) {
      return [];
    }

    const project = this.repository.canonicalProjects.get(primary.projectId);
    const candidateProjects =
      project?.recommendedReplacementProjectIds?.map((projectId) => ({
        projectId,
        versionId: this.findBestVersion(projectId, snapshot.environment),
        relation: "alternative" as const
      })) ?? [];

    if (candidateProjects.length === 0) {
      return [];
    }

    return [
      {
        recommendationId: createPlatformId("rec"),
        kind: candidateProjects.length > 1 ? "bundle" : "replacement",
        rank: 0,
        confidence: clamp(
          Number((finding.confidence * 0.9 + recommendationConfidenceBoost(finding)).toFixed(4))
        ),
        summary: `Replace ${project?.displayName ?? primary.projectId} with ${candidateProjects
          .map((candidate) => this.projectLabel(candidate.projectId))
          .join(" + ")} to keep the pack aligned with ${snapshot.environment.loader} ${snapshot.environment.minecraftVersion}.`,
        rationale:
          "The replacement set is derived from the canonical project mapping and the existing evidence-backed compatibility findings.",
        status: "proposed",
        findingIds: [finding.findingId],
        evidence: finding.evidence,
        replacesSubjects: finding.subjects,
        candidateProjects,
        migrationCost:
          finding.severity === "critical" || candidateProjects.length > 1 ? "medium" : "low",
        expectedCompatibilityGain: expectedGainForSeverity(finding.severity, 0.84),
        impacts: [
          {
            impactType: "compatibility_gain",
            score: expectedGainForSeverity(finding.severity, 0.84),
            summary: "Removes a known incompatible or unsupported mod path."
          },
          {
            impactType: "migration_effort",
            score: candidateProjects.length > 1 ? 0.56 : 0.32,
            summary: "Migration effort stays bounded to replacing the affected optimization stack."
          }
        ],
        steps: [
          {
            stepId: createPlatformId("step"),
            action: "remove_mod",
            projectId: primary.projectId,
            versionId: primary.versionId,
            summary: `Remove ${project?.displayName ?? primary.projectId} from the pack snapshot.`
          },
          ...candidateProjects.map((candidate) => ({
            stepId: createPlatformId("step"),
            action: "add_mod" as const,
            projectId: candidate.projectId,
            versionId: candidate.versionId,
            summary: `Add ${this.projectLabel(candidate.projectId)}${candidate.versionId ? ` ${this.versionLabel(candidate.versionId)}` : ""}.`
          })),
          this.verifyStep("Rerun the analysis to confirm the incompatibility is gone.")
        ]
      }
    ];
  }

  private buildDependencyRecommendation(finding: Finding): Recommendation[] {
    const dependency = finding.subjects.find((subject) => subject.relation === "secondary");

    if (!dependency) {
      return [];
    }

    return [
      {
        recommendationId: createPlatformId("rec"),
        kind: "remediation_plan",
        rank: 0,
        confidence: clamp(Number((finding.confidence * 0.96).toFixed(4))),
        summary: `Add ${this.projectLabel(dependency.projectId)} before rerunning the analysis.`,
        rationale:
          "The dependency comes directly from resolved version metadata and is required for deterministic compatibility checks.",
        status: "proposed",
        findingIds: [finding.findingId],
        evidence: finding.evidence,
        candidateProjects: [dependency],
        migrationCost: "low",
        expectedCompatibilityGain: expectedGainForSeverity(finding.severity, 0.75),
        impacts: [
          {
            impactType: "compatibility_gain",
            score: expectedGainForSeverity(finding.severity, 0.75),
            summary: "Restores a required dependency edge so downstream findings can resolve cleanly."
          },
          {
            impactType: "migration_effort",
            score: 0.18,
            summary: "A single dependency add is a low-friction change."
          }
        ],
        steps: [
          {
            stepId: createPlatformId("step"),
            action: "add_mod",
            projectId: dependency.projectId,
            versionId: dependency.versionId,
            summary: `Add ${this.projectLabel(dependency.projectId)} to the pack.`
          },
          this.verifyStep("Rerun the analysis to confirm the missing dependency finding resolves.")
        ]
      }
    ];
  }

  private buildStabilityPlan(finding: Finding): Recommendation {
    const primaryProjects = finding.subjects
      .filter((subject) => subject.relation !== "secondary")
      .map((subject) => subject.projectId);
    const labels = primaryProjects.map((projectId) => this.projectLabel(projectId));

    return {
      recommendationId: createPlatformId("rec"),
      kind: "remediation_plan",
      rank: 0,
      confidence: clamp(Number((finding.confidence * 0.9).toFixed(4))),
      summary: `Stability-first remediation for ${labels.join(" + ")}: isolate the overlapping targets and retest.`,
      rationale:
        "This plan keeps the current mod lineup as intact as possible while sequencing deterministic validation after each risky overlap.",
      status: "proposed",
      findingIds: [finding.findingId],
      evidence: finding.evidence,
      replacesSubjects: finding.subjects,
      migrationCost: "medium",
      expectedCompatibilityGain: expectedGainForSeverity(finding.severity, 0.68),
      impacts: [
        {
          impactType: "stability_gain",
          score: expectedGainForSeverity(finding.severity, 0.68),
          summary: "Reduces overlap-related instability by isolating the conflicting artifacts."
        },
        {
          impactType: "migration_effort",
          score: 0.48,
          summary: "Requires targeted retesting and possibly pruning one conflicting artifact."
        }
      ],
      steps: [
        {
          stepId: createPlatformId("step"),
          action: "retest_finding",
          summary: `Verify the overlap described by ${finding.title} with only the affected projects enabled.`
        },
        {
          stepId: createPlatformId("step"),
          action: "verify_pack",
          summary: "Capture a fresh snapshot after choosing which artifact path to keep."
        }
      ]
    };
  }

  private createHealthyPackRecommendation(
    snapshot: PackSnapshot,
    migrationCost: "low" | "medium"
  ): Recommendation {
    return {
      recommendationId: createPlatformId("rec"),
      kind: "remediation_plan",
      rank: 0,
      confidence: 0.6,
      summary: `The pack is structurally healthy for deterministic checks on ${snapshot.environment.loader} ${snapshot.environment.minecraftVersion}. Capture a new snapshot after any catalog, rule, or evidence update.`,
      rationale: "No deterministic violations required an immediate replacement or remediation bundle.",
      status: "proposed",
      findingIds: [],
      migrationCost,
      expectedCompatibilityGain: 0.2,
      impacts: [
        {
          impactType: "compatibility_gain",
          score: 0.2,
          summary: "Keeps the current pack state while preserving observability for future drift."
        }
      ],
      steps: [this.verifyStep("Rerun the analysis after the next catalog, rule, or evidence refresh.")]
    };
  }

  private createBundles(
    recommendationSetId: string,
    recommendations: Recommendation[],
    findings: Finding[],
    packDiff?: PackDiff
  ): RecommendationBundle[] {
    const minimalUnblockIds = recommendations
      .filter((recommendation) => {
        const linkedFindings = findings.filter((finding) =>
          recommendation.findingIds?.includes(finding.findingId)
        );
        return linkedFindings.some((finding) =>
          finding.severity === "critical" || finding.severity === "high"
        );
      })
      .sort(compareRecommendations)
      .slice(0, Math.max(1, Math.min(3, recommendations.length)))
      .map((recommendation) => recommendation.recommendationId);

    const stabilityFirstIds = recommendations.map(
      (recommendation) => recommendation.recommendationId
    );

    const minimalBundle: RecommendationBundle = {
      bundleId: createPlatformId("rbd"),
      recommendationSetId,
      strategy: "minimal_unblock",
      recommendationIds:
        minimalUnblockIds.length > 0 ? minimalUnblockIds : stabilityFirstIds.slice(0, 1),
      summary: this.bundleSummary("minimal_unblock", recommendations, minimalUnblockIds),
      rationale: packDiff
        ? "Targets the smallest set of actions needed to remove the highest-severity deltas in the current pack diff."
        : "Targets the smallest set of actions needed to remove the highest-severity blockers first.",
      migrationCost: bundleMigrationCost(recommendations, minimalUnblockIds),
      expectedCompatibilityGain: bundleGain(recommendations, minimalUnblockIds),
      schemaVersion: 1,
      createdAt: now()
    };

    const stabilityBundle: RecommendationBundle = {
      bundleId: createPlatformId("rbd"),
      recommendationSetId,
      strategy: "stability_first",
      recommendationIds: stabilityFirstIds,
      summary: this.bundleSummary("stability_first", recommendations, stabilityFirstIds),
      rationale:
        "Sequences the full deterministic remediation path so the pack can converge toward a more stable baseline.",
      migrationCost: bundleMigrationCost(recommendations, stabilityFirstIds),
      expectedCompatibilityGain: bundleGain(recommendations, stabilityFirstIds),
      schemaVersion: 1,
      createdAt: now()
    };

    return [minimalBundle, stabilityBundle];
  }

  private bundleSummary(
    strategy: RecommendationBundle["strategy"],
    recommendations: Recommendation[],
    recommendationIds: string[]
  ): string {
    const selected = recommendations.filter((recommendation) =>
      recommendationIds.includes(recommendation.recommendationId)
    );
    const summaries = selected.slice(0, 2).map((recommendation) => recommendation.summary);

    if (strategy === "minimal_unblock") {
      return `Minimal unblock plan: ${summaries.join(" Then ")}`;
    }

    return `Stability-first plan: ${summaries.join(" Then ")}${selected.length > 2 ? " Then continue with the remaining deterministic remediation items." : ""}`;
  }

  private findRecommendationSetForRecommendation(recommendationId: string): RecommendationSet {
    const recommendationSet = [...this.repository.recommendationSets.values()].find((set) =>
      set.items.some((item) => item.recommendationId === recommendationId)
    );

    if (!recommendationSet) {
      throw new Error(`Recommendation not found: ${recommendationId}`);
    }

    return recommendationSet;
  }

  private updateRecommendationStatus(
    recommendationSetId: string,
    recommendationId: string,
    status: Recommendation["status"] | undefined
  ) {
    if (!status) {
      return;
    }

    const recommendationSet = this.repository.recommendationSets.get(recommendationSetId);

    if (!recommendationSet) {
      throw new Error(`Recommendation set not found: ${recommendationSetId}`);
    }

    const updatedItems = recommendationSet.items.map((recommendation) =>
      recommendation.recommendationId === recommendationId
        ? {
            ...recommendation,
            status
          }
        : recommendation
    );

    this.repository.recommendationSets.set(recommendationSetId, {
      ...recommendationSet,
      items: updatedItems
    });

    const analysis = this.repository.analyses.get(recommendationSet.analysisId);

    if (analysis) {
      analysis.recommendationSet = {
        ...recommendationSet,
        items: updatedItems
      };
      analysis.recommendations = updatedItems;
    }
  }

  private findBestVersion(
    projectId: string,
    environment: AnalysisEnvironment
  ): string | undefined {
    return [...this.repository.canonicalVersions.values()].find(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.loaders.includes(environment.loader) &&
        candidate.minecraftVersions.includes(environment.minecraftVersion)
    )?.versionId;
  }

  private projectLabel(projectId: string): string {
    return this.repository.canonicalProjects.get(projectId)?.displayName ?? projectId;
  }

  private versionLabel(versionId: string): string {
    return this.repository.canonicalVersions.get(versionId)?.versionLabel ?? versionId;
  }

  private verifyStep(summary: string): NonNullable<Recommendation["steps"]>[number] {
    return {
      stepId: createPlatformId("step"),
      action: "verify_pack",
      summary
    };
  }
}

export class MlService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  runRiskScoring(
    analysisId: string,
    findings: Finding[],
    recommendations: Recommendation[] = []
  ): RiskScoringResult {
    const featureVectors = findings.map((finding) =>
      this.createFeatureVector(analysisId, finding, recommendations)
    );
    const dataset: OfflineDataset = {
      datasetId: createPlatformId("ds"),
      analysisId,
      datasetKind: "finding_risk_training",
      featureVectorIds: featureVectors.map((vector) => vector.featureVectorId),
      summary: {
        rowCount: featureVectors.length,
        labeledRowCount: featureVectors.filter((vector) => Boolean(vector.label)).length,
        featureNamespaces: [...new Set(featureVectors.map((vector) => vector.featureNamespace))]
      },
      schemaVersion: 1,
      createdAt: now()
    };
    const model = this.requireModel("finding_risk_calibration");
    const calibratedScores = findings.map((finding) =>
      this.calibrateFinding(analysisId, finding, model, featureVectors)
    );
    const calibratedFindings: Finding[] = findings.map((finding) => {
      const calibrated = calibratedScores.find((score) => score.findingId === finding.findingId)!;
      const rationale = calibrated.rationale.join(" ");
      const calibrationConfidenceInput: ConfidenceInput = {
        source: "evidence",
        value: calibrated.calibratedConfidence,
        weight: 0.75,
        rationale: `Phase 5 calibrated risk score: ${rationale}`
      };

      return {
        ...finding,
        confidence: calibrated.calibratedConfidence,
        confidenceInputs: [
          ...(finding.confidenceInputs ?? []),
          calibrationConfidenceInput
        ],
        explanation: `${finding.explanation ?? finding.summary ?? ""} Calibrated risk: ${rationale}`.trim()
      };
    });
    this.repository.featureDatasets.set(dataset.datasetId, dataset);
    this.repository.featureDatasetsByAnalysis.set(analysisId, dataset.datasetId);
    this.repository.findingFeatureVectors.set(analysisId, featureVectors);
    this.repository.calibratedFindingScores.set(analysisId, calibratedScores);

    return {
      findings: calibratedFindings,
      dataset,
      featureVectors,
      calibratedScores
    };
  }

  createReviewSummary(
    analysisId: string,
    findings: Finding[],
    recommendations: Recommendation[]
  ): PackReviewSummary {
    const calibratedScores = this.repository.calibratedFindingScores.get(analysisId) ?? [];
    const reviewSummary = this.createGroundedSummary(
      analysisId,
      findings,
      recommendations,
      calibratedScores
    );
    this.repository.reviewSummaries.set(analysisId, reviewSummary);
    return reviewSummary;
  }

  getDatasetForAnalysis(analysisId: string): {
    dataset: OfflineDataset;
    featureVectors: FindingFeatureVector[];
    calibratedScores: CalibratedFindingScore[];
  } {
    const datasetId = this.repository.featureDatasetsByAnalysis.get(analysisId);
    const dataset = datasetId ? this.repository.featureDatasets.get(datasetId) : undefined;

    if (!dataset) {
      throw new Error(`Feature dataset not found for analysis: ${analysisId}`);
    }

    return {
      dataset,
      featureVectors: this.repository.findingFeatureVectors.get(analysisId) ?? [],
      calibratedScores: this.repository.calibratedFindingScores.get(analysisId) ?? []
    };
  }

  getReviewSummary(analysisId: string): PackReviewSummary {
    const reviewSummary = this.repository.reviewSummaries.get(analysisId);

    if (!reviewSummary) {
      throw new Error(`Review summary not found for analysis: ${analysisId}`);
    }

    return reviewSummary;
  }

  private createFeatureVector(
    analysisId: string,
    finding: Finding,
    recommendations: Recommendation[]
  ): FindingFeatureVector {
    const evidenceCount = finding.evidence.length;
    const evidenceDocumentCount = finding.evidence.filter((item) =>
      item.type === "evidence_document" || item.type === "evidence_snippet"
    ).length;
    const provenanceCount = finding.provenance?.length ?? 0;
    const recommendationCoverage = recommendations.filter((recommendation) =>
      recommendation.findingIds?.includes(finding.findingId)
    ).length;

    return {
      featureVectorId: createPlatformId("fv"),
      analysisId,
      findingId: finding.findingId,
      featureNamespace: "finding_risk_v1",
      featureValues: [
        numericFeature("base_confidence", finding.confidence),
        numericFeature("severity_weight", severityWeight(finding.severity)),
        numericFeature("evidence_count", evidenceCount),
        numericFeature("evidence_document_count", evidenceDocumentCount),
        numericFeature("provenance_count", provenanceCount),
        numericFeature("recommendation_coverage", recommendationCoverage),
        booleanFeature(
          "has_direct_evidence",
          finding.evidence.some((item) => item.type === "evidence_document")
        ),
        booleanFeature(
          "has_verified_rule_provenance",
          finding.provenance?.some((item) => item.kind === "verified_rule") ?? false
        ),
        categoricalFeature("severity", finding.severity)
      ],
      label:
        finding.severity === "critical" || finding.severity === "high"
          ? "confirmed_risk"
          : finding.severity === "medium"
            ? "likely_risk"
            : "low_risk",
      schemaVersion: 1,
      createdAt: now()
    };
  }

  private calibrateFinding(
    analysisId: string,
    finding: Finding,
    model: ModelRegistryEntry,
    featureVectors: FindingFeatureVector[]
  ): CalibratedFindingScore {
    const vector = featureVectors.find((item) => item.findingId === finding.findingId);

    if (!vector) {
      throw new Error(`Feature vector not found for finding: ${finding.findingId}`);
    }

    const features = new Map(
      vector.featureValues.map((feature) => [feature.featureName, feature])
    );
    const evidenceBonus = (features.get("evidence_document_count")?.numericValue ?? 0) * 0.03;
    const provenanceBonus = (features.get("provenance_count")?.numericValue ?? 0) * 0.01;
    const severityBonus = ((features.get("severity_weight")?.numericValue ?? 1) - 1) * 0.04;
    const recommendationBonus =
      (features.get("recommendation_coverage")?.numericValue ?? 0) * 0.02;
    const calibratedConfidence = clamp(
      Number(
        (
          finding.confidence +
          evidenceBonus +
          provenanceBonus +
          severityBonus +
          recommendationBonus
        ).toFixed(4)
      )
    );

    return {
      calibratedFindingScoreId: createPlatformId("cfs"),
      analysisId,
      findingId: finding.findingId,
      modelId: model.modelId,
      originalConfidence: finding.confidence,
      calibratedConfidence,
      predictedRiskScore: clamp(
        Number(((calibratedConfidence + severityWeight(finding.severity) / 5) / 2).toFixed(4))
      ),
      rationale: [
        `base=${finding.confidence.toFixed(2)}`,
        `evidence_bonus=${evidenceBonus.toFixed(2)}`,
        `provenance_bonus=${provenanceBonus.toFixed(2)}`,
        `severity_bonus=${severityBonus.toFixed(2)}`,
        `recommendation_bonus=${recommendationBonus.toFixed(2)}`
      ],
      schemaVersion: 1,
      createdAt: now()
    };
  }

  private createGroundedSummary(
    analysisId: string,
    findings: Finding[],
    recommendations: Recommendation[],
    calibratedScores: CalibratedFindingScore[]
  ): PackReviewSummary {
    const summaryModel = this.requireModel("grounded_summary");
    const topFindings = findings
      .slice()
      .sort((left, right) => severityWeight(right.severity) - severityWeight(left.severity))
      .slice(0, 3);
    const sections: GroundedSummarySection[] = topFindings.map((finding, index) => {
      const recommendation = recommendations.find((item) =>
        item.findingIds?.includes(finding.findingId)
      );
      const calibrated = calibratedScores.find((item) => item.findingId === finding.findingId);
      const evidenceCitations: GroundedCitation[] = finding.evidence
        .filter(
          (
            item
          ): item is EvidenceRef & {
            type: Extract<GroundedCitation["citationType"], "evidence_document" | "evidence_snippet">;
          } => item.type === "evidence_document" || item.type === "evidence_snippet"
        )
        .slice(0, 2)
        .map((item) => ({
          citationId: createPlatformId("cit"),
          citationType: item.type,
          targetId: item.id
        }));
      const citations: GroundedCitation[] = [
        {
          citationId: createPlatformId("cit"),
          citationType: "finding",
          targetId: finding.findingId
        },
        ...evidenceCitations,
        ...(recommendation
          ? [
              {
                citationId: createPlatformId("cit"),
                citationType: "recommendation" as const,
                targetId: recommendation.recommendationId
              }
            ]
          : [])
      ];

      return {
        sectionId: createPlatformId("sec"),
        title: index === 0 ? "Highest-risk finding" : `Risk focus ${index + 1}`,
        body: `${finding.title} remains ${finding.severity} severity with calibrated confidence ${calibrated?.calibratedConfidence ?? finding.confidence}. ${recommendation ? `Recommended action: ${recommendation.summary}` : "No recommendation bundle was generated for this item."}`.trim(),
        citations
      };
    });

    return {
      reviewSummaryId: createPlatformId("rvs"),
      analysisId,
      modelId: summaryModel.modelId,
      headline:
        topFindings.length > 0
          ? `${topFindings[0]!.title} is the primary pack risk`
          : "No high-risk findings detected",
      overview:
        topFindings.length > 0
          ? `The deterministic Phase 5 review highlights ${topFindings.length} grounded risk areas backed by findings, evidence, and recommendation outputs.`
          : "The deterministic Phase 5 review did not identify notable grounded risk areas.",
      sections,
      schemaVersion: 1,
      createdAt: now()
    };
  }

  private requireModel(task: ModelRegistryEntry["task"]): ModelRegistryEntry {
    const model = [...this.repository.modelRegistry.values()].find(
      (entry) => entry.task === task && entry.status === "active"
    );

    if (!model) {
      throw new Error(`Active model not found for task: ${task}`);
    }

    return model;
  }
}

export class SimulationService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  run(analysisId: string, snapshot: PackSnapshot, findings: Finding[]): SimulationResult {
    const recipe = [...this.repository.smokeTestRecipes.values()][0];

    if (!recipe) {
      throw new Error("Simulation recipe seed is missing.");
    }

    const observations: SimulationRun["observations"] = [
      {
        observationId: createPlatformId("obs"),
        kind: "smoke_test",
        status: "passed",
        summary: `Executed recipe ${recipe.recipeKey} with deterministic replay steps.`,
        findingTypes: []
      }
    ];

    const crashSignatures = [...this.repository.crashSignatures.values()];

    // Generate observations driven by actual findings — no hardcoded project IDs
    for (const finding of findings) {
      if (finding.severity !== "critical" && finding.severity !== "high") continue;

      if (
        finding.type === "declared_incompatibility" ||
        finding.type === "community_verified_incompatibility"
      ) {
        const sig = crashSignatures.find((s) => s.signatureKey === "render-transformer-conflict");
        observations.push({
          observationId: createPlatformId("obs"),
          kind: "startup",
          status: "failed",
          summary: `Startup smoke test reproduced conflict: ${finding.title}.`,
          findingTypes: [finding.type],
          crashSignatureId: sig?.crashSignatureId
        });
      } else if (
        finding.type === "resource_collision" ||
        finding.type === "class_overlap" ||
        finding.type === "mixin_overlap"
      ) {
        const sig = crashSignatures.find((s) => s.signatureKey === "resource-path-collision");
        observations.push({
          observationId: createPlatformId("obs"),
          kind: "crash_signature",
          status: "failed",
          summary: `Deterministic bootstrap observed ${finding.type.replace(/_/g, " ")}: ${finding.title}.`,
          findingTypes: [finding.type],
          crashSignatureId: sig?.crashSignatureId
        });
      }
    }

    const failedObservations = observations.filter((observation) => observation.status === "failed");
    const simulationRun: SimulationRun = {
      simulationRunId: createPlatformId("sim"),
      analysisId,
      packSnapshotId: snapshot.packSnapshotId,
      recipeId: recipe.recipeId,
      status: failedObservations.length > 0 ? "failed" : "completed",
      summary:
        failedObservations.length > 0
          ? `${failedObservations.length} deterministic simulation checks failed.`
          : "All deterministic simulation checks passed.",
      observations,
      schemaVersion: 1,
      createdAt: now()
    };

    const enrichedFindings: Finding[] = findings.map((finding) => {
      const relatedObservations = failedObservations.filter((observation) =>
        observation.findingTypes.includes(finding.type)
      );

      if (relatedObservations.length === 0) {
        return finding;
      }

      const simulationProvenance: FindingProvenance = {
        kind: "evidence",
        sourceId: simulationRun.simulationRunId,
        sourceType: "simulation_observation",
        note: relatedObservations.map((item) => item.summary).join(" ")
      };
      const simulationConfidenceInput: ConfidenceInput = {
        source: "evidence",
        value: clamp(Number((finding.confidence + 0.08).toFixed(4))),
        weight: 0.8,
        rationale: `Deterministic simulation reproduced ${relatedObservations.length} matching observation(s).`
      };

      return {
        ...finding,
        confidence: clamp(
          Number((finding.confidence + 0.08 * relatedObservations.length).toFixed(4))
        ),
        evidence: [
          ...finding.evidence,
          {
            type: "simulation" as const,
            id: simulationRun.simulationRunId
          }
        ],
        provenance: [
          ...(finding.provenance ?? []),
          simulationProvenance
        ],
        confidenceInputs: [
          ...(finding.confidenceInputs ?? []),
          simulationConfidenceInput
        ],
        explanation: `${finding.explanation ?? finding.summary ?? ""} Simulation result: ${relatedObservations.map((item) => item.summary).join(" ")}`.trim()
      };
    });

    this.repository.simulationRuns.set(analysisId, simulationRun);

    return {
      findings: enrichedFindings,
      simulationRun
    };
  }

  getRun(analysisId: string): SimulationRun {
    const run = this.repository.simulationRuns.get(analysisId);

    if (!run) {
      throw new Error(`Simulation run not found for analysis: ${analysisId}`);
    }

    return run;
  }
}

export class ReleaseGateService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  evaluate(
    analysisId: string,
    findings: Finding[],
    simulationRun?: SimulationRun
  ): ReleaseGateResult {
    const blockingFindings = findings.filter(
      (finding) => finding.severity === "critical" || finding.confidence >= 0.95
    );
    const highFindings = findings.filter((finding) => finding.severity === "high");
    const simulationFailed = simulationRun?.status === "failed";
    const status: ReleaseGateDecision["status"] =
      blockingFindings.length > 0 || simulationFailed
        ? "block"
        : highFindings.length > 0
          ? "warn"
          : "pass";

    const reasons = [
      ...(simulationFailed && simulationRun ? [simulationRun.summary] : []),
      ...blockingFindings.map((finding) => `${finding.severity.toUpperCase()}: ${finding.title}`),
      ...(status === "warn" && highFindings.length > 0
        ? highFindings.map((finding) => `HIGH: ${finding.title}`)
        : [])
    ];

    const releaseGateDecision: ReleaseGateDecision = {
      releaseGateDecisionId: createPlatformId("rgd"),
      analysisId,
      policyKey: "phase6-default-release-gate",
      status,
      summary:
        status === "block"
          ? "Release gate blocked due to deterministic simulation or critical findings."
          : status === "warn"
            ? "Release gate warns due to unresolved high-severity findings."
            : "Release gate passed. No blocking simulation or finding conditions were met.",
      reasons,
      blockingFindingIds: blockingFindings.map((finding) => finding.findingId),
      simulationRunId: simulationRun?.simulationRunId,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.releaseGateDecisions.set(analysisId, releaseGateDecision);
    return { releaseGateDecision };
  }

  getDecision(analysisId: string): ReleaseGateDecision {
    const decision = this.repository.releaseGateDecisions.get(analysisId);

    if (!decision) {
      throw new Error(`Release gate decision not found for analysis: ${analysisId}`);
    }

    return decision;
  }
}

export class IntegrationService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  linkGitHubInstallation(input: LinkGitHubInstallationInput): GitHubInstallationLink {
    const link: GitHubInstallationLink = {
      installationLinkId: createPlatformId("ghl"),
      installationId: input.installationId,
      projectId: input.projectId,
      repositoryFullName: input.repositoryFullName,
      status: "linked",
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.githubInstallationLinks.set(link.installationId, link);
    return link;
  }

  getLinkByProject(projectId: string): GitHubInstallationLink | undefined {
    return [...this.repository.githubInstallationLinks.values()].find(
      (link) => link.projectId === projectId
    );
  }
}

export class NotificationService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  registerWebhook(input: CreateWebhookInput): WebhookRegistration {
    const webhook: WebhookRegistration = {
      webhookId: createPlatformId("whk"),
      targetUrl: input.targetUrl,
      eventTypes: input.eventTypes,
      status: "active",
      secretHint: input.secret ? `${input.secret.slice(0, 4)}...` : undefined,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.webhookRegistrations.set(webhook.webhookId, webhook);
    return webhook;
  }

  listWebhooks(): WebhookRegistration[] {
    return [...this.repository.webhookRegistrations.values()];
  }

  fanOutAnalysisCompleted(
    analysisId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): WebhookDeliveryAttempt[] {
    const deliveries = this.listWebhooks()
      .filter((webhook) => webhook.status === "active" && webhook.eventTypes.includes(eventType))
      .map((webhook) => ({
        deliveryId: createPlatformId("dlv"),
        webhookId: webhook.webhookId,
        analysisId,
        eventType,
        status: "delivered" as const,
        payload,
        schemaVersion: 1,
        createdAt: now()
      }));

    this.repository.webhookDeliveries.set(analysisId, deliveries);
    return deliveries;
  }

  listDeliveries(analysisId: string): WebhookDeliveryAttempt[] {
    return this.repository.webhookDeliveries.get(analysisId) ?? [];
  }

  createStatusCheck(
    analysisId: string,
    releaseGateDecision: ReleaseGateDecision,
    installationId?: string
  ): StatusCheckResult {
    const statusCheck: StatusCheckResult = {
      statusCheckId: createPlatformId("chk"),
      analysisId,
      installationId,
      conclusion:
        releaseGateDecision.status === "pass"
          ? "success"
          : releaseGateDecision.status === "warn"
            ? "neutral"
            : "failure",
      summary: releaseGateDecision.summary,
      detailsUrl: `local://analyses/${analysisId}/report`,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.statusChecks.set(analysisId, statusCheck);
    return statusCheck;
  }

  getStatusCheck(analysisId: string): StatusCheckResult {
    const statusCheck = this.repository.statusChecks.get(analysisId);

    if (!statusCheck) {
      throw new Error(`Status check not found for analysis: ${analysisId}`);
    }

    return statusCheck;
  }
}

export class ReportService {
  constructor(
    private readonly repository: InMemoryPlatformRepository,
    private readonly recommendations: RecommendationService,
    private readonly ml: MlService
  ) {}

  createReport(analysisId: string): AnalysisReportRecord {
    const analysis = this.repository.analyses.get(analysisId);

    if (!analysis) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    const recommendationSet = analysis.recommendationSet
      ? this.recommendations.getSetByAnalysis(analysisId)
      : undefined;
    const feedback = recommendationSet
      ? this.recommendations.listFeedback(recommendationSet.recommendationSetId)
      : [];
    const latestOutcome = recommendationSet
      ? this.recommendations.getLatestOutcome(recommendationSet.recommendationSetId)
      : undefined;
    const reviewSummary = this.repository.reviewSummaries.get(analysisId);
    const simulationRun = this.repository.simulationRuns.get(analysisId);
    const releaseGateDecision = this.repository.releaseGateDecisions.get(analysisId);
    const statusCheck = this.repository.statusChecks.get(analysisId);

    const report: AnalysisReport = {
      reportId: `report-${analysisId}`,
      analysis: analysis.summary,
      findings: analysis.findings,
      recommendationSet,
      recommendations: recommendationSet?.items ?? analysis.recommendations,
      reviewSummary,
      simulationRun,
      releaseGateDecision,
      statusCheck,
      decisionSummary: {
        minimalUnblockSummary: recommendationSet?.bundles.find(
          (bundle) => bundle.strategy === "minimal_unblock"
        )?.summary,
        stabilityFirstSummary: recommendationSet?.bundles.find(
          (bundle) => bundle.strategy === "stability_first"
        )?.summary
      },
      feedback,
      latestOutcome
    };

    this.repository.reports.set(analysisId, report);
    analysis.report = report;

    return report;
  }

  getReport(analysisId: string): AnalysisReportRecord {
    return this.createReport(analysisId);
  }

  exportReport(input: ExportAnalysisReportInput): ExportAnalysisReportResult {
    const report = this.getReport(input.analysisId);

    if (input.format === "json") {
      return {
        format: "json",
        downloadUrl: `local://reports/${input.analysisId}.json`,
        content: JSON.stringify(report, null, 2)
      };
    }

    return {
      format: "markdown",
      downloadUrl: `local://reports/${input.analysisId}.md`,
      content: this.renderMarkdown(report)
    };
  }

  private renderMarkdown(report: AnalysisReportRecord): string {
    const findings = report.findings
      .map((finding) => `- [${finding.severity}] ${finding.title}`)
      .join("\n");
    const recommendations = report.recommendations
      .map((recommendation) => `- #${recommendation.rank} ${recommendation.summary}`)
      .join("\n");

    return [
      `# Analysis Report ${report.analysis.analysisId}`,
      "",
      `Score: ${report.analysis.score ?? "n/a"}`,
      "",
      "## Grounded Review",
      report.reviewSummary
        ? `- ${report.reviewSummary.headline}`
        : "- No grounded review summary",
      "",
      "## Simulation",
      report.simulationRun
        ? `- ${report.simulationRun.status}: ${report.simulationRun.summary}`
        : "- No simulation run",
      "",
      "## Release Gate",
      report.releaseGateDecision
        ? `- ${report.releaseGateDecision.status.toUpperCase()}: ${report.releaseGateDecision.summary}`
        : "- No release gate decision",
      "",
      "## Findings",
      findings || "- None",
      "",
      "## Recommendations",
      recommendations || "- None",
      "",
      "## Decision Summary",
      `- Minimal unblock: ${report.decisionSummary.minimalUnblockSummary ?? "n/a"}`,
      `- Stability first: ${report.decisionSummary.stabilityFirstSummary ?? "n/a"}`,
      "",
      "## Outcome",
      report.latestOutcome
        ? `- ${report.latestOutcome.status}: ${report.latestOutcome.validationSummary}`
        : "- No recorded outcome"
    ].join("\n");
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function compareFindingsForRecommendation(left: Finding, right: Finding): number {
  return severityWeight(right.severity) - severityWeight(left.severity);
}

function compareRecommendations(left: Recommendation, right: Recommendation): number {
  if ((right.expectedCompatibilityGain ?? 0) !== (left.expectedCompatibilityGain ?? 0)) {
    return (right.expectedCompatibilityGain ?? 0) - (left.expectedCompatibilityGain ?? 0);
  }

  if ((right.confidence ?? 0) !== (left.confidence ?? 0)) {
    return (right.confidence ?? 0) - (left.confidence ?? 0);
  }

  return migrationCostWeight(left.migrationCost) - migrationCostWeight(right.migrationCost);
}

function recommendationConfidenceBoost(finding: Finding): number {
  return finding.provenance?.some((item) => item.kind === "evidence") ? 0.08 : 0.04;
}

function expectedGainForSeverity(
  severity: Finding["severity"],
  baseline: number
): number {
  const multiplier =
    severity === "critical"
      ? 1
      : severity === "high"
        ? 0.94
        : severity === "medium"
          ? 0.82
          : 0.65;

  return Number((baseline * multiplier).toFixed(4));
}

function bundleMigrationCost(
  recommendations: Recommendation[],
  recommendationIds: string[]
): NonNullable<Recommendation["migrationCost"]> {
  const selected = recommendations.filter((recommendation) =>
    recommendationIds.includes(recommendation.recommendationId)
  );
  const weight = Math.max(
    ...selected.map((recommendation) => migrationCostWeight(recommendation.migrationCost)),
    1
  );

  return weight >= 3 ? "high" : weight === 2 ? "medium" : "low";
}

function bundleGain(recommendations: Recommendation[], recommendationIds: string[]): number {
  const selected = recommendations.filter((recommendation) =>
    recommendationIds.includes(recommendation.recommendationId)
  );

  if (selected.length === 0) {
    return 0;
  }

  return Number(
    (
      selected.reduce(
        (sum, recommendation) => sum + (recommendation.expectedCompatibilityGain ?? 0),
        0
      ) / selected.length
    ).toFixed(4)
  );
}

function migrationCostWeight(cost: Recommendation["migrationCost"]): number {
  switch (cost) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    default:
      return 4;
  }
}

function severityWeight(severity: Finding["severity"]): number {
  switch (severity) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    default:
      return 1;
  }
}

function numericFeature(featureName: string, value: number) {
  return {
    featureName,
    valueType: "number" as const,
    numericValue: Number(value.toFixed(4))
  };
}

function booleanFeature(featureName: string, value: boolean) {
  return {
    featureName,
    valueType: "boolean" as const,
    booleanValue: value
  };
}

function categoricalFeature(featureName: string, value: string) {
  return {
    featureName,
    valueType: "categorical" as const,
    categoricalValue: value
  };
}

function canonicalSubjectKey(subject: FindingSubject): string {
  return [subject.projectId, subject.versionId ?? "", subject.relation ?? ""].join(":");
}

function dedupeFindingKey(finding: Finding): string {
  return stableHash({
    type: finding.type,
    subjects: finding.subjects.map(canonicalSubjectKey).sort()
  });
}

function averageConfidence(inputs: ConfidenceInput[]): number {
  if (inputs.length === 0) {
    return 0;
  }

  const totalWeight = inputs.reduce((sum, input) => sum + input.weight, 0);
  const weighted = inputs.reduce((sum, input) => sum + input.value * input.weight, 0);
  return Number((weighted / totalWeight).toFixed(4));
}

export class ArtifactAnalysisService {
  readonly mode: "in-process" | "jvm-process" | "jvm-http";
  private readonly javaSourcePath?: string;
  private readonly javaBin: string;
  /** Base URL of the long-lived JVM HTTP service, e.g. http://127.0.0.1:9090 */
  private readonly jvmServiceUrl?: string;

  constructor(private readonly repository: InMemoryPlatformRepository) {
    const configuredSource = process.env.ARTIFACT_ANALYSIS_JAVA_SOURCE?.trim();
    this.javaSourcePath = configuredSource
      ? resolve(configuredSource)
      : undefined;
    this.javaBin = process.env.JAVA_BIN?.trim() || "java";
    const configuredServiceUrl = process.env.ARTIFACT_ANALYSIS_SERVICE_URL?.trim();
    this.jvmServiceUrl = configuredServiceUrl || undefined;
    if (this.jvmServiceUrl) {
      this.mode = "jvm-http";
    } else if (this.javaSourcePath) {
      this.mode = "jvm-process";
    } else {
      this.mode = "in-process";
    }
  }

  analyze(
    analysisId: string,
    snapshot: PackSnapshot
  ): { artifacts: ArtifactAnalysisResult[]; findings: Finding[] } {
    const artifacts: ArtifactAnalysisResult[] = snapshot.mods
      .filter((mod) => Boolean(mod.canonicalProjectId))
      .map((mod) => {
        const profile = mod.canonicalVersionId
          ? this.repository.artifactProfiles.get(mod.canonicalVersionId)
          : undefined;
        const project = mod.canonicalProjectId
          ? this.repository.canonicalProjects.get(mod.canonicalProjectId)
          : undefined;
        const artifactId = profile?.artifactId ?? `artifact-${mod.canonicalProjectId}`;

        return {
          artifactAnalysisId: createPlatformId("aar"),
          analysisId,
          packSnapshotId: snapshot.packSnapshotId,
          projectId: mod.canonicalProjectId!,
          versionId: mod.canonicalVersionId,
          metadata: {
            artifactId,
            name: project?.displayName ?? mod.name,
            version: mod.version,
            loaderHints: [snapshot.environment.loader],
            mixinConfigFiles: profile?.mixinConfigFiles ?? []
          },
          classTargets: (profile?.classTargets ?? []).map((target) => ({
            ownerArtifactId: artifactId,
            target
          })),
          resourceTargets: (profile?.resourceTargets ?? []).map((target) => ({
            ownerArtifactId: artifactId,
            target
          })),
          mixinTargets: (profile?.mixinTargets ?? []).map((target) => ({
            ownerArtifactId: artifactId,
            target
          })),
          embeddedLibraries: (profile?.embeddedLibraries ?? []).map((library) => ({
            ownerArtifactId: artifactId,
            coordinates: library.coordinates,
            packageHints: library.packageHints
          })),
          fingerprint: stableHash({
            projectId: mod.canonicalProjectId,
            versionId: mod.canonicalVersionId,
            profile
          }),
          schemaVersion: 2,
          createdAt: now()
        };
      });

    this.repository.artifactAnalyses.set(analysisId, artifacts);

    const findings = this.jvmServiceUrl
      ? this.findingsFromJvmHttpBoundary(snapshot, artifacts)
      : this.javaSourcePath
      ? this.findingsFromJvmBoundary(snapshot, artifacts)
      : [
          ...this.findOverlapFindings(
            snapshot,
            artifacts,
            "mixin_overlap",
            "high",
            (artifact) => artifact.mixinTargets.map((target) => target.target),
            "Multiple artifacts target the same mixin application point."
          ),
          ...this.findOverlapFindings(
            snapshot,
            artifacts,
            "resource_collision",
            "medium",
            (artifact) => artifact.resourceTargets.map((target) => target.target),
            "Multiple artifacts ship the same resource path."
          ),
          ...this.findOverlapFindings(
            snapshot,
            artifacts,
            "class_overlap",
            "medium",
            (artifact) => artifact.classTargets.map((target) => target.target),
            "Multiple artifacts define the same class or bytecode target."
          ),
          ...this.findEmbeddedLibraryDivergence(snapshot, artifacts)
        ];

    return {
      artifacts,
      findings
    };
  }

  private findingsFromJvmBoundary(
    snapshot: PackSnapshot,
    artifacts: ArtifactAnalysisResult[]
  ): Finding[] {
    const report = this.runJvmBoundary(artifacts);
    const artifactsById = new Map(
      artifacts.map((artifact) => [artifact.metadata.artifactId, artifact] as const)
    );

    return [
      ...report.overlaps
        .map((overlap) => {
          const owners = overlap.artifactIds
            .map((artifactId) => artifactsById.get(artifactId))
            .filter((artifact): artifact is ArtifactAnalysisResult => Boolean(artifact));
          if (owners.length < 2) {
            return undefined;
          }
          return this.buildOverlapFinding(
            snapshot,
            owners,
            overlap.type,
            overlap.type === "mixin_overlap" ? "high" : "medium",
            overlap.target,
            overlap.type === "mixin_overlap"
              ? "Multiple artifacts target the same mixin application point."
              : overlap.type === "resource_collision"
                ? "Multiple artifacts ship the same resource path."
                : "Multiple artifacts define the same class or bytecode target."
          );
        })
        .filter((finding): finding is Finding => Boolean(finding)),
      ...report.divergences
        .map((divergence) => {
          const items = divergence.items
            .map((item) => {
              const artifact = artifactsById.get(item.artifactId);
              return artifact
                ? {
                    artifact,
                    coordinates: item.coordinates
                  }
                : undefined;
            })
            .filter(
              (
                item
              ): item is { artifact: ArtifactAnalysisResult; coordinates: string } =>
                Boolean(item)
            );
          if (items.length < 2) {
            return undefined;
          }
          return this.buildEmbeddedLibraryFinding(snapshot, divergence.packageHint, items);
        })
        .filter((finding): finding is Finding => Boolean(finding))
    ];
  }

  private runJvmBoundary(artifacts: ArtifactAnalysisResult[]) {
    if (!this.javaSourcePath) {
      throw new Error("ARTIFACT_ANALYSIS_JAVA_SOURCE is not configured.");
    }

    const result = spawnSync(this.javaBin, [this.javaSourcePath], {
      input: serializeArtifactBoundaryRequest(artifacts),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });

    if (result.error) {
      throw new Error(`JVM artifact-analysis boundary failed: ${result.error.message}`);
    }

    if (result.status !== 0) {
      throw new Error(
        `JVM artifact-analysis boundary exited with status ${result.status}: ${result.stderr.trim()}`
      );
    }

    return parseArtifactBoundaryResponse(result.stdout);
  }

  /**
   * Call the long-lived JVM HTTP service at {@code ARTIFACT_ANALYSIS_SERVICE_URL}.
   * Uses the same tab-delimited wire format as the subprocess boundary so the
   * JVM side can reuse {@code ArtifactAnalysisBoundary.processInput()}.
   *
   * This method is synchronous at the call-site to avoid threading async into
   * the current deterministic pipeline. It uses a synchronous XHR-style fetch
   * via Node's built-in synchronous HTTP via {@code spawnSync} helper.
   * Once the orchestrator pipeline moves to an async Temporal worker topology
   * this should be upgraded to a proper async fetch.
   */
  private findingsFromJvmHttpBoundary(
    snapshot: PackSnapshot,
    artifacts: ArtifactAnalysisResult[]
  ): Finding[] {
    if (!this.jvmServiceUrl) {
      throw new Error("ARTIFACT_ANALYSIS_SERVICE_URL is not configured.");
    }

    const payload = serializeArtifactBoundaryRequest(artifacts);

    // Use spawnSync(node -e ...) to perform a synchronous HTTP POST without
    // async/await, keeping the current deterministic orchestration pipeline intact.
    const nodeScript = `
const http = require('http');
const url = new URL(process.env.JVM_URL + '/v1/artifact-analysis/analyze');
const body = Buffer.from(process.env.PAYLOAD, 'base64').toString('utf8');
const options = {
  hostname: url.hostname,
  port: url.port || 80,
  path: url.pathname,
  method: 'POST',
  headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) }
};
const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode !== 200) {
      process.stderr.write('HTTP ' + res.statusCode + ': ' + data);
      process.exit(1);
    }
    process.stdout.write(data);
  });
});
req.on('error', (e) => { process.stderr.write(e.message); process.exit(1); });
req.write(body);
req.end();
`;

    const result = spawnSync(process.execPath, ["-e", nodeScript], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        JVM_URL: this.jvmServiceUrl,
        PAYLOAD: Buffer.from(payload).toString("base64")
      }
    });

    if (result.error) {
      throw new Error(`JVM HTTP artifact-analysis boundary failed: ${result.error.message}`);
    }

    if (result.status !== 0) {
      throw new Error(
        `JVM HTTP artifact-analysis boundary returned error: ${result.stderr.trim()}`
      );
    }

    const report = parseArtifactBoundaryResponse(result.stdout);
    const artifactsById = new Map(
      artifacts.map((artifact) => [artifact.metadata.artifactId, artifact] as const)
    );

    return [
      ...report.overlaps
        .map((overlap) => {
          const owners = overlap.artifactIds
            .map((id) => artifactsById.get(id))
            .filter((a): a is ArtifactAnalysisResult => Boolean(a));
          if (owners.length < 2) return undefined;
          return this.buildOverlapFinding(
            snapshot,
            owners,
            overlap.type,
            overlap.type === "mixin_overlap" ? "high" : "medium",
            overlap.target,
            overlap.type === "mixin_overlap"
              ? "Multiple artifacts target the same mixin application point."
              : overlap.type === "resource_collision"
              ? "Multiple artifacts ship the same resource path."
              : "Multiple artifacts define the same class or bytecode target."
          );
        })
        .filter((f): f is Finding => Boolean(f)),
      ...report.divergences
        .map((divergence) => {
          const items = divergence.items
            .map(({ artifactId, coordinates }) => {
              const artifact = artifactsById.get(artifactId);
              return artifact ? { artifact, coordinates } : undefined;
            })
            .filter((item): item is { artifact: ArtifactAnalysisResult; coordinates: string } =>
              Boolean(item)
            );
          if (items.length < 2) return undefined;
          return this.buildEmbeddedLibraryFinding(snapshot, divergence.packageHint, items);
        })
        .filter((f): f is Finding => Boolean(f))
    ];
  }

  private findOverlapFindings(
    snapshot: PackSnapshot,
    artifacts: ArtifactAnalysisResult[],
    type: string,
    severity: Finding["severity"],
    selectTargets: (artifact: ArtifactAnalysisResult) => string[],
    summaryPrefix: string
  ): Finding[] {
    const overlaps = new Map<string, ArtifactAnalysisResult[]>();

    for (const artifact of artifacts) {
      for (const target of selectTargets(artifact)) {
        const items = overlaps.get(target) ?? [];
        items.push(artifact);
        overlaps.set(target, items);
      }
    }

    return [...overlaps.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([target, owners]) =>
        this.buildOverlapFinding(snapshot, owners, type, severity, target, summaryPrefix)
      );
  }

  private findEmbeddedLibraryDivergence(
    snapshot: PackSnapshot,
    artifacts: ArtifactAnalysisResult[]
  ): Finding[] {
    const byPackage = new Map<
      string,
      Array<{ artifact: ArtifactAnalysisResult; coordinates: string }>
    >();

    for (const artifact of artifacts) {
      for (const library of artifact.embeddedLibraries) {
        for (const packageHint of library.packageHints) {
          const items = byPackage.get(packageHint) ?? [];
          items.push({ artifact, coordinates: library.coordinates });
          byPackage.set(packageHint, items);
        }
      }
    }

    return [...byPackage.entries()]
      .filter(([, items]) => new Set(items.map((item) => item.coordinates)).size > 1)
      .map(([packageHint, items]) => this.buildEmbeddedLibraryFinding(snapshot, packageHint, items));
  }

  private buildOverlapFinding(
    snapshot: PackSnapshot,
    owners: ArtifactAnalysisResult[],
    type: string,
    severity: Finding["severity"],
    target: string,
    summaryPrefix: string
  ): Finding {
    const provenance: FindingProvenance[] = owners.map((owner) => ({
      kind: "static_analysis",
      sourceId: owner.artifactAnalysisId,
      sourceType: type,
      version: owner.versionId,
      note: target
    }));
    const confidenceInputs: ConfidenceInput[] = owners.map((owner) => ({
      source: "static_analysis",
      value: 0.8,
      weight: 1,
      rationale: `${owner.metadata.name} targets ${target}.`
    }));

    return {
      findingId: createPlatformId("fnd"),
      type,
      severity,
      confidence: averageConfidence(confidenceInputs),
      reproducibility: "likely",
      title: `${owners.map((owner) => owner.metadata.name).join(" and ")} overlap on ${target}`,
      summary: `${summaryPrefix} Target: ${target}.`,
      explanation: `${summaryPrefix} The artifact analyzer observed the same target in ${owners.length} artifacts.`,
      scope: snapshot.environment,
      evidence: owners.map((owner) => ({
        type: "static_analysis",
        id: owner.artifactAnalysisId
      })),
      subjects: owners.map((owner) => ({
        projectId: owner.projectId,
        versionId: owner.versionId,
        relation: "primary"
      })),
      recommendedActions: [`Review load order or replace one of the overlapping artifacts for ${target}.`],
      provenance,
      confidenceInputs,
      dedupeKey: stableHash({
        type,
        target,
        projects: owners.map((owner) => owner.projectId).sort()
      })
    };
  }

  private buildEmbeddedLibraryFinding(
    snapshot: PackSnapshot,
    packageHint: string,
    items: Array<{ artifact: ArtifactAnalysisResult; coordinates: string }>
  ): Finding {
    const confidenceInputs: ConfidenceInput[] = items.map((item) => ({
      source: "static_analysis",
      value: 0.86,
      weight: 1,
      rationale: `${item.artifact.metadata.name} embeds ${item.coordinates}.`
    }));

    return {
      findingId: createPlatformId("fnd"),
      type: "embedded_library_divergence",
      severity: "high",
      confidence: averageConfidence(confidenceInputs),
      reproducibility: "likely",
      title: `Embedded library divergence on ${packageHint}`,
      summary: `Multiple artifacts embed different versions for ${packageHint}.`,
      explanation: `Static analysis detected conflicting embedded libraries for package namespace ${packageHint}.`,
      scope: snapshot.environment,
      evidence: items.map((item) => ({
        type: "static_analysis",
        id: item.artifact.artifactAnalysisId
      })),
      subjects: items.map((item) => ({
        projectId: item.artifact.projectId,
        versionId: item.artifact.versionId,
        relation: "primary"
      })),
      recommendedActions: [`Align the embedded library versions for package ${packageHint} or replace one of the mods.`],
      provenance: items.map((item) => ({
        kind: "static_analysis",
        sourceId: item.artifact.artifactAnalysisId,
        sourceType: "embedded_library",
        note: item.coordinates
      })),
      confidenceInputs,
      dedupeKey: stableHash({
        type: "embedded_library_divergence",
        packageHint,
        coordinates: items.map((item) => item.coordinates).sort()
      })
    };
  }
}

function encodeArtifactBoundaryField(value: string) {
  return encodeURIComponent(value);
}

function decodeArtifactBoundaryField(value: string) {
  return decodeURIComponent(value);
}

function serializeArtifactBoundaryRequest(artifacts: ArtifactAnalysisResult[]) {
  const lines: string[] = [];

  for (const artifact of artifacts) {
    lines.push(
      [
        "artifact",
        artifact.metadata.artifactId,
        artifact.projectId,
        artifact.versionId ?? "",
        artifact.metadata.name,
        artifact.metadata.version ?? ""
      ]
        .map(encodeArtifactBoundaryField)
        .join("\t")
    );

    for (const target of artifact.mixinTargets) {
      lines.push(
        ["mixin", artifact.metadata.artifactId, target.target]
          .map(encodeArtifactBoundaryField)
          .join("\t")
      );
    }

    for (const target of artifact.classTargets) {
      lines.push(
        ["class", artifact.metadata.artifactId, target.target]
          .map(encodeArtifactBoundaryField)
          .join("\t")
      );
    }

    for (const target of artifact.resourceTargets) {
      lines.push(
        ["resource", artifact.metadata.artifactId, target.target]
          .map(encodeArtifactBoundaryField)
          .join("\t")
      );
    }

    for (const library of artifact.embeddedLibraries) {
      lines.push(
        [
          "library",
          artifact.metadata.artifactId,
          library.coordinates,
          library.packageHints.join(";")
        ]
          .map(encodeArtifactBoundaryField)
          .join("\t")
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseArtifactBoundaryResponse(raw: string): {
  overlaps: Array<{ type: string; target: string; artifactIds: string[] }>;
  divergences: Array<{
    packageHint: string;
    items: Array<{ artifactId: string; coordinates: string }>;
  }>;
} {
  const overlaps: Array<{ type: string; target: string; artifactIds: string[] }> = [];
  const divergences: Array<{
    packageHint: string;
    items: Array<{ artifactId: string; coordinates: string }>;
  }> = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const fields = line.split("\t").map(decodeArtifactBoundaryField);
    const kind = fields[0];

    if (kind === "overlap") {
      overlaps.push({
        type: fields[1] ?? "",
        target: fields[2] ?? "",
        artifactIds: (fields[3] ?? "").split(";").filter(Boolean)
      });
      continue;
    }

    if (kind === "divergence") {
      divergences.push({
        packageHint: fields[1] ?? "",
        items: (fields[2] ?? "")
          .split(";")
          .filter(Boolean)
          .map((item) => {
            const [artifactId, coordinates] = item.split("=", 2);
            return {
              artifactId,
              coordinates
            };
          })
      });
    }
  }

  return { overlaps, divergences };
}

export class GraphService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  upsertAnalysisGraph(
    analysisId: string,
    snapshot: PackSnapshot,
    artifacts: ArtifactAnalysisResult[],
    findings: Finding[]
  ): GraphSnapshot {
    const nodes: GraphNode[] = [
      {
        nodeId: snapshot.packSnapshotId,
        nodeType: "pack_snapshot",
        label: snapshot.packSnapshotId,
        analysisId,
        properties: { environment: snapshot.environment }
      }
    ];
    const edges: GraphEdge[] = [];

    for (const mod of snapshot.mods) {
      if (!mod.canonicalProjectId) {
        continue;
      }

      const projectNodeId = mod.canonicalProjectId;
      if (!nodes.find((node) => node.nodeId === projectNodeId)) {
        nodes.push({
          nodeId: projectNodeId,
          nodeType: "project",
          label:
            this.repository.canonicalProjects.get(projectNodeId)?.displayName ??
            projectNodeId,
          analysisId
        });
      }
      edges.push({
        edgeId: createPlatformId("ged"),
        analysisId,
        edgeType: "contains",
        sourceId: snapshot.packSnapshotId,
        targetId: projectNodeId,
        weight: 1
      });

      if (mod.canonicalVersionId) {
        if (!nodes.find((node) => node.nodeId === mod.canonicalVersionId)) {
          nodes.push({
            nodeId: mod.canonicalVersionId,
            nodeType: "version",
            label:
              this.repository.canonicalVersions.get(mod.canonicalVersionId)
                ?.versionLabel ?? mod.canonicalVersionId,
            analysisId
          });
        }
        edges.push({
          edgeId: createPlatformId("ged"),
          analysisId,
          edgeType: "resolved_to",
          sourceId: projectNodeId,
          targetId: mod.canonicalVersionId,
          weight: 1
        });
      }
    }

    for (const dependency of this.repository.dependencies) {
      if (snapshot.mods.some((mod) => mod.canonicalVersionId === dependency.versionId)) {
        edges.push({
          edgeId: createPlatformId("ged"),
          analysisId,
          edgeType: dependency.relationType,
          sourceId: dependency.versionId,
          targetId: dependency.dependencyProjectId,
          weight: 0.9
        });
      }
    }

    for (const artifact of artifacts) {
      nodes.push({
        nodeId: artifact.metadata.artifactId,
        nodeType: "artifact",
        label: artifact.metadata.name,
        analysisId
      });
      edges.push({
        edgeId: createPlatformId("ged"),
        analysisId,
        edgeType: "backs_project",
        sourceId: artifact.projectId,
        targetId: artifact.metadata.artifactId,
        weight: 1
      });

      const targets = [
        ...artifact.mixinTargets.map((target) => ({ ...target, nodeType: "mixin_target" })),
        ...artifact.classTargets.map((target) => ({ ...target, nodeType: "class_target" })),
        ...artifact.resourceTargets.map((target) => ({ ...target, nodeType: "resource_target" }))
      ];

      for (const target of targets) {
        if (!nodes.find((node) => node.nodeId === target.target)) {
          nodes.push({
            nodeId: target.target,
            nodeType: target.nodeType,
            label: target.target,
            analysisId
          });
        }
        edges.push({
          edgeId: createPlatformId("ged"),
          analysisId,
          edgeType: "targets",
          sourceId: artifact.metadata.artifactId,
          targetId: target.target,
          weight: 0.8
        });
      }

      for (const library of artifact.embeddedLibraries) {
        if (!nodes.find((node) => node.nodeId === library.coordinates)) {
          nodes.push({
            nodeId: library.coordinates,
            nodeType: "embedded_library",
            label: library.coordinates,
            analysisId
          });
        }
        edges.push({
          edgeId: createPlatformId("ged"),
          analysisId,
          edgeType: "embeds",
          sourceId: artifact.metadata.artifactId,
          targetId: library.coordinates,
          weight: 0.85
        });
      }
    }

    const graph: GraphSnapshot = {
      graphId: createPlatformId("grf"),
      analysisId,
      nodes,
      edges,
      schemaVersion: 2,
      createdAt: now()
    };

    const explanationPaths = new Map<string, ExplanationPath>();
    for (const finding of findings) {
      const pathNodes = nodes.filter((node) =>
        finding.subjects.some(
          (subject) =>
            subject.projectId === node.nodeId || subject.versionId === node.nodeId
        )
      );
      const pathEdges = edges.filter((edge) =>
        pathNodes.some(
          (node) => node.nodeId === edge.sourceId || node.nodeId === edge.targetId
        )
      );
      explanationPaths.set(finding.findingId, {
        pathId: createPlatformId("exp"),
        analysisId,
        findingId: finding.findingId,
        summary: `Explanation path for ${finding.title}`,
        nodes: pathNodes,
        edges: pathEdges,
        createdAt: now()
      });
    }

    this.repository.graphSnapshots.set(analysisId, graph);
    this.repository.explanationPaths.set(analysisId, explanationPaths);

    return graph;
  }

  getGraph(analysisId: string): GraphSnapshot | undefined {
    return this.repository.graphSnapshots.get(analysisId);
  }

  getNeighborhood(analysisId: string, centerNodeId: string, depth = 1): GraphNeighborhood {
    const graph = this.requireGraph(analysisId);
    const visited = new Set<string>([centerNodeId]);
    let frontier = new Set<string>([centerNodeId]);

    for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
      const next = new Set<string>();
      for (const edge of graph.edges) {
        if (frontier.has(edge.sourceId) && !visited.has(edge.targetId)) {
          visited.add(edge.targetId);
          next.add(edge.targetId);
        }
        if (frontier.has(edge.targetId) && !visited.has(edge.sourceId)) {
          visited.add(edge.sourceId);
          next.add(edge.sourceId);
        }
      }
      frontier = next;
    }

    return {
      analysisId,
      centerNodeId,
      depth,
      nodes: graph.nodes.filter((node) => visited.has(node.nodeId)),
      edges: graph.edges.filter(
        (edge) => visited.has(edge.sourceId) && visited.has(edge.targetId)
      )
    };
  }

  explainFinding(analysisId: string, findingId: string): ExplanationPath {
    const paths = this.repository.explanationPaths.get(analysisId);
    const path = paths?.get(findingId);

    if (!path) {
      throw new Error(`Explanation path not found: ${analysisId}/${findingId}`);
    }

    return path;
  }

  private requireGraph(analysisId: string): GraphSnapshot {
    const graph = this.repository.graphSnapshots.get(analysisId);

    if (!graph) {
      throw new Error(`Graph not found: ${analysisId}`);
    }

    return graph;
  }
}

export class FindingMergeService {
  merge(input: {
    resolverFindings: Finding[];
    ruleFindings: Finding[];
    staticFindings: Finding[];
    graphService: GraphService;
    analysisId: string;
  }): Finding[] {
    const grouped = new Map<string, Finding[]>();

    for (const finding of [
      ...input.resolverFindings,
      ...input.ruleFindings,
      ...input.staticFindings
    ]) {
      const key = finding.dedupeKey ?? dedupeFindingKey(finding);
      const items = grouped.get(key) ?? [];
      items.push(finding);
      grouped.set(key, items);
    }

    return [...grouped.entries()].map(([key, items]) => {
      const base = items[0]!;
      const evidence = new Map(
        items.flatMap((item) => item.evidence).map((item) => [`${item.type}:${item.id}`, item])
      );
      const subjects = new Map(
        items
          .flatMap((item) => item.subjects)
          .map((subject) => [canonicalSubjectKey(subject), subject])
      );
      const provenance = items.flatMap((item) => item.provenance ?? []);
      const confidenceInputs = items.flatMap((item) => item.confidenceInputs ?? []);
      let explanation = items
        .map((item) => item.explanation)
        .filter((value): value is string => Boolean(value))
        .join(" ");

      try {
        const explanationPath = input.graphService.explainFinding(
          input.analysisId,
          base.findingId
        );
        explanation = `${explanation} ${explanationPath.summary}`.trim();
        provenance.push({
          kind: "graph",
          sourceId: explanationPath.pathId,
          sourceType: "explanation_path"
        });
        confidenceInputs.push({
          source: "graph",
          value: 0.72,
          weight: 0.5,
          rationale: "Graph explanation path connects the affected entities."
        });
      } catch {
        // Explanation enrichment is best effort.
      }

      return {
        ...base,
        evidence: [...evidence.values()],
        subjects: [...subjects.values()],
        provenance,
        confidenceInputs,
        confidence: averageConfidence(
          confidenceInputs.length > 0
            ? confidenceInputs
            : [
                {
                  source: "resolver",
                  value: base.confidence,
                  weight: 1,
                  rationale: "Base finding confidence."
                }
              ]
        ),
        explanation,
        dedupeKey: key
      };
    });
  }
}

export class PackDiffService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  createDiff(input: CreatePackDiffInput): PackDiff {
    const base = this.repository.snapshots.get(input.baseSnapshotId);
    const target = this.repository.snapshots.get(input.targetSnapshotId);

    if (!base || !target) {
      throw new Error("Pack diff requires both base and target snapshots.");
    }

    const baseByProject = new Map(base.mods.map((mod) => [mod.canonicalProjectId ?? mod.name, mod]));
    const targetByProject = new Map(
      target.mods.map((mod) => [mod.canonicalProjectId ?? mod.name, mod])
    );
    const changes: PackDiff["changes"] = [];

    for (const [projectId, mod] of targetByProject.entries()) {
      const previous = baseByProject.get(projectId);
      if (!previous) {
        changes.push({
          changeType: "mod_added",
          projectId,
          after: mod.version,
          summary: `${mod.name} was added to the pack.`
        });
      } else if ((previous.version ?? "") !== (mod.version ?? "")) {
        changes.push({
          changeType: "version_changed",
          projectId,
          before: previous.version,
          after: mod.version,
          summary: `${mod.name} changed from ${previous.version ?? "unknown"} to ${mod.version ?? "unknown"}.`
        });
      }
    }

    for (const [projectId, mod] of baseByProject.entries()) {
      if (!targetByProject.has(projectId)) {
        changes.push({
          changeType: "mod_removed",
          projectId,
          before: mod.version,
          summary: `${mod.name} was removed from the pack.`
        });
      }
    }

    if (stableHash(base.environment) !== stableHash(target.environment)) {
      changes.push({
        changeType: "environment_changed",
        before: JSON.stringify(base.environment),
        after: JSON.stringify(target.environment),
        summary: "The pack environment changed between snapshots."
      });
    }

    const baselineAnalysis = input.baselineAnalysisId
      ? this.repository.analyses.get(input.baselineAnalysisId)
      : undefined;
    const targetAnalysis = input.targetAnalysisId
      ? this.repository.analyses.get(input.targetAnalysisId)
      : undefined;

    if (baselineAnalysis && targetAnalysis) {
      const baselineKeys = new Set(
        baselineAnalysis.findings.map((finding) => finding.dedupeKey ?? dedupeFindingKey(finding))
      );
      const targetKeys = new Set(
        targetAnalysis.findings.map((finding) => finding.dedupeKey ?? dedupeFindingKey(finding))
      );

      for (const finding of targetAnalysis.findings) {
        const key = finding.dedupeKey ?? dedupeFindingKey(finding);
        if (!baselineKeys.has(key)) {
          changes.push({
            changeType: "finding_added",
            projectId: finding.subjects[0]?.projectId,
            after: finding.type,
            summary: `Finding added: ${finding.title}`
          });
        }
      }

      for (const finding of baselineAnalysis.findings) {
        const key = finding.dedupeKey ?? dedupeFindingKey(finding);
        if (!targetKeys.has(key)) {
          changes.push({
            changeType: "finding_resolved",
            projectId: finding.subjects[0]?.projectId,
            before: finding.type,
            summary: `Finding resolved: ${finding.title}`
          });
        }
      }
    }

    const diff: PackDiff = {
      packDiffId: createPlatformId("dif"),
      projectId: input.projectId,
      baseSnapshotId: input.baseSnapshotId,
      targetSnapshotId: input.targetSnapshotId,
      baselineAnalysisId: input.baselineAnalysisId,
      targetAnalysisId: input.targetAnalysisId,
      summary: {
        addedMods: changes.filter((change) => change.changeType === "mod_added").length,
        removedMods: changes.filter((change) => change.changeType === "mod_removed").length,
        changedVersions: changes.filter((change) => change.changeType === "version_changed").length,
        findingAdds: changes.filter((change) => change.changeType === "finding_added").length,
        findingResolutions: changes.filter((change) => change.changeType === "finding_resolved").length
      },
      changes,
      schemaVersion: 2,
      createdAt: now()
    };

    this.repository.packDiffs.set(diff.packDiffId, diff);
    return diff;
  }

  getDiff(packDiffId: string): PackDiff {
    const diff = this.repository.packDiffs.get(packDiffId);

    if (!diff) {
      throw new Error(`Pack diff not found: ${packDiffId}`);
    }

    return diff;
  }
}
