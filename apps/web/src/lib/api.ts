/**
 * Gateway API client for the web application.
 *
 * All requests go to the gateway at NEXT_PUBLIC_GATEWAY_URL (default: http://localhost:8080).
 * Authentication is cookie-backed so browser JavaScript does not need to
 * persist the session JWT locally.
 */

import type {
  AnalysisSummary,
  AnalysisProgressResponse,
  CreatePackDiffRequest,
  CreateAnalysisRequest,
  CreateImportRequest,
  EvidenceSyncResponse,
  EvidenceSearchResponse,
  FindingEvidenceResponse,
  RecommendationsResponse,
  RecommendationFeedbackResponse,
  RecommendationOutcomeResponse,
  SimulationRunResponse,
  ReleaseGateDecisionResponse,
  PackReviewSummaryResponse,
  AnalysisReport,
  ExportResponse,
  CreateEvidenceCurationRequest,
  EvidenceCurationResponse,
  PromoteVerifiedRuleRequest,
  PromoteVerifiedRuleResponse,
  AnalysisGraphResponse,
  GraphNeighborhoodResponse,
  ExplanationPathResponse,
  FindingEvidenceResponse as FindingEvidenceResult,
  Finding,
  SubmitRecommendationFeedbackRequest,
  RecordRecommendationOutcomeRequest,
  SearchEvidenceRequest,
  SessionResponse,
  ImportDetail,
  WebhookDeliveryListResponse,
  PackDiffResponse,
} from "@modcompat/api-contracts";
import type { ArtifactAnalysisResult, PackDiff } from "@modcompat/domain-models";

const GATEWAY_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080")
    : (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080");

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    // Include cookies so the HttpOnly mcp_session cookie is sent automatically
    // after an OIDC callback sets it on the gateway origin.
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      if (body.error?.message) {
        message = body.error.message;
      }
    } catch {
      // ignore
    }
    throw new ApiError(message, res.status);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function fetchSession(): Promise<SessionResponse> {
  // The request is sent with credentials: "include" so if the gateway has set
  // an HttpOnly mcp_session cookie (after the OIDC callback), it will be sent
  // automatically and the gateway will return a valid session.
  return apiFetch<SessionResponse>("/v1/auth/session");
}

export function beginLogout(redirectTo?: string) {
  if (typeof window === "undefined") {
    return;
  }

  const target = redirectTo ?? `${window.location.origin}/sign-in`;
  window.location.assign(
    `${GATEWAY_URL}/auth/logout?redirectTo=${encodeURIComponent(target)}`
  );
}

// ---------------------------------------------------------------------------
// Mod Resolution
// ---------------------------------------------------------------------------

export interface ResolveModsRequest {
  mods: Array<{
    name: string;
    curseforgeProjectId?: number;
    modrinthProjectId?: string;
  }>;
  minecraftVersion?: string;
  loader?: string;
}

export interface ModInfo {
  id: string;
  name: string;
  version: string;
  source: "curseforge" | "modrinth";
  sourceId: number | string;
  description?: string;
  downloadUrl?: string;
  dependencies?: Array<{
    id: string;
    name: string;
    version: string;
    source: "curseforge" | "modrinth";
    required: boolean;
  }>;
  gameVersions: string[];
  loaders: string[];
  downloads: number;
  author?: string;
  iconUrl?: string;
}

export interface ResolveModsResponse {
  mods: ModInfo[];
  totalRequested: number;
  totalFound: number;
  sources: {
    curseforge: number;
    modrinth: number;
  };
}

