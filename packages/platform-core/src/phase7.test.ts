import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createPhase1Platform,
  SlidingWindowRateLimiter,
  QuotaExceededError
} from "./index.js";
import type { QuotaPlan } from "@modcompat/api-contracts";

function loadPhase7Fixtures() {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../fixtures/operations/phase7-rate-limit-fixtures.json"),
      "utf8"
    )
  ) as {
    quotaPlans: { tightTest: QuotaPlan };
    rateLimitConfig: { limit: number; windowMs: number };
    expectedAuditEventTypes: string[];
  };
}

test("phase 7 audit logger captures import and analysis events from the demo flow", () => {
  const platform = createPhase1Platform();
  const fixtures = loadPhase7Fixtures();
  const demo = platform.createDemoFlow();

  const entries = platform.auditLogger.query("org_demo");

  assert.ok(
    fixtures.expectedAuditEventTypes.every((type) =>
      entries.some((entry) => entry.eventType === type)
    ),
    `Expected audit event types ${fixtures.expectedAuditEventTypes.join(", ")} to be present`
  );
  assert.ok(
    entries.some(
      (e) => e.resourceKind === "analysis" && e.resourceId === demo.analysis.analysisId
    ),
    "Expected an audit entry with the demo analysis ID"
  );
  assert.ok(
    entries.every((e) => e.organizationId === "org_demo"),
    "All audit entries must be scoped to org_demo"
  );
  assert.ok(
    entries.every((e) => e.outcome === "success"),
    "All demo flow audit entries must record success outcome"
  );
});

test("phase 7 audit logger query is isolated per organization", () => {
  const platform = createPhase1Platform();
  platform.createDemoFlow();

  const orgDemoEntries = platform.auditLogger.query("org_demo");
  const orgOtherEntries = platform.auditLogger.query("org_other_isolated_test");

  assert.ok(orgDemoEntries.length >= 2, "org_demo should have at least import + analysis entries");
  assert.equal(orgOtherEntries.length, 0, "org_other should have no entries");
});

test("phase 7 quota enforcer tracks and blocks analysis creation when daily limit is exceeded", () => {
  const platform = createPhase1Platform();
  const fixtures = loadPhase7Fixtures();
  const tightPlan = fixtures.quotaPlans.tightTest;

  // Fill the daily analysis quota
  for (let i = 0; i < tightPlan.maxAnalysesPerDay; i++) {
    platform.quota.assertCanStartAnalysis("org_phase7_quota_test", tightPlan);
    platform.quota.recordAnalysisStarted("org_phase7_quota_test");
    platform.quota.recordAnalysisFinished("org_phase7_quota_test");
  }

  // The next attempt must be blocked
  assert.throws(
    () => platform.quota.assertCanStartAnalysis("org_phase7_quota_test", tightPlan),
    QuotaExceededError
  );

  // A different organization's quota is entirely independent
  assert.doesNotThrow(
    () => platform.quota.assertCanStartAnalysis("org_phase7_other", tightPlan),
    "A different organization's quota must not be affected"
  );
});

test("phase 7 quota enforcer tracks concurrent analyses and blocks when limit reached", () => {
  const platform = createPhase1Platform();
  const fixtures = loadPhase7Fixtures();
  const tightPlan = fixtures.quotaPlans.tightTest;

  // Start up to the concurrent limit without finishing
  for (let i = 0; i < tightPlan.maxConcurrentAnalyses; i++) {
    platform.quota.assertCanStartAnalysis("org_phase7_concurrent", tightPlan);
    platform.quota.recordAnalysisStarted("org_phase7_concurrent");
  }

  // Next start must be blocked due to concurrent limit
  assert.throws(
    () => platform.quota.assertCanStartAnalysis("org_phase7_concurrent", tightPlan),
    QuotaExceededError
  );

  // After one finishes the slot opens up again
  platform.quota.recordAnalysisFinished("org_phase7_concurrent");
  assert.doesNotThrow(
    () => platform.quota.assertCanStartAnalysis("org_phase7_concurrent", tightPlan),
    "After finishing one analysis the concurrent slot should be available"
  );
});

test("phase 7 sliding window rate limiter allows up to the configured limit then rejects", () => {
  const fixtures = loadPhase7Fixtures();
  const limiter = new SlidingWindowRateLimiter(fixtures.rateLimitConfig);

  const results = Array.from({ length: fixtures.rateLimitConfig.limit + 1 }, () =>
    limiter.check("actor_phase7_rate")
  );

  const allowed = results.filter((r) => r.allowed);
  const blocked = results.filter((r) => !r.allowed);

  assert.equal(allowed.length, fixtures.rateLimitConfig.limit);
  assert.equal(blocked.length, 1);
  assert.ok(blocked[0]!.retryAfterSeconds! > 0, "Blocked result must include retry-after seconds");
  assert.equal(blocked[0]!.remaining, 0);
});

test("phase 7 sliding window rate limiter is keyed independently per actor", () => {
  const fixtures = loadPhase7Fixtures();
  const limiter = new SlidingWindowRateLimiter(fixtures.rateLimitConfig);

  // Exhaust the window for actor_a
  for (let i = 0; i < fixtures.rateLimitConfig.limit; i++) {
    limiter.check("actor_a");
  }
  const blockedA = limiter.check("actor_a");
  assert.equal(blockedA.allowed, false);

  // actor_b is unaffected
  const allowedB = limiter.check("actor_b");
  assert.ok(allowedB.allowed, "actor_b must be unaffected by actor_a's exhausted window");
});
