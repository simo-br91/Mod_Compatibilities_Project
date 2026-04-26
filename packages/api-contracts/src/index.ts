import type {
  AnalysisServingMode,
  AnalysisVerdict,
  AnalysisEvent,
  AnalysisEnvironment,
  AnalysisPhase,
  AnalysisMode,
  ArtifactAnalysisResult,
  ConfidenceInput,
  EvidenceRef,
  ExplanationPath,
  FindingSubject,
  FindingProvenance,
  GraphNeighborhood,
  GraphSnapshot,
  Organization,
  OrganizationMembership,
  PackDiff,
  PackImport,
  PackSnapshot,
  Project,
  RawPayloadRecord,
  Reproducibility,
  Recommendation,
  RecommendationBundle,
  RecommendationFeedback,
  RecommendationOutcome,
  RecommendationSet,
  ReportExportFormat,
  OfflineDataset,
  FindingFeatureVector,
  CalibratedFindingScore,
  ConfidenceBand,
  ConfidenceSummary,
  CoverageStatus,
  ExactPackAnalysisCacheRecord,
  PackReviewSummary,
  KnowledgeSnapshot,
  PairwiseCompatibilityRecord,
  PromotedCompatibilityClaim,
  SimulationRun,
  ReleaseGateDecision,
  GitHubInstallationLink,
  StatusCheckResult,
  SupportedCoverageScope,
  TechnicalConflictSignature,
  WebhookRegistration,
  Severity,
  SourceConnector,
  SourceSyncRun,
  EvidenceDocument,
  EvidenceSnippet,
  EvidenceSearchHit,
  EvidenceCurationRecord
} from "@modcompat/domain-models";

export interface SessionResponse {
  token: string;
  user: {
    userId: string;
    email: string;
    displayName: string;
  };
  organization: Organization;
  memberships: OrganizationMembership[];
  workspaces: WorkspaceSummary[];
  projects: ProjectSummary[];
  apiKeys: ApiKeyRecord[];
}

