import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AnalysisStatus,
  ArtifactAnalysisResult,
  ConnectorSyncSchedule,
  EvidenceCurationRecord,
  EvidenceDocument,
  EvidenceIngestionError,
  EvidenceSearchDocument,
  EvidenceSnippet,
  ExactPackAnalysisCacheRecord,
  ExplanationPath,
  FindingFeatureVector,
  FeedbackSignalReport,
  FragmentCompatibilityRecord,
  GroundTruthCandidate,
  GroundTruthExactPackRecord,
  GroundTruthKnowledgeSnapshot,
  GroundTruthRun,
  GitHubInstallationLink,
  GraphSnapshot,
  KnowledgeSnapshot,
  ApiKeyRecord,
  ModelEvaluationRecord,
  ModelRegistryEntry,
  OfflineDataset,
  Organization,
  OrganizationMembership,
  PackDiff,
  PackBenchmarkResult,
  PairwiseCompatibilityRecord,
  PromotedCompatibilityClaim,
  ReleaseGateDecision,
  PackReviewSummary,
  RecommendationFeedback,
  RecommendationOutcome,
  RecommendationSet,
  RuleDraftRecord,
  RuleVersionHistoryEntry,
  CalibratedFindingScore,
  CrashSignature,
  SmokeTestRecipe,
  StatusCheckResult,
  SimulationRun,
  UserIdentity,
  RawPayloadRecord,
  SourceConnector,
  SourceSyncRun,
  SnapshotPromotionEvent,
  SnapshotValidationReport,
  SupportedCoverageScope,
  TechnicalConflictSignature,
  Workspace,
  WebhookDeliveryAttempt,
  WebhookRegistration,
  Project,
  PackImport,
  PackSnapshot
} from "@modcompat/domain-models";
import { now, stableHash } from "./helpers.js";
import type {
  AnalysisReportRecord,
  AnalysisRecordInternal,
  CanonicalProjectRecord,
  CanonicalVersionRecord,
  ArtifactProfileRecord,
  DependencyRecord,
  IncompatibilityRecord,
  VerifiedRuleDefinition
} from "./types.js";

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
}

function loadVerifiedRules(): VerifiedRuleDefinition[] {
  const rulesDirectory = resolve(repoRoot(), "rules/verified");
  const files = readdirSync(rulesDirectory).filter((file) => file.endsWith(".json"));

  return files.map((file) =>
    JSON.parse(
      readFileSync(resolve(rulesDirectory, file), "utf8")
    ) as VerifiedRuleDefinition
  );
}

