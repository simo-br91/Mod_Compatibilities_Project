import assert from "node:assert/strict";
import test from "node:test";

import {
  signJwt,
  verifyJwt,
  JwtVerificationError,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  assertPermission,
  PermissionDeniedError,
  ROLE_PERMISSIONS,
  tenantContextFromJwt,
  computeWebhookSignature,
  verifyWebhookSignature,
  nextRetryDelaySeconds,
  WebhookDeliveryScheduler,
  UploadValidationService,
  createPhase1Platform
} from "./index.js";
import type { WebhookTransport } from "./webhooks.js";
import type { TenantContext } from "@modcompat/api-contracts";

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

test("phase 9 signJwt / verifyJwt round-trip succeeds with correct secret", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "usr_test",
    org: "org_test",
    role: "admin" as const,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  const secret = "test-secret-phase9";
  const token = signJwt(payload, secret);
  const decoded = verifyJwt(token, secret);

  assert.equal(decoded.sub, "usr_test");
  assert.equal(decoded.org, "org_test");
  assert.equal(decoded.role, "admin");
});

test("phase 9 verifyJwt throws JwtVerificationError for wrong secret", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { sub: "usr_test", org: "org_test", role: "user", iat: nowSeconds, exp: nowSeconds + 3600 },
    "correct-secret"
  );

  assert.throws(
    () => verifyJwt(token, "wrong-secret"),
    JwtVerificationError
  );
});

test("phase 9 verifyJwt throws JwtVerificationError for expired token", () => {
  const pastSeconds = Math.floor(Date.now() / 1000) - 7200;
  const token = signJwt(
    { sub: "usr_test", org: "org_test", role: "user", iat: pastSeconds - 3600, exp: pastSeconds },
    "secret"
  );

  assert.throws(
    () => verifyJwt(token, "secret"),
    (err: unknown) => {
      assert.ok(err instanceof JwtVerificationError);
      assert.equal(err.code, "jwt_expired");
      return true;
    }
  );
});

test("phase 9 verifyJwt throws JwtVerificationError for malformed token", () => {
  assert.throws(() => verifyJwt("not.a.valid.token.here", "secret"), JwtVerificationError);
  assert.throws(() => verifyJwt("only-two.parts", "secret"), JwtVerificationError);
});

test("phase 9 tenantContextFromJwt builds correct TenantContext", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "usr_ctx",
    org: "org_ctx",
    role: "analyst" as const,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  const secret = "ctx-secret";
  const token = signJwt(payload, secret);
  const decoded = verifyJwt(token, secret);
  const context = tenantContextFromJwt(decoded, "req_123", "trace_123");

  assert.equal(context.organizationId, "org_ctx");
  assert.equal(context.actorId, "usr_ctx");
  assert.equal(context.role, "analyst");
  assert.ok(context.permissions.includes("analyses:read"), "analyst should have analyses:read");
  assert.ok(
    !context.permissions.includes("admin:rules"),
    "analyst should not have admin:rules"
  );
});

test("phase 9 auth session path issues a JWT-backed session when no token is provided", async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "phase9-session-secret-for-tests";

  try {
    const platform = createPhase1Platform();
    const session = await platform.auth.createSessionFromToken();

    assert.equal(session.user.userId, "usr_demo");
    assert.equal(session.organization.organizationId, "org_demo");
    assert.ok(session.token.split(".").length === 3, "session token should be a JWT");

    const decoded = verifyJwt(session.token, process.env.JWT_SECRET);
    assert.equal(decoded.sub, "usr_demo");
    assert.equal(decoded.org, "org_demo");
  } finally {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }
});