export async function resolveMods(request: ResolveModsRequest): Promise<ResolveModsResponse> {
  return apiFetch<ResolveModsResponse>("/v1/mods/resolve", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface ImportModListRequest {
  environment: {
    minecraftVersion: string;
    loader: string;
    javaVersion: string;
    side: string;
  };
  mods: Array<{ name: string; version?: string }>;
  createdBy?: string;
}

export async function importModList(
  projectId: string,
  input: ImportModListRequest
): Promise<ImportDetail> {
  return apiFetch<ImportDetail>(`/v1/projects/${projectId}/imports/mod-list`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

export interface CreateAnalysisInput {
  projectId: string;
  request: CreateAnalysisRequest;
  idempotencyKey: string;
}

export async function createAnalysis(input: CreateAnalysisInput): Promise<{ analysisId: string; idempotencyKey: string; status: string }> {
  return apiFetch(`/v1/projects/${input.projectId}/analyses`, {
    method: "POST",
    headers: { "x-idempotency-key": input.idempotencyKey },
    body: JSON.stringify(input.request),
  });
}

export async function createAnalysisSync(
  projectId: string,
  request: CreateAnalysisRequest
): Promise<{ analysisId: string }> {
  return apiFetch(`/v1/projects/${projectId}/analyses`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function getAnalysisRequestStatus(
  idempotencyKey: string
): Promise<{ idempotencyKey: string; status: string; analysisId?: string; errorMessage?: string }> {
  return apiFetch(`/v1/analysis-requests/${encodeURIComponent(idempotencyKey)}`);
}

export async function cancelAnalysisRequest(idempotencyKey: string): Promise<void> {
  await apiFetch(`/v1/analysis-requests/${encodeURIComponent(idempotencyKey)}/cancel`, {
    method: "POST",
  });
}

export interface AnalysisDetailResponse extends AnalysisProgressResponse {
  findings?: Finding[];
  recommendations?: RecommendationsResponse["items"];
  artifacts?: ArtifactAnalysisResult[];
  packDiff?: PackDiff;
  report?: AnalysisReport;
}

export async function getAnalysis(analysisId: string): Promise<AnalysisDetailResponse> {
  return apiFetch<AnalysisDetailResponse>(`/v1/analyses/${analysisId}`);
}

export async function getAnalysisProgress(analysisId: string): Promise<AnalysisProgressResponse> {
  return apiFetch<AnalysisProgressResponse>(`/v1/analyses/${analysisId}/progress`);
}

export async function getFindings(analysisId: string): Promise<{ findings: Finding[] }> {
  return apiFetch(`/v1/analyses/${analysisId}/findings`);
}

export async function getArtifacts(
  analysisId: string
): Promise<{ items: ArtifactAnalysisResult[] }> {
  return apiFetch(`/v1/analyses/${analysisId}/artifacts`);
}

export async function createPackDiff(
  projectId: string,
  input: CreatePackDiffRequest
): Promise<PackDiffResponse> {
  return apiFetch(`/v1/projects/${projectId}/diffs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPackDiff(packDiffId: string): Promise<PackDiffResponse> {
  return apiFetch(`/v1/pack-diffs/${packDiffId}`);
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export async function getGraph(analysisId: string): Promise<AnalysisGraphResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/graph`);
}

export async function getGraphNeighborhood(
  analysisId: string,
  nodeId: string,
  depth = 2
): Promise<GraphNeighborhoodResponse> {
  return apiFetch(
    `/v1/analyses/${analysisId}/graph/neighborhood?nodeId=${encodeURIComponent(nodeId)}&depth=${depth}`
  );
}

export async function explainFinding(
  analysisId: string,
  findingId: string
): Promise<ExplanationPathResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/explanations/${findingId}`);
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export async function triggerEvidenceSync(
  connectorNames?: string[]
): Promise<EvidenceSyncResponse> {
  return apiFetch("/v1/evidence/sync", {
    method: "POST",
    headers: { "x-idempotency-key": `sync-${Date.now()}` },
    body: JSON.stringify({ connectorNames }),
  });
}

export async function searchEvidence(
  input: SearchEvidenceRequest
): Promise<EvidenceSearchResponse> {
  return apiFetch("/v1/evidence/search", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getFindingEvidence(
  analysisId: string,
  findingId: string
): Promise<FindingEvidenceResult> {
  return apiFetch(
    `/v1/analyses/${analysisId}/findings/${findingId}/evidence`
  );
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export async function getRecommendations(
  analysisId: string
): Promise<RecommendationsResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/recommendations`);
}

export async function submitRecommendationFeedback(
  recommendationId: string,
  input: SubmitRecommendationFeedbackRequest
): Promise<RecommendationFeedbackResponse> {
  return apiFetch(`/v1/recommendations/${recommendationId}/feedback`, {
    method: "POST",
    headers: { "x-idempotency-key": `feedback-${recommendationId}-${Date.now()}` },
    body: JSON.stringify(input),
  });
}

export async function recordRecommendationOutcome(
  recommendationSetId: string,
  input: RecordRecommendationOutcomeRequest
): Promise<RecommendationOutcomeResponse> {
  return apiFetch(`/v1/recommendation-sets/${recommendationSetId}/outcomes`, {
    method: "POST",
    headers: { "x-idempotency-key": `outcome-${recommendationSetId}-${Date.now()}` },
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// ML / Review / Simulation / Release Gate
// ---------------------------------------------------------------------------

export async function getReviewSummary(
  analysisId: string
): Promise<PackReviewSummaryResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/review-summary`);
}

export async function getSimulationRun(
  analysisId: string
): Promise<SimulationRunResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/simulation`);
}

export async function getReleaseGate(
  analysisId: string
): Promise<ReleaseGateDecisionResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/release-gate`);
}

// ---------------------------------------------------------------------------
// Report & Export
// ---------------------------------------------------------------------------

export async function getReport(analysisId: string): Promise<AnalysisReport> {
  return apiFetch(`/v1/analyses/${analysisId}/report`);
}

export async function exportReport(
  analysisId: string,
  format: "json" | "markdown" = "markdown"
): Promise<ExportResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/report/export?format=${format}`);
}

// ---------------------------------------------------------------------------
// Webhook deliveries
// ---------------------------------------------------------------------------

export async function getWebhookDeliveries(
  analysisId: string
): Promise<WebhookDeliveryListResponse> {
  return apiFetch(`/v1/analyses/${analysisId}/webhook-deliveries`);
}

// ---------------------------------------------------------------------------
// Admin — Evidence Curation
// ---------------------------------------------------------------------------

export async function createEvidenceCuration(
  input: CreateEvidenceCurationRequest
): Promise<EvidenceCurationResponse> {
  return apiFetch("/v1/admin/evidence-curations", {
    method: "POST",
    headers: { "x-idempotency-key": `curation-${Date.now()}` },
    body: JSON.stringify(input),
  });
}

export async function promoteVerifiedRule(
  curationId: string,
  input: PromoteVerifiedRuleRequest
): Promise<PromoteVerifiedRuleResponse> {
  return apiFetch(`/v1/admin/evidence-curations/${curationId}/promote`, {
    method: "POST",
    headers: { "x-idempotency-key": `promote-${curationId}-${Date.now()}` },
    body: JSON.stringify(input),
  });
}