export interface WorkspaceSummary {
  workspaceId: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface ProjectSummary {
  projectId: string;
  workspaceId: string;
  organizationId: string;
  name: string;
  slug: string;
  visibility: Project["visibility"];
  createdAt: string;
}

export interface CreateOrganizationRequest {
  name: string;
  slug: string;
}

export interface CreateMembershipRequest {
  userId: string;
  role: OrganizationMembership["role"];
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: ApiKeyRecord["scopes"];
}

export interface CreateAnalysisRequest {
  trigger: "manual" | "webhook" | "scheduled" | "api";
  analysisMode: AnalysisMode;
  inputRef: {
    type: "pack_snapshot" | "import" | "manifest" | "uploaded_mods";
    id: string;
  };
  environment: AnalysisEnvironment;
  options?: {
    runSimulation?: boolean;
    includeAlternatives?: boolean;
    includeLowConfidence?: boolean;
    compareToSnapshotId?: string;
    baselineAnalysisId?: string;
  };
}

export interface AnalysisSummary {
  analysisId: string;
  projectId: string;
  workspaceId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  trigger: "manual" | "webhook" | "scheduled" | "api";
  analysisMode: AnalysisMode;
  score?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  organizationId?: string;
  packSnapshotId?: string;
  verdict?: AnalysisVerdict;
  confidence?: ConfidenceSummary;
  coverageStatus?: CoverageStatus;
  servingMode?: AnalysisServingMode;
  knowledgeSnapshotVersion?: string;
  explanation?: string;
  counts?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}

export interface Finding {
  findingId: string;
  type: string;
  severity: Severity;
  confidence: number;
  confidenceBand?: ConfidenceBand;
  verdict?: import("@modcompat/domain-models").FindingVerdict;
  reproducibility: Reproducibility;
  title: string;
  summary?: string;
  explanation?: string;
  freshnessSummary?: string;
  coverageStatus?: CoverageStatus;
  knowledgeSnapshotVersion?: string;
  scope?: AnalysisEnvironment;
  evidence: EvidenceRef[];
  subjects: FindingSubject[];
  recommendedActions?: string[];
  provenance?: FindingProvenance[];
  confidenceInputs?: ConfidenceInput[];
  dedupeKey?: string;
}

export interface CreateImportRequest {
  sourceType: "manifest" | "mod_list" | "upload" | "repository";
  sourceRef?: string;
}

export interface ImportDetail extends PackImport {
  snapshot?: PackSnapshot;
}

export interface AnalysisProgressResponse {
  analysis: AnalysisSummary;
  phases: AnalysisPhase[];
  events: AnalysisEvent[];
}

export interface RecommendationsResponse {
  recommendationSetId: string;
  items: Recommendation[];
  bundles?: RecommendationBundle[];
  summary?: RecommendationSet["summary"];
}

export interface RecommendationSetResponse {
  recommendationSet: RecommendationSet;
}

export interface SubmitRecommendationFeedbackRequest {
  feedbackType: RecommendationFeedback["feedbackType"];
  note?: string;
  createdBy: string;
}

export interface RecommendationFeedbackResponse {
  feedback: RecommendationFeedback;
}

export interface RecordRecommendationOutcomeRequest {
  status: RecommendationOutcome["status"];
  appliedRecommendationIds: string[];
  validationSummary: string;
  createdBy: string;
}

export interface RecommendationOutcomeResponse {
  outcome: RecommendationOutcome;
}

export interface AnalysisFeatureDatasetResponse {
  dataset: OfflineDataset;
  featureVectors: FindingFeatureVector[];
  calibratedScores: CalibratedFindingScore[];
}

export interface PackReviewSummaryResponse {
  reviewSummary: PackReviewSummary;
}

export interface SimulationRunResponse {
  simulationRun: SimulationRun;
}

export interface ReleaseGateDecisionResponse {
  releaseGateDecision: ReleaseGateDecision;
}

export interface LinkGitHubInstallationRequest {
  projectId: string;
  repositoryFullName: string;
}

export interface GitHubInstallationLinkResponse {
  installationLink: GitHubInstallationLink;
}

export interface CreateWebhookRequest {
  targetUrl: string;
  eventTypes: string[];
  secret?: string;
}

export interface WebhookResponse {
  webhook: WebhookRegistration;
}

export interface WebhookListResponse {
  items: WebhookRegistration[];
}

export interface WebhookDeliveryListResponse {
  items: WebhookDeliveryAttempt[];
}

export interface StatusCheckResponse {
  statusCheck: StatusCheckResult;
}

export interface AnalysisGraphResponse {
  graph: GraphSnapshot;
}

export interface AnalysisArtifactsResponse {
  items: ArtifactAnalysisResult[];
}

export interface GraphNeighborhoodResponse {
  neighborhood: GraphNeighborhood;
}

export interface ExplanationPathResponse {
  explanation: ExplanationPath;
}

export interface CreatePackDiffRequest {
  baseSnapshotId: string;
  targetSnapshotId: string;
  baselineAnalysisId?: string;
  targetAnalysisId?: string;
}

export interface PackDiffResponse {
  diff: PackDiff;
}

export interface TriggerEvidenceSyncRequest {
  connectorNames?: string[];
}

export interface EvidenceSyncResponse {
  connectors: SourceConnector[];
  runs: SourceSyncRun[];
  rawPayloads: RawPayloadRecord[];
  documents: EvidenceDocument[];
  snippets: EvidenceSnippet[];
}

export interface SearchEvidenceRequest {
  query?: string;
  analysisId?: string;
  findingId?: string;
  projectIds?: string[];
  findingTypes?: string[];
  includeContradicted?: boolean;
  includeSuperseded?: boolean;
  limit?: number;
}

export interface EvidenceSearchResponse {
  total: number;
  hits: EvidenceSearchHit[];
}

export interface FindingEvidenceResponse {
  analysisId: string;
  findingId: string;
  hits: EvidenceSearchHit[];
}

export interface CreateEvidenceCurationRequest {
  title: string;
  findingType: string;
  severity: Severity;
  summary: string;
  subjectProjectIds: string[];
  evidenceDocumentIds: string[];
  evidenceSnippetIds?: string[];
  createdBy: string;
}

export interface EvidenceCurationResponse {
  curation: EvidenceCurationRecord;
}

export interface PromoteVerifiedRuleRequest {
  curationId: string;
  promotedBy: string;
}

export interface PromoteVerifiedRuleResponse {
  curation: EvidenceCurationRecord;
  rule: {
    ruleId: string;
    version: number;
  };
}

export interface AnalysisReport {
  reportId: string;
  analysis: AnalysisSummary;
  knowledgeSnapshot?: KnowledgeSnapshot;
  exactPackCacheHit?: ExactPackAnalysisCacheRecord;
  supportingClaims?: PromotedCompatibilityClaim[];
  supportingPairwiseRecords?: PairwiseCompatibilityRecord[];
  supportingTechnicalSignatures?: TechnicalConflictSignature[];
  coverageScope?: SupportedCoverageScope;
  findings: Finding[];
  recommendationSet?: RecommendationSet;
  recommendations: Recommendation[];
  reviewSummary?: PackReviewSummary;
  simulationRun?: SimulationRun;
  releaseGateDecision?: ReleaseGateDecision;
  statusCheck?: StatusCheckResult;
  decisionSummary: {
    minimalUnblockSummary?: string;
    stabilityFirstSummary?: string;
  };
  feedback: RecommendationFeedback[];
  latestOutcome?: RecommendationOutcome;
}

export interface RetrievalAnalysisResponse {
  analysis: AnalysisSummary;
  findings: Finding[];
  recommendations: Recommendation[];
  knowledgeSnapshot?: KnowledgeSnapshot;
  exactPackCacheHit?: ExactPackAnalysisCacheRecord;
  supportingClaims?: PromotedCompatibilityClaim[];
  supportingPairwiseRecords?: PairwiseCompatibilityRecord[];
  supportingTechnicalSignatures?: TechnicalConflictSignature[];
  coverageScope?: SupportedCoverageScope;
  unresolvedEntries?: Array<{
    name: string;
    version?: string;
    reason: "unresolved_project" | "unresolved_version" | "outside_coverage";
  }>;
  freshnessSummary?: string;
}

export interface ExportResponse {
  format: ReportExportFormat;
  downloadUrl: string;
  content?: string;
}

// ---------------------------------------------------------------------------
// Cross-service transport envelope
// ---------------------------------------------------------------------------

/**
 * Structured error envelope shared by all platform HTTP services.
 * Every service that returns an error must use this shape so gateway and
 * clients can inspect and forward errors uniformly.
 */
export interface ServiceErrorEnvelope {
  error: {
    /** Machine-readable error code. */
    code: string;
    /** Human-readable description. */
    message: string;
    /** Whether the client may safely retry this request. */
    retryable: boolean;
    /** Echo of the x-request-id header for this request. */
    requestId: string;
    /** Echo of the x-trace-id header for this request. */
    traceId: string;
  };
}

/**
 * Standard idempotency replay header name.
 * When a service replays a previously-completed request it must set this
 * response header to "true".
 */
export const IDEMPOTENT_REPLAY_HEADER = "x-idempotent-replay" as const;

/**
 * Standard idempotency key request header name.
 */
export const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key" as const;

// ---------------------------------------------------------------------------
// Phase 12 — Security, tenancy, and platform hardening
// ---------------------------------------------------------------------------

/**
 * RBAC roles available in the platform.
 * - owner: full organization control, billing, member management
 * - admin: all data operations including curation and promotion
 * - analyst: evidence curation, finding review, export
 * - user: read analyses, submit feedback, request imports
 * - api_key: machine identity scoped to explicit permission set
 */
export type RbacRole = "owner" | "admin" | "analyst" | "user" | "api_key";

/**
 * Granular permission identifiers used in RBAC checks.
 */
export type Permission =
  | "analyses:read"
  | "analyses:write"
  | "analyses:cancel"
  | "findings:read"
  | "evidence:read"
  | "evidence:sync"
  | "evidence:curate"
  | "evidence:promote"
  | "recommendations:read"
  | "recommendations:feedback"
  | "recommendations:outcome"
  | "graph:read"
  | "reports:read"
  | "reports:export"
  | "imports:read"
  | "imports:write"
  | "admin:curations"
  | "admin:rules"
  | "org:manage"
  | "projects:read"
  | "projects:write"
  | "webhooks:manage"
  | "apikeys:manage";

/**
 * Audit event types that must be recorded for compliance.
 */
export type AuditEventType =
  | "auth.session_created"
  | "auth.api_key_used"
  | "auth.permission_denied"
  | "import.created"
  | "analysis.created"
  | "analysis.cancelled"
  | "evidence.sync_triggered"
  | "evidence.curation_created"
  | "evidence.rule_promoted"
  | "recommendation.feedback_submitted"
  | "recommendation.outcome_recorded"
  | "report.exported"
  | "webhook.delivered"
  | "webhook.failed"
  | "apikey.created"
  | "apikey.revoked"
  | "org.member_invited"
  | "org.member_removed";

/** Single audit log entry recorded for every sensitive platform operation. */
export interface AuditLogEntry {
  auditId: string;
  eventType: AuditEventType;
  /** Organization scope. */
  organizationId: string;
  /** User or api_key actor identifier. */
  actorId: string;
  actorKind: "user" | "api_key" | "system";
  /** HTTP method + path that triggered the event, if applicable. */
  httpMethod?: string;
  httpPath?: string;
  /** Primary resource affected (entity type + ID). */
  resourceKind?: string;
  resourceId?: string;
  /** Outcome of the operation. */
  outcome: "success" | "failure" | "denied";
  /** Optional machine-readable failure code on non-success outcomes. */
  failureCode?: string;
  /** UTC ISO-8601 timestamp. */
  occurredAt: string;
  /** Arbitrary structured context for the event (kept small). */
  metadata?: Record<string, unknown>;
  requestId?: string;
  traceId?: string;
}

/** Quota plan controlling per-period resource usage. */
export interface QuotaPlan {
  planId: string;
  name: string;
  /** Maximum analyses per rolling 24-hour window. */
  maxAnalysesPerDay: number;
  /** Maximum imports per rolling 24-hour window. */
  maxImportsPerDay: number;
  /** Maximum concurrent analyses allowed. */
  maxConcurrentAnalyses: number;
  /** Maximum evidence sync triggers per hour. */
  maxEvidenceSyncsPerHour: number;
  /** Max export bytes per day (0 = unlimited). */
  maxExportBytesPerDay: number;
}

/** Current usage counters for an organization within a quota window. */
export interface QuotaUsage {
  organizationId: string;
  windowStartsAt: string;
  analysesUsed: number;
  importsUsed: number;
  concurrentAnalyses: number;
  evidenceSyncsUsed: number;
  exportBytesUsed: number;
}

/** Result returned by rate-limit checks. */
export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Total limit for the window. */
  limit: number;
  /** UTC ISO-8601 timestamp when the window resets. */
  resetAt: string;
  /** Retry-After seconds when not allowed. */
  retryAfterSeconds?: number;
}

