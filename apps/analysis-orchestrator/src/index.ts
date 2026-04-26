import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadServiceConfig } from "../../../packages/config/src/index.ts";
import { createLogger } from "../../../packages/observability/src/index.ts";
import {
  createPhase1Platform,
  AnalysisCancelledError,
  type Phase1Platform
} from "../../../packages/platform-core/src/index.ts";
import type { CreateAnalysisRequest } from "../../../packages/api-contracts/src/index.ts";
import type { PackSnapshot } from "../../../packages/domain-models/src/index.ts";
import type { CreateAnalysisHttpRequest } from "./temporal/contracts.js";
import { createTemporalExecutionRuntime, type TemporalExecutionRuntime } from "./temporal/runtime.js";

interface ServiceErrorPayload {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    traceId: string;
  };
}

type AnalysisRequestStatus = "started" | "completed" | "failed" | "cancelled";

interface AnalysisRequestState {
  status: AnalysisRequestStatus;
  analysisId?: string;
  errorCode?: string;
  errorMessage?: string;
}

interface LocalAnalysisRequestState extends AnalysisRequestState {
  executionState?: "scheduled" | "running";
}

interface OrchestratorApp {
  config: ReturnType<typeof loadServiceConfig>;
  logger: ReturnType<typeof createLogger>;
  platform: Phase1Platform;
  requestStates: Map<string, LocalAnalysisRequestState>;
  /** AbortControllers for in-flight analyses, keyed by idempotency key. */
  cancellationControllers: Map<string, AbortController>;
  temporal?: TemporalExecutionRuntime;
}

function buildRequestContext(request: IncomingMessage) {
  const requestId = request.headers["x-request-id"]?.toString() ?? `req_${randomUUID()}`;
  const traceId = request.headers["x-trace-id"]?.toString() ?? requestId;
  return { requestId, traceId };
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  context: { requestId: string; traceId: string },
  headers?: Record<string, string>
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": context.requestId,
    "x-trace-id": context.traceId,
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  context: { requestId: string; traceId: string },
  input: {
    code: string;
    message: string;
    retryable: boolean;
  }
) {
  writeJson(
    response,
    statusCode,
    {
      error: {
        code: input.code,
        message: input.message,
        retryable: input.retryable,
        requestId: context.requestId,
        traceId: context.traceId
      }
    } satisfies ServiceErrorPayload,
    context
  );
}

function buildOrchestratorApp(): OrchestratorApp {
  const app: OrchestratorApp = {
    config: loadServiceConfig("orchestrator"),
    logger: createLogger("analysis-orchestrator"),
    platform: createPhase1Platform(),
    requestStates: new Map(),
    cancellationControllers: new Map()
  };

  app.temporal = createTemporalExecutionRuntime({
    address: process.env.TEMPORAL_ADDRESS,
    namespace: process.env.TEMPORAL_NAMESPACE,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE,
    logger: app.logger,
    async executeAnalysis(payload, signal) {
      const result = await executeAnalysis(app, payload, signal);
      return {
        analysisId: result.analysis.analysisId,
        result
      };
    }
  });

  return app;
}

interface GraphContextResponse {
  analysisId: string;
  snapshot: {
    packSnapshotId: string;
    environment: {
      minecraftVersion: string;
      loader: string;
      javaVersion: string;
      side: string;
    };
    mods: Array<{
      name: string;
      version?: string;
      canonicalProjectId?: string;
      canonicalVersionId?: string;
    }>;
  };
  findings: Array<{
    findingId: string;
    title: string;
    subjects: Array<{
      projectId: string;
      versionId?: string;
    }>;
  }>;
  artifacts: Array<{
    artifactAnalysisId: string;
    projectId: string;
    versionId?: string;
    metadata: {
      artifactId: string;
      name: string;
      version?: string;
      loaderHints: string[];
      mixinConfigFiles: string[];
    };
    mixinTargets: Array<{
      ownerArtifactId: string;
      target: string;
    }>;
    classTargets: Array<{
      ownerArtifactId: string;
      target: string;
    }>;
    resourceTargets: Array<{
      ownerArtifactId: string;
      target: string;
    }>;
    embeddedLibraries: Array<{
      ownerArtifactId: string;
      coordinates: string;
      packageHints: string[];
    }>;
  }>;
  projects: Array<{
    projectId: string;
    displayName: string;
  }>;
  versions: Array<{
    versionId: string;
    versionLabel: string;
  }>;
  dependencies: Array<{
    versionId: string;
    dependencyProjectId: string;
    relationType: string;
  }>;
}