export class InMemoryPlatformRepository {
  readonly users = new Map<string, UserIdentity>();
  readonly organizations = new Map<string, Organization>();
  readonly memberships = new Map<string, OrganizationMembership>();
  readonly workspaces = new Map<string, Workspace>();
  readonly projects = new Map<string, Project>();
  readonly apiKeys = new Map<string, ApiKeyRecord & { secret: string }>();
  readonly imports = new Map<string, PackImport>();
  readonly snapshots = new Map<string, PackSnapshot>();
  readonly analyses = new Map<string, AnalysisRecordInternal>();
  readonly artifactAnalyses = new Map<string, ArtifactAnalysisResult[]>();
  readonly graphSnapshots = new Map<string, GraphSnapshot>();
  readonly explanationPaths = new Map<string, Map<string, ExplanationPath>>();
  readonly packDiffs = new Map<string, PackDiff>();
  readonly canonicalProjects = new Map<string, CanonicalProjectRecord>();
  readonly canonicalVersions = new Map<string, CanonicalVersionRecord>();
  readonly artifactProfiles = new Map<string, ArtifactProfileRecord>();
  readonly sourceMappings = new Map<
    string,
    {
      sourceName: string;
      sourceProjectId: string;
      canonicalProjectId: string;
      canonicalVersionId?: string;
    }
  >();
  readonly dependencies: DependencyRecord[] = [];
  readonly incompatibilities: IncompatibilityRecord[] = [];
  readonly workflowExecutions = new Map<
    string,
    { workflowId: string; runId: string; status: AnalysisStatus }
  >();
  readonly sourceConnectors = new Map<string, SourceConnector>();
  readonly sourceConnectorsByName = new Map<string, SourceConnector>();
  readonly sourceSyncRuns = new Map<string, SourceSyncRun>();
  readonly rawPayloads = new Map<string, RawPayloadRecord>();
  readonly evidenceDocuments = new Map<string, EvidenceDocument>();
  readonly evidenceDocumentsByExternalRef = new Map<string, string>();
  readonly evidenceSnippets = new Map<string, EvidenceSnippet>();
  readonly evidenceSearchDocuments = new Map<string, EvidenceSearchDocument>();
  readonly evidenceCurations = new Map<string, EvidenceCurationRecord>();
  /** Ingestion errors keyed by syncRunId → error list. */
  readonly ingestionErrors = new Map<string, EvidenceIngestionError[]>();
  /** Sync schedule per connectorId. */
  readonly connectorSchedules = new Map<string, ConnectorSyncSchedule>();
  /** Rule drafts keyed by draftId. */
  readonly ruleDrafts = new Map<string, RuleDraftRecord>();
  /** Rule version history keyed by ruleId → ordered list of history entries. */
  readonly ruleVersionHistory = new Map<string, RuleVersionHistoryEntry[]>();
  /** Model evaluation records keyed by modelId → list of evaluations. */
  readonly modelEvaluations = new Map<string, ModelEvaluationRecord[]>();
  /** Most recent feedback signal reports, keyed by reportId. */
  readonly feedbackSignalReports = new Map<string, FeedbackSignalReport>();
  readonly recommendationSets = new Map<string, RecommendationSet>();
  readonly recommendationSetsByAnalysis = new Map<string, string>();
  readonly recommendationFeedback = new Map<string, RecommendationFeedback>();
  readonly recommendationFeedbackByRecommendation = new Map<string, string[]>();
  readonly recommendationOutcomes = new Map<string, RecommendationOutcome>();
  readonly recommendationOutcomesBySet = new Map<string, string[]>();
  readonly reports = new Map<string, AnalysisReportRecord>();
  readonly modelRegistry = new Map<string, ModelRegistryEntry>();
  readonly featureDatasets = new Map<string, OfflineDataset>();
  readonly featureDatasetsByAnalysis = new Map<string, string>();
  readonly findingFeatureVectors = new Map<string, FindingFeatureVector[]>();
  readonly calibratedFindingScores = new Map<string, CalibratedFindingScore[]>();
  readonly reviewSummaries = new Map<string, PackReviewSummary>();
  readonly smokeTestRecipes = new Map<string, SmokeTestRecipe>();
  readonly crashSignatures = new Map<string, CrashSignature>();
  readonly simulationRuns = new Map<string, SimulationRun>();
  readonly groundTruthCandidates = new Map<string, GroundTruthCandidate>();
  readonly groundTruthRuns = new Map<string, GroundTruthRun>();
  readonly groundTruthExactPackRecords = new Map<string, GroundTruthExactPackRecord>();
  readonly groundTruthExactPackRecordByKey = new Map<string, string>();
  readonly groundTruthKnowledgeSnapshots = new Map<string, GroundTruthKnowledgeSnapshot>();
  readonly groundTruthKnowledgeSnapshotsByVersion = new Map<string, string>();
  readonly releaseGateDecisions = new Map<string, ReleaseGateDecision>();
  readonly githubInstallationLinks = new Map<string, GitHubInstallationLink>();
  readonly webhookRegistrations = new Map<string, WebhookRegistration>();
  readonly webhookDeliveries = new Map<string, WebhookDeliveryAttempt[]>();
  readonly statusChecks = new Map<string, StatusCheckResult>();
  readonly coverageScopes = new Map<string, SupportedCoverageScope>();
  readonly coverageScopesBySnapshotVersion = new Map<string, string>();
  readonly knowledgeSnapshots = new Map<string, KnowledgeSnapshot>();
  readonly knowledgeSnapshotsByVersion = new Map<string, string>();
  readonly snapshotValidationReports = new Map<string, SnapshotValidationReport>();
  readonly snapshotPromotionEvents = new Map<string, SnapshotPromotionEvent[]>();
  readonly promotedCompatibilityClaims = new Map<string, PromotedCompatibilityClaim>();
  readonly promotedCompatibilityClaimsBySnapshot = new Map<string, string[]>();
  readonly technicalConflictSignatures = new Map<string, TechnicalConflictSignature>();
  readonly technicalConflictSignaturesBySnapshot = new Map<string, string[]>();
  readonly pairwiseCompatibilityRecords = new Map<string, PairwiseCompatibilityRecord>();
  readonly pairwiseCompatibilityBySnapshot = new Map<string, string[]>();
  readonly fragmentCompatibilityRecords = new Map<string, FragmentCompatibilityRecord>();
  readonly fragmentCompatibilityBySnapshot = new Map<string, string[]>();
  readonly packBenchmarkResults = new Map<string, PackBenchmarkResult>();
  readonly packBenchmarkResultsBySnapshot = new Map<string, string[]>();
  readonly exactPackAnalysisCache = new Map<string, ExactPackAnalysisCacheRecord>();
  readonly exactPackAnalysisCacheBySnapshot = new Map<string, string[]>();
  readonly pendingArtifactAnalysisQueue: string[] = [];
  readonly verifiedRules: VerifiedRuleDefinition[];

