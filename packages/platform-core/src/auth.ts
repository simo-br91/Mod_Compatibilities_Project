/**
 * Platform authentication and authorisation utilities.
 *
 * Covers:
 *  - Lightweight JWT parsing and verification (HS256, no external deps)
 *  - API key generation and hashing
 *  - RBAC permission check table
 *  - OrganizationContext extraction from a verified identity
 *
 * NOTE: The JWT implementation here is intentionally minimal — it handles
 * HS256 only and is designed to be replaced by a dedicated auth library once
 * the persistence layer (Phase 7) is wired.  It is fully typed and testable
 * as-is.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { RbacRole, Permission, TenantContext } from "@modcompat/api-contracts";

// ---------------------------------------------------------------------------
// JWT — HS256 only
// ---------------------------------------------------------------------------

export interface JwtHeader {
  alg: "HS256";
  typ: "JWT";
}

export interface JwtPayload {
  sub: string;            // userId
  org: string;            // organizationId
  role: RbacRole;
  permissions?: Permission[];
  email?: string;
  name?: string;
  iat: number;            // issued-at (epoch seconds)
  exp: number;            // expiry (epoch seconds)
  jti?: string;           // JWT ID (for revocation)
  kind?: "user" | "api_key";
}

export class JwtVerificationError extends Error {
  readonly code: string;
  constructor(message: string, code = "jwt_invalid") {
    super(message);
    this.name = "JwtVerificationError";
    this.code = code;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

/**
 * Issue a signed HS256 JWT.
 */
export function signJwt(payload: JwtPayload, secret: string): string {
  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

/**
 * Verify a HS256 JWT and return the decoded payload.
 * Throws `JwtVerificationError` on any failure.
 */
export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtVerificationError("Malformed JWT: expected 3 parts.", "jwt_malformed");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac("sha256", secret).update(signingInput).digest();
  const receivedSig = base64UrlDecode(sigB64);
  if (
    expectedSig.length !== receivedSig.length ||
    !timingSafeEqual(expectedSig, receivedSig)
  ) {
    throw new JwtVerificationError("JWT signature verification failed.", "jwt_signature_invalid");
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as JwtPayload;
  } catch {
    throw new JwtVerificationError("JWT payload is not valid JSON.", "jwt_payload_invalid");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSeconds) {
    throw new JwtVerificationError("JWT has expired.", "jwt_expired");
  }
  if (payload.iat > nowSeconds + 30) {
    // 30-second clock-skew tolerance
    throw new JwtVerificationError("JWT issued in the future.", "jwt_future_iat");
  }

  return payload;
}

/**
 * Create a default demo JWT valid for 8 hours using the provided secret.
 * Useful for development sessions and integration tests.
 */
export function createDemoJwt(secret: string, overrides: Partial<JwtPayload> = {}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: "usr_demo",
    org: "org_demo",
    role: "admin",
    permissions: ROLE_PERMISSIONS["admin"],
    iat: nowSeconds,
    exp: nowSeconds + 8 * 3600,
    jti: randomUUID(),
    kind: "user",
    ...overrides,
  };
  return signJwt(payload, secret);
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * Generate a new raw API key.
 * Format: `mck_<32 random hex bytes>`
 * The raw value is returned once and MUST NOT be stored — only the hash should be persisted.
 */
export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `mck_${randomBytes(32).toString("hex")}`;
  const prefix = raw.slice(0, 12); // "mck_" + 8 hex chars
  const hash = hashApiKey(raw);
  return { raw, prefix, hash };
}

/**
 * Compute the storage hash for an API key.
 * Uses SHA-256; result is lowercase hex.
 */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Constant-time comparison of a raw API key against a stored hash.
 */