interface RecommendationContextResponse {
  analysisId: string;
  tenantId: string;
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
}

interface SimulationRunHydrationResponse {
  simulationRun: NonNullable<ReturnType<Phase1Platform["simulation"]["getRun"]>>;
}

interface OfflineRefreshRequest {
  createdBy?: string;
  connectorNames?: string[];
  catalogMods?: Array<{ name: string; curseforgeProjectId?: number; modrinthProjectId?: string }>;
  minecraftVersion?: string;
  loader?: string;
  artifactLimit?: number;
  forceSnapshot?: boolean;
  approveSnapshot?: boolean;
  promoteSnapshot?: boolean;
}

interface OfflineRefreshResponse {
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
  jarAnalysis?: {
    analyzed: number;
    skipped: number;
    failed: number;
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
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const requestId = `analysis-orchestrator-${randomUUID()}`;
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-trace-id": requestId,
      "x-idempotency-key": requestId
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(
      `Offline refresh dependency request failed (${response.status} ${response.statusText}): ${await response.text()}`
    );
  }

  return (await response.json()) as T;
}

async function runOfflineRefresh(
  app: OrchestratorApp,
  input: OfflineRefreshRequest
): Promise<OfflineRefreshResponse> {
  const response: OfflineRefreshResponse = {
    artifactAnalysis: {
      processed: 0,
      signaturesGenerated: 0,
      versionIds: []
    }
  };

  if (input.catalogMods && input.catalogMods.length > 0 && process.env.CATALOG_SERVICE_URL?.trim()) {
    const catalog = await postJson<{
      totalRequested: number;
      totalFound: number;
    }>(process.env.CATALOG_SERVICE_URL, "/v1/catalog/ingest-live", {
      mods: input.catalogMods,
      minecraftVersion: input.minecraftVersion,
      loader: input.loader,
      createdBy: input.createdBy ?? "analysis-orchestrator"
    });
    response.catalog = catalog;
  }

  if (process.env.EVIDENCE_SERVICE_URL?.trim()) {
    const evidence = await postJson<{
      connectors: unknown[];
      runs: unknown[];
      documents: unknown[];
      snippets: unknown[];
    }>(process.env.EVIDENCE_SERVICE_URL, "/v1/evidence/sync", {
      connectorNames: input.connectorNames
    });
    response.evidence = {
      connectorCount: evidence.connectors.length,
      runCount: evidence.runs.length,
      documentCount: evidence.documents.length,
      snippetCount: evidence.snippets.length
    };
  }

  const pendingQueue = [...app.platform.repository.pendingArtifactAnalysisQueue];
  if (pendingQueue.length > 0) {
    const jarResult = await app.platform.jarAnalysis.fetchAndIngestProfiles(pendingQueue);
    response.jarAnalysis = {
      analyzed: jarResult.analyzed,
      skipped: jarResult.skipped,
      failed: jarResult.failed
    };
  }

  const artifactAnalysis = app.platform.knowledgeSynthesis.processPendingArtifactAnalysis(
    input.artifactLimit
  );
  if (app.platform.persistence.isEnabled()) {
    for (const signatureId of artifactAnalysis.signatureIds) {
      await app.platform.persistence.persistTechnicalConflictSignature(signatureId);
    }
  }
  response.artifactAnalysis = {
    processed: artifactAnalysis.processed,
    signaturesGenerated: artifactAnalysis.signaturesGenerated,
    versionIds: artifactAnalysis.versionIds
  };

  const shouldPromote = input.promoteSnapshot !== false;
  const createdBy = input.createdBy ?? "analysis-orchestrator";
  if (shouldPromote || input.approveSnapshot) {
    const snapshot = app.platform.knowledgeSynthesis.buildCandidateSnapshot({ createdBy });
    const validationReport = app.platform.knowledgeSynthesis.validateSnapshot(snapshot.snapshotId);
    if (validationReport.status === "failed" && !input.forceSnapshot) {
      throw new Error(
        `Offline refresh snapshot validation failed: ${validationReport.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.summary)
          .join("; ")}`
      );
    }
    if (input.approveSnapshot) {
      app.platform.knowledgeSynthesis.approveSnapshot(snapshot.snapshotId, createdBy);
    }
    if (shouldPromote) {
      app.platform.knowledgeSynthesis.promoteSnapshot(snapshot.snapshotId, createdBy);
    }
    if (app.platform.persistence.isEnabled()) {
      await app.platform.persistence.persistKnowledgeSnapshot(snapshot.snapshotId);
    }
    response.snapshot = {
      snapshotId: snapshot.snapshotId,
      version: snapshot.version,
      status: snapshot.status,
      validationStatus: validationReport.status
    };
  }

  return response;
}