  constructor() {
    this.verifiedRules = loadVerifiedRules();
    this.seedCatalog();
    this.seedIdentity();
    this.seedSourceConnectors();
    this.seedModels();
    this.seedSimulationAssets();
    this.seedOfflineKnowledge();
  }

  private seedIdentity() {
    const user: UserIdentity = {
      userId: "usr_demo",
      email: "analyst@example.com",
      displayName: "Demo Analyst",
      schemaVersion: 1,
      createdAt: now()
    };
    const organization: Organization = {
      organizationId: "org_demo",
      tenantId: "org_demo",
      name: "Demo Pack Studio",
      slug: "demo-pack-studio",
      schemaVersion: 1,
      createdAt: now()
    };
    const membership: OrganizationMembership = {
      organizationId: organization.organizationId,
      userId: user.userId,
      role: "owner",
      tenantId: organization.organizationId,
      schemaVersion: 1,
      createdAt: now()
    };
    const workspace: Workspace = {
      workspaceId: "wrk_demo",
      organizationId: organization.organizationId,
      tenantId: organization.organizationId,
      name: "Compatibility Ops",
      slug: "compatibility-ops",
      schemaVersion: 1,
      createdAt: now()
    };
    const project: Project = {
      projectId: "prj_demo",
      organizationId: organization.organizationId,
      tenantId: organization.organizationId,
      workspaceId: workspace.workspaceId,
      name: "Kitchen Sink Pack",
      slug: "kitchen-sink-pack",
      visibility: "private",
      schemaVersion: 1,
      createdAt: now()
    };
    const apiKey: ApiKeyRecord & { secret: string } = {
      apiKeyId: "key_demo",
      organizationId: organization.organizationId,
      tenantId: organization.organizationId,
      createdBy: user.userId,
      name: "Demo automation",
      keyPrefix: "mcp_demo",
      scopes: [
        "workspace:read",
        "workspace:write",
        "project:read",
        "project:write",
        "analysis:read",
        "analysis:write"
      ],
      schemaVersion: 1,
      createdAt: now(),
      secret: "mcp_demo.secret"
    };

    this.users.set(user.userId, user);
    this.organizations.set(organization.organizationId, organization);
    this.memberships.set(`${membership.organizationId}:${membership.userId}`, membership);
    this.workspaces.set(workspace.workspaceId, workspace);
    this.projects.set(project.projectId, project);
    this.apiKeys.set(apiKey.apiKeyId, apiKey);
  }

