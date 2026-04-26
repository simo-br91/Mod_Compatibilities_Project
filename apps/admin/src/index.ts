import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadServiceConfig } from "@modcompat/config";
import { createLogger } from "@modcompat/observability";
import { createPhase1Platform } from "@modcompat/platform-core";

export interface AdminApp {
  config: ReturnType<typeof loadServiceConfig>;
  logger: ReturnType<typeof createLogger>;
  platform: ReturnType<typeof createPhase1Platform>;
  /** In-memory replay cache for create-evidence-curation operations (no-Postgres fallback). */
  curationReplayCache: Map<
    string,
    ReturnType<ReturnType<typeof createPhase1Platform>["evidence"]["createCuration"]>
  >;
  /** In-memory replay cache for promote-verified-rule operations (no-Postgres fallback). */
  promotionReplayCache: Map<
    string,
    ReturnType<ReturnType<typeof createPhase1Platform>["evidence"]["promoteVerifiedRule"]>
  >;
  /** In-memory replay cache for rule-draft write operations (no-Postgres fallback). */
  ruleDraftReplayCache: Map<string, unknown>;
  routes: Array<{ method: "GET" | "POST"; path: string; summary: string }>;
  handlers: {
    createRuleDraft(
      input: Parameters<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["createDraft"]>[0]
    ): ReturnType<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["createDraft"]>;
    validateRuleDraft(
      draftId: string,
      strict?: boolean
    ): ReturnType<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["validateDraft"]>;
    getRuleDraft(
      draftId: string
    ): ReturnType<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["getDraft"]>;
    listRuleDrafts(
      status?: Parameters<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["listDrafts"]>[0]
    ): ReturnType<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["listDrafts"]>;
    getRuleHistory(
      ruleId: string
    ): ReturnType<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["getRuleHistory"]>;
    promoteRuleDraft(
      input: Parameters<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["promoteDraft"]>[0]
    ): ReturnType<ReturnType<typeof createPhase1Platform>["ruleDrafts"]["promoteDraft"]>;
    createEvidenceCuration(
      input: Parameters<ReturnType<typeof createPhase1Platform>["evidence"]["createCuration"]>[0]
    ): ReturnType<ReturnType<typeof createPhase1Platform>["evidence"]["createCuration"]>;
    promoteVerifiedRule(
      input: Parameters<ReturnType<typeof createPhase1Platform>["evidence"]["promoteVerifiedRule"]>[0]
    ): ReturnType<ReturnType<typeof createPhase1Platform>["evidence"]["promoteVerifiedRule"]>;
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

function getIdempotencyKey(request: IncomingMessage) {
  const headerValue = request.headers["x-idempotency-key"]?.toString().trim();
  return headerValue ? headerValue : undefined;
}

export function buildAdminApp(): AdminApp {
  const config = loadServiceConfig("admin");
  const logger = createLogger("admin");
  const platform = createPhase1Platform();

  const routes = [
    { method: "GET" as const, path: "/healthz", summary: "Health check" },
    {
      method: "POST" as const,
      path: "/v1/admin/rule-drafts",
      summary: "Create a verified-rule draft"
    },
    {
      method: "GET" as const,
      path: "/v1/admin/rule-drafts",
      summary: "List verified-rule drafts"
    },
    {
      method: "GET" as const,
      path: "/v1/admin/rule-drafts/:draftId",
      summary: "Get a verified-rule draft"
    },
    {
      method: "POST" as const,
      path: "/v1/admin/rule-drafts/:draftId/validate",
      summary: "Validate a verified-rule draft"
    },
    {
      method: "POST" as const,
      path: "/v1/admin/rule-drafts/:draftId/promote",
      summary: "Promote a verified-rule draft"
    },
    {
      method: "GET" as const,
      path: "/v1/admin/rules/:ruleId/history",
      summary: "Get verified-rule version history"
    },
    {
      method: "POST" as const,
      path: "/v1/admin/evidence-curations",
      summary: "Create analyst evidence curation"
    },
    {
      method: "POST" as const,
      path: "/v1/admin/evidence-curations/:curationId/promote",
      summary: "Promote curated evidence into a verified rule"
    }
  ];

  logger.info("Admin service initialized", {
    routeCount: routes.length,
    workflows: ["rule_draft_governance", "evidence_curation", "verified_rule_promotion"]
  });

  return {
    config,
    logger,
    platform,
    curationReplayCache: new Map(),
    promotionReplayCache: new Map(),
    ruleDraftReplayCache: new Map(),
    routes,
    handlers: {
      createRuleDraft(input) {
        return platform.ruleDrafts.createDraft(input);
      },
      validateRuleDraft(draftId, strict) {
        return platform.ruleDrafts.validateDraft(draftId, strict);
      },
      getRuleDraft(draftId) {
        return platform.ruleDrafts.getDraft(draftId);
      },
      listRuleDrafts(status) {
        return platform.ruleDrafts.listDrafts(status);
      },
      getRuleHistory(ruleId) {
        return platform.ruleDrafts.getRuleHistory(ruleId);
      },
      promoteRuleDraft(input) {
        return platform.ruleDrafts.promoteDraft(input);
      },
      createEvidenceCuration(input) {
        return platform.evidence.createCuration(input);
      },
      promoteVerifiedRule(input) {
        return platform.evidence.promoteVerifiedRule(input);
      }
    }
  };
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

export function startAdminServer(app = buildAdminApp()) {
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

      if (method === "POST" && requestUrl.pathname === "/v1/admin/rule-drafts") {
        const body = await readJsonBody<
          Parameters<AdminApp["handlers"]["createRuleDraft"]>[0]
        >(request);
        if (!body) {
          writeError(response, 400, context, {
            code: "request_body_required",
            message: "Request body is required.",
            retryable: false
          });
          return;
        }

        const idempotencyKey = getIdempotencyKey(request);
        if (!idempotencyKey) {
          writeError(response, 400, context, {
            code: "idempotency_key_required",
            message: "x-idempotency-key header is required for admin write requests.",
            retryable: false
          });
          return;
        }

        const inMemoryDraft = app.ruleDraftReplayCache.get(idempotencyKey);
        if (inMemoryDraft) {
          writeJson(response, 200, inMemoryDraft, context);
          return;
        }

        const existingRequest = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.beginServiceRequest(
              "admin",
              "create-rule-draft",
              idempotencyKey
            )
          : { persisted: false, existing: undefined };

        if (existingRequest.existing?.status === "completed" && existingRequest.existing.response) {
          writeJson(response, 200, existingRequest.existing.response, context);
          return;
        }

        if (existingRequest.existing?.status === "failed") {
          writeError(response, 409, context, {
            code: existingRequest.existing.errorCode ?? "admin_request_failed",
            message:
              existingRequest.existing.errorMessage ??
              "This idempotent admin request previously failed.",
            retryable: false
          });
          return;
        }

        if (existingRequest.existing?.status === "started") {
          writeError(response, 409, context, {
            code: "admin_request_in_progress",
            message: "This idempotent admin request is already in progress.",
            retryable: true
          });
          return;
        }

        const draft = app.handlers.createRuleDraft(body);
        if (app.platform.persistence.isEnabled()) {
          await app.platform.persistence.persistRuleDraft(draft.draftId);
          await app.platform.persistence.completeServiceRequest(
            "admin",
            "create-rule-draft",
            idempotencyKey,
            {
              analysisId: draft.ruleId,
              response: draft
            }
          );
        }
        app.ruleDraftReplayCache.set(idempotencyKey, draft);
        writeJson(response, 201, draft, context);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/v1/admin/rule-drafts") {
        const status = requestUrl.searchParams.get("status") as Parameters<
          AdminApp["handlers"]["listRuleDrafts"]
        >[0];
        const drafts = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.readRuleDrafts(status)
          : app.handlers.listRuleDrafts(status);
        writeJson(response, 200, drafts, context);
        return;
      }

      const ruleDraftMatch = requestUrl.pathname.match(/^\/v1\/admin\/rule-drafts\/([^/]+)$/);
      if (method === "GET" && ruleDraftMatch) {
        const draftId = decodeURIComponent(ruleDraftMatch[1]!);
        const draft = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.readRuleDraft(draftId)
          : app.handlers.getRuleDraft(draftId);
        if (!draft) {
          writeError(response, 404, context, {
            code: "rule_draft_not_found",
            message: `Rule draft not found: ${draftId}`,
            retryable: false
          });
          return;
        }
        writeJson(response, 200, draft, context);
        return;
      }

      const validateRuleDraftMatch = requestUrl.pathname.match(
        /^\/v1\/admin\/rule-drafts\/([^/]+)\/validate$/
      );
      if (method === "POST" && validateRuleDraftMatch) {
        const draftId = decodeURIComponent(validateRuleDraftMatch[1]!);
        const body = await readJsonBody<{ strict?: boolean }>(request);
        const idempotencyKey = getIdempotencyKey(request);
        if (!idempotencyKey) {
          writeError(response, 400, context, {
            code: "idempotency_key_required",
            message: "x-idempotency-key header is required for admin write requests.",
            retryable: false
          });
          return;
        }

        const inMemoryValidation = app.ruleDraftReplayCache.get(idempotencyKey);
        if (inMemoryValidation) {
          writeJson(response, 200, inMemoryValidation, context);
          return;
        }

        const existingRequest = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.beginServiceRequest(
              "admin",
              "validate-rule-draft",
              idempotencyKey
            )
          : { persisted: false, existing: undefined };

        if (existingRequest.existing?.status === "completed" && existingRequest.existing.response) {
          writeJson(response, 200, existingRequest.existing.response, context);
          return;
        }

        if (existingRequest.existing?.status === "failed") {
          writeError(response, 409, context, {
            code: existingRequest.existing.errorCode ?? "admin_request_failed",
            message:
              existingRequest.existing.errorMessage ??
              "This idempotent admin request previously failed.",
            retryable: false
          });
          return;
        }

        if (existingRequest.existing?.status === "started") {
          writeError(response, 409, context, {
            code: "admin_request_in_progress",
            message: "This idempotent admin request is already in progress.",
            retryable: true
          });
          return;
        }

        if (
          !app.platform.repository.ruleDrafts.has(draftId) &&
          app.platform.persistence.isEnabled()
        ) {
          await app.platform.persistence.hydrateRuleDraft(draftId);
        }

        const validated = app.handlers.validateRuleDraft(draftId, body?.strict);
        if (app.platform.persistence.isEnabled()) {
          await app.platform.persistence.persistRuleDraft(validated.draftId);
          await app.platform.persistence.completeServiceRequest(
            "admin",
            "validate-rule-draft",
            idempotencyKey,
            {
              analysisId: validated.ruleId,
              response: validated
            }
          );
        }
        app.ruleDraftReplayCache.set(idempotencyKey, validated);
        writeJson(response, 200, validated, context);
        return;
      }

      const promoteRuleDraftMatch = requestUrl.pathname.match(
        /^\/v1\/admin\/rule-drafts\/([^/]+)\/promote$/
      );
      if (method === "POST" && promoteRuleDraftMatch) {
        const draftId = decodeURIComponent(promoteRuleDraftMatch[1]!);
        const body = await readJsonBody<{ promotedBy: string; changeNote?: string }>(request);
        if (!body?.promotedBy) {
          writeError(response, 400, context, {
            code: "promoted_by_required",
            message: "`promotedBy` is required.",
            retryable: false
          });
          return;
        }

        const idempotencyKey = getIdempotencyKey(request);
        if (!idempotencyKey) {
          writeError(response, 400, context, {
            code: "idempotency_key_required",
            message: "x-idempotency-key header is required for admin write requests.",
            retryable: false
          });
          return;
        }

        const inMemoryPromotion = app.ruleDraftReplayCache.get(idempotencyKey);
        if (inMemoryPromotion) {
          writeJson(response, 200, inMemoryPromotion, context);
          return;
        }

        const existingRequest = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.beginServiceRequest(
              "admin",
              "promote-rule-draft",
              idempotencyKey
            )
          : { persisted: false, existing: undefined };

        if (existingRequest.existing?.status === "completed" && existingRequest.existing.response) {
          writeJson(response, 200, existingRequest.existing.response, context);
          return;
        }

        if (existingRequest.existing?.status === "failed") {
          writeError(response, 409, context, {
            code: existingRequest.existing.errorCode ?? "admin_request_failed",
            message:
              existingRequest.existing.errorMessage ??
              "This idempotent admin request previously failed.",
            retryable: false
          });
          return;
        }

        if (existingRequest.existing?.status === "started") {
          writeError(response, 409, context, {
            code: "admin_request_in_progress",
            message: "This idempotent admin request is already in progress.",
            retryable: true
          });
          return;
        }

        if (
          !app.platform.repository.ruleDrafts.has(draftId) &&
          app.platform.persistence.isEnabled()
        ) {
          await app.platform.persistence.hydrateRuleDraft(draftId);
        }

        const promotion = app.handlers.promoteRuleDraft({
          draftId,
          promotedBy: body.promotedBy,
          changeNote: body.changeNote
        });
        if (app.platform.persistence.isEnabled()) {
          await app.platform.persistence.persistRuleDraft(promotion.draft.draftId);
          await app.platform.persistence.persistVerifiedRule(promotion.rule.rule_id);
          await app.platform.persistence.persistRuleVersionHistory(promotion.rule.rule_id);
          await app.platform.persistence.completeServiceRequest(
            "admin",
            "promote-rule-draft",
            idempotencyKey,
            {
              analysisId: promotion.rule.rule_id,
              response: promotion
            }
          );
        }
        app.ruleDraftReplayCache.set(idempotencyKey, promotion);
        writeJson(response, 200, promotion, context);
        return;
      }

      const ruleHistoryMatch = requestUrl.pathname.match(/^\/v1\/admin\/rules\/([^/]+)\/history$/);
      if (method === "GET" && ruleHistoryMatch) {
        const ruleId = decodeURIComponent(ruleHistoryMatch[1]!);
        const history = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.readRuleVersionHistory(ruleId)
          : app.handlers.getRuleHistory(ruleId);
        writeJson(response, 200, history, context);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/admin/evidence-curations") {
        const body = await readJsonBody<
          Parameters<AdminApp["handlers"]["createEvidenceCuration"]>[0]
        >(request);
        if (!body) {
          writeError(response, 400, context, {
            code: "request_body_required",
            message: "Request body is required.",
            retryable: false
          });
          return;
        }

        const idempotencyKey = getIdempotencyKey(request);
        if (!idempotencyKey) {
          writeError(response, 400, context, {
            code: "idempotency_key_required",
            message: "x-idempotency-key header is required for admin write requests.",
            retryable: false
          });
          return;
        }

        // In-memory replay fallback for no-Postgres mode.
        const inMemoryCuration = app.curationReplayCache.get(idempotencyKey);
        if (inMemoryCuration) {
          writeJson(response, 200, inMemoryCuration, context);
          return;
        }

        const existingRequest = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.beginServiceRequest(
              "admin",
              "create-evidence-curation",
              idempotencyKey
            )
          : { persisted: false, existing: undefined };

        if (existingRequest.existing?.status === "completed" && existingRequest.existing.response) {
          writeJson(response, 200, existingRequest.existing.response, context);
          return;
        }

        if (existingRequest.existing?.status === "failed") {
          writeError(response, 409, context, {
            code: existingRequest.existing.errorCode ?? "admin_request_failed",
            message:
              existingRequest.existing.errorMessage ??
              "This idempotent admin request previously failed.",
            retryable: false
          });
          return;
        }

        if (existingRequest.existing?.status === "started") {
          writeError(response, 409, context, {
            code: "admin_request_in_progress",
            message: "This idempotent admin request is already in progress.",
            retryable: true
          });
          return;
        }

        const curation = app.handlers.createEvidenceCuration(body);
        if (app.platform.persistence.isEnabled()) {
          await app.platform.persistence.persistEvidenceCuration(curation.curationId);
          await app.platform.persistence.hydrateAdminState(curation.curationId);
          await app.platform.persistence.completeServiceRequest(
            "admin",
            "create-evidence-curation",
            idempotencyKey,
            {
              response: curation
              }
            );
        }
        app.curationReplayCache.set(idempotencyKey, curation);
        writeJson(response, 200, curation, context);
        return;
      }

      const promoteMatch = requestUrl.pathname.match(
        /^\/v1\/admin\/evidence-curations\/([^/]+)\/promote$/
      );
      if (method === "POST" && promoteMatch) {
        const curationId = decodeURIComponent(promoteMatch[1]);
        const body = await readJsonBody<{ promotedBy: string }>(request);
        if (!body?.promotedBy) {
          writeError(response, 400, context, {
            code: "promoted_by_required",
            message: "`promotedBy` is required.",
            retryable: false
          });
          return;
        }

        const idempotencyKey = getIdempotencyKey(request);
        if (!idempotencyKey) {
          writeError(response, 400, context, {
            code: "idempotency_key_required",
            message: "x-idempotency-key header is required for admin write requests.",
            retryable: false
          });
          return;
        }

        // In-memory replay fallback for no-Postgres mode.
        const inMemoryPromotion = app.promotionReplayCache.get(idempotencyKey);
        if (inMemoryPromotion) {
          writeJson(response, 200, inMemoryPromotion, context);
          return;
        }

        const existingRequest = app.platform.persistence.isEnabled()
          ? await app.platform.persistence.beginServiceRequest(
              "admin",
              "promote-verified-rule",
              idempotencyKey
            )
          : { persisted: false, existing: undefined };

        if (existingRequest.existing?.status === "completed" && existingRequest.existing.response) {
          writeJson(response, 200, existingRequest.existing.response, context);
          return;
        }

        if (existingRequest.existing?.status === "failed") {
          writeError(response, 409, context, {
            code: existingRequest.existing.errorCode ?? "admin_request_failed",
            message:
              existingRequest.existing.errorMessage ??
              "This idempotent admin request previously failed.",
            retryable: false
          });
          return;
        }

        if (existingRequest.existing?.status === "started") {
          writeError(response, 409, context, {
            code: "admin_request_in_progress",
            message: "This idempotent admin request is already in progress.",
            retryable: true
          });
          return;
        }

        if (
          !app.platform.repository.evidenceCurations.has(curationId) &&
          app.platform.persistence.isEnabled()
        ) {
          await app.platform.persistence.hydrateAdminState(curationId);
        }

        const promotion = app.handlers.promoteVerifiedRule({
          curationId,
          promotedBy: body.promotedBy
        });
        if (app.platform.persistence.isEnabled()) {
          await app.platform.persistence.persistVerifiedRule(promotion.rule.ruleId);
          await app.platform.persistence.persistEvidenceCuration(curationId);
          await app.platform.persistence.hydrateAdminState(curationId);
          await app.platform.persistence.completeServiceRequest(
            "admin",
            "promote-verified-rule",
            idempotencyKey,
            {
              analysisId: promotion.rule.ruleId,
              response: promotion
              }
            );
        }
        app.promotionReplayCache.set(idempotencyKey, promotion);
        writeJson(response, 200, promotion, context);
        return;
      }

      writeError(response, 404, context, {
        code: "route_not_found",
        message: "Route not found.",
        retryable: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const idempotencyKey = method === "POST" ? getIdempotencyKey(request) : undefined;
      const operationName =
        requestUrl.pathname === "/v1/admin/rule-drafts"
          ? "create-rule-draft"
          : requestUrl.pathname.includes("/rule-drafts/") && requestUrl.pathname.endsWith("/validate")
            ? "validate-rule-draft"
            : requestUrl.pathname.includes("/rule-drafts/") && requestUrl.pathname.endsWith("/promote")
              ? "promote-rule-draft"
              : requestUrl.pathname === "/v1/admin/evidence-curations"
                ? "create-evidence-curation"
                : requestUrl.pathname.includes("/evidence-curations/") && requestUrl.pathname.endsWith("/promote")
                  ? "promote-verified-rule"
                  : undefined;
      if (idempotencyKey && operationName && app.platform.persistence.isEnabled()) {
        await app.platform.persistence.failServiceRequest("admin", operationName, idempotencyKey, {
          code: "admin_request_failed",
          message
        });
      }
      app.logger.error("Admin request failed", {
        method,
        path: requestUrl.pathname,
        requestId: context.requestId,
        traceId: context.traceId,
        error: message
      });
      writeError(response, 500, context, {
        code: "admin_request_failed",
        message,
        retryable: true
      });
    }
  });

  server.listen(app.config.port, () => {
    app.logger.info("Admin HTTP server listening", {
      port: app.config.port,
      routeCount: app.routes.length,
      persistence: app.platform.persistence.getStatus()
    });
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startAdminServer();
}
