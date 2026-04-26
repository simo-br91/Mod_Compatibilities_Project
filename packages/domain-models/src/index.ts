export type Loader = "forge" | "fabric" | "quilt" | "neoforge" | "unknown";
export type Side = "client" | "server" | "both";
export type AnalysisMode = "fast" | "standard" | "deep";
export type AnalysisStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Reproducibility =
  | "confirmed"
  | "likely"
  | "intermittent"
  | "not_tested";
export type OrganizationRole = "owner" | "admin" | "member" | "viewer";
export type ProjectVisibility = "private" | "organization" | "public";
export type ApiKeyScope =
  | "workspace:read"
  | "workspace:write"
  | "project:read"
  | "project:write"
  | "analysis:read"
  | "analysis:write";
export type ImportSourceType =
  | "manifest"
  | "mod_list"
  | "upload"
  | "repository";
export type ImportStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";
export type AnalysisPhaseName =
  | "normalization"
  | "resolution"
  | "static_analysis"
  | "graph_enrichment"
  | "merge_findings"
  | "evidence_enrichment"
  | "risk_scoring"
  | "simulation"
  | "pack_diff"
  | "rule_evaluation"
  | "recommendation"
  | "release_gating"
  | "reporting";
export type RecommendationKind =
  | "replacement"
  | "bundle"
  | "remediation_plan";
export type MigrationCost = "low" | "medium" | "high" | "unknown";
export type RecommendationStatus =
  | "proposed"
  | "accepted"
  | "dismissed"
  | "applied";
export type RecommendationFeedbackType =
  | "accepted"
  | "dismissed"
  | "helpful"
  | "not_helpful";
export type RecommendationOutcomeStatus =
  | "pending"
  | "validated"
  | "rejected"
  | "deferred";
export type RecommendationBundleStrategy =
  | "minimal_unblock"
  | "stability_first";
export type ReportExportFormat = "json" | "markdown";
export type FeatureValueType = "number" | "boolean" | "categorical";
export type SimulationRunStatus = "completed" | "failed";
export type GroundTruthCandidateStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped";
export type GroundTruthRunStatus = "completed" | "failed" | "timed_out";
export type GroundTruthVerdict =
  | "passed_startup_and_world"
  | "failed_startup"
  | "failed_world_load"
  | "timed_out"
  | "inconclusive";
export type GroundTruthKnowledgeSnapshotStatus = "draft" | "promoted";
export type ReleaseGateStatus = "pass" | "warn" | "block";
export type WebhookStatus = "active" | "paused";
export type DeliveryStatus = "pending" | "delivered";
export type AnalysisVerdict =
  | "known_incompatible"
  | "likely_incompatible"
  | "mixed_or_conditional"
  | "no_known_issue_found"
  | "insufficient_evidence";
export type FindingVerdict =
  | "confirmed_conflict"
  | "confirmed_requirement_gap"
  | "confirmed_environment_mismatch"
  | "reported_conflict"
  | "inferred_technical_risk"
  | "reported_fixed_in_later_version"
  | "unknown";
export type ConfidenceBand =
  | "very_high"
  | "high"
  | "medium"
  | "low"
  | "very_low";
export type CoverageStatus =
  | "high_confidence_coverage"
  | "best_effort_coverage"
  | "outside_validated_coverage";
export type AnalysisServingMode =
  | "snapshot_exact_pack"
  | "snapshot_retrieval_assembly"
  | "legacy_live_analysis"
  | "offline_benchmark";
export type AnalysisEventType =
  | "analysis.queued"
  | "analysis.started"
  | "analysis.phase.completed"
  | "analysis.finding.emitted"
  | "analysis.completed"
  | "analysis.failed";

export interface TenantScopedRecord {
  tenantId?: string;
  traceId?: string;
  schemaVersion: number;
}

export interface AnalysisEnvironment {
  minecraftVersion: string;
  loader: Loader;
  loaderVersion?: string;
  javaVersion: string;
  side: Side;
}