  private seedCatalog() {
    const projects: CanonicalProjectRecord[] = [
      {
        projectId: "cp_fabric_api",
        slug: "fabric-api",
        displayName: "Fabric API",
        aliases: ["fabric-api", "fabric api"]
      },
      {
        projectId: "cp_sodium",
        slug: "sodium",
        displayName: "Sodium",
        aliases: ["sodium"]
      },
      {
        projectId: "cp_lithium",
        slug: "lithium",
        displayName: "Lithium",
        aliases: ["lithium"]
      },
      {
        projectId: "cp_optifine",
        slug: "optifine",
        displayName: "OptiFine",
        aliases: ["optifine", "optifabric"],
        recommendedReplacementProjectIds: ["cp_sodium", "cp_lithium"]
      },
      {
        projectId: "cp_modmenu",
        slug: "modmenu",
        displayName: "Mod Menu",
        aliases: ["modmenu", "mod menu"]
      }
    ];

    const versions: CanonicalVersionRecord[] = [
      {
        versionId: "ver_fabric_api_121",
        projectId: "cp_fabric_api",
        versionLabel: "0.100.8+1.21.1",
        loaders: ["fabric"],
        minecraftVersions: ["1.21.1"],
        javaVersions: ["21"],
        primaryFileDownloadUrl: "https://cdn.modrinth.com/data/P7dR8mSH/versions/0.100.8/fabric-api-0.100.8%2B1.21.1.jar"
      },
      {
        versionId: "ver_sodium_121",
        projectId: "cp_sodium",
        versionLabel: "0.6.0+mc1.21.1",
        loaders: ["fabric"],
        minecraftVersions: ["1.21.1"],
        javaVersions: ["21"],
        primaryFileDownloadUrl: "https://cdn.modrinth.com/data/EV0O3YRU/versions/0.6.0/sodium-fabric-0.6.0%2Bmc1.21.1.jar"
      },
      {
        versionId: "ver_lithium_121",
        projectId: "cp_lithium",
        versionLabel: "0.15.0+mc1.21.1",
        loaders: ["fabric"],
        minecraftVersions: ["1.21.1"],
        javaVersions: ["21"],
        primaryFileDownloadUrl: "https://cdn.modrinth.com/data/gvQqBUqZ/versions/0.15.0/lithium-fabric-0.15.0%2Bmc1.21.1.jar"
      },
      {
        versionId: "ver_optifine_120",
        projectId: "cp_optifine",
        versionLabel: "HD_U_I6",
        loaders: ["forge"],
        minecraftVersions: ["1.20.1"],
        javaVersions: ["17"],
        primaryFileDownloadUrl: "https://optifine.net/download?f=OptiFine_1.20.1_HD_U_I6.jar"
      },
      {
        versionId: "ver_modmenu_121",
        projectId: "cp_modmenu",
        versionLabel: "11.0.2",
        loaders: ["fabric"],
        minecraftVersions: ["1.21.1"],
        javaVersions: ["21"],
        primaryFileDownloadUrl: "https://cdn.modrinth.com/data/mOgUt4GM/versions/11.0.2/modmenu-11.0.2%2B1.21.1.jar"
      }
    ];

    for (const project of projects) {
      this.canonicalProjects.set(project.projectId, project);
    }

    for (const version of versions) {
      this.canonicalVersions.set(version.versionId, version);
    }

    this.sourceMappings.set("modrinth:AANobbMI", {
      sourceName: "modrinth",
      sourceProjectId: "AANobbMI",
      canonicalProjectId: "cp_fabric_api",
      canonicalVersionId: "ver_fabric_api_121"
    });
    this.sourceMappings.set("modrinth:AbcSodium", {
      sourceName: "modrinth",
      sourceProjectId: "AbcSodium",
      canonicalProjectId: "cp_sodium",
      canonicalVersionId: "ver_sodium_121"
    });
    this.sourceMappings.set("curseforge:fabric-api", {
      sourceName: "curseforge",
      sourceProjectId: "fabric-api",
      canonicalProjectId: "cp_fabric_api",
      canonicalVersionId: "ver_fabric_api_121"
    });

    this.dependencies.push(
      {
        versionId: "ver_sodium_121",
        dependencyProjectId: "cp_fabric_api",
        relationType: "required"
      },
      {
        versionId: "ver_modmenu_121",
        dependencyProjectId: "cp_fabric_api",
        relationType: "required"
      }
    );

    this.incompatibilities.push({
      versionId: "ver_optifine_120",
      incompatibleProjectId: "cp_sodium",
      reason: "Rendering transformers conflict and cannot be loaded together."
    });

    const artifactProfiles: ArtifactProfileRecord[] = [
      {
        artifactId: "artifact_fabric_api_121",
        versionId: "ver_fabric_api_121",
        mixinConfigFiles: [],
        mixinTargets: [],
        classTargets: ["net.fabricmc.fabric.api.event.EventFactory"],
        resourceTargets: ["fabric.mod.json"],
        embeddedLibraries: []
      },
      {
        artifactId: "artifact_sodium_121",
        versionId: "ver_sodium_121",
        mixinConfigFiles: ["sodium.mixins.json"],
        mixinTargets: [
          "net.minecraft.client.render.WorldRenderer",
          "net.minecraft.client.texture.SpriteAtlasTexture"
        ],
        classTargets: [
          "me.jellysquid.mods.sodium.client.SodiumClientMod",
          "org.lwjgl.system.MemoryUtil"
        ],
        resourceTargets: ["assets/minecraft/shaders/core/rendertype_solid.json"],
        embeddedLibraries: [
          {
            coordinates: "org.lwjgl:lwjgl:3.3.3",
            packageHints: ["org.lwjgl.system"]
          }
        ]
      },
      {
        artifactId: "artifact_lithium_121",
        versionId: "ver_lithium_121",
        mixinConfigFiles: ["lithium.mixins.json"],
        mixinTargets: ["net.minecraft.world.chunk.ChunkStatus"],
        classTargets: ["me.jellysquid.mods.lithium.common.LithiumMod"],
        resourceTargets: [],
        embeddedLibraries: []
      },
      {
        artifactId: "artifact_optifine_120",
        versionId: "ver_optifine_120",
        mixinConfigFiles: ["optifine.mixins.json"],
        mixinTargets: ["net.minecraft.client.render.WorldRenderer"],
        classTargets: ["net.optifine.Config", "org.lwjgl.system.MemoryUtil"],
        resourceTargets: ["assets/minecraft/shaders/core/rendertype_solid.json"],
        embeddedLibraries: [
          {
            coordinates: "org.lwjgl:lwjgl:3.2.2",
            packageHints: ["org.lwjgl.system"]
          }
        ]
      },
      {
        artifactId: "artifact_modmenu_121",
        versionId: "ver_modmenu_121",
        mixinConfigFiles: [],
        mixinTargets: [],
        classTargets: ["com.terraformersmc.modmenu.ModMenu"],
        resourceTargets: ["assets/modmenu/icon.png"],
        embeddedLibraries: []
      }
    ];

    for (const artifactProfile of artifactProfiles) {
      this.artifactProfiles.set(artifactProfile.versionId, artifactProfile);
    }
  }