export function verifyApiKey(raw: string, storedHash: string): boolean {
  const computedHash = hashApiKey(raw);
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

/**
 * Default permission grants per role.
 * Callers may extend or restrict these at the API key level.
 */
export const ROLE_PERMISSIONS: Record<RbacRole, Permission[]> = {
  owner: [
    "analyses:read", "analyses:write", "analyses:cancel",
    "findings:read",
    "evidence:read", "evidence:sync", "evidence:curate", "evidence:promote",
    "recommendations:read", "recommendations:feedback", "recommendations:outcome",
    "graph:read",
    "reports:read", "reports:export",
    "imports:read", "imports:write",
    "admin:curations", "admin:rules",
    "org:manage",
    "projects:read", "projects:write",
    "webhooks:manage", "apikeys:manage",
  ],
  admin: [
    "analyses:read", "analyses:write", "analyses:cancel",
    "findings:read",
    "evidence:read", "evidence:sync", "evidence:curate", "evidence:promote",
    "recommendations:read", "recommendations:feedback", "recommendations:outcome",
    "graph:read",
    "reports:read", "reports:export",
    "imports:read", "imports:write",
    "admin:curations", "admin:rules",
    "projects:read", "projects:write",
    "webhooks:manage",
  ],
  analyst: [
    "analyses:read",
    "findings:read",
    "evidence:read", "evidence:sync", "evidence:curate",
    "recommendations:read", "recommendations:feedback",
    "graph:read",
    "reports:read", "reports:export",
    "imports:read",
    "projects:read",
  ],
  user: [
    "analyses:read", "analyses:write",
    "findings:read",
    "evidence:read",
    "recommendations:read", "recommendations:feedback",
    "graph:read",
    "reports:read", "reports:export",
    "imports:read", "imports:write",
    "projects:read",
  ],
  api_key: [], // api_key permissions are explicitly enumerated on the key record
};

/**
 * Check whether a role (or explicit permission list) grants a given permission.
 */
export function hasPermission(
  roleOrPermissions: RbacRole | Permission[],
  permission: Permission
): boolean {
  const list: Permission[] =
    Array.isArray(roleOrPermissions)
      ? roleOrPermissions
      : ROLE_PERMISSIONS[roleOrPermissions] ?? [];
  return list.includes(permission);
}

/**
 * Assert a permission, throwing if the actor is not authorised.
 */
export function assertPermission(
  context: Pick<TenantContext, "role" | "permissions">,
  permission: Permission
): void {
  const granted =
    context.role === "api_key"
      ? hasPermission(context.permissions, permission)
      : hasPermission(context.role, permission);
  if (!granted) {
    throw new PermissionDeniedError(permission);
  }
}

export class PermissionDeniedError extends Error {
  readonly code = "permission_denied" as const;
  readonly permission: Permission;
  constructor(permission: Permission) {
    super(`Actor does not have the '${permission}' permission.`);
    this.name = "PermissionDeniedError";
    this.permission = permission;
  }
}

// ---------------------------------------------------------------------------
// TenantContext construction
// ---------------------------------------------------------------------------

/**
 * Build a `TenantContext` from a verified JWT payload.
 * Used by gateway middleware after `verifyJwt` succeeds.
 */
export function tenantContextFromJwt(
  payload: JwtPayload,
  requestId: string,
  traceId: string
): TenantContext {
  const role = payload.role;
  const permissions: Permission[] =
    role === "api_key"
      ? (payload.permissions ?? [])
      : ROLE_PERMISSIONS[role] ?? [];
  return {
    organizationId: payload.org,
    actorId: payload.sub,
    actorKind: payload.kind ?? "user",
    role,
    permissions,
    requestId,
    traceId,
  };
}

/**
 * Build a system-internal `TenantContext` for background jobs that are not
 * triggered by an authenticated HTTP request.
 */
export function systemTenantContext(
  organizationId: string,
  requestId = randomUUID()
): TenantContext {
  return {
    organizationId,
    actorId: "system",
    actorKind: "system",
    role: "admin",
    permissions: ROLE_PERMISSIONS["admin"],
    requestId,
    traceId: requestId,
  };
}