function normalizeCreateAnalysisRequest(
  body: Partial<CreateAnalysisHttpRequest> & { request?: CreateAnalysisRequest }
): CreateAnalysisHttpRequest {
  if (!body.projectId || !body.request) {
    throw new Error("Request body must include projectId and request.");
  }

  return {
    projectId: body.projectId,
    request: body.request
  };
}

async function resolveInputRefSnapshotId(
  platform: Phase1Platform,
  inputRef: CreateAnalysisRequest["inputRef"]
): Promise<string> {
  if (inputRef.type === "pack_snapshot") {
    return inputRef.id;
  }

  if (inputRef.type === "import") {
    // Look up the import record (already in-memory or hydrate from persistence).
    const importRecord = platform.repository.imports.get(inputRef.id);
    if (!importRecord) {
      throw new Error(`Import not found: ${inputRef.id}`);
    }
    if (!importRecord.packSnapshotId) {
      throw new Error(`Import ${inputRef.id} has no associated pack snapshot.`);
    }
    return importRecord.packSnapshotId;
  }

  // For manifest and uploaded_mods: treat inputRef.id as a snapshot ID directly.
  // Full import processing for these types is a Phase 9 concern.
  return inputRef.id;
}

async function hydrateExecutionContext(
  platform: Phase1Platform,
  projectId: string,
  request: CreateAnalysisRequest
) {
  if (!platform.persistence.isEnabled()) {
    return;
  }

  await platform.persistence.ensureSchema();
  await platform.persistence.hydrateProject(projectId);

  if (request.inputRef.type === "import") {
    // Hydrate all imports for this project so we can resolve the snapshot ID.
    await platform.persistence.hydrateImportsForProject(projectId);
    const importRecord = platform.repository.imports.get(request.inputRef.id);
    if (!importRecord?.packSnapshotId) {
      throw new Error(
        `Import ${request.inputRef.id} not found or has no snapshot after hydration.`
      );
    }
    await platform.persistence.hydrateSnapshot(importRecord.packSnapshotId);
  } else {
    await platform.persistence.hydrateSnapshot(request.inputRef.id);
  }

  if (request.options?.compareToSnapshotId) {
    await platform.persistence.hydrateSnapshot(request.options.compareToSnapshotId);
  }

  await platform.persistence.hydrateModelRegistryEntries();
  await platform.persistence.hydrateAdminState();
}

async function hydrateAnalysisIfNeeded(platform: Phase1Platform, analysisId: string) {
  if (platform.repository.analyses.has(analysisId)) {
    return;
  }

  if (!platform.persistence.isEnabled()) {
    return;
  }

  const result = await platform.persistence.hydrateAnalysis(analysisId);
  if (result) {
    platform.cacheAnalysisResult(result);
  }
}

