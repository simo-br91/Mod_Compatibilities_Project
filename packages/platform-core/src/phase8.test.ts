import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createPhase1Platform,
  TenantIsolationError,
  filterByTenant,
  stampTenant
} from "./index.js";
import type { TenantContext } from "@modcompat/api-contracts";
import type { TenantScopedRecord } from "@modcompat/domain-models";

function loadPhase8Fixtures() {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../fixtures/tenancy/phase8-tenant-fixtures.json"),
      "utf8"
    )
  ) as {
    organizations: Array<{
      organizationId: string;
      actorId: string;
      actorKind: "user" | "api_key" | "system";
      role: "owner" | "admin" | "analyst" | "user" | "api_key";
      expectedAccess: boolean;
    }>;
  };
}

function buildContext(
  org: ReturnType<typeof loadPhase8Fixtures>["organizations"][number]
): TenantContext {
  return {
    organizationId: org.organizationId,
    actorId: org.actorId,
    actorKind: org.actorKind,
    role: org.role,
    permissions: [],
    requestId: `req_phase8_${org.organizationId}`,
    traceId: `trace_phase8_${org.organizationId}`
  };
}

test("phase 8 tenant-scoped analysis retrieval enforces organization ownership", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const fixtures = loadPhase8Fixtures();

  for (const org of fixtures.organizations) {
    const context = buildContext(org);
    if (org.expectedAccess) {
      assert.doesNotThrow(
        () => platform.getTenantScopedAnalysis(demo.analysis.analysisId, context),
        `org ${org.organizationId} should be allowed to read the demo analysis`
      );
    } else {
      assert.throws(
        () => platform.getTenantScopedAnalysis(demo.analysis.analysisId, context),
        TenantIsolationError,
        `org ${org.organizationId} must be blocked from reading org_demo's analysis`
      );
    }
  }
});

test("phase 8 tenant-scoped analysis returns correct analysis data for the owning org", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();

  const ownerContext: TenantContext = {
    organizationId: "org_demo",
    actorId: "usr_demo",
    actorKind: "user",
    role: "owner",
    permissions: [],
    requestId: "req_phase8_owner",
    traceId: "trace_phase8_owner"
  };

  const result = platform.getTenantScopedAnalysis(demo.analysis.analysisId, ownerContext);

  assert.equal(result.analysis.analysisId, demo.analysis.analysisId);
  assert.equal(result.analysis.organizationId, "org_demo");
  assert.ok(result.findings.length > 0, "Retrieved analysis must include findings");
  assert.ok(result.recommendations.length > 0, "Retrieved analysis must include recommendations");
});

test("phase 8 filterByTenant correctly partitions records across organizations", () => {
  const orgAContext: TenantContext = {
    organizationId: "org_a_phase8",
    actorId: "usr_a",
    actorKind: "user",
    role: "owner",
    permissions: [],
    requestId: "req_a",
    traceId: "trace_a"
  };
  const orgBContext: TenantContext = {
    organizationId: "org_b_phase8",
    actorId: "usr_b",
    actorKind: "user",
    role: "owner",
    permissions: [],
    requestId: "req_b",
    traceId: "trace_b"
  };

  type TestRecord = TenantScopedRecord & { id: string };
  const records: TestRecord[] = [
    stampTenant({ schemaVersion: 1, id: "r1" } as TestRecord, orgAContext),
    stampTenant({ schemaVersion: 1, id: "r2" } as TestRecord, orgBContext),
    stampTenant({ schemaVersion: 1, id: "r3" } as TestRecord, orgAContext)
  ];

  const orgARecords = filterByTenant(records, orgAContext);
  const orgBRecords = filterByTenant(records, orgBContext);

  assert.equal(orgARecords.length, 2);
  assert.equal(orgBRecords.length, 1);
  assert.ok(orgARecords.every((r) => r.tenantId === "org_a_phase8"));
  assert.ok(orgBRecords.every((r) => r.tenantId === "org_b_phase8"));
});

test("phase 8 stampTenant sets the correct tenantId and does not mutate the original", () => {
  const context: TenantContext = {
    organizationId: "org_stamp_test",
    actorId: "usr_test",
    actorKind: "user",
    role: "user",
    permissions: [],
    requestId: "req_stamp",
    traceId: "trace_stamp"
  };

  type TestRecord = TenantScopedRecord & { value: string };
  const original: TestRecord = { schemaVersion: 1, value: "hello" };
  const stamped = stampTenant(original, context);

  assert.equal(stamped.tenantId, "org_stamp_test");
  assert.equal(stamped.value, "hello");
  assert.equal(original.tenantId, undefined, "Original record must not be mutated");
});

test("phase 8 records without tenantId pass through filterByTenant for any organization (global catalog compatibility)", () => {
  const context: TenantContext = {
    organizationId: "org_any",
    actorId: "usr_any",
    actorKind: "user",
    role: "user",
    permissions: [],
    requestId: "req_any",
    traceId: "trace_any"
  };

  type TestRecord = TenantScopedRecord & { id: string };
  const globalRecord: TestRecord = { schemaVersion: 1, id: "global_r1" };
  const filtered = filterByTenant([globalRecord], context);

  assert.equal(filtered.length, 1, "Records with no tenantId must be visible to all organizations");
});