test("phase 9 auth session path accepts a caller-provided JWT and resolves the scoped session", async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "phase9-session-secret-for-tests";

  try {
    const platform = createPhase1Platform();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = signJwt(
      {
        sub: "usr_demo",
        org: "org_demo",
        role: "owner",
        iat: nowSeconds,
        exp: nowSeconds + 3600
      },
      process.env.JWT_SECRET
    );

    const session = await platform.auth.createSessionFromToken(token);

    assert.equal(session.token, token);
    assert.equal(session.user.userId, "usr_demo");
    assert.equal(session.organization.organizationId, "org_demo");
    assert.ok(
      session.memberships.some((membership) => membership.role === "owner"),
      "expected owner membership to be present"
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

test("phase 9 generateApiKey returns raw key with mck_ prefix and matching hash", () => {
  const { raw, prefix, hash } = generateApiKey();

  assert.ok(raw.startsWith("mck_"), "Raw key must start with mck_");
  assert.ok(raw.startsWith(prefix), "Prefix must be the beginning of the raw key");
  assert.equal(hash, hashApiKey(raw), "Hash must match the computed hash of the raw key");
});

test("phase 9 verifyApiKey returns true for matching raw/hash pair", () => {
  const { raw, hash } = generateApiKey();
  assert.ok(verifyApiKey(raw, hash), "verifyApiKey must return true for the correct pair");
});

test("phase 9 verifyApiKey returns false for wrong raw key", () => {
  const { hash } = generateApiKey();
  const { raw: wrongRaw } = generateApiKey();
  assert.equal(verifyApiKey(wrongRaw, hash), false);
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

test("phase 9 assertPermission does not throw for owner accessing admin:rules", () => {
  const context: TenantContext = {
    organizationId: "org_rbac",
    actorId: "usr_owner",
    actorKind: "user",
    role: "owner",
    permissions: ROLE_PERMISSIONS["owner"],
    requestId: "req_rbac",
    traceId: "trace_rbac"
  };
  assert.doesNotThrow(() => assertPermission(context, "admin:rules"));
});

test("phase 9 assertPermission throws PermissionDeniedError for user accessing admin:rules", () => {
  const context: TenantContext = {
    organizationId: "org_rbac",
    actorId: "usr_regular",
    actorKind: "user",
    role: "user",
    permissions: ROLE_PERMISSIONS["user"],
    requestId: "req_rbac_user",
    traceId: "trace_rbac_user"
  };

  assert.throws(
    () => assertPermission(context, "admin:rules"),
    (err: unknown) => {
      assert.ok(err instanceof PermissionDeniedError);
      assert.equal(err.code, "permission_denied");
      assert.equal(err.permission, "admin:rules");
      return true;
    }
  );
});

test("phase 9 assertPermission respects explicit permission list for api_key role", () => {
  const contextWithPerm: TenantContext = {
    organizationId: "org_apikey",
    actorId: "key_abc",
    actorKind: "api_key",
    role: "api_key",
    permissions: ["analyses:read", "reports:export"],
    requestId: "req_key",
    traceId: "trace_key"
  };
  assert.doesNotThrow(() => assertPermission(contextWithPerm, "analyses:read"));
  assert.throws(() => assertPermission(contextWithPerm, "analyses:write"), PermissionDeniedError);
});

// ---------------------------------------------------------------------------
// Webhook signing
// ---------------------------------------------------------------------------

test("phase 9 computeWebhookSignature produces deterministic hex output", () => {
  const sig1 = computeWebhookSignature('{"event":"test"}', "secret", "1700000000");
  const sig2 = computeWebhookSignature('{"event":"test"}', "secret", "1700000000");
  assert.equal(sig1, sig2, "Same inputs must produce identical signatures");
  assert.match(sig1, /^[0-9a-f]{64}$/, "Signature must be 64 hex chars (SHA-256)");
});

test("phase 9 verifyWebhookSignature accepts a fresh valid signature", () => {
  const payload = '{"event":"analysis.completed"}';
  const secret = "webhook-secret-phase9";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeWebhookSignature(payload, secret, timestamp);

  assert.ok(
    verifyWebhookSignature(payload, secret, signature, timestamp),
    "A fresh valid signature must be accepted"
  );
});

test("phase 9 verifyWebhookSignature rejects a stale timestamp", () => {
  const payload = '{"event":"analysis.completed"}';
  const secret = "webhook-secret-phase9";
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400); // > 300s old
  const signature = computeWebhookSignature(payload, secret, staleTimestamp);

  assert.equal(
    verifyWebhookSignature(payload, secret, signature, staleTimestamp),
    false,
    "Stale timestamp must be rejected"
  );
});

test("phase 9 verifyWebhookSignature rejects tampered payload", () => {
  const secret = "webhook-secret-phase9";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeWebhookSignature('{"original":"payload"}', secret, timestamp);

  assert.equal(
    verifyWebhookSignature('{"tampered":"payload"}', secret, signature, timestamp),
    false,
    "Tampered payload must be rejected"
  );
});

// ---------------------------------------------------------------------------
// WebhookDeliveryScheduler — retry and dead-letter
// ---------------------------------------------------------------------------

test("phase 9 WebhookDeliveryScheduler delivers successfully on first attempt", async () => {
  const deliveries: Array<{ url: string; payload: string }> = [];
  const transport: WebhookTransport = {
    async deliver(url, payload) {
      deliveries.push({ url, payload });
      return { httpStatus: 200, durationMs: 1 };
    }
  };
  const scheduler = new WebhookDeliveryScheduler(transport);
  scheduler.schedule("wh_1", "https://example.com/hook", "secret", "analysis.completed", '{"id":"a1"}');

  await scheduler.processDue();

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.url, "https://example.com/hook");
  assert.equal(scheduler.pendingCount(), 0);

  const attempts = scheduler.getAttempts("wh_1");
  assert.equal(attempts.length, 1);
  assert.ok(attempts[0]!.deliveredAt, "Successful attempt must have deliveredAt set");
});

test("phase 9 WebhookDeliveryScheduler retries on failure and dead-letters after 5 attempts", async () => {
  const transport: WebhookTransport = {
    async deliver() {
      return { httpStatus: 500, durationMs: 1 };
    }
  };
  const scheduler = new WebhookDeliveryScheduler(transport);
  scheduler.schedule("wh_dlq", "https://example.com/hook", "secret", "analysis.completed", '{"id":"a2"}');

  // Exhaust all 5 attempts by processing pending deliveries regardless of delay
  for (let i = 0; i < 5; i++) {
    // Force all pending to be due by passing a far-future timestamp
    await scheduler.processDue(Date.now() + 10_000_000);
  }

  assert.equal(scheduler.pendingCount(), 0, "All retries exhausted — nothing should remain pending");
  const deadLetters = scheduler.getDeadLetters("wh_dlq");
  assert.equal(deadLetters.length, 1, "Delivery should be dead-lettered after 5 failed attempts");
  assert.equal(deadLetters[0]!.totalAttempts, 5);
});

test("phase 9 nextRetryDelaySeconds follows the back-off schedule", () => {
  assert.equal(nextRetryDelaySeconds(0), 10);
  assert.equal(nextRetryDelaySeconds(1), 30);
  assert.equal(nextRetryDelaySeconds(2), 120);
  assert.equal(nextRetryDelaySeconds(3), 600);
  assert.equal(nextRetryDelaySeconds(4), 1800);
  // Beyond the table should clamp to the last value
  assert.equal(nextRetryDelaySeconds(10), 1800);
});

// ---------------------------------------------------------------------------
// UploadValidationService
// ---------------------------------------------------------------------------

test("phase 9 UploadValidationService accepts a valid JAR (ZIP magic bytes)", () => {
  const jarBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(100)]);
  const svc = new UploadValidationService();
  const result = svc.validate(jarBytes, "application/java-archive");

  assert.ok(result.valid, "JAR with PK header must be valid");
  assert.equal(result.detectedMimeType, "application/java-archive");
});

test("phase 9 UploadValidationService accepts a valid Java class file (CAFEBABE)", () => {
  const classBytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, ...new Uint8Array(100)]);
  const svc = new UploadValidationService();
  const result = svc.validate(classBytes);

  assert.ok(result.valid);
  assert.equal(result.detectedMimeType, "application/java-archive");
});