  private seedSourceConnectors() {
    const connectors: SourceConnector[] = [
      {
        connectorId: "src_github",
        connectorName: "github",
        sourceType: "github",
        status: "ready",
        trustTier: "maintainer",
        schemaVersion: 1,
        createdAt: now(),
        updatedAt: now()
      },
      {
        connectorId: "src_curseforge",
        connectorName: "curseforge",
        sourceType: "curseforge",
        status: "ready",
        trustTier: "curated",
        schemaVersion: 1,
        createdAt: now(),
        updatedAt: now()
      },
      {
        connectorId: "src_modrinth",
        connectorName: "modrinth",
        sourceType: "modrinth",
        status: "ready",
        trustTier: "community",
        schemaVersion: 1,
        createdAt: now(),
        updatedAt: now()
      },
      {
        connectorId: "src_curated_community",
        connectorName: "curated-community",
        sourceType: "curated_community",
        status: "ready",
        trustTier: "curated",
        schemaVersion: 1,
        createdAt: now(),
        updatedAt: now()
      }
    ];

    for (const connector of connectors) {
      this.sourceConnectors.set(connector.connectorId, connector);
      this.sourceConnectorsByName.set(connector.connectorName, connector);
    }
  }

  private seedModels() {
    const entries: ModelRegistryEntry[] = [
      {
        modelId: "mdl_finding_risk_v1",
        modelKey: "finding-risk-calibrator",
        version: "phase5-deterministic-v1",
        task: "finding_risk_calibration",
        status: "active",
        metrics: {
          validation_precision: 0.81,
          validation_recall: 0.76
        },
        config: {
          evidenceBonus: 0.08,
          primarySubjectBonus: 0.04
        },
        schemaVersion: 1,
        createdAt: now()
      },
      {
        modelId: "mdl_grounded_summary_v1",
        modelKey: "grounded-pack-review",
        version: "phase5-deterministic-v1",
        task: "grounded_summary",
        status: "active",
        metrics: {
          citation_coverage: 1,
          unsupported_claim_rate: 0
        },
        config: {
          maxSections: 3
        },
        schemaVersion: 1,
        createdAt: now()
      }
    ];

    for (const entry of entries) {
      this.modelRegistry.set(entry.modelId, entry);
    }
  }

