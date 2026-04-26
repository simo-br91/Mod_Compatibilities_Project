import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadServiceConfig } from "@modcompat/config";
import { createLogger } from "@modcompat/observability";
import {
  createPhase1Platform,
  type EvidenceSearchInput,
  type EvidenceSearchResult,
  type EvidenceSyncResult,
  type FindingEvidenceLookup
} from "@modcompat/platform-core";

import { buildEvidenceRuntime } from "./runtime.js";
import type { EvidenceRuntime } from "./runtime.js";

export interface EvidenceApp {
  config: ReturnType<typeof loadServiceConfig>;
  logger: ReturnType<typeof createLogger>;
  platform: ReturnType<typeof createPhase1Platform>;
  runtime: EvidenceRuntime;
  syncReplayCache: Map<string, EvidenceSyncResult>;
  routes: Array<{ method: "GET" | "POST"; path: string; summary: string }>;
  handlers: {
    sync(connectorNames?: string[]): Promise<EvidenceSyncResult>;
    search(input: EvidenceSearchInput): Promise<EvidenceSearchResult>;
    getFindingEvidence(analysisId: string, findingId: string, limit?: number): Promise<FindingEvidenceLookup>;
  };
}

interface ServiceErrorPayload {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    traceId: string;
  };
}

export function buildEvidenceApp(): EvidenceApp {
  const config = loadServiceConfig("evidence");
  const logger = createLogger("evidence");
  const platform = createPhase1Platform();
  const runtime = buildEvidenceRuntime(platform, logger);

  const routes = [
    { method: "POST" as const, path: "/v1/evidence/sync", summary: "Run configured connector sync" },
    { method: "POST" as const, path: "/v1/evidence/search", summary: "Search evidence documents and snippets" },
    { method: "GET" as const, path: "/v1/analyses/:analysisId/findings/:findingId/evidence", summary: "Retrieve evidence linked to an analysis finding" }
  ];

  logger.info("Evidence service initialized", {
    routeCount: routes.length,
    indexes: ["evidence-documents", "evidence-snippets"],
    configuredConnectors: runtime.configuredConnectorNames
  });

  const app: EvidenceApp = {
    config,
    logger,
    platform,
    runtime,
    syncReplayCache: new Map(),
    routes,
    handlers: {
      sync(connectorNames) {
        return runtime.sync(connectorNames);
      },
      async search(input) {
        if (runtime.search) {
          return runtime.search.search(input);
        }
        return platform.evidence.search(input);
      },
      async getFindingEvidence(analysisId, findingId, limit = 5) {
        const searchInput = buildFindingSearchInput(app, analysisId, findingId, limit);

        if (runtime.search) {
          return {
            analysisId,
            findingId,
            hits: (await runtime.search.search(searchInput)).hits
          } satisfies FindingEvidenceLookup;
        }

        return platform.evidence.getFindingEvidence(analysisId, findingId, limit);
      }
    }
  };

  return app;
}

function buildRequestContext(request: IncomingMessage) {
  const requestId = request.headers["x-request-id"]?.toString() ?? `req_${randomUUID()}`;
  const traceId = request.headers["x-trace-id"]?.toString() ?? requestId;
  return { requestId, traceId };
}

function getIdempotencyKey(request: IncomingMessage) {
  const headerValue = request.headers["x-idempotency-key"]?.toString().trim();
  return headerValue ? headerValue : undefined;
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
  context: { requestId: string; traceId: string }
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": context.requestId,
    "x-trace-id": context.traceId
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

async function hydrateAnalysisIfNeeded(app: EvidenceApp, analysisId: string) {
  if (app.platform.repository.analyses.has(analysisId)) {
    return;
  }

  if (!app.platform.persistence.isEnabled()) {
    return;
  }

  await app.platform.persistence.hydrateAnalysis(analysisId);
}

function buildFindingSearchInput(
  app: EvidenceApp,
  analysisId: string,
  findingId: string,
  limit: number
): EvidenceSearchInput {
  const analysis = app.platform.repository.analyses.get(analysisId);
  const finding = analysis?.findings.find((item) => item.findingId === findingId);

  if (!finding) {
    throw new Error(`Finding not found: ${analysisId}/${findingId}`);
  }

  return {
    analysisId,
    findingId,
    query: [finding.title, finding.summary, finding.explanation].filter(Boolean).join(" "),
    projectIds: finding.subjects.map((subject) => subject.projectId),
    findingTypes: [finding.type],
    limit
  };
}

export function startEvidenceServer(app = buildEvidenceApp()) {
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
            routes: app.routes.length,
            persistence: app.platform.persistence.getStatus()
          },
          context
        );
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/evidence/sync") {
        const body = await readJsonBody<{ connectorNames?: string[] }>(request);
        const idempotencyKey = getIdempotencyKey(request);
        if (!idempotencyKey) {
          writeError(response, 400, context, {
            code: "idempotency_key_required",
            message: "x-idempotency-key header is required for evidence sync requests.",
            retryable: false
          });
          return;
        }

        const replayed = app.syncReplayCache.get(idempotencyKey);
        if (replayed) {
          writeJson(response, 200, replayed, context);
          return;
        }

        const result = await app.handlers.sync(body?.connectorNames);
        app.syncReplayCache.set(idempotencyKey, result);
        writeJson(response, 200, result, context);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/evidence/search") {
        const body = await readJsonBody<Parameters<EvidenceApp["handlers"]["search"]>[0]>(request);

        if (!body) {
          writeError(response, 400, context, {
            code: "request_body_required",
            message: "Request body is required.",
            retryable: false
          });
          return;
        }

        writeJson(response, 200, await app.handlers.search(body), context);
        return;
      }

      const evidenceMatch = requestUrl.pathname.match(
        /^\/v1\/analyses\/([^/]+)\/findings\/([^/]+)\/evidence$/
      );
      if (method === "GET" && evidenceMatch) {
        const analysisId = decodeURIComponent(evidenceMatch[1]);
        const findingId = decodeURIComponent(evidenceMatch[2]);
        const limit = Number(requestUrl.searchParams.get("limit") ?? "5");

        await hydrateAnalysisIfNeeded(app, analysisId);
        writeJson(
          response,
          200,
          await app.handlers.getFindingEvidence(
            analysisId,
            findingId,
            Number.isNaN(limit) ? 5 : limit
          ),
          context
        );
        return;
      }

      writeError(response, 404, context, {
        code: "route_not_found",
        message: "Route not found.",
        retryable: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      app.logger.error("Evidence request failed", {
        method,
        path: requestUrl.pathname,
        requestId: context.requestId,
        traceId: context.traceId,
        error: message
      });
      writeError(response, 500, context, {
        code: "evidence_request_failed",
        message,
        retryable: true
      });
    }
  });

  void (async () => {
    try {
      await app.runtime.initialize();
      server.listen(app.config.port, () => {
        app.logger.info("Evidence HTTP server listening", {
          port: app.config.port,
          routeCount: app.routes.length,
          persistence: app.platform.persistence.getStatus()
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      app.logger.error("Evidence startup initialization failed", {
        error: message
      });
      process.exitCode = 1;
    }
  })();

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startEvidenceServer();
}