test("phase 9 UploadValidationService rejects files exceeding max size", () => {
  const bigFile = new Uint8Array(200); // 200 bytes with 100-byte limit
  const svc = new UploadValidationService({ maxFileSizeBytes: 100 });
  const result = svc.validate(bigFile);

  assert.equal(result.valid, false);
  assert.equal(result.rejectionReason, "size_exceeded");
});

test("phase 9 UploadValidationService rejects Windows PE executables (MZ header)", () => {
  const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Uint8Array(100)]);
  const svc = new UploadValidationService();
  const result = svc.validate(exeBytes);

  assert.equal(result.valid, false);
  assert.equal(result.rejectionReason, "malware_signature");
});

test("phase 9 UploadValidationService rejects ELF binaries", () => {
  const elfBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...new Uint8Array(100)]);
  const svc = new UploadValidationService();
  const result = svc.validate(elfBytes);

  assert.equal(result.valid, false);
  assert.equal(result.rejectionReason, "malware_signature");
});

test("phase 9 UploadValidationService rejects MIME mismatch (JSON declared but JAR detected)", () => {
  const jarBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(100)]);
  const svc = new UploadValidationService();
  const result = svc.validate(jarBytes, "application/json");

  assert.equal(result.valid, false);
  assert.equal(result.rejectionReason, "mime_mismatch");
});

test("phase 9 UploadValidationService allows zip declared as application/zip when JAR is detected", () => {
  const jarBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(100)]);
  const svc = new UploadValidationService();
  const result = svc.validate(jarBytes, "application/zip");

  assert.ok(result.valid, "application/zip declared for a JAR (which is a ZIP) must be accepted");
});

// ---------------------------------------------------------------------------
// Phase1Platform integration — webhookScheduler and uploadValidation wired
// ---------------------------------------------------------------------------

test("phase 9 Phase1Platform exposes webhookScheduler and uploadValidation", () => {
  const platform = createPhase1Platform();
  assert.ok(platform.webhookScheduler, "webhookScheduler must be present on Phase1Platform");
  assert.ok(platform.uploadValidation, "uploadValidation must be present on Phase1Platform");

  // Quick sanity: upload validation works through the platform instance
  const jarBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(100)]);
  const result = platform.uploadValidation.validate(jarBytes);
  assert.ok(result.valid);
});
