import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPhase1Platform } from "./index.js";

function loadPhase6Fixtures() {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../fixtures/simulation/phase6-simulation-fixtures.json"),
      "utf8"
    )
  ) as {
    recipes: Array<{ recipeKey: string }>;
    crashSignatures: Array<{ signatureKey: string }>;
  };
}

test("phase 6 analysis materializes deterministic simulation and release gate outputs", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const fixtures = loadPhase6Fixtures();

  assert.ok(demo.simulationRun);
  assert.ok(demo.releaseGateDecision);
  assert.ok(demo.phases.some((phase) => phase.phaseName === "simulation"));
  assert.ok(demo.phases.some((phase) => phase.phaseName === "release_gating"));
  assert.equal(demo.simulationRun!.recipeId, "rcp_client_startup_v1");
  assert.equal(fixtures.recipes[0]!.recipeKey, "client-startup-smoke");
  assert.equal(demo.releaseGateDecision!.status, "block");
});

test("phase 6 simulation evidence feeds findings and reports", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const report = platform.reports.getReport(demo.analysis.analysisId);

  assert.ok(
    demo.findings.some((finding) => finding.evidence.some((evidence) => evidence.type === "simulation"))
  );
  assert.equal(report.simulationRun?.simulationRunId, demo.simulationRun?.simulationRunId);
  assert.equal(
    report.releaseGateDecision?.releaseGateDecisionId,
    demo.releaseGateDecision?.releaseGateDecisionId
  );
});

test("extended phase 6 partner surfaces materialize status checks and webhook deliveries", () => {
  const platform = createPhase1Platform();
  platform.integrations.linkGitHubInstallation({
    installationId: "123456",
    projectId: "prj_demo",
    repositoryFullName: "demo-pack-studio/kitchen-sink-pack"
  });
  platform.notifications.registerWebhook({
    targetUrl: "https://example.invalid/webhooks/modcompat",
    eventTypes: ["analysis.completed"],
    secret: "demo-secret"
  });

  const demo = platform.createDemoFlow();
  const statusCheck = platform.notifications.getStatusCheck(demo.analysis.analysisId);
  const deliveries = platform.notifications.listDeliveries(demo.analysis.analysisId);

  assert.ok(statusCheck);
  assert.equal(statusCheck.installationId, "123456");
  assert.ok(deliveries.length >= 1);
  assert.equal(deliveries[0]!.eventType, "analysis.completed");
});