  private seedSimulationAssets() {
    const createdAt = now();
    const recipes: SmokeTestRecipe[] = [
      {
        recipeId: "rcp_client_startup_v1",
        recipeKey: "client-startup-smoke",
        title: "Client startup smoke test",
        steps: [
          "Launch the pack to main menu",
          "Join a local single-player world",
          "Render common shader and texture paths"
        ],
        successCriteria: [
          "No startup crash",
          "No render transformer conflict",
          "No duplicated resource load failure"
        ],
        schemaVersion: 1,
        createdAt
      }
    ];
    const crashSignatures: CrashSignature[] = [
      {
        crashSignatureId: "crs_optifine_sodium_v1",
        signatureKey: "render-transformer-conflict",
        headline: "Renderer transformer conflict on Fabric client startup",
        pattern: "OptiFine and Sodium attempt incompatible renderer transforms",
        relatedFindingTypes: ["declared_incompatibility", "community_verified_incompatibility"],
        schemaVersion: 1,
        createdAt
      },
      {
        crashSignatureId: "crs_resource_collision_v1",
        signatureKey: "resource-path-collision",
        headline: "Resource path collision during client bootstrap",
        pattern: "Duplicate shader or resource path ownership causes bootstrap failure",
        relatedFindingTypes: ["resource_collision", "mixin_overlap", "class_overlap"],
        schemaVersion: 1,
        createdAt
      }
    ];

    for (const recipe of recipes) {
      this.smokeTestRecipes.set(recipe.recipeId, recipe);
    }
    for (const signature of crashSignatures) {
      this.crashSignatures.set(signature.crashSignatureId, signature);
    }
  }