export interface InputRef {
  type: "pack_snapshot" | "import" | "manifest" | "uploaded_mods";
  id: string;
}

export interface AnalysisOptions {
  runSimulation?: boolean;
  includeAlternatives?: boolean;
  includeLowConfidence?: boolean;
}

export interface FindingSubject {
  projectId: string;
  versionId?: string;
  relation?: "primary" | "secondary" | "alternative" | "environment";
}

export interface EvidenceRef {
  type:
    | "rule"
    | "issue"
    | "discussion"
    | "evidence_document"
    | "evidence_snippet"
    | "simulation"
    | "model"
    | "static_analysis"
    | "graph"
    | "ground_truth"
    | "catalog";
  id: string;
  snippetId?: string;
}

export interface FindingProvenance {
  kind:
    | "resolver"
    | "verified_rule"
    | "static_analysis"
    | "graph"
    | "ground_truth"
    | "diff"
    | "evidence";
  sourceId: string;
  sourceType: string;
  version?: string;
  note?: string;
}

export interface ConfidenceInput {
  source:
    | "resolver"
    | "verified_rule"
    | "static_analysis"
    | "graph"
    | "ground_truth"
    | "diff"
    | "evidence";
  value: number;
  weight: number;
  rationale: string;
}

export type TrustTier = "official" | "maintainer" | "curated" | "community";
export type ConnectorStatus = "ready" | "syncing" | "degraded";
export type SyncRunStatus = "queued" | "running" | "completed" | "failed";
export type EvidenceDocumentKind =
  | "github_issue"
  | "github_discussion"
  | "release_note"
  | "curated_post";
export type EvidenceSnippetKind =
  | "summary"
  | "problem_statement"
  | "reproduction"
  | "resolution"
  | "status_update";
export type EvidenceRelevance =
  | "direct"
  | "supporting"
  | "background"
  | "irrelevant";
export type EvidenceStance = "supports" | "contradicts" | "neutral";
export type EvidenceRelationType =
  | "incompatible_with"
  | "requires"
  | "recommended_replacement"
  | "supersedes"
  | "contradicts";

