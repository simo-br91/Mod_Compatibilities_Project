import type {
  AnalysisEnvironment,
  ArtifactAnalysisResult,
  ApiKeyRecord,
  ApiKeyScope,
  EvidenceCurationRecord,
  EvidenceDocument,
  EvidenceSearchHit,
  EvidenceSnippet,
  FindingFeatureVector,
  GitHubInstallationLink,
  GraphNeighborhood,
  GraphSnapshot,
  OfflineDataset,
  Organization,
  OrganizationMembership,
  PackDiff,
  PackReviewSummary,
  OrganizationRole,
  PackImport,
  PackModReference,
  PackSnapshot,
  Project,
  CalibratedFindingScore,
  ReleaseGateDecision,
  RecommendationBundle,
  RecommendationFeedback,
  RecommendationOutcome,
  RecommendationSet,
  ReportExportFormat,
  ProjectVisibility,
  RawPayloadRecord,
  Recommendation,
  Reproducibility,
  Severity,
  ExplanationPath,
  SourceConnector,
  SourceSyncRun,
  SmokeTestRecipe,
  StatusCheckResult,
  SimulationRun,
  UserIdentity,
  WebhookDeliveryAttempt,
  WebhookRegistration,
  Workspace
} from "@modcompat/domain-models";
import type {
  AnalysisReport,
  AnalysisSummary,
  CreateWebhookRequest,
  CreateEvidenceCurationRequest,
  CreateAnalysisRequest,
  CreatePackDiffRequest,
  ExportResponse,
  Finding,
  LinkGitHubInstallationRequest,
  RecordRecommendationOutcomeRequest,
  SearchEvidenceRequest,
  SubmitRecommendationFeedbackRequest
} from "@modcompat/api-contracts";

export type DependencyRelation = "required" | "optional" | "embedded";

export interface CanonicalProjectRecord {
  projectId: string;
  slug: string;
  displayName: string;
  aliases: string[];
  recommendedReplacementProjectIds?: string[];
}

export interface CanonicalVersionRecord {
  versionId: string;
  projectId: string;
  versionLabel: string;
  loaders: string[];
  minecraftVersions: string[];
  javaVersions: string[];
  primaryFileDownloadUrl?: string;
  /** ISO 8601 date string from the source registry (Modrinth/CurseForge published date). */
  releaseDate?: string;
}

export interface DependencyRecord {
  versionId: string;
  dependencyProjectId: string;
  relationType: DependencyRelation;
}

export interface IncompatibilityRecord {
  versionId: string;
  incompatibleProjectId: string;
  reason: string;
}

export interface VerifiedRuleDefinition {
  rule_id: string;
  version: number;
  title: string;
  finding_type: string;
  severity: Severity;
  confidence: number;
  reproducibility: Reproducibility;
  summary: string;
  recommended_actions: string[];
  conditions: Array<
    | { type: "project_present"; project_id: string }
    | { type: "loader_is"; loader: string }
    | { type: "minecraft_version_is"; minecraft_version: string }
    | { type: "version_range"; project_id: string; min_version?: string; max_version?: string }
  >;
}

export interface ArtifactProfileRecord {
  artifactId: string;
  versionId: string;
  mixinConfigFiles: string[];
  mixinTargets: string[];
  classTargets: string[];
  resourceTargets: string[];
  embeddedLibraries: Array<{
    coordinates: string;
    packageHints: string[];
  }>;
  packageNamespaces?: string[];
  accessWidenerTargets?: string[];
  accessTransformerTargets?: string[];
  refmapTargets?: string[];
}