async function buildGraphContext(
  platform: Phase1Platform,
  analysisId: string
): Promise<GraphContextResponse> {
  await hydrateAnalysisIfNeeded(platform, analysisId);

  const analysis = platform.repository.analyses.get(analysisId);
  if (!analysis) {
    throw new Error(`Analysis not found: ${analysisId}`);
  }

  const packSnapshotId = analysis.summary.packSnapshotId;
  if (!packSnapshotId) {
    throw new Error(`Analysis snapshot not found: ${analysisId}`);
  }

  if (!platform.repository.snapshots.has(packSnapshotId) && platform.persistence.isEnabled()) {
    await platform.persistence.hydrateSnapshot(packSnapshotId);
  }

  const snapshot = platform.repository.snapshots.get(packSnapshotId);
  if (!snapshot) {
    throw new Error(`Pack snapshot not found: ${packSnapshotId}`);
  }

  const artifacts =
    platform.repository.artifactAnalyses.get(analysisId) ??
    analysis.artifacts ??
    [];

  return {
    analysisId,
    snapshot: {
      packSnapshotId: snapshot.packSnapshotId,
      environment: {
        minecraftVersion: snapshot.environment.minecraftVersion,
        loader: snapshot.environment.loader,
        javaVersion: snapshot.environment.javaVersion,
        side: snapshot.environment.side
      },
      mods: snapshot.mods.map((mod) => ({
        name: mod.name,
        version: mod.version,
        canonicalProjectId: mod.canonicalProjectId,
        canonicalVersionId: mod.canonicalVersionId
      }))
    },
    findings: analysis.findings.map((finding) => ({
      findingId: finding.findingId,
      title: finding.title,
      subjects: finding.subjects.map((subject) => ({
        projectId: subject.projectId,
        versionId: subject.versionId
      }))
    })),
    artifacts: artifacts.map((artifact) => ({
      artifactAnalysisId: artifact.artifactAnalysisId,
      projectId: artifact.projectId,
      versionId: artifact.versionId,
      metadata: {
        artifactId: artifact.metadata.artifactId,
        name: artifact.metadata.name,
        version: artifact.metadata.version,
        loaderHints: artifact.metadata.loaderHints,
        mixinConfigFiles: artifact.metadata.mixinConfigFiles
      },
      mixinTargets: artifact.mixinTargets,
      classTargets: artifact.classTargets,
      resourceTargets: artifact.resourceTargets,
      embeddedLibraries: artifact.embeddedLibraries
    })),
    projects: [...platform.repository.canonicalProjects.values()].map((project) => ({
      projectId: project.projectId,
      displayName: project.displayName
    })),
    versions: [...platform.repository.canonicalVersions.values()].map((version) => ({
      versionId: version.versionId,
      versionLabel: version.versionLabel
    })),
    dependencies: platform.repository.dependencies.map((dependency) => ({
      versionId: dependency.versionId,
      dependencyProjectId: dependency.dependencyProjectId,
      relationType: dependency.relationType
    }))
  };
}

