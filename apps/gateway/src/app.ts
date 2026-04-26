import { createHash, randomUUID } from "node:crypto";

import { loadServiceConfig } from "@modcompat/config";
import { createLogger } from "@modcompat/observability";
import {
  createPhase1Platform,
  Phase1Platform,
  assertPermission,
  PermissionDeniedError,
  SlidingWindowRateLimiter,
  buildAuditEntry,
  DEFAULT_QUOTA_PLAN,
  ROLE_PERMISSIONS,
  tenantContextFromHeaders,
  tenantContextFromJwt,
  tenantForwardHeaders,
  verifyJwt
} from "@modcompat/platform-core";
import type { AuditEventType, TenantContext, Permission } from "@modcompat/api-contracts";
import type { PackSnapshot } from "@modcompat/domain-models";

import { resolveJwtSecret } from "./auth-runtime.js";

type MaybePromise<T> = T | Promise<T>;

interface ServiceErrorResponse {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    requestId?: string;
    traceId?: string;
  };
}

function normalizeServiceErrorText(rawText: string) {
  let normalizedText = rawText;
  try {
    const payload = JSON.parse(rawText) as ServiceErrorResponse;
    if (payload.error?.message) {
      normalizedText = `${payload.error.code ?? "service_error"}: ${payload.error.message}`;
    }
  } catch {
    // Keep raw response text when the body is not JSON.
  }
  return normalizedText;
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function extractBearerToken(headers: GatewayRequestHeaders) {
  const authorization =
    firstHeaderValue(headers.authorization) ??
    firstHeaderValue(headers.Authorization);

  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    throw new Error("Authorization header must use the Bearer scheme.");
  }

  return token;
}

function normalizeHeaderRecord(headers: GatewayRequestHeaders): GatewayRequestHeaders {
  const normalized: GatewayRequestHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

type AnalysisRequestStatus = "started" | "completed" | "failed" | "cancelled";

interface AnalysisRequestState {
  idempotencyKey: string;
  status: AnalysisRequestStatus;
  analysisId?: string;
  errorCode?: string;
  errorMessage?: string;
}

type RecommendationGenerationPayload = {
  analysisId: string;
  tenantId?: string;
  snapshot: PackSnapshot;
  findings: ReturnType<Phase1Platform["orchestrator"]["getAnalysis"]>["findings"];
  projects: Array<{
    projectId: string;
    displayName: string;
    recommendedReplacementProjectIds?: string[];
  }>;
  versions: Array<{
    versionId: string;
    projectId: string;
    versionLabel: string;
    loaders: string[];
    minecraftVersions: string[];
  }>;
};

function isBoundaryNotFoundError(error: unknown, codeHint?: string) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("(404") ||
    (codeHint ? error.message.includes(codeHint) : false)
  );
}

export interface RouteDefinition {
  method: "GET" | "POST" | "PATCH";
  path: string;
  summary: string;
}

export type GatewayRequestHeaders = Record<string, string | string[] | undefined>;

