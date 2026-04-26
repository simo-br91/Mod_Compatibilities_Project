/**
 * Gateway HTTP server.
 *
 * Serves:
 *  - GET  /auth/login          — redirect to OIDC provider (PKCE, state)
 *  - GET  /auth/callback       — exchange code, issue platform JWT, set cookie
 *  - GET  /auth/logout         — clear session cookie, redirect to web sign-in
 *  - GET  /v1/auth/session     — read session from Bearer token or mcp_session cookie
 *  - All other /v1/* routes handled by the gateway app handlers
 *
 * Real OIDC is required whenever demo auth is disabled. Local development can
 * opt into an explicit demo session flow via ALLOW_DEMO_AUTH=true.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { buildGatewayApp } from "./app.js";
import {
  type GatewayOidcConfig,
  assertGatewayAuthConfiguration,
  normalizeRedirectTarget,
  readGatewayOidcConfig,
  resolveJwtSecret,
  resolveWebBaseUrl,
  shouldAllowDemoAuth,
  shouldUseSecureCookies
} from "./auth-runtime.js";
import {
  signJwt,
  verifyJwt,
  createDemoJwt,
  ROLE_PERMISSIONS,
  JwtVerificationError
} from "@modcompat/platform-core";

// ---------------------------------------------------------------------------
// PKCE & state helpers (Node crypto only)
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function computeCodeChallenge(codeVerifier: string): string {
  return base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
}

// ---------------------------------------------------------------------------
// State store — in-process Map with 10-minute TTL
// ---------------------------------------------------------------------------

interface OidcStateEntry {
  codeVerifier: string;
  redirectTo: string;
  createdAt: number; // epoch ms
}

const oidcStateStore = new Map<string, OidcStateEntry>();
const OIDC_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function pruneExpiredState() {
  const cutoff = Date.now() - OIDC_STATE_TTL_MS;
  for (const [key, entry] of oidcStateStore) {
    if (entry.createdAt < cutoff) {
      oidcStateStore.delete(key);
    }
  }
}

function storeOidcState(state: string, entry: Omit<OidcStateEntry, "createdAt">) {
  pruneExpiredState();
  oidcStateStore.set(state, { ...entry, createdAt: Date.now() });
}

function consumeOidcState(state: string): OidcStateEntry | undefined {
  const entry = oidcStateStore.get(state);
  if (!entry) return undefined;
  oidcStateStore.delete(state);
  if (Date.now() - entry.createdAt > OIDC_STATE_TTL_MS) return undefined;
  return entry;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "mcp_session";
const SESSION_MAX_AGE = 8 * 3600; // 8 hours in seconds

function buildSetCookieHeader(value: string, options: { clear?: boolean; secure?: boolean }) {
  const maxAge = options.clear ? 0 : SESSION_MAX_AGE;
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Path=/`,
    `Max-Age=${maxAge}`
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function buildSessionCookieHeader(
  token: string,
  options: { clear?: boolean; secure?: boolean }
) {
  return buildSetCookieHeader(options.clear ? "" : token, options);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) {
      result[pair.trim()] = "";
    } else {
      result[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return result;
}

function extractSessionToken(req: IncomingMessage): string | undefined {
  // 1. Bearer token from Authorization header
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const [scheme, token] = authHeader.split(/\s+/, 2);
    if (scheme?.toLowerCase() === "bearer" && token) return token;
  }

  // 2. HttpOnly cookie
  const cookies = parseCookies(req.headers["cookie"]);
  return cookies[SESSION_COOKIE] || undefined;
}

// ---------------------------------------------------------------------------
// JWT helpers for the OIDC flow
// ---------------------------------------------------------------------------

type OidcConfig = GatewayOidcConfig;

function stableUserId(oidcSub: string): string {
  return "usr_" + createHash("sha256").update(oidcSub).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendRedirect(
  res: ServerResponse,
  location: string,
  statusCode = 302,
  extraHeaders?: Record<string, string | string[]>
) {
  res.writeHead(statusCode, { location, ...(extraHeaders ?? {}) });
  res.end();
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown, extraHeaders?: Record<string, string>) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders
  });
  res.end(payload);
}

function sendError(res: ServerResponse, statusCode: number, code: string, message: string) {
  sendJson(res, statusCode, { error: { code, message } });
}

async function issueDemoSession(
  res: ServerResponse,
  app: ReturnType<typeof buildGatewayApp>,
  secureCookies: boolean,
  redirectTo?: string
) {
  const demoJwt = createDemoJwt(resolveJwtSecret(process.env));
  const session = await app.handlers.getSession(demoJwt);
  const cookieHeader = buildSessionCookieHeader(demoJwt, { secure: secureCookies });

  if (redirectTo) {
    sendRedirect(res, redirectTo, 302, { "set-cookie": cookieHeader });
    return;
  }

  sendJson(res, 200, session, { "set-cookie": cookieHeader });
}

// ---------------------------------------------------------------------------
// OIDC env var helpers
// ---------------------------------------------------------------------------

function getOidcConfig(): OidcConfig | null {
  return readGatewayOidcConfig(process.env);
}

// ---------------------------------------------------------------------------
// OIDC token exchange
// ---------------------------------------------------------------------------

interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  id_token?: string;
  expires_in?: number;
}

interface OidcUserInfo {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

async function exchangeCodeForTokens(
  oidc: OidcConfig,
  code: string,
  codeVerifier: string
): Promise<OidcTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oidc.redirectUri,
    client_id: oidc.clientId,
    client_secret: oidc.clientSecret,
    code_verifier: codeVerifier
  });

  const response = await fetch(`${oidc.issuerUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<OidcTokenResponse>;
}

async function fetchUserInfo(oidc: OidcConfig, accessToken: string): Promise<OidcUserInfo> {
  const response = await fetch(`${oidc.issuerUrl}/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`UserInfo fetch failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<OidcUserInfo>;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  app: ReturnType<typeof buildGatewayApp>
) {
  const oidc = getOidcConfig();
  const webBaseUrl = resolveWebBaseUrl(process.env);
  const secureCookies = shouldUseSecureCookies(process.env);
  const requestedRedirect = new URL(req.url ?? "/", "http://localhost").searchParams.get(
    "redirectTo"
  );
  const redirectTo = normalizeRedirectTarget(
    requestedRedirect,
    webBaseUrl,
    `${webBaseUrl}/dashboard`
  );
  if (!oidc) {
    if (shouldAllowDemoAuth(process.env)) {
      await issueDemoSession(res, app, secureCookies, redirectTo);
      return;
    }

    sendError(
      res,
      503,
      "oidc_not_configured",
      "OIDC is not configured. Set OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URI."
    );
    return;
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);

  storeOidcState(state, { codeVerifier, redirectTo });

  const authUrl = new URL(`${oidc.issuerUrl}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", oidc.clientId);
  authUrl.searchParams.set("redirect_uri", oidc.redirectUri);
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  sendRedirect(res, authUrl.toString());
}

async function handleCallback(req: IncomingMessage, res: ServerResponse) {
  const oidc = getOidcConfig();
  const webBaseUrl = resolveWebBaseUrl(process.env);
  const secureCookies = shouldUseSecureCookies(process.env);
  const signInUrl = new URL("/sign-in", webBaseUrl);
  if (!oidc) {
    sendError(res, 503, "oidc_not_configured", "OIDC is not configured.");
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    const desc = url.searchParams.get("error_description") ?? errorParam;
    signInUrl.searchParams.set("error", desc);
    sendRedirect(res, signInUrl.toString());
    return;
  }

  if (!code || !state) {
    sendError(res, 400, "missing_params", "code and state query parameters are required.");
    return;
  }

  const stateEntry = consumeOidcState(state);
  if (!stateEntry) {
    sendError(res, 400, "invalid_state", "State parameter is invalid or has expired.");
    return;
  }

  let tokens: OidcTokenResponse;
  try {
    tokens = await exchangeCodeForTokens(oidc, code, stateEntry.codeVerifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed.";
    signInUrl.searchParams.set("error", message);
    sendRedirect(res, signInUrl.toString());
    return;
  }

  let userInfo: OidcUserInfo;
  try {
    userInfo = await fetchUserInfo(oidc, tokens.access_token);
  } catch (err) {
    const message = err instanceof Error ? err.message : "UserInfo fetch failed.";
    signInUrl.searchParams.set("error", message);
    sendRedirect(res, signInUrl.toString());
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const sub = stableUserId(userInfo.sub);

  const jwtPayload = {
    sub,
    org: "org_default",
    role: "user" as const,
    permissions: ROLE_PERMISSIONS["user"],
    email: userInfo.email,
    name: userInfo.name ?? userInfo.preferred_username ?? userInfo.email ?? sub,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_MAX_AGE,
    kind: "user" as const
  };

  const secret = resolveJwtSecret(process.env);
  const platformJwt = signJwt(jwtPayload, secret);
  const cookieHeader = buildSessionCookieHeader(platformJwt, { secure: secureCookies });
  const redirectTo = normalizeRedirectTarget(
    stateEntry.redirectTo,
    webBaseUrl,
    `${webBaseUrl}/dashboard`
  );

  sendRedirect(res, redirectTo, 302, { "set-cookie": cookieHeader });
}

function handleLogout(req: IncomingMessage, res: ServerResponse) {
  const webBaseUrl = resolveWebBaseUrl(process.env);
  const requestedRedirect = new URL(req.url ?? "/", "http://localhost").searchParams.get(
    "redirectTo"
  );
  const redirectTo = normalizeRedirectTarget(
    requestedRedirect,
    webBaseUrl,
    `${webBaseUrl}/sign-in`
  );
  const cookieHeader = buildSessionCookieHeader("", {
    clear: true,
    secure: shouldUseSecureCookies(process.env)
  });

  sendRedirect(res, redirectTo, 302, { "set-cookie": cookieHeader });
}

async function handleGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  app: ReturnType<typeof buildGatewayApp>
) {
  const token = extractSessionToken(req);

  if (!token) {
    const oidc = getOidcConfig();
    if (!oidc && shouldAllowDemoAuth(process.env)) {
      app.logger.warn("OIDC not configured; issuing an explicit local demo session.");
      try {
        await issueDemoSession(res, app, shouldUseSecureCookies(process.env));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create demo session.";
        sendError(res, 500, "session_error", message);
      }
      return;
    }

    sendError(res, 401, "unauthorized", "Authentication required. No token or session cookie provided.");
    return;
  }

  let verifiedPayload;
  try {
    verifiedPayload = verifyJwt(token, resolveJwtSecret(process.env));
  } catch (err) {
    if (err instanceof JwtVerificationError) {
      sendError(res, 401, err.code, err.message);
    } else {
      sendError(res, 401, "unauthorized", "Invalid token.");
    }
    return;
  }

  try {
    const session = await app.handlers.getSession(token);
    sendJson(res, 200, session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Session error.";
    app.logger.warn("Session hydration failed, returning JWT-derived session", {
      sub: verifiedPayload.sub,
      org: verifiedPayload.org,
      error: message
    });

    const syntheticSession = {
      token,
      user: {
        userId: verifiedPayload.sub,
        organizationId: verifiedPayload.org,
        displayName: verifiedPayload.name ?? verifiedPayload.sub,
        email: verifiedPayload.email ?? "",
        schemaVersion: 1,
        createdAt: new Date().toISOString()
      },
      organization: {
        organizationId: verifiedPayload.org,
        tenantId: verifiedPayload.org,
        name: "Default Organization",
        slug: "default",
        schemaVersion: 1,
        createdAt: new Date().toISOString()
      },
      memberships: [],
      workspaces: [],
      projects: [],
      apiKeys: []
    };

    sendJson(res, 200, syntheticSession);
  }
}

// ---------------------------------------------------------------------------
// CORS helper (allow the web app origin)
// ---------------------------------------------------------------------------

function setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers["origin"];
  const webBase = resolveWebBaseUrl(process.env);
  if (origin && (origin === webBase || !shouldUseSecureCookies(process.env))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "authorization, content-type, x-request-id, x-trace-id, x-idempotency-key");
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  }
}

// ---------------------------------------------------------------------------
// Main server factory
// ---------------------------------------------------------------------------

export function startGatewayServer(app = buildGatewayApp()) {
  const authRuntime = assertGatewayAuthConfiguration(process.env);
  const oidc = getOidcConfig();
  if (!oidc && authRuntime.demoAuthAllowed) {
    app.logger.warn(
      "OIDC env vars not set (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI). " +
        "Explicit demo auth is active for local development."
    );
  }

  const server = createServer(async (req, res) => {
    setCorsHeaders(req, res);

    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, `http://127.0.0.1:${app.config.port}`);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // -----------------------------------------------------------------------
      // Auth routes (OIDC)
      // -----------------------------------------------------------------------
      if (method === "GET" && pathname === "/auth/login") {
        await handleLogin(req, res, app);
        return;
      }

      if (method === "GET" && pathname === "/auth/callback") {
        await handleCallback(req, res);
        return;
      }

      if (method === "GET" && pathname === "/auth/logout") {
        handleLogout(req, res);
        return;
      }

      // -----------------------------------------------------------------------
      // Health check
      // -----------------------------------------------------------------------
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, {
          service: app.config.serviceName,
          status: "ok",
          oidc: oidc ? "configured" : "disabled",
          authMode: authRuntime.demoAuthAllowed && !oidc ? "demo" : "oidc"
        });
        return;
      }

      // -----------------------------------------------------------------------
      // Session endpoint (must handle cookie-based auth after OIDC callback)
      // -----------------------------------------------------------------------
      if (method === "GET" && pathname === "/v1/auth/session") {
        await handleGetSession(req, res, app);
        return;
      }

      // -----------------------------------------------------------------------
      // All other /v1/* routes — delegate to existing gateway app handlers
      // -----------------------------------------------------------------------
      await handleV1Route(req, res, app, method, pathname, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error.";
      app.logger.error("Gateway request failed", { method, path: pathname, error: message });
      sendError(res, 500, "internal_error", message);
    }
  });

  server.listen(app.config.port, () => {
    app.logger.info("Gateway HTTP server listening", {
      port: app.config.port,
      routeCount: app.routes.length,
      oidc: oidc ? "configured" : "disabled",
      authMode: authRuntime.demoAuthAllowed && !oidc ? "demo" : "oidc"
    });
  });

  return server;
}

// ---------------------------------------------------------------------------
// V1 route dispatcher — mirrors the routes defined in app.ts
// ---------------------------------------------------------------------------

async function readJsonBody<T>(req: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

async function handleV1Route(
  req: IncomingMessage,
  res: ServerResponse,
  app: ReturnType<typeof buildGatewayApp>,
  method: string,
  pathname: string,
  url: URL
) {
  // Resolve tenant context from headers (bearer token or x-* headers)
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = v;
  }

  // Also inject cookie-based session token into Authorization if not already set
  if (!headers["authorization"]) {
    const cookies = parseCookies(req.headers["cookie"]);
    const cookieJwt = cookies[SESSION_COOKIE];
    if (cookieJwt) {
      headers["authorization"] = `Bearer ${cookieJwt}`;
    }
  }

  const context = await app.auth.resolveTenantContext(headers).catch(() => undefined);

  // ---------- POST /v1/organizations ------------------------------------------
  if (method === "POST" && pathname === "/v1/organizations") {
    const body = await readJsonBody<{ name: string; slug: string }>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const org = app.platform.workspace.createOrganization(body);
    sendJson(res, 201, org);
    return;
  }

  // ---------- POST /v1/workspaces ---------------------------------------------
  if (method === "POST" && pathname === "/v1/workspaces") {
    const body = await readJsonBody<{ organizationId: string; name: string; slug: string }>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const ws = await app.handlers.createWorkspace(body);
    sendJson(res, 201, ws);
    return;
  }

  // ---------- POST /v1/projects -----------------------------------------------
  if (method === "POST" && pathname === "/v1/projects") {
    const body = await readJsonBody<{ workspaceId: string; name: string; slug: string; visibility?: "private" | "organization" | "public" }>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const project = await app.handlers.createProject(body);
    sendJson(res, 201, project);
    return;
  }

  // ---------- POST /v1/projects/:projectId/imports/mod-list -------------------
  const importMatch = pathname.match(/^\/v1\/projects\/([^/]+)\/imports\/mod-list$/);
  if (method === "POST" && importMatch) {
    const projectId = decodeURIComponent(importMatch[1]!);
    const body = await readJsonBody<Parameters<typeof app.handlers.importModList>[0]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.importModList({ ...body, projectId }, context);
    sendJson(res, 201, result);
    return;
  }

  // ---------- POST /v1/mods/resolve -----------------------------------------
  const resolveMatch = pathname.match(/^\/v1\/mods\/resolve$/);
  if (method === "POST" && resolveMatch) {
    const body = await readJsonBody<{
      mods: Array<{ name: string; curseforgeProjectId?: number; modrinthProjectId?: string }>;
      minecraftVersion?: string;
      loader?: string;
    }>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    if (!body.mods || !Array.isArray(body.mods)) {
      sendError(res, 400, "invalid_input", "mods array is required."); return;
    }
    const result = await app.handlers.resolveMods(body, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/projects/:projectId/analyses ---------------------------
  const analysisSubmitMatch = pathname.match(/^\/v1\/projects\/([^/]+)\/analyses$/);
  if (method === "POST" && analysisSubmitMatch) {
    const projectId = decodeURIComponent(analysisSubmitMatch[1]!);
    const body = await readJsonBody<Parameters<typeof app.handlers.createAnalysis>[1]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const idempotencyKey = getHeader(req, "x-idempotency-key");
    if (idempotencyKey) {
      const result = await app.handlers.submitAnalysisRequest(projectId, body, context);
      sendJson(res, 202, result);
    } else {
      const result = await app.handlers.createAnalysis(projectId, body, context);
      sendJson(res, 201, result);
    }
    return;
  }

  // ---------- GET /v1/analysis-requests/:key ----------------------------------
  const requestStatusMatch = pathname.match(/^\/v1\/analysis-requests\/([^/]+)$/);
  if (method === "GET" && requestStatusMatch) {
    const key = decodeURIComponent(requestStatusMatch[1]!);
    const result = await app.handlers.getAnalysisRequestStatus(key);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/analysis-requests/:key/cancel --------------------------
  const requestCancelMatch = pathname.match(/^\/v1\/analysis-requests\/([^/]+)\/cancel$/);
  if (method === "POST" && requestCancelMatch) {
    const key = decodeURIComponent(requestCancelMatch[1]!);
    const result = await app.handlers.cancelAnalysisRequest(key);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId ------------------------------------
  const analysisGetMatch = pathname.match(/^\/v1\/analyses\/([^/]+)$/);
  if (method === "GET" && analysisGetMatch) {
    const analysisId = decodeURIComponent(analysisGetMatch[1]!);
    const result = await app.handlers.getAnalysis(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/progress ---------------------------
  const progressMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/progress$/);
  if (method === "GET" && progressMatch) {
    const analysisId = decodeURIComponent(progressMatch[1]!);
    const result = await app.handlers.getAnalysis(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/findings ---------------------------
  const findingsMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/findings$/);
  if (method === "GET" && findingsMatch) {
    const analysisId = decodeURIComponent(findingsMatch[1]!);
    const analysis = await app.handlers.getAnalysis(analysisId, context);
    sendJson(res, 200, { findings: analysis.findings });
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/artifacts --------------------------
  const artifactsMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/artifacts$/);
  if (method === "GET" && artifactsMatch) {
    const analysisId = decodeURIComponent(artifactsMatch[1]!);
    const result = await app.handlers.getAnalysisArtifacts(analysisId, context);
    sendJson(res, 200, { items: result });
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/graph ------------------------------
  const graphMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/graph$/);
  if (method === "GET" && graphMatch) {
    const analysisId = decodeURIComponent(graphMatch[1]!);
    const result = await app.handlers.getAnalysisGraph(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/graph/neighborhood -----------------
  const neighborhoodMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/graph\/neighborhood$/);
  if (method === "GET" && neighborhoodMatch) {
    const analysisId = decodeURIComponent(neighborhoodMatch[1]!);
    const nodeId = url.searchParams.get("nodeId") ?? "";
    const depth = Number(url.searchParams.get("depth") ?? "1");
    const result = await app.handlers.getGraphNeighborhood(analysisId, nodeId, depth, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/explanations/:findingId ------------
  const explanationMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/explanations\/([^/]+)$/);
  if (method === "GET" && explanationMatch) {
    const analysisId = decodeURIComponent(explanationMatch[1]!);
    const findingId = decodeURIComponent(explanationMatch[2]!);
    const result = await app.handlers.explainFinding(analysisId, findingId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/evidence/sync ------------------------------------------
  if (method === "POST" && pathname === "/v1/evidence/sync") {
    const body = await readJsonBody<{ connectorNames?: string[] }>(req);
    const result = await app.handlers.syncEvidence(body?.connectorNames, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/evidence/search ----------------------------------------
  if (method === "POST" && pathname === "/v1/evidence/search") {
    const body = await readJsonBody<Parameters<typeof app.handlers.searchEvidence>[0]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.searchEvidence(body);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/findings/:findingId/evidence -------
  const findingEvidenceMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/findings\/([^/]+)\/evidence$/);
  if (method === "GET" && findingEvidenceMatch) {
    const analysisId = decodeURIComponent(findingEvidenceMatch[1]!);
    const findingId = decodeURIComponent(findingEvidenceMatch[2]!);
    const limit = Number(url.searchParams.get("limit") ?? "5");
    const result = await app.handlers.getFindingEvidence(analysisId, findingId, limit, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/admin/rule-drafts -------------------------------------
  if (method === "POST" && pathname === "/v1/admin/rule-drafts") {
    const body = await readJsonBody<Parameters<typeof app.handlers.createRuleDraft>[0]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.createRuleDraft(body, context);
    sendJson(res, 201, result);
    return;
  }

  // ---------- GET /v1/admin/rule-drafts --------------------------------------
  if (method === "GET" && pathname === "/v1/admin/rule-drafts") {
    const status = url.searchParams.get("status") as Parameters<typeof app.handlers.listRuleDrafts>[0];
    const result = await app.handlers.listRuleDrafts(status, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/admin/rule-drafts/:draftId -----------------------------
  const ruleDraftMatch = pathname.match(/^\/v1\/admin\/rule-drafts\/([^/]+)$/);
  if (method === "GET" && ruleDraftMatch) {
    const draftId = decodeURIComponent(ruleDraftMatch[1]!);
    const result = await app.handlers.getRuleDraft(draftId, context);
    if (!result) { sendError(res, 404, "not_found", "Rule draft not found."); return; }
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/admin/rule-drafts/:draftId/validate -------------------
  const validateRuleDraftMatch = pathname.match(/^\/v1\/admin\/rule-drafts\/([^/]+)\/validate$/);
  if (method === "POST" && validateRuleDraftMatch) {
    const draftId = decodeURIComponent(validateRuleDraftMatch[1]!);
    const body = await readJsonBody<{ strict?: boolean }>(req);
    const result = await app.handlers.validateRuleDraft(draftId, body?.strict, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/admin/rule-drafts/:draftId/promote --------------------
  const promoteRuleDraftMatch = pathname.match(/^\/v1\/admin\/rule-drafts\/([^/]+)\/promote$/);
  if (method === "POST" && promoteRuleDraftMatch) {
    const draftId = decodeURIComponent(promoteRuleDraftMatch[1]!);
    const body = await readJsonBody<{ promotedBy: string; changeNote?: string }>(req);
    if (!body?.promotedBy) { sendError(res, 400, "body_required", "`promotedBy` is required."); return; }
    const result = await app.handlers.promoteRuleDraft(
      { draftId, promotedBy: body.promotedBy, changeNote: body.changeNote },
      context
    );
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/admin/rules/:ruleId/history ----------------------------
  const ruleHistoryMatch = pathname.match(/^\/v1\/admin\/rules\/([^/]+)\/history$/);
  if (method === "GET" && ruleHistoryMatch) {
    const ruleId = decodeURIComponent(ruleHistoryMatch[1]!);
    const result = await app.handlers.getRuleHistory(ruleId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/admin/evidence-curations --------------------------------
  if (method === "POST" && pathname === "/v1/admin/evidence-curations") {
    const body = await readJsonBody<Parameters<typeof app.handlers.createEvidenceCuration>[0]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.createEvidenceCuration(body, context);
    sendJson(res, 201, result);
    return;
  }

  // ---------- POST /v1/admin/evidence-curations/:curationId/promote -----------
  const promoteMatch = pathname.match(/^\/v1\/admin\/evidence-curations\/([^/]+)\/promote$/);
  if (method === "POST" && promoteMatch) {
    const curationId = decodeURIComponent(promoteMatch[1]!);
    const body = await readJsonBody<{ promotedBy: string }>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.promoteVerifiedRule({ curationId, promotedBy: body.promotedBy }, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/recommendations --------------------
  const recommendationsMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/recommendations$/);
  if (method === "GET" && recommendationsMatch) {
    const analysisId = decodeURIComponent(recommendationsMatch[1]!);
    const result = await app.handlers.getRecommendations(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/recommendations/:recommendationId/feedback -------------
  const feedbackMatch = pathname.match(/^\/v1\/recommendations\/([^/]+)\/feedback$/);
  if (method === "POST" && feedbackMatch) {
    const recommendationId = decodeURIComponent(feedbackMatch[1]!);
    const body = await readJsonBody<Omit<Parameters<typeof app.handlers.submitRecommendationFeedback>[0], "recommendationId">>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.submitRecommendationFeedback({ ...body, recommendationId });
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/recommendation-sets/:setId/outcomes --------------------
  const outcomeMatch = pathname.match(/^\/v1\/recommendation-sets\/([^/]+)\/outcomes$/);
  if (method === "POST" && outcomeMatch) {
    const recommendationSetId = decodeURIComponent(outcomeMatch[1]!);
    const body = await readJsonBody<Omit<Parameters<typeof app.handlers.recordRecommendationOutcome>[0], "recommendationSetId">>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.recordRecommendationOutcome({ ...body, recommendationSetId });
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/ml/features ------------------------
  const mlFeaturesMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/ml\/features$/);
  if (method === "GET" && mlFeaturesMatch) {
    const analysisId = decodeURIComponent(mlFeaturesMatch[1]!);
    const result = await app.handlers.getAnalysisFeatureDataset(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/review-summary ---------------------
  const reviewMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/review-summary$/);
  if (method === "GET" && reviewMatch) {
    const analysisId = decodeURIComponent(reviewMatch[1]!);
    const result = await app.handlers.getPackReviewSummary(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/simulation -------------------------
  const simulationMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/simulation$/);
  if (method === "GET" && simulationMatch) {
    const analysisId = decodeURIComponent(simulationMatch[1]!);
    const result = await app.handlers.getSimulationRun(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/release-gate ----------------------
  const releaseGateMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/release-gate$/);
  if (method === "GET" && releaseGateMatch) {
    const analysisId = decodeURIComponent(releaseGateMatch[1]!);
    const result = await app.handlers.getReleaseGateDecision(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/status-check -----------------------
  const statusCheckMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/status-check$/);
  if (method === "GET" && statusCheckMatch) {
    const analysisId = decodeURIComponent(statusCheckMatch[1]!);
    const result = await app.handlers.getStatusCheck(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/report -----------------------------
  const reportMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/report$/);
  if (method === "GET" && reportMatch && !pathname.endsWith("/export")) {
    const analysisId = decodeURIComponent(reportMatch[1]!);
    const result = await app.handlers.getAnalysisReport(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/report/export ----------------------
  const reportExportMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/report\/export$/);
  if (method === "GET" && reportExportMatch) {
    const analysisId = decodeURIComponent(reportExportMatch[1]!);
    const format = (url.searchParams.get("format") ?? "markdown") as "json" | "markdown";
    const result = await app.handlers.exportAnalysisReport({ analysisId, format }, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/projects/:projectId/diffs ------------------------------
  const diffCreateMatch = pathname.match(/^\/v1\/projects\/([^/]+)\/diffs$/);
  if (method === "POST" && diffCreateMatch) {
    const projectId = decodeURIComponent(diffCreateMatch[1]!);
    const body = await readJsonBody<Parameters<typeof app.handlers.createPackDiff>[1]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.createPackDiff(projectId, body);
    sendJson(res, 201, result);
    return;
  }

  // ---------- GET /v1/pack-diffs/:packDiffId ----------------------------------
  const diffGetMatch = pathname.match(/^\/v1\/pack-diffs\/([^/]+)$/);
  if (method === "GET" && diffGetMatch) {
    const packDiffId = decodeURIComponent(diffGetMatch[1]!);
    const result = await app.handlers.getPackDiff(packDiffId);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/integrations/github/installations/:id/link -------------
  const githubLinkMatch = pathname.match(/^\/v1\/integrations\/github\/installations\/([^/]+)\/link$/);
  if (method === "POST" && githubLinkMatch) {
    const installationId = decodeURIComponent(githubLinkMatch[1]!);
    const body = await readJsonBody<{ projectId: string; repositoryFullName: string }>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.linkGitHubInstallation({ installationId, ...body });
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/webhooks -----------------------------------------------
  if (method === "POST" && pathname === "/v1/webhooks") {
    const body = await readJsonBody<Parameters<typeof app.handlers.createWebhook>[0]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.createWebhook(body, context);
    sendJson(res, 201, result);
    return;
  }

  // ---------- GET /v1/webhooks ------------------------------------------------
  if (method === "GET" && pathname === "/v1/webhooks") {
    const result = await app.handlers.listWebhooks();
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/analyses/:analysisId/webhook-deliveries ----------------
  const webhookDeliveriesMatch = pathname.match(/^\/v1\/analyses\/([^/]+)\/webhook-deliveries$/);
  if (method === "GET" && webhookDeliveriesMatch) {
    const analysisId = decodeURIComponent(webhookDeliveriesMatch[1]!);
    const result = await app.handlers.listWebhookDeliveries(analysisId, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/internal/snapshots/build-and-promote ------------------
  if (method === "POST" && pathname === "/v1/internal/snapshots/build-and-promote") {
    const body = await readJsonBody<{ createdBy?: string; versionLabel?: string; force?: boolean }>(req);
    const options = { createdBy: body?.createdBy ?? "system", versionLabel: body?.versionLabel, force: body?.force };
    const result = await app.handlers.buildAndPromoteSnapshot(options, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/internal/artifact-analysis/schedule --------------------
  if (method === "POST" && pathname === "/v1/internal/artifact-analysis/schedule") {
    const body = await readJsonBody<{ versionIds?: string[] }>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    if (!Array.isArray(body.versionIds)) {
      sendError(res, 400, "invalid_input", "versionIds array is required."); return;
    }
    const result = await app.handlers.scheduleArtifactAnalysis(body.versionIds, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/internal/snapshots/active -------------------------------
  if (method === "GET" && pathname === "/v1/internal/snapshots/active") {
    const result = await app.handlers.getActiveSnapshotSummary(context);
    if (!result) { sendError(res, 404, "not_found", "No active knowledge snapshot found."); return; }
    sendJson(res, 200, result);
    return;
  }

  // ---------- GET /v1/internal/snapshots/:snapshotId/candidates ----------------
  const candidatesMatch = pathname.match(/^\/v1\/internal\/snapshots\/([^/]+)\/candidates$/);
  if (method === "GET" && candidatesMatch) {
    const snapshotId = decodeURIComponent(candidatesMatch[1]!);
    const result = await app.handlers.generateCandidatesForPipeline1(snapshotId, context);
    sendJson(res, 200, { candidates: result });
    return;
  }

  // ---------- POST /v1/internal/snapshots/:snapshotId/approve ----------------
  const approveSnapshotMatch = pathname.match(/^\/v1\/internal\/snapshots\/([^/]+)\/approve$/);
  if (method === "POST" && approveSnapshotMatch) {
    const snapshotId = decodeURIComponent(approveSnapshotMatch[1]!);
    const body = await readJsonBody<{ approvedBy?: string; note?: string }>(req);
    if (!body?.approvedBy) { sendError(res, 400, "body_required", "`approvedBy` is required."); return; }
    const result = await app.handlers.approveSnapshot(
      snapshotId,
      { approvedBy: body.approvedBy, note: body.note },
      context
    );
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/internal/snapshots/refresh -----------------------------
  if (method === "POST" && pathname === "/v1/internal/snapshots/refresh") {
    const body = await readJsonBody<{ createdBy?: string; force?: boolean }>(req);
    const options = { createdBy: body?.createdBy ?? "system", force: body?.force };
    const result = await app.handlers.triggerSnapshotRefresh(options, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/internal/offline/refresh -------------------------------
  if (method === "POST" && pathname === "/v1/internal/offline/refresh") {
    const body = await readJsonBody<Parameters<typeof app.handlers.runOfflineRefresh>[0]>(req);
    const result = await app.handlers.runOfflineRefresh(body ?? {}, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/internal/catalog/ingest --------------------------------
  if (method === "POST" && pathname === "/v1/internal/catalog/ingest") {
    const body = await readJsonBody<Parameters<typeof app.handlers.ingestCatalog>[0]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.ingestCatalog(body, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- POST /v1/internal/evidence/ingest -------------------------------
  if (method === "POST" && pathname === "/v1/internal/evidence/ingest") {
    const body = await readJsonBody<Parameters<typeof app.handlers.ingestEvidence>[0]>(req);
    if (!body) { sendError(res, 400, "body_required", "Request body required."); return; }
    const result = await app.handlers.ingestEvidence(body, context);
    sendJson(res, 200, result);
    return;
  }

  // ---------- 404 -------------------------------------------------------------
  sendError(res, 404, "route_not_found", `${method} ${pathname} is not a known gateway route.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startGatewayServer();
}