/** API key record persisted per organization. */
export interface ApiKeyRecord {
  keyId: string;
  organizationId: string;
  name: string;
  /** SHA-256 hex digest of the raw key; the raw value is never stored. */
  keyHash: string;
  /** Key prefix shown in the UI (first 8 chars of the raw key). */
  keyPrefix: string;
  role: RbacRole;
  permissions: Permission[];
  scopes: Permission[];
  /** Whether the key has been revoked. */
  revoked: boolean;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

/** Webhook delivery attempt record. */
export interface WebhookDeliveryAttempt {
  attemptId: string;
  webhookId: string;
  eventType: string;
  payload: string;
  /** HMAC-SHA256 signature of the payload. */
  signature: string;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  attemptNumber: number;
  deliveredAt?: string;
  nextRetryAt?: string;
  createdAt: string;
}

/** Dead-lettered webhook delivery that exhausted all retries. */
export interface WebhookDeadLetter {
  deadLetterId: string;
  webhookId: string;
  eventType: string;
  payload: string;
  totalAttempts: number;
  lastError: string;
  deadLetteredAt: string;
}

/** Upload validation result returned by the hardening layer. */
export interface UploadValidationResult {
  valid: boolean;
  detectedMimeType?: string;
  declaredMimeType?: string;
  fileSizeBytes: number;
  /** Populated when valid is false. */
  rejectionReason?: "mime_mismatch" | "size_exceeded" | "disallowed_type" | "malware_signature";
}

/**
 * Tenant context propagated through every service boundary.
 * All repository and query operations must filter by this context.
 */
export interface TenantContext {
  organizationId: string;
  actorId: string;
  actorKind: "user" | "api_key" | "system";
  role: RbacRole;
  permissions: Permission[];
  requestId: string;
  traceId: string;
}

// HTTP header names for tenant context propagation
export const TENANT_ORG_HEADER = "x-organization-id" as const;
export const TENANT_ACTOR_HEADER = "x-actor-id" as const;
export const TENANT_ROLE_HEADER = "x-actor-role" as const;
export const REQUEST_ID_HEADER = "x-request-id" as const;
export const TRACE_ID_HEADER = "x-trace-id" as const;