  private seedOfflineKnowledge() {
    const createdAt = now();
    const snapshotVersion = "knowledge_snapshot_demo_v1";
    const coverageScope: SupportedCoverageScope = {
      coverageScopeId: "cov_demo_v1",
      snapshotVersion,
      status: "high_confidence_coverage",
      supportedMinecraftVersions: ["1.21.1"],
      supportedLoaders: ["fabric"],
      supportedProjectIds: [
        "cp_fabric_api",
        "cp_sodium",
        "cp_lithium",
        "cp_optifine",
        "cp_modmenu"
      ],
      versionFreshnessWindowDays: 30,
      notes: "Initial promoted demo coverage for the seeded Fabric compatibility slice.",
      schemaVersion: 1,
      createdAt
    };
    this.coverageScopes.set(coverageScope.coverageScopeId, coverageScope);
    this.coverageScopesBySnapshotVersion.set(snapshotVersion, coverageScope.coverageScopeId);

    const snapshot: KnowledgeSnapshot = {
      snapshotId: "ks_demo_v1",
      version: snapshotVersion,
      status: "promoted",
      coverageScopeId: coverageScope.coverageScopeId,
      activatedAt: createdAt,
      createdBy: "usr_demo",
      schemaVersion: 1,
      createdAt,
      components: [
        {
          componentType: "catalog",
          recordCount: this.canonicalProjects.size + this.canonicalVersions.size,
          checksum: stableHash({
            projects: [...this.canonicalProjects.keys()].sort(),
            versions: [...this.canonicalVersions.keys()].sort()
          })
        },
        {
          componentType: "promoted_claims",
          recordCount: 1,
          checksum: stableHash("claim_demo_optifine_sodium_conflict")
        },
        {
          componentType: "exact_pack_cache",
          recordCount: 1,
          checksum: stableHash("cache_demo_optifine_sodium_pack")
        },
        {
          componentType: "coverage_scope",
          recordCount: 1,
          checksum: stableHash(coverageScope)
        }
      ]
    };
    this.knowledgeSnapshots.set(snapshot.snapshotId, snapshot);
    this.knowledgeSnapshotsByVersion.set(snapshot.version, snapshot.snapshotId);

    const promotedClaim: PromotedCompatibilityClaim = {
      promotedClaimId: "clm_demo_optifine_sodium_conflict",
      snapshotId: snapshot.snapshotId,
      claimKey: "optifine-sodium-renderer-conflict",
      findingType: "known_incompatible_pair",
      findingVerdict: "confirmed_conflict",
      severity: "critical",
      confidence: {
        score: 0.98,
        band: "very_high",
        explanation:
          "This conflict is backed by verified rules, technical conflict evidence, and promoted snapshot review.",
        primaryDrivers: [
          "Verified incompatibility between OptiFine and Sodium",
          "Structural renderer target overlap detected offline",
          "Promoted snapshot review marked this combination as known incompatible"
        ]
      },
      sourceKinds: ["verified_rule", "technical_signature", "evidence"],
      subjectProjectIds: ["cp_optifine", "cp_sodium"],
      subjectVersionIds: ["ver_optifine_120", "ver_sodium_121"],
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      explanation:
        "OptiFine and Sodium are treated as a known incompatible renderer combination in the promoted knowledge snapshot.",
      evidenceRefs: [
        {
          type: "rule",
          id: "rule_demo_optifine_sodium"
        },
        {
          type: "static_analysis",
          id: "sig_demo_optifine_sodium_renderer"
        }
      ],
      freshnessSummary: "Snapshot refreshed from demo promoted knowledge.",
      schemaVersion: 1,
      createdAt
    };
    this.promotedCompatibilityClaims.set(promotedClaim.promotedClaimId, promotedClaim);
    this.promotedCompatibilityClaimsBySnapshot.set(snapshot.snapshotId, [
      promotedClaim.promotedClaimId
    ]);

    const technicalSignature: TechnicalConflictSignature = {
      technicalConflictSignatureId: "sig_demo_optifine_sodium_renderer",
      signatureKey: "optifine-sodium-worldrenderer-overlap",
      snapshotId: snapshot.snapshotId,
      signatureType: "mixin_overlap",
      projectIds: ["cp_optifine", "cp_sodium"],
      versionIds: ["ver_optifine_120", "ver_sodium_121"],
      targetRef: "net.minecraft.client.render.WorldRenderer",
      confidence: {
        score: 0.93,
        band: "very_high",
        explanation: "Offline artifact analysis found both mods targeting the same rendering path.",
        primaryDrivers: [
          "Shared WorldRenderer target",
          "Conflicting render pipeline modifications"
        ]
      },
      evidenceRefs: [
        {
          type: "static_analysis",
          id: "artifact_optifine_120"
        },
        {
          type: "static_analysis",
          id: "artifact_sodium_121"
        }
      ],
      schemaVersion: 1,
      createdAt
    };
    this.technicalConflictSignatures.set(
      technicalSignature.technicalConflictSignatureId,
      technicalSignature
    );
    this.technicalConflictSignaturesBySnapshot.set(snapshot.snapshotId, [
      technicalSignature.technicalConflictSignatureId
    ]);

    const packFingerprint = stableHash({
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      mods: [
        { projectId: "cp_modmenu", versionId: "ver_modmenu_121", source: "user" },
        { projectId: "cp_optifine", versionId: "ver_optifine_120", source: "user" },
        { projectId: "cp_sodium", versionId: "ver_sodium_121", source: "user" }
      ]
    });
    const exactPackCache: ExactPackAnalysisCacheRecord = {
      exactPackCacheId: "epc_demo_optifine_sodium_pack",
      snapshotId: snapshot.snapshotId,
      packFingerprint,
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      verdict: "known_incompatible",
      confidence: {
        score: 0.98,
        band: "very_high",
        explanation:
          "The pack fingerprint matches a promoted exact-pack cache entry in the active knowledge snapshot.",
        primaryDrivers: [
          "Exact pack fingerprint cache hit",
          "Matching promoted incompatibility claim",
          "Supported Fabric 1.21.1 coverage scope"
        ]
      },
      coverageStatus: "high_confidence_coverage",
      findingIds: [],
      recommendationIds: [],
      explanation:
        "This pack matches a known incompatible combination that was promoted into the active knowledge snapshot.",
      freshnessSummary: "Knowledge snapshot demo_v1",
      schemaVersion: 1,
      createdAt
    };
    this.exactPackAnalysisCache.set(exactPackCache.exactPackCacheId, exactPackCache);
    this.exactPackAnalysisCacheBySnapshot.set(snapshot.snapshotId, [
      exactPackCache.exactPackCacheId
    ]);

    // -----------------------------------------------------------------
    // Pairwise compatibility records
    // -----------------------------------------------------------------
    const pairSodiumLithium: PairwiseCompatibilityRecord = {
      pairwiseCompatibilityId: "pwr_demo_sodium_lithium_compatible",
      snapshotId: snapshot.snapshotId,
      leftProjectId: "cp_sodium",
      leftVersionId: "ver_sodium_121",
      rightProjectId: "cp_lithium",
      rightVersionId: "ver_lithium_121",
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      verdict: "no_known_issue_found",
      confidence: {
        score: 0.91,
        band: "very_high",
        explanation:
          "Sodium and Lithium are from the same author and have been verified compatible across 1.21.x Fabric releases.",
        primaryDrivers: [
          "Same author (JellySquid)",
          "No structural target overlap",
          "Community-verified compatible pair"
        ]
      },
      claimIds: [],
      schemaVersion: 1,
      createdAt
    };

    const pairOptiFineModMenu: PairwiseCompatibilityRecord = {
      pairwiseCompatibilityId: "pwr_demo_optifine_modmenu_incompatible",
      snapshotId: snapshot.snapshotId,
      leftProjectId: "cp_optifine",
      leftVersionId: "ver_optifine_120",
      rightProjectId: "cp_modmenu",
      rightVersionId: "ver_modmenu_121",
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "client"
      },
      verdict: "likely_incompatible",
      confidence: {
        score: 0.78,
        band: "high",
        explanation:
          "OptiFine (Forge 1.20.1) and Mod Menu (Fabric 1.21.1) target different loaders and MC versions; loading together is unsupported.",
        primaryDrivers: [
          "Different loader targets (Forge vs Fabric)",
          "Different Minecraft version targets (1.20.1 vs 1.21.1)",
          "No cross-loader compatibility bridge detected"
        ]
      },
      claimIds: [],
      schemaVersion: 1,
      createdAt
    };