async function buildRecommendationContext(
  platform: Phase1Platform,
  analysisId: string
): Promise<RecommendationContextResponse> {
  await hydrateAnalysisIfNeeded(platform, analysisId);

  const analysis = platform.repository.analyses.get(analysisId);
  if (!analysis) {
    throw new Error(`Analysis not found: ${analysisId}`);
  }

  const packSnapshotId = analysis.summary.packSnapshotId;
  if (!packSnapshotId) {
    throw new Error(`Analysis snapshot not found: ${analysisId}`);
  }

  if (!platform.repository.snapshots.has(packSnapshotId) && platform.persistence.isEnabled()) {
    await platform.persistence.hydrateSnapshot(packSnapshotId);
  }

  const snapshot = platform.repository.snapshots.get(packSnapshotId);
  if (!snapshot) {
    throw new Error(`Pack snapshot not found: ${packSnapshotId}`);
  }

  return {
    analysisId,
    tenantId: analysis.summary.organizationId ?? snapshot.organizationId,
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

async function buildSimulationRunHydration(
  platform: Phase1Platform,
  analysisId: string
): Promise<SimulationRunHydrationResponse> {
  await hydrateAnalysisIfNeeded(platform, analysisId);

  const simulationRun =
    platform.repository.simulationRuns.get(analysisId) ??
    platform.repository.analyses.get(analysisId)?.simulationRun;

  if (!simulationRun) {
    throw new Error(`Simulation run not found: ${analysisId}`);
  }

  return {
    simulationRun
  };
}

async function executeAnalysis(
  app: OrchestratorApp,
  payload: CreateAnalysisHttpRequest,
  signal?: AbortSignal
) {
  await hydrateExecutionContext(app.platform, payload.projectId, payload.request);
  app.platform.evidence.syncFixtures();

  // Resolve the inputRef to a concrete pack_snapshot ID before executing.
  const resolvedSnapshotId = await resolveInputRefSnapshotId(
    app.platform,
    payload.request.inputRef
  );
  const resolvedRequest =
    payload.request.inputRef.type === "pack_snapshot"
      ? payload.request
      : {
          ...payload.request,
          inputRef: { type: "pack_snapshot" as const, id: resolvedSnapshotId }
        };

  const result = app.platform.orchestrator.createAnalysis(
    payload.projectId,
    resolvedRequest,
    signal
  );
  app.platform.cacheAnalysisResult(result);

  if (app.platform.persistence.isEnabled()) {
    await app.platform.persistence.persistAnalysis(result.analysis.analysisId);
  }

  return result;
}

async function readRequestState(app: OrchestratorApp, idempotencyKey: string) {
  const persisted = app.platform.persistence.isEnabled()
    ? await app.platform.persistence.readServiceRequest(
        "analysis-orchestrator",
        "create-analysis",
        idempotencyKey
      )
    : undefined;

  if (persisted) {
    return {
      idempotencyKey,
      status: persisted.status,
      analysisId: persisted.analysisId,
      errorCode: persisted.errorCode,
      errorMessage: persisted.errorMessage
    };
  }

  const inMemory = app.requestStates.get(idempotencyKey);
  if (!inMemory) {
    return undefined;
  }

  return {
    idempotencyKey,
    status: inMemory.status,
    analysisId: inMemory.analysisId,
    errorCode: inMemory.errorCode,
    errorMessage: inMemory.errorMessage
  };
}

async function cancelRequestState(app: OrchestratorApp, idempotencyKey: string) {
  const localState = app.requestStates.get(idempotencyKey);
  const existingState = await readRequestState(app, idempotencyKey);

  if (!existingState) {
    return {
      statusCode: 404,
      state: undefined,
      error: {
        code: "analysis_request_not_found",
        message: `Analysis request not found for idempotency key ${idempotencyKey}.`,
        retryable: false
      }
    } as const;
  }

  if (existingState.status === "cancelled") {
    return {
      statusCode: 200,
      state: existingState
    } as const;
  }

  if (existingState.status === "completed" || existingState.status === "failed") {
    return {
      statusCode: 409,
      state: existingState,
      error: {
        code: "analysis_request_not_cancellable",
        message: `Analysis request ${idempotencyKey} is already ${existingState.status}.`,
        retryable: false
      }
    } as const;
  }

  if (localState?.executionState === "running") {
    if (app.temporal?.enabled) {
      await app.temporal.cancelAnalysisRequest(idempotencyKey);
    } else {
      // Signal the in-flight pipeline to cancel cooperatively between phases.
      const controller = app.cancellationControllers.get(idempotencyKey);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
    }
    // Return accepted so the client knows cancellation was requested.
    // The pipeline will transition to "cancelled" once it reaches the next
    // phase-boundary check; the client should poll the request state to confirm.
    return {
      statusCode: 202,
      state: {
        idempotencyKey,
        status: "started" as const,
        errorCode: undefined,
        errorMessage: undefined
      }
    } as const;
  }

  const cancelledState: LocalAnalysisRequestState = {
    status: "cancelled",
    errorCode: "analysis_request_cancelled",
    errorMessage: "Analysis request was cancelled."
  };
  app.requestStates.set(idempotencyKey, cancelledState);
  if (app.platform.persistence.isEnabled()) {
      await app.platform.persistence.cancelServiceRequest(
        "analysis-orchestrator",
        "create-analysis",
        idempotencyKey,
        {
          code: cancelledState.errorCode!,
          message: cancelledState.errorMessage!
        }
      );
  }

  return {
    statusCode: 200,
    state: {
      idempotencyKey,
      status: "cancelled" as const,
      errorCode: cancelledState.errorCode,
      errorMessage: cancelledState.errorMessage
    }
  } as const;
}

function isWorkflowCancellation(error: unknown): boolean {
  if (error instanceof AnalysisCancelledError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const cause =
    error.cause instanceof Error
      ? `${error.cause.name}:${error.cause.message}`
      : typeof error.cause === "string"
        ? error.cause
        : "";
  const summary = `${error.name}:${error.message}:${cause}`.toLowerCase();

  return summary.includes("cancel") || summary.includes("cancelled");
}

function runAnalysisInBackground(
  app: OrchestratorApp,
  idempotencyKey: string,
  payload: CreateAnalysisHttpRequest
) {
  const controller = app.temporal?.enabled ? undefined : new AbortController();
  if (controller) {
    app.cancellationControllers.set(idempotencyKey, controller);
  }

  setTimeout(async () => {
    const scheduledState = app.requestStates.get(idempotencyKey);
    if (scheduledState?.status === "cancelled") {
      app.cancellationControllers.delete(idempotencyKey);
      return;
    }

    app.requestStates.set(idempotencyKey, {
      ...scheduledState,
      status: "started",
      executionState: "running"
    });

    try {
      const result = app.temporal?.enabled
        ? (await (await app.temporal.startAnalysisRequest(idempotencyKey, payload)).result()).result
        : await executeAnalysis(app, payload, controller?.signal);
      app.cancellationControllers.delete(idempotencyKey);
      app.requestStates.set(idempotencyKey, {
        status: "completed",
        analysisId: result.analysis.analysisId
      });
      if (app.platform.persistence.isEnabled()) {
        await app.platform.persistence.completeServiceRequest(
          "analysis-orchestrator",
          "create-analysis",
          idempotencyKey,
          {
            analysisId: result.analysis.analysisId,
            response: result
          }
        );
      }
    } catch (error) {
      app.cancellationControllers.delete(idempotencyKey);
      if (isWorkflowCancellation(error)) {
        const cancelledState: LocalAnalysisRequestState = {
          status: "cancelled",
          errorCode: "analysis_request_cancelled",
          errorMessage:
            error instanceof Error ? error.message : "Analysis request was cancelled."
        };
        app.requestStates.set(idempotencyKey, cancelledState);
        if (app.platform.persistence.isEnabled()) {
          await app.platform.persistence.cancelServiceRequest(
            "analysis-orchestrator",
            "create-analysis",
            idempotencyKey,
            { code: cancelledState.errorCode!, message: cancelledState.errorMessage! }
          );
        }
        app.logger.info("Background analysis cancelled cooperatively", { idempotencyKey });
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      app.requestStates.set(idempotencyKey, {
        status: "failed",
        errorCode: "analysis_execution_failed",
        errorMessage: message
      });
      if (app.platform.persistence.isEnabled()) {
        await app.platform.persistence.failServiceRequest(
          "analysis-orchestrator",
          "create-analysis",
          idempotencyKey,
          {
            code: "analysis_execution_failed",
            message
          }
        );
      }
      app.logger.error("Background analysis execution failed", {
        idempotencyKey,
        error: message
      });
    }
  }, 50);
}

function getIdempotencyKey(request: IncomingMessage) {
  const headerValue = request.headers["x-idempotency-key"]?.toString().trim();
  return headerValue ? headerValue : undefined;
}

export function startOrchestratorServer(app = buildOrchestratorApp()) {
  const server = createServer(async (request, response) => {
    const context = buildRequestContext(request);
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${app.config.port}`);

    try {
      if (method === "GET" && requestUrl.pathname === "/healthz") {
        writeJson(
          response,
          200,
          {
            service: app.config.serviceName,
            status: "ok",
            transport: "http",
            persistence: app.platform.persistence.getStatus(),
            temporal: app.temporal?.getStatus() ?? { enabled: false, ready: false }
          },
          context
        );
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/analyses") {
        const body = await readJsonBody<CreateAnalysisHttpRequest>(request);
        const payload = normalizeCreateAnalysisRequest(body ?? {});
        const idempotencyKey = getIdempotencyKey(request);
        if (!idempotencyKey) {
          writeError(response, 400, context, {
            code: "idempotency_key_required",
            message: "x-idempotency-key header is required for analysis submission.",
            retryable: false
          });
          return;
        }

        const existingRequest = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.beginServiceRequest(
              "analysis-orchestrator",
              "create-analysis",
              idempotencyKey
            )
          : { persisted: false, existing: undefined };
        const existingState =
          existingRequest.existing ??
          (app.requestStates.has(idempotencyKey)
            ? {
                serviceName: "analysis-orchestrator",
                operationName: "create-analysis",
                idempotencyKey,
                status: app.requestStates.get(idempotencyKey)!.status,
                analysisId: app.requestStates.get(idempotencyKey)!.analysisId,
                errorCode: app.requestStates.get(idempotencyKey)!.errorCode,
                errorMessage: app.requestStates.get(idempotencyKey)!.errorMessage,
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString()
              }
            : undefined);

        if (existingState?.status === "completed") {
          if (existingRequest.existing?.response) {
            writeJson(response, 200, existingRequest.existing.response, context, {
              "x-idempotent-replay": "true"
            });
            return;
          }

          if (existingState.analysisId) {
            writeJson(
              response,
              200,
              app.platform.orchestrator.getAnalysis(existingState.analysisId),
              context,
              {
                "x-idempotent-replay": "true"
              }
            );
            return;
          }
        }

        if (existingState?.status === "failed") {
          writeError(response, 409, context, {
            code: existingState.errorCode ?? "analysis_request_failed",
            message:
              existingState.errorMessage ??
              "This idempotent request previously failed.",
            retryable: false
          });
          return;
        }

        if (existingState?.status === "cancelled") {
          writeError(response, 409, context, {
            code: existingState.errorCode ?? "analysis_request_cancelled",
            message:
              existingState.errorMessage ??
              "This idempotent request was previously cancelled.",
            retryable: false
          });
          return;
        }

        if (existingState?.status === "started") {
          writeJson(
            response,
            202,
            {
              idempotencyKey,
              status: "started"
            },
            context,
            {
              "x-idempotent-replay": "true"
            }
          );
          return;
        }

        app.requestStates.set(idempotencyKey, {
          status: "started",
          executionState: "scheduled"
        });
        runAnalysisInBackground(app, idempotencyKey, payload);
        writeJson(response, 202, { idempotencyKey, status: "started" }, context);
        return;
      }

      const requestMatch = requestUrl.pathname.match(/^\/v1\/analysis-requests\/([^/]+)$/);
      if (method === "GET" && requestMatch) {
        const idempotencyKey = decodeURIComponent(requestMatch[1]);
        const requestState = await readRequestState(app, idempotencyKey);
        if (!requestState) {
          writeError(response, 404, context, {
            code: "analysis_request_not_found",
            message: `Analysis request not found for idempotency key ${idempotencyKey}.`,
            retryable: false
          });
          return;
        }

        writeJson(response, 200, requestState, context);
        return;
      }

      const cancelMatch = requestUrl.pathname.match(/^\/v1\/analysis-requests\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const idempotencyKey = decodeURIComponent(cancelMatch[1]);
        const cancellation = await cancelRequestState(app, idempotencyKey);
        if ("error" in cancellation && cancellation.error) {
          writeError(response, cancellation.statusCode, context, cancellation.error);
          return;
        }

        writeJson(response, cancellation.statusCode, cancellation.state, context);
        return;
      }

      const analysisMatch = requestUrl.pathname.match(/^\/v1\/analyses\/([^/]+)$/);
      if (method === "GET" && analysisMatch) {
        const analysisId = decodeURIComponent(analysisMatch[1]);
        await hydrateAnalysisIfNeeded(app.platform, analysisId);
        writeJson(response, 200, app.platform.orchestrator.getAnalysis(analysisId), context);
        return;
      }

      const graphContextMatch = requestUrl.pathname.match(
        /^\/v1\/internal\/analyses\/([^/]+)\/graph-context$/
      );
      if (method === "GET" && graphContextMatch) {
        const analysisId = decodeURIComponent(graphContextMatch[1]);
        try {
          const graphContext = await buildGraphContext(app.platform, analysisId);
          writeJson(response, 200, graphContext, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          if (
            message.startsWith("Analysis not found:") ||
            message.startsWith("Analysis snapshot not found:") ||
            message.startsWith("Pack snapshot not found:")
          ) {
            writeError(response, 404, context, {
              code: "graph_context_not_found",
              message,
              retryable: false
            });
            return;
          }
          throw error;
        }
        return;
      }

      const recommendationContextMatch = requestUrl.pathname.match(
        /^\/v1\/internal\/analyses\/([^/]+)\/recommendation-context$/
      );
      if (method === "GET" && recommendationContextMatch) {
        const analysisId = decodeURIComponent(recommendationContextMatch[1]);
        try {
          const recommendationContext = await buildRecommendationContext(app.platform, analysisId);
          writeJson(response, 200, recommendationContext, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          if (
            message.startsWith("Analysis not found:") ||
            message.startsWith("Analysis snapshot not found:") ||
            message.startsWith("Pack snapshot not found:")
          ) {
            writeError(response, 404, context, {
              code: "recommendation_context_not_found",
              message,
              retryable: false
            });
            return;
          }
          throw error;
        }
        return;
      }

      const simulationRunMatch = requestUrl.pathname.match(
        /^\/v1\/internal\/analyses\/([^/]+)\/simulation-run$/
      );
      if (method === "GET" && simulationRunMatch) {
        const analysisId = decodeURIComponent(simulationRunMatch[1]);
        try {
          const simulationRun = await buildSimulationRunHydration(app.platform, analysisId);
          writeJson(response, 200, simulationRun, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          if (
            message.startsWith("Analysis not found:") ||
            message.startsWith("Simulation run not found:")
          ) {
            writeError(response, 404, context, {
              code: "simulation_run_not_found",
              message,
              retryable: false
            });
            return;
          }
          throw error;
        }
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/internal/offline/refresh") {
        const body = await readJsonBody<OfflineRefreshRequest>(request);
        const result = await runOfflineRefresh(app, body ?? {});
        writeJson(response, 200, result, context);
        return;
      }

      writeJson(response, 404, { error: "Route not found." }, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const idempotencyKey = method === "POST" && requestUrl.pathname === "/v1/analyses"
        ? getIdempotencyKey(request)
        : undefined;
      if (idempotencyKey) {
        app.requestStates.set(idempotencyKey, {
          status: "failed",
          errorCode: "analysis_execution_failed",
          errorMessage: message
        });
        if (app.platform.persistence.isEnabled()) {
          await app.platform.persistence.failServiceRequest(
            "analysis-orchestrator",
            "create-analysis",
            idempotencyKey,
            {
              code: "analysis_execution_failed",
              message
            }
          );
        }
      }
      app.logger.error("Analysis orchestrator request failed", {
        method,
        path: requestUrl.pathname,
        requestId: context.requestId,
        traceId: context.traceId,
        error: message
      });
      writeError(response, 500, context, {
        code: "analysis_execution_failed",
        message,
        retryable: true
      });
    }
  });

  server.on("close", () => {
    if (app.temporal?.enabled) {
      void app.temporal.shutdown();
    }
  });

  server.listen(app.config.port, () => {
    app.logger.info("Analysis orchestrator HTTP server listening", {
      port: app.config.port,
      persistence: app.platform.persistence.getStatus(),
      temporal: app.temporal?.getStatus() ?? { enabled: false, ready: false }
    });
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startOrchestratorServer();
}
