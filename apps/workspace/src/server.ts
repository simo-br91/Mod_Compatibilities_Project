/**
 * Workspace service HTTP server.
 *
 * Serves:
 *  GET  /healthz
 *
 *  Billing endpoints:
 *  GET  /v1/billing/subscription          — current subscription for the caller's org
 *  POST /v1/billing/checkout              — create a Stripe Checkout session
 *  POST /v1/billing/portal                — create a Stripe Customer Portal session
 *  POST /v1/billing/webhooks              — receive Stripe webhook events
 *
 *  Internal plan lookup (called by gateway to enforce per-org quotas):
 *  GET  /v1/internal/billing/plan?organizationId=...
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getBillingService } from "./billing.js";

const PORT = process.env.WORKSPACE_HTTP_PORT ?? process.env.PORT ?? "8090";
const billing = getBillingService();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function err(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

async function parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    const buf = await readBody(req);
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    err(res, 400, "invalid_json", "Request body is not valid JSON.");
    return null;
  }
}

/** Naive bearer-token extraction — production should verify JWT via platform-core. */
function extractOrgId(req: IncomingMessage): string | null {
  // Gateway passes x-organization-id as a trusted internal header when calling
  // internal billing endpoints on behalf of an authenticated user.
  const internal = req.headers["x-organization-id"];
  if (typeof internal === "string" && internal.trim()) return internal.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";

  // Health check
  if (url.pathname === "/healthz") {
    json(res, 200, {
      service: "workspace",
      status: "ok",
      billing: {
        configured: billing.isConfigured()
      }
    });
    return;
  }

  // -------------------------------------------------------------------------
  // GET /v1/billing/subscription
  // -------------------------------------------------------------------------
  if (url.pathname === "/v1/billing/subscription" && method === "GET") {
    const orgId = extractOrgId(req);
    if (!orgId) {
      err(res, 401, "unauthorized", "x-organization-id header is required.");
      return;
    }
    const sub = billing.getSubscription(orgId);
    const plan = billing.getPlanForOrg(orgId);
    json(res, 200, { subscription: sub ?? null, plan });
    return;
  }

  // -------------------------------------------------------------------------
  // POST /v1/billing/checkout
  // -------------------------------------------------------------------------
  if (url.pathname === "/v1/billing/checkout" && method === "POST") {
    const orgId = extractOrgId(req);
    if (!orgId) {
      err(res, 401, "unauthorized", "x-organization-id header is required.");
      return;
    }

    type Body = {
      planId: "plan_pro" | "plan_enterprise";
      successUrl: string;
      cancelUrl: string;
      customerEmail?: string;
      customerName?: string;
    };
    const body = await parseJsonBody<Body>(req, res);
    if (!body) return;

    if (!body.planId || !body.successUrl || !body.cancelUrl) {
      err(res, 400, "missing_fields", "planId, successUrl, and cancelUrl are required.");
      return;
    }

    if (!["plan_pro", "plan_enterprise"].includes(body.planId)) {
      err(res, 400, "invalid_plan", "planId must be plan_pro or plan_enterprise.");
      return;
    }

    try {
      const existing = billing.getSubscription(orgId);
      const result = await billing.createCheckoutSession({
        organizationId: orgId,
        planId: body.planId,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        existingCustomerId: existing?.stripeCustomerId,
        customerEmail: body.customerEmail,
        customerName: body.customerName
      });
      json(res, 200, result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      err(res, 500, "checkout_failed", message);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // POST /v1/billing/portal
  // -------------------------------------------------------------------------
  if (url.pathname === "/v1/billing/portal" && method === "POST") {
    const orgId = extractOrgId(req);
    if (!orgId) {
      err(res, 401, "unauthorized", "x-organization-id header is required.");
      return;
    }

    const body = await parseJsonBody<{ returnUrl: string }>(req, res);
    if (!body) return;

    if (!body.returnUrl) {
      err(res, 400, "missing_fields", "returnUrl is required.");
      return;
    }

    try {
      const result = await billing.createPortalSession({
        organizationId: orgId,
        returnUrl: body.returnUrl
      });
      json(res, 200, result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      err(res, 500, "portal_failed", message);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // POST /v1/billing/webhooks  (raw body required — no JSON pre-parse)
  // -------------------------------------------------------------------------
  if (url.pathname === "/v1/billing/webhooks" && method === "POST") {
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string" || !signature) {
      err(res, 400, "missing_signature", "Stripe-Signature header is required.");
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch {
      err(res, 400, "body_read_error", "Failed to read request body.");
      return;
    }

    try {
      const result = await billing.handleWebhookEvent(rawBody, signature);
      json(res, 200, result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Return 400 on signature failures so Stripe retries correctly
      err(res, 400, "webhook_error", message);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // GET /v1/internal/billing/plan?organizationId=...
  // Called by the gateway to get the enforced QuotaPlan for an org.
  // -------------------------------------------------------------------------
  if (url.pathname === "/v1/internal/billing/plan" && method === "GET") {
    const organizationId = url.searchParams.get("organizationId");
    if (!organizationId) {
      err(res, 400, "missing_param", "organizationId query parameter is required.");
      return;
    }
    const plan = billing.getPlanForOrg(organizationId);
    json(res, 200, { plan });
    return;
  }

  // 404 fallback
  err(res, 404, "not_found", `${method} ${url.pathname} is not a known workspace endpoint.`);
});

server.listen(PORT, () => {
  console.log(`[workspace] billing service listening on :${PORT}`);
  console.log(`[workspace] Stripe configured: ${billing.isConfigured()}`);
});

server.on("error", (e) => {
  console.error("[workspace] server error:", e);
  process.exit(1);
});
