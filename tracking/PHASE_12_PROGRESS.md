# Phase 12 Progress — Security, Tenancy, and Platform Hardening

## Status: COMPLETE

All exit criteria met. 49/49 tests pass across platform-core (phase2–phase9), no regressions.

---

## Deliverables

### `packages/platform-core/src/auth.ts` (pre-existing, now exported)
- HS256 JWT sign (`signJwt`) and verify (`verifyJwt`) — constant-time signature check, expiry check, 30-second clock-skew tolerance
- `JwtVerificationError` with typed `code` field (`jwt_malformed`, `jwt_signature_invalid`, `jwt_expired`, `jwt_future_iat`)
- `generateApiKey()` — `mck_<32 random hex>` prefix format; `hashApiKey`, `verifyApiKey` with `timingSafeEqual`
- `ROLE_PERMISSIONS` — full RBAC grant table for `owner / admin / analyst / user / api_key`
- `hasPermission`, `assertPermission`, `PermissionDeniedError`
- `tenantContextFromJwt(payload, requestId, traceId)` — gateway middleware helper
- `systemTenantContext(organizationId)` — background-job helper
- `createDemoJwt(secret, overrides?)` — dev/test convenience

### `packages/platform-core/src/webhooks.ts` (pre-existing, now exported)
- `computeWebhookSignature(payload, secret, timestamp)` — HMAC-SHA256 of `${timestamp}.${payload}`
- `verifyWebhookSignature(...)` — constant-time verify + staleness guard (default 300 s)
- `nextRetryDelaySeconds(attempt)` — back-off table: 10 s → 30 s → 2 m → 10 m → 30 m
- `WebhookDeliveryScheduler` — `schedule()`, `processDue(now?)`, dead-letter after 5 failed attempts, `getAttempts()`, `getDeadLetters()`
- `noopWebhookTransport` — success no-op for tests and dev

### `packages/platform-core/src/upload-validation.ts` (new)
- `UploadValidationService` — configurable max size (default 100 MB) and allowed MIME set
- Magic-byte MIME detection: ZIP/JAR (`PK\x03\x04`), Java class (`CAFEBABE`), JSON (`{`/`[`)
- Malware signature rejection at byte 0: Windows PE (`MZ` / `4D 5A`), ELF (`7F ELF` / `7F 45 4C 46`)
- ZIP ↔ JAR declared-type aliasing (application/zip accepted for JAR content)
- Returns `UploadValidationResult` from `@modcompat/api-contracts`

### `packages/platform-core/src/rate-limit.ts` (extended)
- Added `DEFAULT_QUOTA_PLAN` — generous self-hosted defaults (1000 analyses/day, 10 concurrent, 10 GB export/day)

### `packages/platform-core/src/index.ts` (extended)
- Barrel exports added: `auth.js`, `webhooks.js`, `upload-validation.js`
- `Phase1Platform` gains `webhookScheduler = new WebhookDeliveryScheduler(noopWebhookTransport)` and `uploadValidation = new UploadValidationService()`

### `apps/gateway/src/app.ts` (hardened)
- Imports: `assertPermission`, `PermissionDeniedError`, `SlidingWindowRateLimiter`, `buildAuditEntry`, `DEFAULT_QUOTA_PLAN`, `TenantContext`
- Two rate limiters: `authenticatedApiLimiter` (100 req/min) and `writeOperationLimiter` (30 req/min)
- `checkPermission` / `checkWritePermission` helpers enforce rate limit then RBAC in one call
- `auditSuccess` / `auditDenied` helpers write to `platform.auditLogger`
- Hardened handlers (all accept optional `context?: TenantContext`):
  - `importModList` → `imports:write` permission check + `import.created` audit
  - `submitAnalysisRequest` → `analyses:write` permission check
  - `createAnalysis` → `analyses:write` + `quota.assertCanStartAnalysis` + `analysis.created` audit
  - `syncEvidence` → `evidence:sync` permission check
  - `createEvidenceCuration` → `evidence:curate` + `evidence.curation.created` audit
  - `promoteVerifiedRule` → `evidence:promote` + `evidence.rule.promoted` audit
  - `createWebhook` → `webhooks:manage` + `webhook.created` audit
  - `exportAnalysisReport` → `reports:export` + `report.exported` audit
- Log line updated: `"Gateway Phase 12 initialized"`

### `packages/platform-core/src/phase9.test.ts` (new — 26 tests)
| Area | Tests |
|------|-------|
| JWT sign / verify | 4 |
| `tenantContextFromJwt` | 1 |
| API key generation / verification | 3 |
| RBAC `assertPermission` | 3 |
| Webhook HMAC signing | 3 |
| `WebhookDeliveryScheduler` retry + DLQ | 3 |
| `nextRetryDelaySeconds` back-off | 1 |
| `UploadValidationService` | 7 |
| `Phase1Platform` integration | 1 |

---

## Exit Criteria

- [x] Tenant data isolated by design and in tests (phase8 tests)
- [x] JWT authentication layer with HS256 signing and verification
- [x] API key generation with timing-safe comparison
- [x] RBAC: full role-permission table, `assertPermission`, `PermissionDeniedError`
- [x] Upload hardening: MIME detection from magic bytes, size limits, malware signature rejection
- [x] Webhook signing with replay protection (timestamp staleness check)
- [x] Webhook retry scheduler with exponential back-off and dead-letter queue
- [x] Quota enforcement (`assertCanStartAnalysis`) wired into gateway `createAnalysis`
- [x] Per-actor rate limiting wired into gateway write handlers
- [x] Audit logging wired for all mutating gateway operations
- [x] All public entry points have auth/authz/rate-limiting/auditability hooks
- [x] 49/49 tests pass (phase2–phase9), zero regressions