    this.pairwiseCompatibilityRecords.set(
      pairSodiumLithium.pairwiseCompatibilityId,
      pairSodiumLithium
    );
    this.pairwiseCompatibilityRecords.set(
      pairOptiFineModMenu.pairwiseCompatibilityId,
      pairOptiFineModMenu
    );
    this.pairwiseCompatibilityBySnapshot.set(snapshot.snapshotId, [
      pairSodiumLithium.pairwiseCompatibilityId,
      pairOptiFineModMenu.pairwiseCompatibilityId
    ]);

    // -----------------------------------------------------------------
    // Fragment compatibility record — the well-known Fabric performance
    // trio (Fabric API + Sodium + Lithium) is a safe combination
    // -----------------------------------------------------------------
    const fragmentFabricPerf: FragmentCompatibilityRecord = {
      fragmentCompatibilityId: "frag_demo_fabric_perf_trio",
      snapshotId: snapshot.snapshotId,
      fragmentHash: stableHash({
        projectIds: ["cp_fabric_api", "cp_sodium", "cp_lithium"].sort()
      }),
      projectIds: ["cp_fabric_api", "cp_sodium", "cp_lithium"],
      versionIds: ["ver_fabric_api_121", "ver_sodium_121", "ver_lithium_121"],
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      verdict: "no_known_issue_found",
      confidence: {
        score: 0.95,
        band: "very_high",
        explanation:
          "The Fabric API + Sodium + Lithium trio is a well-known, community-validated performance combination for Fabric 1.21.1.",
        primaryDrivers: [
          "Widely deployed performance trio",
          "No structural conflicts in artifact profiles",
          "Covered by promoted snapshot knowledge"
        ]
      },
      claimIds: [],
      schemaVersion: 1,
      createdAt
    };

    this.fragmentCompatibilityRecords.set(
      fragmentFabricPerf.fragmentCompatibilityId,
      fragmentFabricPerf
    );
    this.fragmentCompatibilityBySnapshot.set(snapshot.snapshotId, [
      fragmentFabricPerf.fragmentCompatibilityId
    ]);

    // Update snapshot component list to reflect new knowledge
    snapshot.components.push(
      {
        componentType: "pairwise_matrix",
        recordCount: 2,
        checksum: stableHash([
          pairSodiumLithium.pairwiseCompatibilityId,
          pairOptiFineModMenu.pairwiseCompatibilityId
        ])
      },
      {
        componentType: "fragment_cache",
        recordCount: 1,
        checksum: stableHash(fragmentFabricPerf.fragmentCompatibilityId)
      }
    );
  }
}