export interface Session {
  token: string;
  user: UserIdentity;
  organization: Organization;
  memberships: OrganizationMembership[];
  workspaces: Workspace[];
  projects: Project[];
  apiKeys: ApiKeyRecord[];
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export interface CreateWorkspaceInput {
  organizationId: string;
  name: string;
  slug: string;
}

export interface CreateProjectInput {
  workspaceId: string;
  name: string;
  slug: string;
  visibility?: ProjectVisibility;
}

export interface ManifestImportInput {
  projectId: string;
  manifestFormat: "curseforge" | "modrinth" | "prism";
  manifest: {
    name?: string;
    files?: Array<{
      projectID?: string | number;
      fileID?: string | number;
      slug?: string;
      name?: string;
      version?: string;
    }>;
  };
  environment: AnalysisEnvironment;
  createdBy: string;
}

export interface ModListImportInput {
  projectId: string;
  mods: PackModReference[];
  environment: AnalysisEnvironment;
  createdBy: string;
}

export interface ImportResult {
  importRecord: PackImport;
  snapshot: PackSnapshot;
}

export interface AnalysisResult {
  analysis: AnalysisSummary;
  phases: import("@modcompat/domain-models").AnalysisPhase[];
  events: import("@modcompat/domain-models").AnalysisEvent[];
  findings: Finding[];
  recommendations: Recommendation[];
  recommendationSet?: RecommendationSet;
  featureDataset?: OfflineDataset;
  featureVectors?: FindingFeatureVector[];
  calibratedScores?: CalibratedFindingScore[];
  reviewSummary?: PackReviewSummary;
  simulationRun?: SimulationRun;
  releaseGateDecision?: ReleaseGateDecision;
  statusCheck?: StatusCheckResult;
  artifacts?: ArtifactAnalysisResult[];
  graph?: GraphSnapshot;
  packDiff?: PackDiff;
  report?: AnalysisReport;
}

export interface WebFlowState {
  session: Session;
  importRecord: PackImport;
  snapshot: PackSnapshot;
  analysis: AnalysisSummary;
  phases: import("@modcompat/domain-models").AnalysisPhase[];
  events: import("@modcompat/domain-models").AnalysisEvent[];
  findings: Finding[];
  recommendations: Recommendation[];
  recommendationSet?: RecommendationSet;
  featureDataset?: OfflineDataset;
  featureVectors?: FindingFeatureVector[];
  calibratedScores?: CalibratedFindingScore[];
  reviewSummary?: PackReviewSummary;
  simulationRun?: SimulationRun;
  releaseGateDecision?: ReleaseGateDecision;
  statusCheck?: StatusCheckResult;
  artifacts?: ArtifactAnalysisResult[];
  graph?: GraphSnapshot;
  packDiff?: PackDiff;
  report?: AnalysisReport;
}

export interface AnalysisRecordInternal {
  summary: AnalysisSummary;
  phases: import("@modcompat/domain-models").AnalysisPhase[];
  events: import("@modcompat/domain-models").AnalysisEvent[];
  findings: Finding[];
  recommendations: Recommendation[];
  recommendationSet?: RecommendationSet;
  featureDataset?: OfflineDataset;
  featureVectors: FindingFeatureVector[];
  calibratedScores: CalibratedFindingScore[];
  reviewSummary?: PackReviewSummary;
  simulationRun?: SimulationRun;
  releaseGateDecision?: ReleaseGateDecision;
  statusCheck?: StatusCheckResult;
  artifacts: ArtifactAnalysisResult[];
  graph?: GraphSnapshot;
  explanationPaths: Map<string, ExplanationPath>;
  packDiff?: PackDiff;
  report?: AnalysisReportRecord;
}

export interface CreateApiKeyInput {
  organizationId: string;
  createdBy: string;
  name: string;
  scopes: ApiKeyScope[];
}

export interface CreateMembershipInput {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}

export interface CreateAnalysisInput {
  projectId: string;
  request: CreateAnalysisRequest;
}

export interface CreatePackDiffInput extends CreatePackDiffRequest {
  projectId: string;
}

export interface GraphQueryResult {
  neighborhood: GraphNeighborhood;
  explanation: ExplanationPath;
}

export interface EvidenceFixtureRecord {
  connectorName: "github" | "curated-community";
  externalDocumentId: string;
  kind: "github_issue" | "github_discussion" | "release_note" | "curated_post";
  title: string;
  sourceUrl: string;
  author?: string;
  publishedAt: string;
  updatedAt?: string;
  tags?: string[];
  relatedProjectIds?: string[];
  relatedVersionIds?: string[];
  findingTypes?: string[];
  body: string;
  snippets?: Array<{
    kind: "summary" | "problem_statement" | "reproduction" | "resolution" | "status_update";
    text: string;
  }>;
  relationHints?: Array<{
    type: "duplicate" | "contradicts" | "supersedes";
    targetExternalDocumentId: string;
  }>;
  extractedRelations?: Array<{
    relationType:
      | "incompatible_with"
      | "requires"
      | "recommended_replacement"
      | "supersedes"
      | "contradicts";
    subject: string;
    object: string;
    confidence?: number;
  }>;
}

export interface EvidenceFixtureSet {
  connectors: Array<{
    connectorName: "github" | "curated-community";
    sourceType: "github" | "curated_community";
    trustTier: "official" | "maintainer" | "curated" | "community";
    records: EvidenceFixtureRecord[];
  }>;
}

export interface EvidenceSyncResult {
  connectors: SourceConnector[];
  runs: SourceSyncRun[];
  rawPayloads: RawPayloadRecord[];
  documents: EvidenceDocument[];
  snippets: EvidenceSnippet[];
}

export interface EvidenceSearchResult {
  total: number;
  hits: EvidenceSearchHit[];
}

export interface FindingEvidenceLookup {
  analysisId: string;
  findingId: string;
  hits: EvidenceSearchHit[];
}

export interface CreateEvidenceCurationInput extends CreateEvidenceCurationRequest {}

export interface PromoteVerifiedRuleInput {
  curationId: string;
  promotedBy: string;
}

export interface PromotionResult {
  curation: EvidenceCurationRecord;
  rule: {
    ruleId: string;
    version: number;
  };
}

export interface EvidenceSearchInput extends SearchEvidenceRequest {}

export interface RecommendationGenerationResult {
  recommendationSet: RecommendationSet;
  recommendations: Recommendation[];
  bundles: RecommendationBundle[];
}

export interface SubmitRecommendationFeedbackInput
  extends SubmitRecommendationFeedbackRequest {
  recommendationId: string;
}

export interface RecordRecommendationOutcomeInput
  extends RecordRecommendationOutcomeRequest {
  recommendationSetId: string;
}

export interface AnalysisReportRecord extends AnalysisReport {}

export interface RiskScoringResult {
  findings: Finding[];
  dataset: OfflineDataset;
  featureVectors: FindingFeatureVector[];
  calibratedScores: CalibratedFindingScore[];
}

export interface ExportAnalysisReportInput {
  analysisId: string;
  format: ReportExportFormat;
}

export interface ExportAnalysisReportResult extends ExportResponse {}

export interface LinkGitHubInstallationInput extends LinkGitHubInstallationRequest {
  installationId: string;
}

export interface CreateWebhookInput extends CreateWebhookRequest {}

export interface SimulationFixtureSet {
  recipes: Array<{
    recipeKey: string;
    title: string;
    steps: string[];
    successCriteria: string[];
  }>;
  crashSignatures: Array<{
    signatureKey: string;
    headline: string;
    pattern: string;
    relatedFindingTypes: string[];
  }>;
}

export interface SimulationResult {
  findings: Finding[];
  simulationRun: SimulationRun;
}

export interface ReleaseGateResult {
  releaseGateDecision: ReleaseGateDecision;
}