export interface SourceConnector extends TenantScopedRecord {
  connectorId: string;
  connectorName: string;
  sourceType: "github" | "curated_community" | "curseforge" | "modrinth";
  status: ConnectorStatus;
  trustTier: TrustTier;
  /** ISO timestamp of the last successfully completed sync run. */
  lastSyncAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceSyncRun extends TenantScopedRecord {
  syncRunId: string;
  connectorId: string;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt?: string;
  checkpoint?: Record<string, unknown>;
  stats: {
    rawPayloadCount: number;
    documentCount: number;
    snippetCount: number;
    contradictionCount: number;
    supersessionCount: number;
  };
  createdAt: string;
}

export interface RawPayloadRecord extends TenantScopedRecord {
  rawPayloadId: string;
  connectorId: string;
  syncRunId: string;
  externalDocumentId: string;
  contentType: string;
  checksum: string;
  body: Record<string, unknown>;
  fetchedAt: string;
  createdAt: string;
}

export interface EvidenceTrust {
  tier: TrustTier;
  score: number;
  signals: string[];
}

export interface ExtractedEntity {
  entityType: "project" | "version" | "loader" | "minecraft_version";
  value: string;
  confidence: number;
}

export interface ExtractedRelation {
  relationType: EvidenceRelationType;
  subject: string;
  object: string;
  confidence: number;
}

export interface EvidenceRelation {
  relationType: "duplicate" | "contradicts" | "supersedes";
  targetDocumentId: string;
}

export interface EvidenceDocument extends TenantScopedRecord {
  documentId: string;
  connectorId: string;
  syncRunId: string;
  rawPayloadId: string;
  externalDocumentId: string;
  kind: EvidenceDocumentKind;
  title: string;
  sourceUrl: string;
  author?: string;
  publishedAt: string;
  updatedAt?: string;
  harvestedAt: string;
  trust: EvidenceTrust;
  recencyScore: number;
  relevance: EvidenceRelevance;
  stance: EvidenceStance;
  summary: string;
  content: string;
  tags: string[];
  relatedProjectIds: string[];
  relatedVersionIds: string[];
  findingTypes: string[];
  extractedEntities: ExtractedEntity[];
  extractedRelations: ExtractedRelation[];
  provenance: {
    connectorName: string;
    syncRunId: string;
    externalDocumentId: string;
    rawPayloadId: string;
  };
  clusterId: string;
  duplicateDocumentIds: string[];
  contradictedByDocumentIds: string[];
  supersededByDocumentId?: string;
  createdAt: string;
}

export interface EvidenceSnippet extends TenantScopedRecord {
  snippetId: string;
  documentId: string;
  kind: EvidenceSnippetKind;
  text: string;
  textHash: string;
  relevance: EvidenceRelevance;
  stance: EvidenceStance;
  trustScore: number;
  relatedProjectIds: string[];
  relatedVersionIds: string[];
  extractedEntities: ExtractedEntity[];
  extractedRelations: ExtractedRelation[];
  contradictionDocumentIds: string[];
  supersededByDocumentId?: string;
  createdAt: string;
}

export interface EvidenceSearchDocument {
  index: "evidence-documents" | "evidence-snippets";
  id: string;
  documentId: string;
  snippetId?: string;
  title: string;
  text: string;
  connectorId: string;
  trustTier: TrustTier;
  trustScore: number;
  recencyScore: number;
  relevance: EvidenceRelevance;
  stance: EvidenceStance;
  findingTypes: string[];
  relatedProjectIds: string[];
  relatedVersionIds: string[];
  clusterId: string;
  contradictedByDocumentIds: string[];
  supersededByDocumentId?: string;
  sourceUrl: string;
  publishedAt: string;
}

export interface EvidenceSearchHit {
  score: number;
  document: EvidenceSearchDocument;
}

export interface EvidenceCurationRecord extends TenantScopedRecord {
  curationId: string;
  title: string;
  findingType: string;
  severity: Severity;
  summary: string;
  subjectProjectIds: string[];
  evidenceDocumentIds: string[];
  evidenceSnippetIds: string[];
  ruleDraft: Record<string, unknown>;
  status: "draft" | "promoted";
  createdBy: string;
  promotedRuleId?: string;
  createdAt: string;
  promotedAt?: string;
}

export interface Organization extends TenantScopedRecord {
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface UserIdentity extends TenantScopedRecord {
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface OrganizationMembership extends TenantScopedRecord {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: string;
}

export interface Workspace extends TenantScopedRecord {
  workspaceId: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Project extends TenantScopedRecord {
  projectId: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  slug: string;
  visibility: ProjectVisibility;
  createdAt: string;
}

export interface ApiKeyRecord extends TenantScopedRecord {
  apiKeyId: string;
  organizationId: string;
  createdBy: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface PackModReference {
  name: string;
  version?: string;
  source?: string;
  sourceProjectId?: string;
  sourceVersionId?: string;
}

export interface ResolvedPackMod extends PackModReference {
  canonicalProjectId?: string;
  canonicalVersionId?: string;
  resolutionMethod:
    | "source_mapping"
    | "slug_match"
    | "alias_match"
    | "unresolved";
  confidence: number;
}

export interface PackImport extends TenantScopedRecord {
  importId: string;
  projectId: string;
  organizationId: string;
  sourceType: ImportSourceType;
  status: ImportStatus;
  sourceRef?: string;
  packSnapshotId?: string;
  environment?: AnalysisEnvironment;
  createdAt: string;
  completedAt?: string;
}

export interface PackSnapshot extends TenantScopedRecord {
  packSnapshotId: string;
  projectId: string;
  organizationId: string;
  sourceType: ImportSourceType;
  normalizedHash: string;
  environment: AnalysisEnvironment;
  mods: ResolvedPackMod[];
  sourceRef?: string;
  sourcePayloadUri?: string;
  createdBy?: string;
  createdAt: string;
}

export interface AnalysisCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface ConfidenceSummary {
  score: number;
  band: ConfidenceBand;
  explanation: string;
  primaryDrivers: string[];
}

export interface AnalysisPhase extends TenantScopedRecord {
  phaseId: string;
  analysisId: string;
  phaseName: AnalysisPhaseName;
  status: "completed" | "skipped" | "failed";
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  artifacts?: Array<{ type: string; id: string }>;
}

export interface AnalysisEvent extends TenantScopedRecord {
  eventId: string;
  analysisId: string;
  eventType: AnalysisEventType;
  message: string;
  occurredAt: string;
  phaseName?: AnalysisPhaseName;
  payload?: Record<string, unknown>;
}

export interface Recommendation {
  recommendationId: string;
  kind: RecommendationKind;
  rank: number;
  confidence: number;
  summary: string;
  rationale?: string;
  status?: RecommendationStatus;
  findingIds?: string[];
  evidence?: EvidenceRef[];
  replacesSubjects?: FindingSubject[];
  candidateProjects?: FindingSubject[];
  migrationCost?: MigrationCost;
  expectedCompatibilityGain?: number;
  impacts?: RecommendationImpact[];
  steps?: RecommendationStep[];
}

export interface RecommendationImpact {
  impactType:
    | "compatibility_gain"
    | "stability_gain"
    | "performance_gain"
    | "migration_effort";
  score: number;
  summary: string;
}

export interface RecommendationStep {
  stepId: string;
  action:
    | "remove_mod"
    | "add_mod"
    | "replace_mod"
    | "pin_version"
    | "verify_pack"
    | "retest_finding";
  projectId?: string;
  versionId?: string;
  summary: string;
}

export interface RecommendationBundle extends TenantScopedRecord {
  bundleId: string;
  recommendationSetId: string;
  strategy: RecommendationBundleStrategy;
  recommendationIds: string[];
  summary: string;
  rationale: string;
  migrationCost: MigrationCost;
  expectedCompatibilityGain: number;
  createdAt: string;
}

export interface RecommendationSet extends TenantScopedRecord {
  recommendationSetId: string;
  analysisId: string;
  generationStrategy: string;
  items: Recommendation[];
  bundles: RecommendationBundle[];
  summary: {
    recommendationCount: number;
    bundleCount: number;
    unresolvedFindingCount: number;
    minimalUnblockBundleId?: string;
    stabilityFirstBundleId?: string;
  };
  createdAt: string;
}

export interface RecommendationFeedback extends TenantScopedRecord {
  feedbackId: string;
  recommendationSetId: string;
  recommendationId: string;
  feedbackType: RecommendationFeedbackType;
  note?: string;
  createdBy: string;
  createdAt: string;
}

export interface RecommendationOutcome extends TenantScopedRecord {
  outcomeId: string;
  recommendationSetId: string;
  status: RecommendationOutcomeStatus;
  appliedRecommendationIds: string[];
  validationSummary: string;
  createdBy: string;
  createdAt: string;
}

export interface FeatureValue {
  featureName: string;
  valueType: FeatureValueType;
  numericValue?: number;
  booleanValue?: boolean;
  categoricalValue?: string;
}

export interface FindingFeatureVector extends TenantScopedRecord {
  featureVectorId: string;
  analysisId: string;
  findingId: string;
  featureNamespace: "finding_risk_v1";
  featureValues: FeatureValue[];
  label?: "confirmed_risk" | "likely_risk" | "low_risk";
  createdAt: string;
}

export interface OfflineDataset extends TenantScopedRecord {
  datasetId: string;
  analysisId: string;
  datasetKind: "finding_risk_training" | "recommendation_ranking_eval";
  featureVectorIds: string[];
  summary: {
    rowCount: number;
    labeledRowCount: number;
    featureNamespaces: string[];
  };
  createdAt: string;
}

export interface ModelRegistryEntry extends TenantScopedRecord {
  modelId: string;
  modelKey: string;
  version: string;
  task: "finding_risk_calibration" | "grounded_summary";
  status: "shadow" | "active" | "rollback_ready";
  metrics: Record<string, number>;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface CalibratedFindingScore extends TenantScopedRecord {
  calibratedFindingScoreId: string;
  analysisId: string;
  findingId: string;
  modelId: string;
  originalConfidence: number;
  calibratedConfidence: number;
  predictedRiskScore: number;
  rationale: string[];
  createdAt: string;
}

export interface GroundedCitation {
  citationId: string;
  citationType: "finding" | "evidence_document" | "evidence_snippet" | "recommendation";
  targetId: string;
}

export interface GroundedSummarySection {
  sectionId: string;
  title: string;
  body: string;
  citations: GroundedCitation[];
}

export interface PackReviewSummary extends TenantScopedRecord {
  reviewSummaryId: string;
  analysisId: string;
  modelId: string;
  headline: string;
  overview: string;
  sections: GroundedSummarySection[];
  createdAt: string;
}

export interface SmokeTestRecipe extends TenantScopedRecord {
  recipeId: string;
  recipeKey: string;
  title: string;
  steps: string[];
  successCriteria: string[];
  createdAt: string;
}

export interface CrashSignature extends TenantScopedRecord {
  crashSignatureId: string;
  signatureKey: string;
  headline: string;
  pattern: string;
  relatedFindingTypes: string[];
  createdAt: string;
}

export interface SimulationObservation {
  observationId: string;
  kind: "startup" | "crash_signature" | "resource_pressure" | "smoke_test";
  status: "passed" | "failed";
  summary: string;
  findingTypes: string[];
  crashSignatureId?: string;
}

export interface SimulationRun extends TenantScopedRecord {
  simulationRunId: string;
  analysisId: string;
  packSnapshotId: string;
  recipeId: string;
  status: SimulationRunStatus;
  summary: string;
  observations: SimulationObservation[];
  createdAt: string;
}

export interface GroundTruthObservation {
  observationId: string;
  kind: "process" | "startup" | "world_load" | "crash_report" | "log_hint";
  status: "info" | "passed" | "failed";
  summary: string;
}

export interface GroundTruthCandidate extends TenantScopedRecord {
  candidateId: string;
  candidateKind: "pack_snapshot";
  packSnapshotId: string;
  packFingerprint: string;
  environment: AnalysisEnvironment;
  dedupeKey: string;
  executionProfileKey: string;
  discoveredFrom?: string;
  status: GroundTruthCandidateStatus;
  priority: number;
  attempts: number;
  latestRunId?: string;
  latestVerdict?: GroundTruthVerdict;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface GroundTruthRun extends TenantScopedRecord {
  groundTruthRunId: string;
  candidateId: string;
  packSnapshotId: string;
  packFingerprint: string;
  environment: AnalysisEnvironment;
  executionProfileKey: string;
  status: GroundTruthRunStatus;
  verdict: GroundTruthVerdict;
  reachedMainMenu: boolean;
  reachedWorld: boolean;
  exitCode?: number;
  durationMs: number;
  summary: string;
  observations: GroundTruthObservation[];
  stdoutText?: string;
  stderrText?: string;
  artifactDirectory?: string;
  rawResult?: Record<string, unknown>;
  createdAt: string;
}

export interface GroundTruthExactPackRecord extends TenantScopedRecord {
  groundTruthExactPackRecordId: string;
  groundTruthSnapshotId?: string;
  packFingerprint: string;
  packSnapshotId: string;
  environment: AnalysisEnvironment;
  executionProfileKey: string;
  verdict: GroundTruthVerdict;
  confidence: ConfidenceSummary;
  runIds: string[];
  latestRunId: string;
  summary: string;
  reproducibilityScore: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroundTruthKnowledgeSnapshot extends TenantScopedRecord {
  groundTruthSnapshotId: string;
  version: string;
  status: GroundTruthKnowledgeSnapshotStatus;
  recordCount: number;
  includedRecordIds: string[];
  checksums: Record<string, string>;
  createdBy?: string;
  activatedAt?: string;
  createdAt: string;
}

export interface ReleaseGateDecision extends TenantScopedRecord {
  releaseGateDecisionId: string;
  analysisId: string;
  policyKey: string;
  status: ReleaseGateStatus;
  summary: string;
  reasons: string[];
  blockingFindingIds: string[];
  simulationRunId?: string;
  createdAt: string;
}

export interface GitHubInstallationLink extends TenantScopedRecord {
  installationLinkId: string;
  installationId: string;
  projectId: string;
  repositoryFullName: string;
  status: "linked";
  createdAt: string;
}

export interface WebhookRegistration extends TenantScopedRecord {
  webhookId: string;
  targetUrl: string;
  eventTypes: string[];
  status: WebhookStatus;
  secretHint?: string;
  createdAt: string;
}

export interface WebhookDeliveryAttempt extends TenantScopedRecord {
  deliveryId: string;
  webhookId: string;
  analysisId: string;
  eventType: string;
  status: DeliveryStatus;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StatusCheckResult extends TenantScopedRecord {
  statusCheckId: string;
  analysisId: string;
  installationId?: string;
  conclusion: "success" | "neutral" | "failure";
  summary: string;
  detailsUrl: string;
  createdAt: string;
}

export interface SupportedCoverageScope extends TenantScopedRecord {
  coverageScopeId: string;
  snapshotVersion: string;
  status: CoverageStatus;
  supportedMinecraftVersions: string[];
  supportedLoaders: Loader[];
  supportedProjectIds: string[];
  versionFreshnessWindowDays: number;
  notes?: string;
  createdAt: string;
}

export interface KnowledgeSnapshotComponent {
  componentType:
    | "catalog"
    | "verified_rules"
    | "promoted_claims"
    | "technical_signatures"
    | "pairwise_matrix"
    | "fragment_cache"
    | "exact_pack_cache"
    | "coverage_scope";
  recordCount: number;
  checksum: string;
}

export interface KnowledgeSnapshot extends TenantScopedRecord {
  snapshotId: string;
  version: string;
  status: "draft" | "validated" | "approved" | "promoted" | "rolled_back";
  coverageScopeId?: string;
  validationReportId?: string;
  activatedAt?: string;
  createdBy?: string;
  createdAt: string;
  components: KnowledgeSnapshotComponent[];
}

export interface SnapshotValidationReport extends TenantScopedRecord {
  validationReportId: string;
  snapshotId: string;
  status: "passed" | "failed";
  checks: Array<{
    code: string;
    status: "passed" | "failed";
    summary: string;
  }>;
  createdAt: string;
}

export interface SnapshotPromotionEvent extends TenantScopedRecord {
  promotionEventId: string;
  snapshotId: string;
  action: "approved" | "promoted" | "rolled_back";
  actorId: string;
  note?: string;
  createdAt: string;
}

export interface PromotedCompatibilityClaim extends TenantScopedRecord {
  promotedClaimId: string;
  snapshotId: string;
  claimKey: string;
  findingType: string;
  findingVerdict: FindingVerdict;
  severity: Severity;
  confidence: ConfidenceSummary;
  sourceKinds: Array<"verified_rule" | "evidence" | "technical_signature" | "catalog">;
  subjectProjectIds: string[];
  subjectVersionIds: string[];
  environment?: AnalysisEnvironment;
  explanation: string;
  evidenceRefs: EvidenceRef[];
  freshnessSummary?: string;
  createdAt: string;
}

export interface TechnicalConflictSignature extends TenantScopedRecord {
  technicalConflictSignatureId: string;
  signatureKey: string;
  snapshotId?: string;
  signatureType:
    | "mixin_overlap"
    | "class_overlap"
    | "resource_overlap"
    | "embedded_library_divergence"
    | "package_namespace_conflict"
    | "other_structural_risk";
  projectIds: string[];
  versionIds: string[];
  targetRef?: string;
  packageHint?: string;
  confidence: ConfidenceSummary;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
}

export interface PairwiseCompatibilityRecord extends TenantScopedRecord {
  pairwiseCompatibilityId: string;
  snapshotId: string;
  leftProjectId: string;
  leftVersionId?: string;
  rightProjectId: string;
  rightVersionId?: string;
  environment?: AnalysisEnvironment;
  verdict: AnalysisVerdict;
  confidence: ConfidenceSummary;
  claimIds: string[];
  recommendationIds?: string[];
  createdAt: string;
}

export interface FragmentCompatibilityRecord extends TenantScopedRecord {
  fragmentCompatibilityId: string;
  snapshotId: string;
  fragmentHash: string;
  projectIds: string[];
  versionIds: string[];
  environment?: AnalysisEnvironment;
  verdict: AnalysisVerdict;
  confidence: ConfidenceSummary;
  claimIds: string[];
  createdAt: string;
}

export interface PackBenchmarkResult extends TenantScopedRecord {
  packBenchmarkResultId: string;
  snapshotId: string;
  benchmarkKey: string;
  packFingerprint: string;
  environment: AnalysisEnvironment;
  verdict: AnalysisVerdict;
  confidence: ConfidenceSummary;
  findingIds: string[];
  createdAt: string;
}

export interface ExactPackAnalysisCacheRecord extends TenantScopedRecord {
  exactPackCacheId: string;
  snapshotId: string;
  packFingerprint: string;
  environment: AnalysisEnvironment;
  verdict: AnalysisVerdict;
  confidence: ConfidenceSummary;
  coverageStatus: CoverageStatus;
  findingIds: string[];
  recommendationIds: string[];
  explanation: string;
  freshnessSummary?: string;
  createdAt: string;
}

export interface ArtifactMetadata {
  artifactId: string;
  name: string;
  version?: string;
  loaderHints: string[];
  mixinConfigFiles: string[];
}

export interface TargetDescriptor {
  ownerArtifactId: string;
  target: string;
}

export interface EmbeddedLibrary {
  ownerArtifactId: string;
  coordinates: string;
  packageHints: string[];
}

export interface ArtifactAnalysisResult extends TenantScopedRecord {
  artifactAnalysisId: string;
  analysisId: string;
  packSnapshotId: string;
  projectId: string;
  versionId?: string;
  metadata: ArtifactMetadata;
  classTargets: TargetDescriptor[];
  resourceTargets: TargetDescriptor[];
  mixinTargets: TargetDescriptor[];
  embeddedLibraries: EmbeddedLibrary[];
  fingerprint: string;
  createdAt: string;
}

export interface GraphNode {
  nodeId: string;
  nodeType: string;
  label: string;
  analysisId: string;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  edgeId: string;
  analysisId: string;
  edgeType: string;
  sourceId: string;
  targetId: string;
  weight?: number;
  properties?: Record<string, unknown>;
}

export interface GraphSnapshot extends TenantScopedRecord {
  graphId: string;
  analysisId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  createdAt: string;
}

export interface ExplanationPath {
  pathId: string;
  analysisId: string;
  findingId: string;
  summary: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  createdAt: string;
}

export interface GraphNeighborhood {
  analysisId: string;
  centerNodeId: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PackDiffChange {
  changeType:
    | "mod_added"
    | "mod_removed"
    | "version_changed"
    | "environment_changed"
    | "finding_added"
    | "finding_resolved";
  projectId?: string;
  before?: string;
  after?: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Rule draft, versioning, and promotion
// ---------------------------------------------------------------------------

export type RuleDraftStatus = "draft" | "validated" | "promoted" | "rejected";

/** A rule condition as stored in a draft (mirrors VerifiedRuleDefinition conditions). */
export type RuleDraftCondition =
  | { type: "project_present"; project_id: string }
  | { type: "loader_is"; loader: string }
  | { type: "minecraft_version_is"; minecraft_version: string }
  | { type: "version_range"; project_id: string; min_version?: string; max_version?: string };

/** A draft of a verified rule before it passes validation and promotion. */
export interface RuleDraftRecord extends TenantScopedRecord {
  draftId: string;
  /** The stable rule ID this draft targets. Auto-assigned on first draft; reused for new versions. */
  ruleId: string;
  /** Monotonically increasing version number within the rule's lifecycle. */
  version: number;
  title: string;
  findingType: string;
  severity: Severity;
  confidence: number;
  reproducibility: Reproducibility;
  summary: string;
  recommendedActions: string[];
  conditions: RuleDraftCondition[];
  status: RuleDraftStatus;
  /** Populated when status is "rejected" or "validated" (if errors found). */
  validationErrors?: string[];
  createdBy: string;
  promotedAt?: string;
  createdAt: string;
}

/** One entry in a rule's version history. */
export interface RuleVersionHistoryEntry {
  ruleId: string;
  version: number;
  draftId: string;
  promotedBy: string;
  promotedAt: string;
  /** Human-readable summary of what changed in this version. */
  changeNote?: string;
}

// ---------------------------------------------------------------------------
// Model evaluation and feedback signal aggregation
// ---------------------------------------------------------------------------

/** Offline evaluation metrics for a specific model version against a dataset. */
export interface ModelEvaluationRecord extends TenantScopedRecord {
  evaluationId: string;
  modelId: string;
  datasetId: string;
  metrics: {
    precision: number;
    recall: number;
    f1: number;
    auc?: number;
    /** Mean absolute error between original and calibrated confidence. */
    calibrationError?: number;
  };
  sampleCount: number;
  evaluatedAt: string;
}

/** Aggregated feedback signal report derived from recommendation feedback and outcomes. */
export interface FeedbackSignalReport {
  reportId: string;
  generatedAt: string;
  analysisCount: number;
  totalFeedbackItems: number;
  totalOutcomes: number;
  /** Fraction of recommendations that received "accepted" feedback. */
  overallAcceptanceRate: number;
  /** Fraction of outcome sets with status "validated". */
  overallValidationRate: number;
  /** Per-recommendation-kind acceptance breakdown. */
  acceptanceByKind: Record<string, { accepted: number; dismissed: number; rate: number }>;
  /** Confidence accuracy: how well calibrated scores predicted actual outcomes. */
  confidenceAccuracy?: number;
}

/** A single item-level failure recorded during a connector sync run. */
export interface EvidenceIngestionError extends TenantScopedRecord {
  errorId: string;
  connectorId: string;
  syncRunId: string;
  /** External document ID that caused the failure, if known. */
  externalDocumentId?: string;
  errorCode: string;
  message: string;
  /** Partial raw payload that triggered the error, for debugging. */
  rawPayload?: Record<string, unknown>;
  /** Whether retrying the same item on the next sync run may succeed. */
  retryable: boolean;
  occurredAt: string;
}

/** Per-connector sync cadence and quota budget configuration. */
export interface ConnectorSyncSchedule {
  connectorId: string;
  /** How often to trigger a sync, in minutes. */
  cadenceMinutes: number;
  /** Maximum items to fetch per sync run (quota budget). */
  maxItemsPerRun: number;
  /** ISO timestamp of the last sync attempt (started, regardless of outcome). */
  lastAttemptAt?: string;
  /** ISO timestamp when the next sync is due. */
  nextDueAt?: string;
}

export interface PackDiff extends TenantScopedRecord {
  packDiffId: string;
  projectId: string;
  baseSnapshotId: string;
  targetSnapshotId: string;
  baselineAnalysisId?: string;
  targetAnalysisId?: string;
  summary: {
    addedMods: number;
    removedMods: number;
    changedVersions: number;
    findingAdds: number;
    findingResolutions: number;
  };
  changes: PackDiffChange[];
  createdAt: string;
}