interface EvidenceBoundaryClient {
  mode: "http";
  baseUrl: string;
  sync(
    connectorNames: string[] | undefined,
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["evidence"]["syncFixtures"]>>;
  search(
    input: Parameters<Phase1Platform["evidence"]["search"]>[0]
  ): Promise<ReturnType<Phase1Platform["evidence"]["search"]>>;
  getFindingEvidence(
    analysisId: string,
    findingId: string,
    limit?: number,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["evidence"]["getFindingEvidence"]>>;
}

interface AdminBoundaryClient {
  mode: "http";
  baseUrl: string;
  createRuleDraft(
    input: Parameters<Phase1Platform["ruleDrafts"]["createDraft"]>[0],
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["ruleDrafts"]["createDraft"]>>;
  validateRuleDraft(
    draftId: string,
    input: { strict?: boolean },
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["ruleDrafts"]["validateDraft"]>>;
  getRuleDraft(
    draftId: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["ruleDrafts"]["getDraft"]>>;
  listRuleDrafts(
    status?: Parameters<Phase1Platform["ruleDrafts"]["listDrafts"]>[0],
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["ruleDrafts"]["listDrafts"]>>;
  getRuleHistory(
    ruleId: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["ruleDrafts"]["getRuleHistory"]>>;
  promoteRuleDraft(
    input: Parameters<Phase1Platform["ruleDrafts"]["promoteDraft"]>[0],
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["ruleDrafts"]["promoteDraft"]>>;
  createEvidenceCuration(
    input: Parameters<Phase1Platform["evidence"]["createCuration"]>[0],
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["evidence"]["createCuration"]>>;
  promoteVerifiedRule(
    input: Parameters<Phase1Platform["evidence"]["promoteVerifiedRule"]>[0],
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["evidence"]["promoteVerifiedRule"]>>;
}

interface RecommendationBoundaryClient {
  mode: "http";
  baseUrl: string;
  generateRecommendations(
    input: RecommendationGenerationPayload,
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["recommendations"]["getSetByAnalysis"]>>;
  getRecommendations(
    analysisId: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["recommendations"]["getSetByAnalysis"]>>;
  submitFeedback(
    analysisId: string,
    input: Parameters<Phase1Platform["recommendations"]["submitFeedback"]>[0],
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["recommendations"]["submitFeedback"]>>;
  recordOutcome(
    input: Parameters<Phase1Platform["recommendations"]["recordOutcome"]>[0],
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["recommendations"]["recordOutcome"]>>;
}

interface GraphBoundaryClient {
  mode: "http";
  baseUrl: string;
  syncGraph(
    graph: NonNullable<ReturnType<Phase1Platform["graph"]["getGraph"]>>,
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<void>;
  syncExplanation(
    explanation: ReturnType<Phase1Platform["graph"]["explainFinding"]>,
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<void>;
  getGraph(
    analysisId: string,
    context?: TenantContext
  ): Promise<NonNullable<ReturnType<Phase1Platform["graph"]["getGraph"]>>>;
  getNeighborhood(
    analysisId: string,
    nodeId: string,
    depth?: number,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["graph"]["getNeighborhood"]>>;
  explainFinding(
    analysisId: string,
    findingId: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["graph"]["explainFinding"]>>;
}

interface SimulationBoundaryClient {
  mode: "http";
  baseUrl: string;
  syncRun(
    run: ReturnType<Phase1Platform["simulation"]["getRun"]>,
    idempotencyKey: string,
    context?: TenantContext
  ): Promise<void>;
  getRun(
    analysisId: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["simulation"]["getRun"]>>;
}

interface OrchestratorBoundaryClient {
  mode: "http";
  baseUrl: string;
  runOfflineRefresh(
    input: {
      createdBy?: string;
      connectorNames?: string[];
      catalogMods?: Array<{ name: string; curseforgeProjectId?: number; modrinthProjectId?: string }>;
      minecraftVersion?: string;
      loader?: string;
      artifactLimit?: number;
      forceSnapshot?: boolean;
      approveSnapshot?: boolean;
      promoteSnapshot?: boolean;
    },
    context?: TenantContext
  ): Promise<{
    catalog?: {
      totalRequested: number;
      totalFound: number;
    };
    evidence?: {
      connectorCount: number;
      runCount: number;
      documentCount: number;
      snippetCount: number;
    };
    artifactAnalysis: {
      processed: number;
      signaturesGenerated: number;
      versionIds: string[];
    };
    snapshot?: {
      snapshotId: string;
      version: string;
      status: string;
      validationStatus: string;
    };
  }>;
  submitAnalysis(
    input: {
      projectId: string;
      request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1];
      idempotencyKey: string;
    },
    context?: TenantContext
  ): Promise<
    | {
        idempotencyKey: string;
        status: "started";
      }
    | ReturnType<Phase1Platform["orchestrator"]["createAnalysis"]>
  >;
  createAnalysis(
    input: {
      projectId: string;
      request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1];
      idempotencyKey: string;
    },
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["orchestrator"]["createAnalysis"]>>;
  getRequestStatus(idempotencyKey: string): Promise<AnalysisRequestState>;
  cancelRequest(idempotencyKey: string): Promise<AnalysisRequestState>;
  getAnalysis(
    analysisId: string,
    context?: TenantContext
  ): Promise<ReturnType<Phase1Platform["orchestrator"]["getAnalysis"]>>;
}

interface CatalogBoundaryClient {
  mode: "http";
  baseUrl: string;
  resolveMods(
    input: {
      mods: Array<{ name: string; curseforgeProjectId?: number; modrinthProjectId?: string }>;
      minecraftVersion?: string;
      loader?: string;
    },
    context?: TenantContext
  ): Promise<{
    mods: Array<{
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
    }>;
    totalRequested: number;
    totalFound: number;
    sources: {
      curseforge: number;
      modrinth: number;
    };
  }>;
}

export interface GatewayApp {
  config: ReturnType<typeof loadServiceConfig>;
  logger: ReturnType<typeof createLogger>;
  routes: RouteDefinition[];
  platform: Phase1Platform;
  auth: {
    getSessionFromHeaders(headers: GatewayRequestHeaders): Promise<ReturnType<Phase1Platform["auth"]["createSession"]>>;
    resolveTenantContext(headers: GatewayRequestHeaders): Promise<TenantContext | undefined>;
    requireTenantContext(headers: GatewayRequestHeaders): Promise<TenantContext>;
  };
  serviceBoundaries: {
    catalog:
      | { mode: "in-process" }
      | {
          mode: "http";
          baseUrl: string;
        };
    evidence:
      | { mode: "in-process" }
      | {
          mode: "http";
          baseUrl: string;
        };
    admin:
      | { mode: "in-process" }
      | {
          mode: "http";
          baseUrl: string;
        };
    recommendation:
      | { mode: "in-process" }
      | {
          mode: "http";
          baseUrl: string;
        };
    graph:
      | { mode: "in-process" }
      | {
          mode: "http";
          baseUrl: string;
        };
    simulation:
      | { mode: "in-process" }
      | {
          mode: "http";
          baseUrl: string;
        };
    orchestrator:
      | { mode: "in-process" }
      | {
          mode: "http";
          baseUrl: string;
        };
  };
  handlers: {
    getSession(token?: string): Promise<ReturnType<Phase1Platform["auth"]["createSession"]>>;
    createWorkspace(input: {
      organizationId: string;
      name: string;
      slug: string;
    }): ReturnType<Phase1Platform["workspace"]["createWorkspace"]>;
    createProject(input: {
      workspaceId: string;
      name: string;
      slug: string;
      visibility?: "private" | "organization" | "public";
    }): ReturnType<Phase1Platform["workspace"]["createProject"]>;
    importModList(input: Parameters<Phase1Platform["imports"]["importModList"]>[0], context?: TenantContext): ReturnType<Phase1Platform["imports"]["importModList"]>;
    submitAnalysisRequest(
      projectId: string,
      request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1],
      context?: TenantContext
    ): MaybePromise<AnalysisRequestState | ReturnType<Phase1Platform["orchestrator"]["createAnalysis"]>>;
    createAnalysis(projectId: string, request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1], context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["orchestrator"]["createAnalysis"]>>;
    getAnalysisRequestStatus(idempotencyKey: string): MaybePromise<AnalysisRequestState>;
    cancelAnalysisRequest(idempotencyKey: string): MaybePromise<AnalysisRequestState>;
    getAnalysis(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["orchestrator"]["getAnalysis"]>>;
    getAnalysisArtifacts(analysisId: string, context?: TenantContext): MaybePromise<NonNullable<ReturnType<Phase1Platform["orchestrator"]["getAnalysis"]>["artifacts"]>>;
    getAnalysisGraph(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["graph"]["getGraph"]>>;
    getGraphNeighborhood(analysisId: string, nodeId: string, depth?: number, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["graph"]["getNeighborhood"]>>;
    explainFinding(analysisId: string, findingId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["graph"]["explainFinding"]>>;
    syncEvidence(connectorNames?: string[], context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["evidence"]["syncFixtures"]>>;
    searchEvidence(input: Parameters<Phase1Platform["evidence"]["search"]>[0]): MaybePromise<ReturnType<Phase1Platform["evidence"]["search"]>>;
    getFindingEvidence(analysisId: string, findingId: string, limit?: number, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["evidence"]["getFindingEvidence"]>>;
    createRuleDraft(input: Parameters<Phase1Platform["ruleDrafts"]["createDraft"]>[0], context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ruleDrafts"]["createDraft"]>>;
    validateRuleDraft(draftId: string, strict?: boolean, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ruleDrafts"]["validateDraft"]>>;
    getRuleDraft(draftId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ruleDrafts"]["getDraft"]>>;
    listRuleDrafts(status?: Parameters<Phase1Platform["ruleDrafts"]["listDrafts"]>[0], context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ruleDrafts"]["listDrafts"]>>;
    getRuleHistory(ruleId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ruleDrafts"]["getRuleHistory"]>>;
    promoteRuleDraft(input: Parameters<Phase1Platform["ruleDrafts"]["promoteDraft"]>[0], context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ruleDrafts"]["promoteDraft"]>>;
    createEvidenceCuration(input: Parameters<Phase1Platform["evidence"]["createCuration"]>[0], context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["evidence"]["createCuration"]>>;
    promoteVerifiedRule(input: Parameters<Phase1Platform["evidence"]["promoteVerifiedRule"]>[0], context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["evidence"]["promoteVerifiedRule"]>>;
    getRecommendations(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["recommendations"]["getSetByAnalysis"]>>;
    submitRecommendationFeedback(input: Parameters<Phase1Platform["recommendations"]["submitFeedback"]>[0]): MaybePromise<ReturnType<Phase1Platform["recommendations"]["submitFeedback"]>>;
    recordRecommendationOutcome(input: Parameters<Phase1Platform["recommendations"]["recordOutcome"]>[0]): MaybePromise<ReturnType<Phase1Platform["recommendations"]["recordOutcome"]>>;
    getAnalysisFeatureDataset(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ml"]["getDatasetForAnalysis"]>>;
    getPackReviewSummary(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["ml"]["getReviewSummary"]>>;
    getSimulationRun(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["simulation"]["getRun"]>>;
    getReleaseGateDecision(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["releaseGates"]["getDecision"]>>;
    getStatusCheck(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["notifications"]["getStatusCheck"]>>;
    linkGitHubInstallation(input: Parameters<Phase1Platform["integrations"]["linkGitHubInstallation"]>[0]): ReturnType<Phase1Platform["integrations"]["linkGitHubInstallation"]>;
    createWebhook(input: Parameters<Phase1Platform["notifications"]["registerWebhook"]>[0], context?: TenantContext): ReturnType<Phase1Platform["notifications"]["registerWebhook"]>;
    listWebhooks(): ReturnType<Phase1Platform["notifications"]["listWebhooks"]>;
    listWebhookDeliveries(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["notifications"]["listDeliveries"]>>;
    getAnalysisReport(analysisId: string, context?: TenantContext): MaybePromise<ReturnType<Phase1Platform["reports"]["getReport"]>>;
    exportAnalysisReport(input: Parameters<Phase1Platform["reports"]["exportReport"]>[0], context?: TenantContext): ReturnType<Phase1Platform["reports"]["exportReport"]>;
    createPackDiff(projectId: string, request: Parameters<Phase1Platform["orchestrator"]["createPackDiff"]>[1]): ReturnType<Phase1Platform["orchestrator"]["createPackDiff"]>;
    getPackDiff(packDiffId: string): ReturnType<Phase1Platform["diffs"]["getDiff"]>;
    getDemoFlow(): ReturnType<Phase1Platform["createDemoFlow"]>;
    buildAndPromoteSnapshot(
      options: { createdBy: string; versionLabel?: string; force?: boolean },
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["knowledgeSynthesis"]["buildAndPromoteSnapshot"]>>;
    scheduleArtifactAnalysis(
      versionIds: string[],
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["knowledgeSynthesis"]["scheduleArtifactAnalysis"]>>;
    getActiveSnapshotSummary(
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["knowledgeSynthesis"]["getSnapshotSummary"]>>;
    generateCandidatesForPipeline1(
      snapshotId: string,
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["knowledgeSynthesis"]["generateCandidatesForPipeline1"]>>;
    approveSnapshot(
      snapshotId: string,
      input: { approvedBy: string; note?: string },
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["knowledgeSynthesis"]["approveSnapshot"]>>;
    triggerSnapshotRefresh(
      options: { createdBy: string; force?: boolean },
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["knowledgeSynthesis"]["triggerSnapshotRefresh"]>>;
    runOfflineRefresh(
      input: {
        createdBy?: string;
        connectorNames?: string[];
        catalogMods?: Array<{ name: string; curseforgeProjectId?: number; modrinthProjectId?: string }>;
        minecraftVersion?: string;
        loader?: string;
        artifactLimit?: number;
        forceSnapshot?: boolean;
        approveSnapshot?: boolean;
        promoteSnapshot?: boolean;
      },
      context?: TenantContext
    ): MaybePromise<{
      catalog?: {
        totalRequested: number;
        totalFound: number;
      };
      evidence?: {
        connectorCount: number;
        runCount: number;
        documentCount: number;
        snippetCount: number;
      };
      artifactAnalysis: {
        processed: number;
        signaturesGenerated: number;
        versionIds: string[];
      };
      snapshot?: {
        snapshotId: string;
        version: string;
        status: string;
        validationStatus: string;
      };
    }>;
    ingestCatalog(
      payload: Parameters<Phase1Platform["catalogIngestion"]["bulkIngest"]>[0],
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["catalogIngestion"]["bulkIngest"]>>;
    ingestEvidence(
      payload: Parameters<Phase1Platform["evidenceIngestion"]["bulkIngestEvidence"]>[0],
      context?: TenantContext
    ): MaybePromise<ReturnType<Phase1Platform["evidenceIngestion"]["bulkIngestEvidence"]>>;
    resolveMods(
      input: {
        mods: Array<{ name: string; curseforgeProjectId?: number; modrinthProjectId?: string }>;
        minecraftVersion?: string;
        loader?: string;
      },
      context?: TenantContext
    ): Promise<{
      mods: Array<{
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
      }>;
      totalRequested: number;
      totalFound: number;
      sources: {
        curseforge: number;
        modrinth: number;
      };
    }>;
  };
}

function buildEvidenceBoundaryClient(
  logger: ReturnType<typeof createLogger>
): EvidenceBoundaryClient | undefined {
  const baseUrl = process.env.EVIDENCE_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  async function request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    context?: TenantContext;
  }): Promise<T> {
    const requestId = `gateway-${randomUUID()}`;
    const response = await fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-trace-id": requestId,
        ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}),
        ...(input.context ? tenantForwardHeaders(input.context) : {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });

    if (!response.ok) {
      const text = await response.text();
      const normalizedText = normalizeServiceErrorText(text);
      throw new Error(
        `Evidence service request failed (${response.status} ${response.statusText}): ${normalizedText}`
      );
    }

    logger.info("Gateway evidence boundary request completed", {
      requestId,
      path: input.path,
      transport: "http"
    });

    return (await response.json()) as T;
  }

  return {
    mode: "http",
    baseUrl,
    sync(connectorNames, idempotencyKey, context) {
      return request({
        method: "POST",
        path: "/v1/evidence/sync",
        body: { connectorNames },
        idempotencyKey,
        context
      });
    },
    search(input) {
      return request({
        method: "POST",
        path: "/v1/evidence/search",
        body: input
      });
    },
    getFindingEvidence(analysisId, findingId, limit = 5, context) {
      const path = `/v1/analyses/${encodeURIComponent(analysisId)}/findings/${encodeURIComponent(
        findingId
      )}/evidence?limit=${limit}`;
      return request({
        method: "GET",
        path,
        context
      });
    }
  };
}

function buildAdminBoundaryClient(
  logger: ReturnType<typeof createLogger>
): AdminBoundaryClient | undefined {
  const baseUrl = process.env.ADMIN_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  if (!process.env.POSTGRES_URL) {
    logger.info("Gateway admin boundary disabled because POSTGRES_URL is not configured", {
      requestedBaseUrl: baseUrl
    });
    return undefined;
  }

  async function request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    context?: TenantContext;
  }): Promise<T> {
    const requestId = `gateway-${randomUUID()}`;
    const response = await fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-trace-id": requestId,
        ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}),
        ...(input.context ? tenantForwardHeaders(input.context) : {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });

    if (!response.ok) {
      const text = await response.text();
      const normalizedText = normalizeServiceErrorText(text);
      throw new Error(
        `Admin service request failed (${response.status} ${response.statusText}): ${normalizedText}`
      );
    }

    logger.info("Gateway admin boundary request completed", {
      requestId,
      path: input.path,
      transport: "http"
    });

    return (await response.json()) as T;
  }

  return {
    mode: "http",
    baseUrl,
    createRuleDraft(input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: "/v1/admin/rule-drafts",
        body: input,
        idempotencyKey,
        context
      });
    },
    validateRuleDraft(draftId, input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: `/v1/admin/rule-drafts/${encodeURIComponent(draftId)}/validate`,
        body: input,
        idempotencyKey,
        context
      });
    },
    getRuleDraft(draftId, context) {
      return request({
        method: "GET",
        path: `/v1/admin/rule-drafts/${encodeURIComponent(draftId)}`,
        context
      });
    },
    listRuleDrafts(status, context) {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
      return request({
        method: "GET",
        path: `/v1/admin/rule-drafts${suffix}`,
        context
      });
    },
    getRuleHistory(ruleId, context) {
      return request({
        method: "GET",
        path: `/v1/admin/rules/${encodeURIComponent(ruleId)}/history`,
        context
      });
    },
    promoteRuleDraft(input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: `/v1/admin/rule-drafts/${encodeURIComponent(input.draftId)}/promote`,
        body: { promotedBy: input.promotedBy, changeNote: input.changeNote },
        idempotencyKey,
        context
      });
    },
    createEvidenceCuration(input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: "/v1/admin/evidence-curations",
        body: input,
        idempotencyKey,
        context
      });
    },
    promoteVerifiedRule(input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: `/v1/admin/evidence-curations/${encodeURIComponent(input.curationId)}/promote`,
        body: { promotedBy: input.promotedBy },
        idempotencyKey,
        context
      });
    }
  };
}

function buildRecommendationBoundaryClient(
  logger: ReturnType<typeof createLogger>
): RecommendationBoundaryClient | undefined {
  const baseUrl = process.env.RECOMMENDATION_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  async function request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    context?: TenantContext;
  }): Promise<T> {
    const requestId = `gateway-${randomUUID()}`;
    const response = await fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-trace-id": requestId,
        ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}),
        ...(input.context ? tenantForwardHeaders(input.context) : {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });

    if (!response.ok) {
      const text = await response.text();
      const normalizedText = normalizeServiceErrorText(text);
      throw new Error(
        `Recommendation service request failed (${response.status} ${response.statusText}): ${normalizedText}`
      );
    }

    logger.info("Gateway recommendation boundary request completed", {
      requestId,
      path: input.path,
      transport: "http"
    });

    return (await response.json()) as T;
  }

  return {
    mode: "http",
    baseUrl,
    async generateRecommendations(input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: "/v1/internal/recommendations/generate",
        body: input,
        idempotencyKey,
        context
      });
    },
    getRecommendations(analysisId, context) {
      return request({
        method: "GET",
        path: `/v1/analyses/${encodeURIComponent(analysisId)}/recommendations`,
        context
      });
    },
    submitFeedback(analysisId, input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: `/v1/recommendations/${encodeURIComponent(input.recommendationId)}/feedback?analysis_id=${encodeURIComponent(analysisId)}`,
        body: {
          feedbackType: input.feedbackType,
          note: input.note,
          createdBy: input.createdBy
        },
        idempotencyKey,
        context
      });
    },
    recordOutcome(input, idempotencyKey, context) {
      return request({
        method: "POST",
        path: `/v1/recommendation-sets/${encodeURIComponent(input.recommendationSetId)}/outcomes`,
        body: {
          status: input.status,
          appliedRecommendationIds: input.appliedRecommendationIds,
          validationSummary: input.validationSummary,
          createdBy: input.createdBy
        },
        idempotencyKey,
        context
      });
    }
  };
}

function buildCatalogBoundaryClient(
  logger: ReturnType<typeof createLogger>
): CatalogBoundaryClient | undefined {
  const baseUrl = process.env.CATALOG_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  async function request<T>(input: {
    method: "POST";
    path: string;
    body?: unknown;
    context?: TenantContext;
  }): Promise<T> {
    const requestId = `gateway-${randomUUID()}`;
    const response = await fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-trace-id": requestId,
        ...(input.context ? tenantForwardHeaders(input.context) : {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });

    if (!response.ok) {
      const text = await response.text();
      const normalizedText = normalizeServiceErrorText(text);
      throw new Error(
        `Catalog service request failed (${response.status} ${response.statusText}): ${normalizedText}`
      );
    }

    logger.info("Gateway catalog boundary request completed", {
      requestId,
      path: input.path,
      transport: "http"
    });

    return (await response.json()) as T;
  }

  return {
    mode: "http",
    baseUrl,
    resolveMods(input, context) {
      return request({
        method: "POST",
        path: "/v1/catalog/resolve",
        body: input,
        context
      });
    }
  };
}

function buildGraphBoundaryClient(
  logger: ReturnType<typeof createLogger>
): GraphBoundaryClient | undefined {
  const baseUrl = process.env.GRAPH_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  async function request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    context?: TenantContext;
  }): Promise<T> {
    const requestId = `gateway-${randomUUID()}`;
    const response = await fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-trace-id": requestId,
        ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}),
        ...(input.context ? tenantForwardHeaders(input.context) : {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });

    if (!response.ok) {
      const text = await response.text();
      const normalizedText = normalizeServiceErrorText(text);
      throw new Error(`Graph service request failed (${response.status} ${response.statusText}): ${normalizedText}`);
    }

    logger.info("Gateway graph boundary request completed", {
      requestId,
      path: input.path,
      transport: "http"
    });

    return (await response.json()) as T;
  }

  return {
    mode: "http",
    baseUrl,
    async syncGraph(graph, idempotencyKey, context) {
      await request({
        method: "POST",
        path: "/v1/internal/graph/upsert",
        body: {
          analysis_id: graph.analysisId,
          nodes: graph.nodes.map((node) => ({
            node_id: node.nodeId,
            node_type: node.nodeType,
            label: node.label,
            properties: node.properties ?? {}
          })),
          edges: graph.edges.map((edge) => ({
            edge_id: edge.edgeId,
            edge_type: edge.edgeType,
            source_id: edge.sourceId,
            target_id: edge.targetId,
            weight: edge.weight ?? 0,
            properties: edge.properties ?? {}
          }))
        },
          idempotencyKey,
          context
        });
      },
    async syncExplanation(explanation, idempotencyKey, context) {
        await request({
        method: "POST",
        path: "/v1/internal/graph/explanations",
        body: {
          analysis_id: explanation.analysisId,
          finding_id: explanation.findingId,
          nodes: explanation.nodes.map((node) => ({
            node_id: node.nodeId,
            node_type: node.nodeType,
            label: node.label,
            properties: node.properties ?? {}
          })),
          edges: explanation.edges.map((edge) => ({
            edge_id: edge.edgeId,
            edge_type: edge.edgeType,
            source_id: edge.sourceId,
            target_id: edge.targetId,
            weight: edge.weight ?? 0,
            properties: edge.properties ?? {}
          }))
        },
          idempotencyKey,
          context
        });
      },
    async getGraph(analysisId, context) {
      const response = await request<{
        analysis_id: string;
        nodes: Array<{ node_id: string; node_type: string; label: string; properties?: Record<string, unknown> }>;
        edges: Array<{ edge_id: string; edge_type: string; source_id: string; target_id: string; weight?: number; properties?: Record<string, unknown> }>;
        }>({
          method: "GET",
          path: `/v1/internal/graph/snapshot?analysis_id=${encodeURIComponent(analysisId)}`,
          context
        });

      return {
        graphId: `graph_${response.analysis_id}`,
        analysisId: response.analysis_id,
        tenantId: "org_demo",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        nodes: response.nodes.map((node) => ({
          nodeId: node.node_id,
          nodeType: node.node_type,
          label: node.label,
          analysisId: response.analysis_id,
          properties: node.properties
        })),
        edges: response.edges.map((edge) => ({
          edgeId: edge.edge_id,
          analysisId: response.analysis_id,
          edgeType: edge.edge_type,
          sourceId: edge.source_id,
          targetId: edge.target_id,
          weight: edge.weight,
          properties: edge.properties
        }))
      };
    },
    async getNeighborhood(analysisId, nodeId, depth = 1, context) {
      const response = await request<{
        analysis_id: string;
        center_node_id: string;
        depth: number;
        nodes: Array<{ node_id: string; node_type: string; label: string; properties?: Record<string, unknown> }>;
        edges: Array<{ edge_id: string; edge_type: string; source_id: string; target_id: string; weight?: number; properties?: Record<string, unknown> }>;
        }>({
          method: "GET",
          path: `/v1/internal/graph/neighborhood?analysis_id=${encodeURIComponent(analysisId)}&node_id=${encodeURIComponent(nodeId)}&depth=${depth}`,
          context
        });

      return {
        analysisId: response.analysis_id,
        centerNodeId: response.center_node_id,
        depth: response.depth,
        nodes: response.nodes.map((node) => ({
          nodeId: node.node_id,
          nodeType: node.node_type,
          label: node.label,
          analysisId: response.analysis_id,
          properties: node.properties
        })),
        edges: response.edges.map((edge) => ({
          edgeId: edge.edge_id,
          analysisId: response.analysis_id,
          edgeType: edge.edge_type,
          sourceId: edge.source_id,
          targetId: edge.target_id,
          weight: edge.weight,
          properties: edge.properties
        }))
      };
    },
    async explainFinding(analysisId, findingId, context) {
      const response = await request<{
        path_id: string;
        analysis_id: string;
        finding_id: string;
        summary: string;
        nodes: Array<{ node_id: string; node_type: string; label: string; properties?: Record<string, unknown> }>;
        edges: Array<{ edge_id: string; edge_type: string; source_id: string; target_id: string; weight?: number; properties?: Record<string, unknown> }>;
        }>({
          method: "GET",
          path: `/v1/internal/graph/explanations?analysis_id=${encodeURIComponent(analysisId)}&finding_id=${encodeURIComponent(findingId)}`,
          context
        });

      return {
        pathId: response.path_id,
        analysisId: response.analysis_id,
        findingId: response.finding_id,
        summary: response.summary,
        createdAt: new Date().toISOString(),
        nodes: response.nodes.map((node) => ({
          nodeId: node.node_id,
          nodeType: node.node_type,
          label: node.label,
          analysisId: response.analysis_id,
          properties: node.properties
        })),
        edges: response.edges.map((edge) => ({
          edgeId: edge.edge_id,
          analysisId: response.analysis_id,
          edgeType: edge.edge_type,
          sourceId: edge.source_id,
          targetId: edge.target_id,
          weight: edge.weight,
          properties: edge.properties
        }))
      };
    }
  };
}

function buildSimulationBoundaryClient(
  logger: ReturnType<typeof createLogger>
): SimulationBoundaryClient | undefined {
  const baseUrl = process.env.SIMULATION_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  async function request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    context?: TenantContext;
  }): Promise<T> {
    const requestId = `gateway-${randomUUID()}`;
    const response = await fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-trace-id": requestId,
        ...(input.idempotencyKey ? { "x-idempotency-key": input.idempotencyKey } : {}),
        ...(input.context ? tenantForwardHeaders(input.context) : {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });

    if (!response.ok) {
      const text = await response.text();
      const normalizedText = normalizeServiceErrorText(text);
      throw new Error(
        `Simulation service request failed (${response.status} ${response.statusText}): ${normalizedText}`
      );
    }

    logger.info("Gateway simulation boundary request completed", {
      requestId,
      path: input.path,
      transport: "http"
    });

    return (await response.json()) as T;
  }

  return {
    mode: "http",
    baseUrl,
    async syncRun(run, idempotencyKey, context) {
      await request({
        method: "POST",
        path: "/v1/internal/simulation/runs",
        body: {
          simulationRun: run
        },
          idempotencyKey,
          context
        });
      },
      getRun(analysisId, context) {
        return request({
          method: "GET",
          path: `/v1/analyses/${encodeURIComponent(analysisId)}/simulation`,
          context
        });
      }
    };
  }

function buildOrchestratorBoundaryClient(
  logger: ReturnType<typeof createLogger>
): OrchestratorBoundaryClient | undefined {
  const baseUrl = process.env.ORCHESTRATOR_SERVICE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  if (!process.env.POSTGRES_URL) {
    logger.info("Gateway orchestrator boundary disabled because POSTGRES_URL is not configured", {
      requestedBaseUrl: baseUrl
    });
    return undefined;
  }

  async function request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    context?: TenantContext;
  }): Promise<T> {
    const requestId = `gateway-${randomUUID()}`;
    const idempotencyKey =
      input.body &&
      typeof input.body === "object" &&
      "idempotencyKey" in (input.body as Record<string, unknown>) &&
      typeof (input.body as { idempotencyKey?: unknown }).idempotencyKey === "string"
        ? (input.body as { idempotencyKey: string }).idempotencyKey
        : undefined;
    const response = await fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-trace-id": requestId,
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        ...(input.context ? tenantForwardHeaders(input.context) : {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });

    if (!response.ok) {
      const text = await response.text();
      const normalizedText = normalizeServiceErrorText(text);
      throw new Error(
        `Orchestrator service request failed (${response.status} ${response.statusText}): ${normalizedText}`
      );
    }

    logger.info("Gateway orchestrator boundary request completed", {
      requestId,
      path: input.path,
      transport: "http"
    });

    return (await response.json()) as T;
  }

  return {
    mode: "http",
    baseUrl,
    runOfflineRefresh(input, context) {
      return request({
        method: "POST",
        path: "/v1/internal/offline/refresh",
        body: input,
        context
      });
    },
      submitAnalysis(input, context) {
        return request<{
          idempotencyKey: string;
          status: "started";
        } | ReturnType<Phase1Platform["orchestrator"]["createAnalysis"]>>({
          method: "POST",
          path: "/v1/analyses",
          body: input,
          context
        });
      },
      async createAnalysis(input, context) {
        const submission = await this.submitAnalysis(input, context);

      if ("analysis" in submission) {
        return submission;
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < 15000) {
        const requestStatus = await this.getRequestStatus(input.idempotencyKey);

        if (requestStatus.status === "completed" && requestStatus.analysisId) {
            return request({
              method: "GET",
              path: `/v1/analyses/${encodeURIComponent(requestStatus.analysisId)}`,
              context
            });
          }

        if (requestStatus.status === "failed") {
          throw new Error(
            `Orchestrator request failed: ${requestStatus.errorCode ?? "analysis_execution_failed"}: ${requestStatus.errorMessage ?? "Unknown error"}`
          );
        }

        if (requestStatus.status === "cancelled") {
          throw new Error(
            `Orchestrator request cancelled: ${requestStatus.errorCode ?? "analysis_request_cancelled"}: ${requestStatus.errorMessage ?? "Analysis request was cancelled."}`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      throw new Error("Orchestrator request timed out while waiting for async completion.");
    },
    getRequestStatus(idempotencyKey) {
      return request({
        method: "GET",
        path: `/v1/analysis-requests/${encodeURIComponent(idempotencyKey)}`
      });
    },
    cancelRequest(idempotencyKey) {
      return request({
        method: "POST",
        path: `/v1/analysis-requests/${encodeURIComponent(idempotencyKey)}/cancel`
      });
    },
      getAnalysis(analysisId, context) {
        return request({
          method: "GET",
          path: `/v1/analyses/${encodeURIComponent(analysisId)}`,
          context
        });
      }
  };
}

// ---------------------------------------------------------------------------
// Billing boundary — fetches per-org QuotaPlan from the workspace service
// ---------------------------------------------------------------------------

function buildBillingBoundaryClient(logger: ReturnType<typeof createLogger>) {
  const baseUrl = process.env.WORKSPACE_SERVICE_URL?.trim();
  if (!baseUrl) return null;

  return {
    baseUrl,
    async getPlanForOrg(organizationId: string): Promise<import("@modcompat/api-contracts").QuotaPlan> {
      try {
        const res = await fetch(
          `${baseUrl}/v1/internal/billing/plan?organizationId=${encodeURIComponent(organizationId)}`
        );
        if (!res.ok) {
          logger.warn("Billing boundary: plan fetch failed, using default plan", {
            organizationId,
            status: res.status
          });
          return DEFAULT_QUOTA_PLAN;
        }
        const body = (await res.json()) as { plan: import("@modcompat/api-contracts").QuotaPlan };
        return body.plan ?? DEFAULT_QUOTA_PLAN;
      } catch (e) {
        logger.warn("Billing boundary: request error, using default plan", {
          organizationId,
          error: e instanceof Error ? e.message : String(e)
        });
        return DEFAULT_QUOTA_PLAN;
      }
    }
  };
}

export function buildGatewayApp(): GatewayApp {
  const config = loadServiceConfig("gateway");
  const logger = createLogger("gateway");
  const platform = createPhase1Platform();
  const catalogBoundary = buildCatalogBoundaryClient(logger);
  const evidenceBoundary = buildEvidenceBoundaryClient(logger);
  const adminBoundary = buildAdminBoundaryClient(logger);
  const recommendationBoundary = buildRecommendationBoundaryClient(logger);
  const graphBoundary = buildGraphBoundaryClient(logger);
  const simulationBoundary = buildSimulationBoundaryClient(logger);
  const orchestratorBoundary = buildOrchestratorBoundaryClient(logger);
  const billingBoundary = buildBillingBoundaryClient(logger);
  const inProcessAnalysisRequests = new Map<string, AnalysisRequestState>();

  // Rate limiters — 100 req/min for authenticated reads, 30 req/min for writes
  const authenticatedApiLimiter = new SlidingWindowRateLimiter({ limit: 100, windowMs: 60_000 });
  const writeOperationLimiter = new SlidingWindowRateLimiter({ limit: 30, windowMs: 60_000 });

  function enforceRateLimit(limiter: SlidingWindowRateLimiter, actorId: string) {
    const result = limiter.check(actorId);
    if (!result.allowed) {
      const err = new Error(
        `Rate limit exceeded. Retry after ${result.retryAfterSeconds ?? 0} seconds.`
      );
      (err as NodeJS.ErrnoException).code = "rate_limit_exceeded";
      throw err;
    }
  }

  async function resolveTenantContext(headers: GatewayRequestHeaders): Promise<TenantContext | undefined> {
    const normalizedHeaders = normalizeHeaderRecord(headers);
    const bearerToken = extractBearerToken(normalizedHeaders);
    const requestId =
      firstHeaderValue(normalizedHeaders["x-request-id"]) ?? `gateway-${randomUUID()}`;
    const traceId = firstHeaderValue(normalizedHeaders["x-trace-id"]) ?? requestId;

    if (bearerToken) {
      if (!bearerToken.includes(".")) {
        throw new Error("Bearer authentication currently requires a signed JWT.");
      }

      const session = await platform.auth.createSessionFromToken(
        bearerToken,
        platform.persistence
      );
      const payload = verifyJwt(session.token, resolveJwtSecret(process.env));
      return tenantContextFromJwt(payload, requestId, traceId);
    }

    const forwarded = tenantContextFromHeaders(normalizedHeaders);
    if (
      forwarded.organizationId &&
      forwarded.actorId &&
      forwarded.role &&
      forwarded.requestId &&
      forwarded.traceId
    ) {
      return {
        organizationId: forwarded.organizationId,
        actorId: forwarded.actorId,
        actorKind: forwarded.role === "api_key" ? "api_key" : "user",
        role: forwarded.role,
        permissions:
          forwarded.role === "api_key" ? [] : ROLE_PERMISSIONS[forwarded.role] ?? [],
        requestId: forwarded.requestId,
        traceId: forwarded.traceId
      };
    }

    return undefined;
  }

  async function requireTenantContext(headers: GatewayRequestHeaders): Promise<TenantContext> {
    const context = await resolveTenantContext(headers);
    if (!context) {
      throw new Error("Authentication required.");
    }
    return context;
  }

  function checkPermission(context: TenantContext | undefined, permission: Permission) {
    if (context) {
      enforceRateLimit(authenticatedApiLimiter, context.actorId);
      assertPermission(context, permission);
    }
  }

  function checkWritePermission(context: TenantContext | undefined, permission: Permission) {
    if (context) {
      enforceRateLimit(writeOperationLimiter, context.actorId);
      assertPermission(context, permission);
    }
  }

  function auditSuccess(
    context: TenantContext,
    eventType: AuditEventType,
    resourceKind: string,
    resourceId: string
  ) {
    platform.auditLogger.record(
      buildAuditEntry(
        {
          organizationId: context.organizationId,
          actorId: context.actorId,
          actorKind: context.actorKind,
          role: context.role,
          permissions: context.permissions,
          requestId: context.requestId,
          traceId: context.traceId
        },
        eventType,
        { resourceKind, resourceId, outcome: "success" }
      )
    );
  }

  function auditDenied(
    context: TenantContext,
    eventType: AuditEventType,
    resourceKind: string,
    resourceId: string
  ) {
    platform.auditLogger.record(
      buildAuditEntry(
        {
          organizationId: context.organizationId,
          actorId: context.actorId,
          actorKind: context.actorKind,
          role: context.role,
          permissions: context.permissions,
          requestId: context.requestId,
          traceId: context.traceId
        },
        eventType,
        { resourceKind, resourceId, outcome: "denied" }
      )
    );
  }

  const preferServiceOwnedRecommendationHydration = Boolean(
    recommendationBoundary && orchestratorBoundary
  );
  const preferServiceOwnedGraphDerivation = Boolean(graphBoundary && orchestratorBoundary);
  const preferServiceOwnedSimulationHydration = Boolean(
    simulationBoundary && orchestratorBoundary
  );

  const routes: RouteDefinition[] = [
    { method: "GET", path: "/v1/auth/session", summary: "Get authenticated session" },
    { method: "POST", path: "/v1/organizations", summary: "Create organization" },
    {
      method: "POST",
      path: "/v1/organizations/:organizationId/memberships",
      summary: "Create organization membership"
    },
    {
      method: "POST",
      path: "/v1/organizations/:organizationId/api-keys",
      summary: "Create API key"
    },
    { method: "POST", path: "/v1/workspaces", summary: "Create workspace" },
    { method: "POST", path: "/v1/projects", summary: "Create project" },
    {
      method: "POST",
      path: "/v1/projects/:projectId/imports/mod-list",
      summary: "Import a normalized mod list"
    },
    { method: "POST", path: "/v1/projects/:projectId/analyses", summary: "Create analysis" },
    { method: "GET", path: "/v1/analysis-requests/:idempotencyKey", summary: "Get analysis request status" },
    { method: "POST", path: "/v1/analysis-requests/:idempotencyKey/cancel", summary: "Cancel an accepted analysis request" },
    { method: "GET", path: "/v1/analyses/:analysisId", summary: "Get analysis summary" },
    {
      method: "GET",
      path: "/v1/analyses/:analysisId/progress",
      summary: "Get analysis progress"
    },
    { method: "GET", path: "/v1/analyses/:analysisId/findings", summary: "List findings" },
    { method: "GET", path: "/v1/analyses/:analysisId/artifacts", summary: "List artifact analysis outputs" },
    { method: "GET", path: "/v1/analyses/:analysisId/graph", summary: "Get graph snapshot" },
    { method: "GET", path: "/v1/analyses/:analysisId/graph/neighborhood", summary: "Get graph neighborhood" },
    { method: "GET", path: "/v1/analyses/:analysisId/explanations/:findingId", summary: "Get explanation path" },
    { method: "POST", path: "/v1/evidence/sync", summary: "Run deterministic evidence sync" },
    { method: "POST", path: "/v1/evidence/search", summary: "Search evidence indexes" },
    { method: "GET", path: "/v1/analyses/:analysisId/findings/:findingId/evidence", summary: "Get evidence linked to a finding" },
    { method: "POST", path: "/v1/admin/rule-drafts", summary: "Create a verified-rule draft" },
    { method: "GET", path: "/v1/admin/rule-drafts", summary: "List verified-rule drafts" },
    { method: "GET", path: "/v1/admin/rule-drafts/:draftId", summary: "Get a verified-rule draft" },
    { method: "POST", path: "/v1/admin/rule-drafts/:draftId/validate", summary: "Validate a verified-rule draft" },
    { method: "POST", path: "/v1/admin/rule-drafts/:draftId/promote", summary: "Promote a verified-rule draft" },
    { method: "GET", path: "/v1/admin/rules/:ruleId/history", summary: "Get verified-rule version history" },
    { method: "POST", path: "/v1/admin/evidence-curations", summary: "Create analyst evidence curation" },
    { method: "POST", path: "/v1/admin/evidence-curations/:curationId/promote", summary: "Promote curated evidence into a verified rule" },
    { method: "GET", path: "/v1/analyses/:analysisId/recommendations", summary: "List recommendations" },
    { method: "POST", path: "/v1/recommendations/:recommendationId/feedback", summary: "Submit recommendation feedback" },
    { method: "POST", path: "/v1/recommendation-sets/:recommendationSetId/outcomes", summary: "Record recommendation outcome" },
    { method: "GET", path: "/v1/analyses/:analysisId/ml/features", summary: "Get analysis feature dataset" },
    { method: "GET", path: "/v1/analyses/:analysisId/review-summary", summary: "Get grounded pack review summary" },
    { method: "GET", path: "/v1/analyses/:analysisId/simulation", summary: "Get simulation run" },
    { method: "GET", path: "/v1/analyses/:analysisId/release-gate", summary: "Get release gate decision" },
    { method: "GET", path: "/v1/analyses/:analysisId/status-check", summary: "Get analysis status check result" },
    { method: "GET", path: "/v1/analyses/:analysisId/report", summary: "Get analysis report" },
    { method: "GET", path: "/v1/analyses/:analysisId/report/export", summary: "Export analysis report" },
    { method: "POST", path: "/v1/projects/:projectId/diffs", summary: "Create pack diff" },
    { method: "GET", path: "/v1/pack-diffs/:packDiffId", summary: "Get pack diff" },
    { method: "POST", path: "/v1/integrations/github/installations/:installationId/link", summary: "Link GitHub installation" },
    { method: "POST", path: "/v1/webhooks", summary: "Register webhook" },
    { method: "GET", path: "/v1/webhooks", summary: "List webhooks" },
    { method: "GET", path: "/v1/analyses/:analysisId/webhook-deliveries", summary: "List webhook deliveries for an analysis" },
    { method: "POST", path: "/v1/internal/snapshots/build-and-promote", summary: "Build and promote a new knowledge snapshot" },
    { method: "POST", path: "/v1/internal/artifact-analysis/schedule", summary: "Schedule offline artifact analysis for canonical version IDs" },
    { method: "GET", path: "/v1/internal/snapshots/active", summary: "Get the active knowledge snapshot summary" },
    { method: "GET", path: "/v1/internal/snapshots/:snapshotId/candidates", summary: "Generate prioritized candidate pairs for Pipeline 1 testing" },
    { method: "POST", path: "/v1/internal/snapshots/:snapshotId/approve", summary: "Approve a validated knowledge snapshot for promotion" },
    { method: "POST", path: "/v1/internal/snapshots/refresh", summary: "Trigger a snapshot rebuild when needed" },
    { method: "POST", path: "/v1/internal/offline/refresh", summary: "Run orchestrator-owned offline refresh across catalog, evidence, artifact signatures, and snapshots" },
    { method: "POST", path: "/v1/internal/catalog/ingest", summary: "Bulk-ingest catalog projects, versions, source mappings, and incompatibilities" },
    { method: "POST", path: "/v1/internal/evidence/ingest", summary: "Bulk-ingest verified rules and artifact profiles" }
  ];

  logger.info("Gateway Phase 12 initialized", {
    port: config.port,
    routeCount: routes.length,
    evidenceBoundary: evidenceBoundary?.mode ?? "in-process",
    catalogBoundary: catalogBoundary?.mode ?? "in-process",
    adminBoundary: adminBoundary?.mode ?? "in-process",
    recommendationBoundary: recommendationBoundary?.mode ?? "in-process",
    graphBoundary: graphBoundary?.mode ?? "in-process",
    simulationBoundary: simulationBoundary?.mode ?? "in-process",
    orchestratorBoundary: orchestratorBoundary?.mode ?? "in-process"
  });

  function buildAnalysisIdempotencyKey(
    projectId: string,
    request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1]
  ) {
    return `analysis-${createHash("sha256")
      .update(JSON.stringify({ projectId, request }))
      .digest("hex")}`;
  }

  function buildAdminIdempotencyKey(operation: string, payload: unknown) {
    return `admin-${operation}-${createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")}`;
  }

  function buildBoundaryIdempotencyKey(operation: string, payload: unknown) {
    return `${operation}-${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  }

  async function prepareBoundaryAnalysisRequest(
    projectId: string,
    request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1]
  ) {
    let remoteRequest = request;
    if (platform.persistence.isEnabled()) {
      await platform.persistence.persistImportsForProject(projectId);
      const persistedSnapshotId = await platform.persistence.resolvePersistedSnapshotId(
        request.inputRef.id
      );
      const persistedCompareToSnapshotId =
        await platform.persistence.resolvePersistedSnapshotId(
          request.options?.compareToSnapshotId
        );
      remoteRequest = {
        ...request,
        inputRef: {
          ...request.inputRef,
          id: persistedSnapshotId ?? request.inputRef.id
        },
        options: request.options
          ? {
              ...request.options,
              compareToSnapshotId:
                persistedCompareToSnapshotId ?? request.options.compareToSnapshotId
            }
          : undefined
      };
    }

    return {
      request: remoteRequest,
      idempotencyKey: buildAnalysisIdempotencyKey(projectId, request)
    };
  }

  async function resolveRequestSnapshotId(
    request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1]
  ) {
    if (request.inputRef.type === "pack_snapshot") {
      return request.inputRef.id;
    }

    if (request.inputRef.type === "import") {
      const importRecord = platform.repository.imports.get(request.inputRef.id);
      if (importRecord?.packSnapshotId) {
        return importRecord.packSnapshotId;
      }
    }

    return undefined;
  }

  async function tryServeAnalysisFromSnapshot(
    projectId: string,
    request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1]
  ) {
    const project = platform.repository.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const snapshotId = await resolveRequestSnapshotId(request);
    if (!snapshotId) {
      return undefined;
    }

    let snapshot = platform.repository.snapshots.get(snapshotId);
    if (!snapshot && platform.persistence.isEnabled()) {
      await platform.persistence.hydrateSnapshot(snapshotId);
      snapshot = platform.repository.snapshots.get(snapshotId);
    }

    if (!snapshot) {
      return undefined;
    }

    const analysisInput = {
      projectId,
      workspaceId: project.workspaceId,
      organizationId: project.organizationId,
      packSnapshotId: snapshot.packSnapshotId,
      packFingerprint: snapshot.normalizedHash,
      environment: snapshot.environment
    };

    const exactPackHit = platform.snapshotAnalysis.createAnalysisFromExactPackCache(analysisInput);
    if (exactPackHit) {
      return platform.cacheAnalysisResult(exactPackHit);
    }

    const assembled = platform.snapshotAnalysis.createAnalysisFromRetrievalAssembly(analysisInput);
    return assembled ? platform.cacheAnalysisResult(assembled) : undefined;
  }

  function shouldAllowLegacyLiveFallback(
    request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1]
  ) {
    if (process.env.ENABLE_LEGACY_LIVE_FALLBACK?.trim() === "true") {
      return true;
    }

    return request.analysisMode === "deep";
  }

  function assertOfflineFirstCoverageOrFallback(
    request: Parameters<Phase1Platform["orchestrator"]["createAnalysis"]>[1]
  ) {
    if (shouldAllowLegacyLiveFallback(request)) {
      return;
    }

    throw new Error(
      "Offline-first coverage not available for this pack. Retrieval-first serving refused legacy live analysis because ENABLE_LEGACY_LIVE_FALLBACK is not enabled."
    );
  }

  function cacheRecommendationSetLocally(
    recommendationSet: ReturnType<Phase1Platform["recommendations"]["getSetByAnalysis"]>
  ) {
    platform.repository.recommendationSets.set(
      recommendationSet.recommendationSetId,
      recommendationSet
    );
    platform.repository.recommendationSetsByAnalysis.set(
      recommendationSet.analysisId,
      recommendationSet.recommendationSetId
    );
    const analysis = platform.repository.analyses.get(recommendationSet.analysisId);
    if (analysis) {
      analysis.recommendationSet = recommendationSet;
      analysis.recommendations = recommendationSet.items;
    }
  }

  function findLocalRecommendationSetByRecommendationId(recommendationId: string) {
    return [...platform.repository.recommendationSets.values()].find((recommendationSet) =>
      recommendationSet.items.some((item) => item.recommendationId === recommendationId)
    );
  }

  function updateRecommendationItemStatusLocally(
    recommendationSetId: string,
    recommendationId: string,
    status: ReturnType<Phase1Platform["recommendations"]["getSetByAnalysis"]>["items"][number]["status"]
  ) {
    const recommendationSet = platform.repository.recommendationSets.get(recommendationSetId);
    if (!recommendationSet) {
      return;
    }

    const updatedSet = {
      ...recommendationSet,
      items: recommendationSet.items.map((item) =>
        item.recommendationId === recommendationId
          ? {
              ...item,
              status
            }
          : item
      )
    };
    cacheRecommendationSetLocally(updatedSet);
  }

  function cacheRecommendationFeedbackLocally(
    feedback: ReturnType<Phase1Platform["recommendations"]["submitFeedback"]>
  ) {
    platform.repository.recommendationFeedback.set(feedback.feedbackId, feedback);
    const feedbackIds =
      platform.repository.recommendationFeedbackByRecommendation.get(feedback.recommendationId) ??
      [];
    if (!feedbackIds.includes(feedback.feedbackId)) {
      feedbackIds.push(feedback.feedbackId);
      platform.repository.recommendationFeedbackByRecommendation.set(
        feedback.recommendationId,
        feedbackIds
      );
    }

    const status =
      feedback.feedbackType === "accepted"
        ? "accepted"
        : feedback.feedbackType === "dismissed"
          ? "dismissed"
          : undefined;
    updateRecommendationItemStatusLocally(
      feedback.recommendationSetId,
      feedback.recommendationId,
      status
    );
  }

  function cacheRecommendationOutcomeLocally(
    outcome: ReturnType<Phase1Platform["recommendations"]["recordOutcome"]>
  ) {
    platform.repository.recommendationOutcomes.set(outcome.outcomeId, outcome);
    const outcomeIds =
      platform.repository.recommendationOutcomesBySet.get(outcome.recommendationSetId) ?? [];
    if (!outcomeIds.includes(outcome.outcomeId)) {
      outcomeIds.push(outcome.outcomeId);
      platform.repository.recommendationOutcomesBySet.set(
        outcome.recommendationSetId,
        outcomeIds
      );
    }

    for (const recommendationId of outcome.appliedRecommendationIds) {
      updateRecommendationItemStatusLocally(
        outcome.recommendationSetId,
        recommendationId,
        outcome.status === "validated" ? "applied" : undefined
      );
    }
  }

  async function ensureAnalysisRecord(analysisId: string) {
    let analysis = platform.repository.analyses.get(analysisId);

    if (!analysis && orchestratorBoundary) {
      const remoteAnalysis = await orchestratorBoundary.getAnalysis(analysisId);
      platform.cacheAnalysisResult(remoteAnalysis);
      analysis = platform.repository.analyses.get(analysisId);
    }

    if (!analysis && platform.persistence.isEnabled()) {
      const hydrated = await platform.persistence.hydrateAnalysis(analysisId);
      if (hydrated) {
        platform.cacheAnalysisResult(hydrated);
        analysis = platform.repository.analyses.get(analysisId);
      }
    }

    if (!analysis) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    return analysis;
  }

  function shouldAllowAdvancedRuntimeForServingMode(
    servingMode: ReturnType<Phase1Platform["orchestrator"]["getAnalysis"]>["analysis"]["servingMode"]
  ) {
    if (process.env.ENABLE_ADVANCED_RUNTIME_ENRICHMENT?.trim() === "true") {
      return true;
    }

    return servingMode === "legacy_live_analysis" || servingMode === "offline_benchmark";
  }

  async function ensureAdvancedRuntimeAllowed(
    analysisId: string,
    capability: "graph" | "simulation" | "ml" | "recommendations"
  ) {
    const analysis = await ensureAnalysisRecord(analysisId);
    if (shouldAllowAdvancedRuntimeForServingMode(analysis.summary.servingMode)) {
      return analysis;
    }

    throw new Error(
      `${capability} is not available for snapshot-served analyses unless ENABLE_ADVANCED_RUNTIME_ENRICHMENT=true.`
    );
  }

  function buildSnapshotRecommendationSetFromAnalysis(
    analysisId: string
  ): ReturnType<Phase1Platform["recommendations"]["getSetByAnalysis"]> {
    const analysis = platform.repository.analyses.get(analysisId);
    if (!analysis) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    const recommendationSet = {
      recommendationSetId: `recset_snapshot_${analysisId}`,
      analysisId,
      generationStrategy: "snapshot_precomputed",
      items: analysis.recommendations,
      bundles: [],
      summary: {
        recommendationCount: analysis.recommendations.length,
        bundleCount: 0,
        unresolvedFindingCount: analysis.findings.length
      },
      tenantId: analysis.summary.organizationId,
      schemaVersion: 1,
      createdAt: analysis.summary.finishedAt ?? analysis.summary.createdAt
    };

    cacheRecommendationSetLocally(recommendationSet);
    return recommendationSet;
  }

  async function requireAnalysisAccess(
    analysisId: string,
    context: TenantContext | undefined,
    permission: Permission
  ) {
    if (!context) {
      return ensureAnalysisRecord(analysisId);
    }

    try {
      checkPermission(context, permission);
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        auditDenied(context, "auth.permission_denied", "analysis", analysisId);
      }
      throw err;
    }

    const analysis = await ensureAnalysisRecord(analysisId);
    if (analysis.summary.organizationId !== context.organizationId) {
      auditDenied(context, "auth.permission_denied", "analysis", analysisId);
      throw new Error(
        `Analysis ${analysisId} does not belong to organization ${context.organizationId}.`
      );
    }

    return analysis;
  }

  async function buildRecommendationGenerationPayload(
    analysisId: string
  ): Promise<RecommendationGenerationPayload> {
    let analysis = platform.repository.analyses.get(analysisId);
    if (!analysis && orchestratorBoundary) {
      const remoteAnalysis = await orchestratorBoundary.getAnalysis(analysisId);
      platform.cacheAnalysisResult(remoteAnalysis);
      analysis = platform.repository.analyses.get(analysisId);
    }

    if (!analysis && platform.persistence.isEnabled()) {
      const hydrated = await platform.persistence.hydrateAnalysis(analysisId);
      if (hydrated) {
        platform.cacheAnalysisResult(hydrated);
        analysis = platform.repository.analyses.get(analysisId);
      }
    }

    if (!analysis) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    const snapshotId = analysis.summary.packSnapshotId;
    if (!snapshotId) {
      throw new Error(`Analysis snapshot not found: ${analysisId}`);
    }

    let snapshot = platform.repository.snapshots.get(snapshotId);
    if (!snapshot && platform.persistence.isEnabled()) {
      await platform.persistence.hydrateSnapshot(snapshotId);
      snapshot = platform.repository.snapshots.get(snapshotId);
    }
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    return {
      analysisId,
      tenantId: analysis.summary.organizationId,
      snapshot,
      findings: analysis.findings,
      projects: [...platform.repository.canonicalProjects.values()].map((project) => ({
        projectId: project.projectId,
        displayName: project.displayName,
        recommendedReplacementProjectIds: project.recommendedReplacementProjectIds
      })),
      versions: [...platform.repository.canonicalVersions.values()].map((version) => ({
        versionId: version.versionId,
        projectId: version.projectId,
        versionLabel: version.versionLabel,
        loaders: version.loaders,
        minecraftVersions: version.minecraftVersions
      }))
    };
  }

  async function generateRecommendationSetViaBoundary(analysisId: string, context?: TenantContext) {
    if (!recommendationBoundary) {
      throw new Error("Recommendation boundary is not configured.");
    }

    const payload = await buildRecommendationGenerationPayload(analysisId);
    const recommendationSet = await recommendationBoundary.generateRecommendations(
      payload,
      buildBoundaryIdempotencyKey("recommendation-generate", payload),
      context
    );
    cacheRecommendationSetLocally(recommendationSet);
    const remoteRecommendationSet = await recommendationBoundary.getRecommendations(analysisId);
    cacheRecommendationSetLocally(remoteRecommendationSet);
    return remoteRecommendationSet;
  }

  function syncGraphToBoundary(
    graph: NonNullable<ReturnType<Phase1Platform["graph"]["getGraph"]>>
  ) {
    if (!graphBoundary) {
      return Promise.resolve();
    }

    return graphBoundary.syncGraph(
      graph,
      buildBoundaryIdempotencyKey("graph-sync", {
        analysisId: graph.analysisId,
        nodes: graph.nodes,
        edges: graph.edges
      })
    );
  }

  function syncExplanationToBoundary(
    explanation: ReturnType<Phase1Platform["graph"]["explainFinding"]>
  ) {
    if (!graphBoundary) {
      return Promise.resolve();
    }

    return graphBoundary.syncExplanation(
      explanation,
      buildBoundaryIdempotencyKey("graph-explanation", {
        analysisId: explanation.analysisId,
        findingId: explanation.findingId,
        nodes: explanation.nodes,
        edges: explanation.edges
      })
    );
  }

  return {
    config,
    logger,
    routes,
    platform,
    auth: {
      getSessionFromHeaders(headers) {
        return platform.auth.createSessionFromToken(extractBearerToken(headers), platform.persistence);
      },
      resolveTenantContext,
      requireTenantContext
    },
    serviceBoundaries: {
      catalog: catalogBoundary
        ? {
            mode: "http",
            baseUrl: catalogBoundary.baseUrl
          }
        : {
            mode: "in-process"
          },
      evidence: evidenceBoundary
        ? {
            mode: "http",
            baseUrl: evidenceBoundary.baseUrl
          }
        : {
            mode: "in-process"
          },
      admin: adminBoundary
        ? {
            mode: "http",
            baseUrl: adminBoundary.baseUrl
          }
        : {
            mode: "in-process"
          },
      recommendation: recommendationBoundary
        ? {
            mode: "http",
            baseUrl: recommendationBoundary.baseUrl
          }
        : {
            mode: "in-process"
          },
      graph: graphBoundary
        ? {
            mode: "http",
            baseUrl: graphBoundary.baseUrl
          }
        : {
            mode: "in-process"
          },
      simulation: simulationBoundary
        ? {
            mode: "http",
            baseUrl: simulationBoundary.baseUrl
          }
        : {
            mode: "in-process"
          },
      orchestrator: orchestratorBoundary
        ? {
            mode: "http",
            baseUrl: orchestratorBoundary.baseUrl
          }
        : {
            mode: "in-process"
          }
    },
    handlers: {
      getSession(token) {
        return platform.auth.createSessionFromToken(token, platform.persistence);
      },
      createWorkspace(input) {
        return platform.workspace.createWorkspace(input);
      },
      createProject(input) {
        return platform.workspace.createProject(input);
      },
      importModList(input, context) {
        if (context) {
          try {
            checkWritePermission(context, "imports:write");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "import", input.projectId);
            }
            throw err;
          }
        }
        const result = platform.imports.importModList(input);
        if (context) {
          auditSuccess(context, "import.created", "import", result.importRecord.importId);
        }
        return result;
      },
      submitAnalysisRequest(projectId, request, context) {
        if (context) {
          try {
            checkWritePermission(context, "analyses:write");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "analysis", projectId);
            }
            throw err;
          }
        }
        const idempotencyKey = buildAnalysisIdempotencyKey(projectId, request);

        return Promise.resolve()
          .then(() => tryServeAnalysisFromSnapshot(projectId, request))
          .then((served) => {
            if (served) {
              inProcessAnalysisRequests.set(idempotencyKey, {
                idempotencyKey,
                status: "completed",
                analysisId: served.analysis.analysisId
              });
              if (context) {
                platform.quota.recordAnalysisStarted(context.organizationId);
                platform.quota.recordAnalysisFinished(context.organizationId);
                auditSuccess(context, "analysis.created", "analysis", served.analysis.analysisId);
              }
              return served;
            }

            assertOfflineFirstCoverageOrFallback(request);

            if (orchestratorBoundary) {
              return Promise.resolve()
                .then(() => prepareBoundaryAnalysisRequest(projectId, request))
                .then((prepared) =>
                  orchestratorBoundary.submitAnalysis(
                    {
                      projectId,
                      request: prepared.request,
                      idempotencyKey: prepared.idempotencyKey
                    },
                    context
                  )
                )
                .then((submission) =>
                  "analysis" in submission ? platform.cacheAnalysisResult(submission) : submission
                );
            }

            return Promise.resolve().then(() => {
              const result = platform.orchestrator.createAnalysis(projectId, request);
              inProcessAnalysisRequests.set(idempotencyKey, {
                idempotencyKey,
                status: "completed",
                analysisId: result.analysis.analysisId
              });
              return result;
            });
          });
      },
      async createAnalysis(projectId, request, context) {
        if (context) {
          try {
            checkWritePermission(context, "analyses:write");
            // Use per-org plan from the billing boundary when available;
            // fall back to the default plan for local dev / self-hosted.
            const plan = billingBoundary
              ? await billingBoundary.getPlanForOrg(context.organizationId)
              : DEFAULT_QUOTA_PLAN;
            platform.quota.assertCanStartAnalysis(context.organizationId, plan);
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "analysis", projectId);
            }
            throw err;
          }
        }

        const served = await tryServeAnalysisFromSnapshot(projectId, request);
        if (served) {
          inProcessAnalysisRequests.set(buildAnalysisIdempotencyKey(projectId, request), {
            idempotencyKey: buildAnalysisIdempotencyKey(projectId, request),
            status: "completed",
            analysisId: served.analysis.analysisId
          });
          if (context) {
            platform.quota.recordAnalysisStarted(context.organizationId);
            platform.quota.recordAnalysisFinished(context.organizationId);
            auditSuccess(context, "analysis.created", "analysis", served.analysis.analysisId);
          }
          return served;
        }

        assertOfflineFirstCoverageOrFallback(request);

        if (orchestratorBoundary) {
          return Promise.resolve()
            .then(() => prepareBoundaryAnalysisRequest(projectId, request))
            .then((prepared) =>
              orchestratorBoundary.createAnalysis(
                {
                  projectId,
                  request: prepared.request,
                  idempotencyKey: prepared.idempotencyKey
                },
                context
              )
            )
            .then((result) => {
              const cached = platform.cacheAnalysisResult(result);
              if (context) {
                platform.quota.recordAnalysisStarted(context.organizationId);
                platform.quota.recordAnalysisFinished(context.organizationId);
                auditSuccess(context, "analysis.created", "analysis", cached.analysis.analysisId);
              }
              return cached;
            });
        }
        const result = platform.orchestrator.createAnalysis(projectId, request);
        inProcessAnalysisRequests.set(buildAnalysisIdempotencyKey(projectId, request), {
          idempotencyKey: buildAnalysisIdempotencyKey(projectId, request),
          status: "completed",
          analysisId: result.analysis.analysisId
        });
        if (context) {
          platform.quota.recordAnalysisStarted(context.organizationId);
          platform.quota.recordAnalysisFinished(context.organizationId);
          auditSuccess(context, "analysis.created", "analysis", result.analysis.analysisId);
        }
        return result;
      },
      getAnalysisRequestStatus(idempotencyKey) {
        if (orchestratorBoundary) {
          return orchestratorBoundary.getRequestStatus(idempotencyKey);
        }

        const localState = inProcessAnalysisRequests.get(idempotencyKey);
        if (!localState) {
          throw new Error(`Analysis request not found for idempotency key ${idempotencyKey}.`);
        }

        return localState;
      },
      cancelAnalysisRequest(idempotencyKey) {
        if (orchestratorBoundary) {
          return orchestratorBoundary.cancelRequest(idempotencyKey);
        }

        const localState = inProcessAnalysisRequests.get(idempotencyKey);
        if (!localState) {
          throw new Error(`Analysis request not found for idempotency key ${idempotencyKey}.`);
        }

        return localState;
      },
      getAnalysis(analysisId, context) {
        const run = () => {
          if (orchestratorBoundary) {
            return orchestratorBoundary
              .getAnalysis(analysisId, context)
              .then((result) => platform.cacheAnalysisResult(result));
          }
          return platform.orchestrator.getAnalysis(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(run);
        }
        return run();
      },
      getAnalysisArtifacts(analysisId, context) {
        const run = () => {
          if (orchestratorBoundary) {
            return orchestratorBoundary
              .getAnalysis(analysisId, context)
              .then((result) => result.artifacts ?? []);
          }
          return platform.orchestrator.getAnalysis(analysisId).artifacts ?? [];
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(run);
        }
        return run();
      },
      getAnalysisGraph(analysisId, context) {
        const run = async () => {
          const localGraph = platform.graph.getGraph(analysisId);
          if (!localGraph) {
            await ensureAdvancedRuntimeAllowed(analysisId, "graph");
          }

          if (graphBoundary) {
            if (preferServiceOwnedGraphDerivation) {
              return graphBoundary.getGraph(analysisId, context).catch((error) => {
                if (!localGraph || !isBoundaryNotFoundError(error, "graph_not_found")) {
                  throw error;
                }

                return syncGraphToBoundary(localGraph).then(() => graphBoundary.getGraph(analysisId, context));
              });
            }
            if (!localGraph) {
              return undefined;
            }
            return syncGraphToBoundary(localGraph).then(() => graphBoundary.getGraph(analysisId, context));
          }
          return platform.graph.getGraph(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "graph:read").then(run);
        }
        return run();
      },
      getGraphNeighborhood(analysisId, nodeId, depth = 1, context) {
        const run = async () => {
          const localGraph = platform.graph.getGraph(analysisId);
          if (!localGraph) {
            await ensureAdvancedRuntimeAllowed(analysisId, "graph");
          }

          if (graphBoundary) {
            if (preferServiceOwnedGraphDerivation) {
              return graphBoundary.getNeighborhood(analysisId, nodeId, depth, context).catch((error) => {
                if (!localGraph || !isBoundaryNotFoundError(error, "neighborhood_not_found")) {
                  throw error;
                }

                return syncGraphToBoundary(localGraph).then(() =>
                  graphBoundary.getNeighborhood(analysisId, nodeId, depth, context)
                );
              });
            }
            if (!localGraph) {
              throw new Error(`Graph not found: ${analysisId}`);
            }
            return syncGraphToBoundary(localGraph).then(() =>
              graphBoundary.getNeighborhood(analysisId, nodeId, depth, context)
            );
          }
          return platform.graph.getNeighborhood(analysisId, nodeId, depth);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "graph:read").then(run);
        }
        return run();
      },
      explainFinding(analysisId, findingId, context) {
        const run = async () => {
          const localGraph = platform.graph.getGraph(analysisId);
          if (!localGraph) {
            await ensureAdvancedRuntimeAllowed(analysisId, "graph");
          }

          if (graphBoundary) {
            if (preferServiceOwnedGraphDerivation) {
              return graphBoundary.explainFinding(analysisId, findingId, context).catch((error) => {
                if (!localGraph || !isBoundaryNotFoundError(error, "explanation_not_found")) {
                  throw error;
                }

              let explanation: ReturnType<Phase1Platform["graph"]["explainFinding"]>;
              try {
                explanation = platform.graph.explainFinding(analysisId, findingId);
              } catch {
                throw error;
                }
                return syncGraphToBoundary(localGraph)
                  .then(() => syncExplanationToBoundary(explanation))
                  .then(() => graphBoundary.explainFinding(analysisId, findingId, context));
              });
            }
            if (!localGraph) {
              throw new Error(`Graph not found: ${analysisId}`);
            }
            const explanation = platform.graph.explainFinding(analysisId, findingId);
            return syncGraphToBoundary(localGraph)
              .then(() => syncExplanationToBoundary(explanation))
              .then(() => graphBoundary.explainFinding(analysisId, findingId, context));
          }
          return platform.graph.explainFinding(analysisId, findingId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "graph:read").then(run);
        }
        return run();
      },
      syncEvidence(connectorNames, context) {
        if (context) {
          try {
            checkWritePermission(context, "evidence:sync");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "evidence", context.organizationId);
            }
            throw err;
          }
        }
        if (evidenceBoundary) {
          return evidenceBoundary.sync(
            connectorNames,
            buildBoundaryIdempotencyKey("evidence-sync", {
              connectorNames: [...(connectorNames ?? [])].sort()
            }),
            context
          );
        }
        return platform.evidence.syncFixtures(connectorNames);
      },
      searchEvidence(input) {
        if (evidenceBoundary) {
          return evidenceBoundary.search(input);
        }
        return platform.evidence.search(input);
      },
      getFindingEvidence(analysisId, findingId, limit = 5, context) {
        const run = () =>
          evidenceBoundary
            ? evidenceBoundary.getFindingEvidence(analysisId, findingId, limit, context)
            : platform.evidence.getFindingEvidence(analysisId, findingId, limit);
        if (context) {
          return requireAnalysisAccess(analysisId, context, "evidence:read").then(run);
        }
        if (evidenceBoundary) {
          return evidenceBoundary.getFindingEvidence(analysisId, findingId, limit, context);
        }
        return platform.evidence.getFindingEvidence(analysisId, findingId, limit);
      },
      createRuleDraft(input, context) {
        if (context) {
          try {
            checkWritePermission(context, "admin:rules");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "rule_draft", input.ruleId ?? "new");
            }
            throw err;
          }
        }
        if (adminBoundary) {
          return adminBoundary.createRuleDraft(
            input,
            buildAdminIdempotencyKey("create-rule-draft", input),
            context
          );
        }
        return platform.ruleDrafts.createDraft(input);
      },
      validateRuleDraft(draftId, strict = false, context) {
        if (context) {
          try {
            checkWritePermission(context, "admin:rules");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "rule_draft", draftId);
            }
            throw err;
          }
        }
        if (adminBoundary) {
          return adminBoundary.validateRuleDraft(
            draftId,
            { strict },
            buildAdminIdempotencyKey("validate-rule-draft", { draftId, strict }),
            context
          );
        }
        return platform.ruleDrafts.validateDraft(draftId, strict);
      },
      getRuleDraft(draftId, context) {
        if (context) {
          checkPermission(context, "admin:rules");
        }
        if (adminBoundary) {
          return adminBoundary.getRuleDraft(draftId, context);
        }
        return platform.ruleDrafts.getDraft(draftId);
      },
      listRuleDrafts(status, context) {
        if (context) {
          checkPermission(context, "admin:rules");
        }
        if (adminBoundary) {
          return adminBoundary.listRuleDrafts(status, context);
        }
        return platform.ruleDrafts.listDrafts(status);
      },
      getRuleHistory(ruleId, context) {
        if (context) {
          checkPermission(context, "admin:rules");
        }
        if (adminBoundary) {
          return adminBoundary.getRuleHistory(ruleId, context);
        }
        return platform.ruleDrafts.getRuleHistory(ruleId);
      },
      promoteRuleDraft(input, context) {
        if (context) {
          try {
            checkWritePermission(context, "admin:rules");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "rule_draft", input.draftId);
            }
            throw err;
          }
        }
        if (adminBoundary) {
          return adminBoundary.promoteRuleDraft(
            input,
            buildAdminIdempotencyKey("promote-rule-draft", input),
            context
          );
        }
        return platform.ruleDrafts.promoteDraft(input);
      },
      createEvidenceCuration(input, context) {
        if (context) {
          try {
            checkWritePermission(context, "evidence:curate");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(
                context,
                "auth.permission_denied",
                "evidence_curation",
                context.organizationId
              );
            }
            throw err;
          }
        }
        if (adminBoundary) {
          return adminBoundary.createEvidenceCuration(
            input,
            buildAdminIdempotencyKey("create-curation", input),
            context
          );
        }
        const result = platform.evidence.createCuration(input);
        if (context) {
          auditSuccess(
            context,
            "evidence.curation_created",
            "evidence_curation",
            result.curationId
          );
        }
        return result;
      },
      promoteVerifiedRule(input, context) {
        if (context) {
          try {
            checkWritePermission(context, "evidence:promote");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "verified_rule", input.curationId);
            }
            throw err;
          }
        }
        if (adminBoundary) {
          return adminBoundary
            .promoteVerifiedRule(input, buildAdminIdempotencyKey("promote-rule", input), context)
            .then(async (promotion) => {
              if (platform.persistence.isEnabled()) {
                await platform.persistence.hydrateAdminState(promotion.curation.curationId);
              }
              if (context) {
                auditSuccess(
                  context,
                  "evidence.rule_promoted",
                  "verified_rule",
                  promotion.curation.curationId
                );
              }
              return promotion;
            });
        }
        const promotion = platform.evidence.promoteVerifiedRule(input);
        if (context) {
          auditSuccess(
            context,
            "evidence.rule_promoted",
            "verified_rule",
            promotion.curation.curationId
          );
        }
        return promotion;
      },
      getRecommendations(analysisId, context) {
        const run = async () => {
        const analysis = await ensureAnalysisRecord(analysisId);
        if (!shouldAllowAdvancedRuntimeForServingMode(analysis.summary.servingMode)) {
          const recommendationSetId = platform.repository.recommendationSetsByAnalysis.get(analysisId);
          const existing = recommendationSetId
            ? platform.repository.recommendationSets.get(recommendationSetId)
            : undefined;
          return existing ?? buildSnapshotRecommendationSetFromAnalysis(analysisId);
        }
        if (recommendationBoundary) {
          if (preferServiceOwnedRecommendationHydration) {
            return recommendationBoundary.getRecommendations(analysisId, context)
              .then((recommendationSet) => {
                cacheRecommendationSetLocally(recommendationSet);
                return recommendationSet;
              })
              .catch((error) => {
                if (!isBoundaryNotFoundError(error, "recommendation_set_not_found")) {
                  throw error;
                }

                return generateRecommendationSetViaBoundary(analysisId, context);
              });
          }

          return generateRecommendationSetViaBoundary(analysisId, context);
        }
        return platform.recommendations.getSetByAnalysis(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "recommendations:read").then(run);
        }
        return run();
      },
      submitRecommendationFeedback(input) {
        if (recommendationBoundary) {
          const recommendationSet = findLocalRecommendationSetByRecommendationId(
            input.recommendationId
          );
          if (!recommendationSet) {
            throw new Error(`Recommendation not found: ${input.recommendationId}`);
          }

          return recommendationBoundary
            .submitFeedback(
              recommendationSet.analysisId,
              input,
              buildBoundaryIdempotencyKey("recommendation-feedback", {
                analysisId: recommendationSet.analysisId,
                recommendationId: input.recommendationId,
                feedbackType: input.feedbackType,
                note: input.note,
                createdBy: input.createdBy
              })
            )
            .then((feedback) => {
              cacheRecommendationFeedbackLocally(feedback);
              return feedback;
            });
        }
        return platform.recommendations.submitFeedback(input);
      },
      recordRecommendationOutcome(input) {
        if (recommendationBoundary) {
          return recommendationBoundary
            .recordOutcome(
              input,
              buildBoundaryIdempotencyKey("recommendation-outcome", {
                recommendationSetId: input.recommendationSetId,
                status: input.status,
                appliedRecommendationIds: input.appliedRecommendationIds,
                validationSummary: input.validationSummary,
                createdBy: input.createdBy
              })
            )
            .then((outcome) => {
              cacheRecommendationOutcomeLocally(outcome);
              return outcome;
            });
        }
        return platform.recommendations.recordOutcome(input);
      },
      getAnalysisFeatureDataset(analysisId, context) {
        const run = async () => {
          const existing = platform.ml.getDatasetForAnalysis(analysisId);
          if (existing) {
            return existing;
          }
          await ensureAdvancedRuntimeAllowed(analysisId, "ml");
          return platform.ml.getDatasetForAnalysis(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(run);
        }
        return run();
      },
      getPackReviewSummary(analysisId, context) {
        const run = async () => {
          const existing = platform.ml.getReviewSummary(analysisId);
          if (existing) {
            return existing;
          }
          await ensureAdvancedRuntimeAllowed(analysisId, "ml");
          return platform.ml.getReviewSummary(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(run);
        }
        return run();
      },
      getSimulationRun(analysisId, context) {
        const run = async () => {
        const existingRun = platform.repository.simulationRuns.get(analysisId);
        if (!existingRun) {
          await ensureAdvancedRuntimeAllowed(analysisId, "simulation");
        }
        if (simulationBoundary) {
          const syncLocalRunToBoundary = (run: ReturnType<Phase1Platform["simulation"]["getRun"]>) =>
            simulationBoundary
              .syncRun(
                run,
                buildBoundaryIdempotencyKey("simulation-run", {
                  analysisId: run.analysisId,
                  simulationRunId: run.simulationRunId,
                    status: run.status,
                    observationIds: run.observations.map((observation) => observation.observationId)
                }),
                context
              )
              .then(() => simulationBoundary.getRun(analysisId, context));

          if (preferServiceOwnedSimulationHydration) {
            return simulationBoundary.getRun(analysisId, context).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              const localRun = platform.repository.simulationRuns.get(analysisId);
              if (!localRun || (!message.includes("(404") && !message.includes("simulation_run_not_found"))) {
                throw error;
              }
              return syncLocalRunToBoundary(localRun);
            });
          }
          const run = platform.simulation.getRun(analysisId);
          return syncLocalRunToBoundary(run);
        }
        return platform.simulation.getRun(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(run);
        }
        return run();
      },
      getReleaseGateDecision(analysisId, context) {
        const run = async () => {
          const existing = platform.releaseGates.getDecision(analysisId);
          if (existing) {
            return existing;
          }
          await ensureAdvancedRuntimeAllowed(analysisId, "simulation");
          return platform.releaseGates.getDecision(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(run);
        }
        return run();
      },
      getStatusCheck(analysisId, context) {
        const run = async () => {
          const existing = platform.notifications.getStatusCheck(analysisId);
          if (existing) {
            return existing;
          }
          await ensureAdvancedRuntimeAllowed(analysisId, "simulation");
          return platform.notifications.getStatusCheck(analysisId);
        };
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(run);
        }
        return run();
      },
      linkGitHubInstallation(input) {
        return platform.integrations.linkGitHubInstallation(input);
      },
      createWebhook(input, context) {
        if (context) {
          try {
            checkWritePermission(context, "webhooks:manage");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "webhook", context.organizationId);
            }
            throw err;
          }
        }
        return platform.notifications.registerWebhook(input);
      },
      listWebhooks() {
        return platform.notifications.listWebhooks();
      },
      listWebhookDeliveries(analysisId, context) {
        if (context) {
          return requireAnalysisAccess(analysisId, context, "analyses:read").then(() =>
            platform.notifications.listDeliveries(analysisId)
          );
        }
        return platform.notifications.listDeliveries(analysisId);
      },
      getAnalysisReport(analysisId, context) {
        if (context) {
          return requireAnalysisAccess(analysisId, context, "reports:read").then(() =>
            platform.reports.getReport(analysisId)
          );
        }
        return platform.reports.getReport(analysisId);
      },
      exportAnalysisReport(input, context) {
        if (context) {
          try {
            checkPermission(context, "reports:export");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "report", input.analysisId);
            }
            throw err;
          }
          auditSuccess(context, "report.exported", "report", input.analysisId);
        }
        return platform.reports.exportReport(input);
      },
      createPackDiff(projectId, request) {
        return platform.orchestrator.createPackDiff(projectId, request);
      },
      getPackDiff(packDiffId) {
        return platform.diffs.getDiff(packDiffId);
      },
      getDemoFlow() {
        return platform.createDemoFlow();
      },
      async buildAndPromoteSnapshot(options, context) {
        if (context) {
          try {
            checkWritePermission(context, "analyses:write");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "knowledge_snapshot", "build");
            }
            throw err;
          }
        }
        const result = platform.knowledgeSynthesis.buildAndPromoteSnapshot(options);

        // Persist snapshot and all related data to database
        if (platform.persistence.isEnabled()) {
          const snapshotId = result.snapshot.snapshotId;

          // Persist the snapshot itself
          await platform.persistence.persistKnowledgeSnapshot(snapshotId);

          // Persist all claims for this snapshot
          const claims =
            platform.repository.promotedCompatibilityClaimsBySnapshot.get(snapshotId) ?? [];
          for (const claimId of claims) {
            await platform.persistence.persistPromotedCompatibilityClaim(claimId);
          }

          // Persist all pairwise records for this snapshot
          const pairwiseIds =
            platform.repository.pairwiseCompatibilityBySnapshot.get(snapshotId) ?? [];
          for (const recordId of pairwiseIds) {
            await platform.persistence.persistPairwiseCompatibilityRecord(recordId);
          }

          // Persist all fragment records for this snapshot
          const fragmentIds =
            platform.repository.fragmentCompatibilityBySnapshot.get(snapshotId) ?? [];
          for (const recordId of fragmentIds) {
            await platform.persistence.persistFragmentCompatibilityRecord(recordId);
          }

          // Persist all signatures for this snapshot
          const signatureIds =
            platform.repository.technicalConflictSignaturesBySnapshot.get(snapshotId) ?? [];
          for (const signatureId of signatureIds) {
            await platform.persistence.persistTechnicalConflictSignature(signatureId);
          }
        }

        if (context) {
          auditSuccess(
            context,
            "analysis.created" as AuditEventType,
            "knowledge_snapshot",
            result.snapshot.snapshotId
          );
        }
        return result;
      },
      scheduleArtifactAnalysis(versionIds, context) {
        if (context) {
          try {
            checkWritePermission(context, "analyses:write");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "artifact_analysis", "schedule");
            }
            throw err;
          }
        }
        return platform.knowledgeSynthesis.scheduleArtifactAnalysis(versionIds);
      },
      getActiveSnapshotSummary(_context) {
        const activeSnapshot = platform.knowledgeSynthesis.getActiveSnapshot();
        if (!activeSnapshot) {
          return undefined;
        }
        return platform.knowledgeSynthesis.getSnapshotSummary(activeSnapshot.snapshotId);
      },
      generateCandidatesForPipeline1(snapshotId, _context) {
        const snapshot = platform.repository.knowledgeSnapshots.get(snapshotId);
        if (!snapshot) {
          throw new Error(`Snapshot not found: ${snapshotId}`);
        }
        return platform.knowledgeSynthesis.generateCandidatesForPipeline1(snapshotId);
      },
      approveSnapshot(snapshotId, input, context) {
        if (context) {
          try {
            checkWritePermission(context, "analyses:write");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "knowledge_snapshot", snapshotId);
            }
            throw err;
          }
        }
        const snapshot = platform.knowledgeSynthesis.approveSnapshot(
          snapshotId,
          input.approvedBy,
          input.note
        );
        if (platform.persistence.isEnabled()) {
          return platform.persistence.persistKnowledgeSnapshot(snapshot.snapshotId).then(() => snapshot);
        }
        return snapshot;
      },
      async triggerSnapshotRefresh(options, context) {
        if (context) {
          try {
            checkWritePermission(context, "analyses:write");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "knowledge_snapshot", "refresh");
            }
            throw err;
          }
        }

        const result = platform.knowledgeSynthesis.triggerSnapshotRefresh(options);

        // If a snapshot was triggered and persistence is enabled, persist it
        if (result.triggered && platform.persistence.isEnabled()) {
          const activeSnapshot = platform.knowledgeSynthesis.getActiveSnapshot();
          if (activeSnapshot) {
            const snapshotId = activeSnapshot.snapshotId;

            // Persist the snapshot itself
            await platform.persistence.persistKnowledgeSnapshot(snapshotId);

            // Persist all claims for this snapshot
            const claims =
              platform.repository.promotedCompatibilityClaimsBySnapshot.get(snapshotId) ?? [];
            for (const claimId of claims) {
              await platform.persistence.persistPromotedCompatibilityClaim(claimId);
            }

            // Persist all pairwise records for this snapshot
            const pairwiseIds =
              platform.repository.pairwiseCompatibilityBySnapshot.get(snapshotId) ?? [];
            for (const recordId of pairwiseIds) {
              await platform.persistence.persistPairwiseCompatibilityRecord(recordId);
            }

            // Persist all fragment records for this snapshot
            const fragmentIds =
              platform.repository.fragmentCompatibilityBySnapshot.get(snapshotId) ?? [];
            for (const recordId of fragmentIds) {
              await platform.persistence.persistFragmentCompatibilityRecord(recordId);
            }

            // Persist all signatures for this snapshot
            const signatureIds =
              platform.repository.technicalConflictSignaturesBySnapshot.get(snapshotId) ?? [];
            for (const signatureId of signatureIds) {
              await platform.persistence.persistTechnicalConflictSignature(signatureId);
            }
          }
        }

        return result;
      },
      runOfflineRefresh(input, context) {
        if (context) {
          try {
            checkWritePermission(context, "analyses:write");
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "offline_refresh", "run");
            }
            throw err;
          }
        }
        if (orchestratorBoundary) {
          return orchestratorBoundary.runOfflineRefresh(input, context);
        }

        const artifactAnalysis = platform.knowledgeSynthesis.processPendingArtifactAnalysis(
          input.artifactLimit
        );
        return {
          artifactAnalysis: {
            processed: artifactAnalysis.processed,
            signaturesGenerated: artifactAnalysis.signaturesGenerated,
            versionIds: artifactAnalysis.versionIds
          }
        };
      },
      ingestCatalog(payload, _context) {
        return platform.catalogIngestion.bulkIngest(payload);
      },
      ingestEvidence(payload, _context) {
        return platform.evidenceIngestion.bulkIngestEvidence(payload);
      },
      async resolveMods(input, context) {
        if (context) {
          try {
            checkPermission(context, "projects:read" as Permission);
          } catch (err) {
            if (err instanceof PermissionDeniedError) {
              auditDenied(context, "auth.permission_denied", "mods", "resolve");
            }
            throw err;
          }
          auditSuccess(context, "analysis.created" as AuditEventType, "mods", "batch");
        }

        if (catalogBoundary) {
          return catalogBoundary.resolveMods(input, context);
        }

        const { ModResolver } = await import("../../catalog/src/index.js");
        const resolver = new ModResolver(process.env.CURSEFORGE_API_KEY);

        const { mods: modLookups, minecraftVersion, loader } = input;
        const mods = await resolver.resolveMultipleMods(modLookups, {
          minecraftVersion,
          loader,
          exactMatch: false
        });

        return {
          mods,
          totalRequested: modLookups.length,
          totalFound: mods.length,
          sources: {
            curseforge: mods.filter((m: any) => m.source === "curseforge").length,
            modrinth: mods.filter((m: any) => m.source === "modrinth").length
          }
        };
      }
    }
  };
}
