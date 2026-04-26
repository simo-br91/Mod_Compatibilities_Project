import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";
import {
  createPhase1Platform,
  ModelVersionConflictError,
  RuleValidationError
} from "./index.js";

const DEFAULT_POSTGRES_SMOKE_URL = "postgres://postgres:postgres@localhost:5432/modcompat";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function buildDatabaseConnectionString(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildAdminConnectionString(connectionString: string): string {
  return buildDatabaseConnectionString(connectionString, "postgres");
}

function describeConnectionError(error: unknown): string {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? ` (${error.code})`
        : "";
    return error.message ? `${error.name}${code}: ${error.message}` : `${error.name}${code}`;
  }

  return String(error);
}

async function tryCreateTempDatabase(baseConnectionString: string) {
  const adminPool = new Pool({
    connectionString: buildAdminConnectionString(baseConnectionString)
  });
  const databaseName = `modcompat_phase10_${randomUUID().replaceAll("-", "")}`;

  try {
    await adminPool.query("SELECT 1");
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    return {
      adminPool,
      databaseName,
      connectionString: buildDatabaseConnectionString(baseConnectionString, databaseName)
    };
  } catch (error) {
    await adminPool.end().catch(() => undefined);
    throw error;
  }
}

async function dropTempDatabase(adminPool: Pool, databaseName: string) {
  await adminPool.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1
       AND pid <> pg_backend_pid()`,
    [databaseName]
  );
  await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  await adminPool.end();
}

async function closePersistencePool(platform: ReturnType<typeof createPhase1Platform>) {
  const pool = (platform.persistence as unknown as { pool?: Pool }).pool;
  if (pool) {
    await pool.end();
  }
}

test("phase 10 rule drafts increment version numbers from live rules and pending drafts", () => {
  const platform = createPhase1Platform();

  const baseInput = {
    ruleId: "vr_optifine_fabric_loader_conflict",
    title: "OptiFine remains incompatible with the Fabric baseline",
    findingType: "verified_rule_conflict",
    severity: "critical" as const,
    confidence: 0.99,
    reproducibility: "confirmed" as const,
    summary: "Updated production-grade rule metadata.",
    recommendedActions: ["Remove OptiFine from Fabric packs."],
    conditions: [
      { type: "project_present" as const, project_id: "cp_optifine" },
      { type: "loader_is" as const, loader: "fabric" }
    ],
    createdBy: "usr_demo"
  };

  const firstDraft = platform.ruleDrafts.createDraft(baseInput);
  const secondDraft = platform.ruleDrafts.createDraft({
    ...baseInput,
    title: "OptiFine remains incompatible with supported Fabric targets"
  });

  assert.equal(firstDraft.version, 2, "Seeded verified rule v1 should force the next draft to v2");
  assert.equal(
    secondDraft.version,
    3,
    "Pending drafts must also advance the version number"
  );
});

test("phase 10 rule validation accepts intermittent reproducibility and rejects malformed draft DSL", () => {
  const platform = createPhase1Platform();

  const validDraft = platform.ruleDrafts.createDraft({
    title: "Intermittent renderer overlap",
    findingType: "renderer_overlap",
    severity: "medium",
    confidence: 0.72,
    reproducibility: "intermittent",
    summary: "Observed intermittently during curated replay.",
    recommendedActions: ["Pin the affected renderer pair before release."],
    conditions: [{ type: "project_present", project_id: "cp_sodium" }],
    createdBy: "usr_demo"
  });

  const validated = platform.ruleDrafts.validateDraft(validDraft.draftId, true);
  assert.equal(validated.status, "validated");

  const invalidDraft = platform.ruleDrafts.createDraft({
    title: "Broken range draft",
    findingType: "version_rule",
    severity: "high",
    confidence: 0.8,
    reproducibility: "possible" as never,
    summary: "This draft intentionally violates the DSL contract.",
    recommendedActions: [" "],
    conditions: [{ type: "version_range", project_id: "cp_sodium" } as never],
    createdBy: "usr_demo"
  });

  assert.throws(
    () => platform.ruleDrafts.validateDraft(invalidDraft.draftId, true),
    (error: unknown) => {
      assert.ok(error instanceof RuleValidationError);
      assert.ok(error.errors.includes('invalid reproducibility "possible"'));
      assert.ok(
        error.errors.includes("condition[0]: version_range requires min_version or max_version")
      );
      assert.ok(error.errors.includes("recommendedActions cannot contain blank entries"));
      return true;
    }
  );
  assert.equal(platform.ruleDrafts.getDraft(invalidDraft.draftId)?.status, "rejected");
});

test("phase 10 promoted version-range rules stay intact and execute through the verified rule engine", () => {
  const platform = createPhase1Platform();

  const draft = platform.ruleDrafts.createDraft({
    title: "Sodium 0.6.0 Fabric baseline verification",
    findingType: "version_window_match",
    severity: "medium",
    confidence: 0.88,
    reproducibility: "confirmed",
    summary: "The curated Fabric baseline expects Sodium 0.6.0 on Minecraft 1.21.1.",
    recommendedActions: ["Keep Sodium pinned to the verified baseline."],
    conditions: [
      { type: "project_present", project_id: "cp_sodium" },
      {
        type: "version_range",
        project_id: "cp_sodium",
        min_version: "0.6.0+mc1.21.1",
        max_version: "0.6.0+mc1.21.1"
      },
      { type: "loader_is", loader: "fabric" }
    ],
    createdBy: "usr_demo"
  });

  platform.ruleDrafts.validateDraft(draft.draftId, true);
  const promoted = platform.ruleDrafts.promoteDraft({
    draftId: draft.draftId,
    promotedBy: "usr_demo",
    changeNote: "Promote the first version-aware rule."
  });

  assert.ok(
    promoted.rule.conditions.some((condition) => condition.type === "version_range"),
    "Promotion must retain the version_range condition instead of dropping it"
  );
  assert.equal(platform.ruleDrafts.getRuleHistory(promoted.rule.rule_id).length, 1);

  const imported = platform.imports.importModList({
    projectId: "prj_demo",
    createdBy: "usr_demo",
    environment: {
      minecraftVersion: "1.21.1",
      loader: "fabric",
      javaVersion: "21",
      side: "both"
    },
    mods: [{ name: "sodium", version: "0.6.0+mc1.21.1" }]
  });

  const findings = platform.rules.evaluate(imported.snapshot);
  const emitted = findings.find((finding) => finding.type === "version_window_match");

  assert.ok(emitted, "The promoted rule should emit a finding for the matching snapshot");
  assert.deepEqual(emitted?.subjects, [{ projectId: "cp_sodium", relation: "primary" }]);
});

test("phase 10 model deployment and rollback preserve a rollback-ready candidate", () => {
  const platform = createPhase1Platform();

  const originalActive = platform.modelVersions.getActive("finding_risk_calibration");
  assert.ok(originalActive, "The seeded calibrator should start active");

  const shadow = platform.modelVersions.registerVersion({
    modelKey: "finding-risk-calibrator",
    version: "offline-trained-v2",
    task: "finding_risk_calibration",
    metrics: { precision: 0.91, recall: 0.84, f1: 0.87 },
    config: { artifactUri: "models/finding-risk/offline-trained-v2.bin" }
  });

  const deployed = platform.modelVersions.deployVersion(shadow.modelId);
  assert.equal(deployed.status, "active");
  assert.equal(
    platform.repository.modelRegistry.get(originalActive!.modelId)?.status,
    "rollback_ready"
  );

  const restored = platform.modelVersions.rollback("finding_risk_calibration");
  assert.equal(restored.modelId, originalActive!.modelId);
  assert.equal(platform.modelVersions.getActive("finding_risk_calibration")?.modelId, restored.modelId);
  assert.equal(platform.repository.modelRegistry.get(shadow.modelId)?.status, "rollback_ready");
});

test("phase 10 model version registration is idempotent for identical payloads and rejects conflicts", () => {
  const platform = createPhase1Platform();

  const registered = platform.modelVersions.registerVersion({
    modelKey: "grounded-pack-review",
    version: "reranker-shadow-v1",
    task: "grounded_summary",
    metrics: { precision: 0.8, recall: 0.79, f1: 0.795 },
    config: { artifactUri: "models/summaries/reranker-shadow-v1.bin" }
  });

  const sameVersion = platform.modelVersions.registerVersion({
    modelKey: "grounded-pack-review",
    version: "reranker-shadow-v1",
    task: "grounded_summary",
    metrics: { precision: 0.8, recall: 0.79, f1: 0.795 },
    config: { artifactUri: "models/summaries/reranker-shadow-v1.bin" }
  });

  assert.equal(sameVersion.modelId, registered.modelId);

  assert.throws(
    () =>
      platform.modelVersions.registerVersion({
        modelKey: "grounded-pack-review",
        version: "reranker-shadow-v1",
        task: "grounded_summary",
        metrics: { precision: 0.91, recall: 0.8, f1: 0.85 },
        config: { artifactUri: "models/summaries/reranker-shadow-v1-hotfix.bin" }
      }),
    ModelVersionConflictError
  );

  const evaluation = platform.modelVersions.recordEvaluation({
    modelId: registered.modelId,
    datasetId: "ds_grounded_summary_truth_v1",
    metrics: {
      precision: 0.83,
      recall: 0.8,
      f1: 0.8146,
      auc: 0.9,
      calibrationError: 0.04
    },
    sampleCount: 128
  });

  assert.equal(platform.modelVersions.getEvaluations(registered.modelId).length, 1);
  assert.equal(platform.modelVersions.getEvaluations(registered.modelId)[0]?.evaluationId, evaluation.evaluationId);
});

test("phase 10 feedback aggregation summarizes recommendation signals and stores the report", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const recommendationSet = demo.recommendationSet;

  assert.ok(recommendationSet, "Demo flow should produce a recommendation set");
  assert.ok(recommendationSet!.items.length > 0, "Demo flow should produce at least one recommendation");

  const accepted = recommendationSet!.items[0]!;
  platform.recommendations.submitFeedback({
    recommendationId: accepted.recommendationId,
    feedbackType: "accepted",
    createdBy: "usr_demo",
    note: "Applied successfully."
  });

  const dismissed = recommendationSet!.items[1];
  if (dismissed) {
    platform.recommendations.submitFeedback({
      recommendationId: dismissed.recommendationId,
      feedbackType: "dismissed",
      createdBy: "usr_demo",
      note: "Not needed for this pack."
    });
  }

  platform.recommendations.recordOutcome({
    recommendationSetId: recommendationSet!.recommendationSetId,
    status: "validated",
    appliedRecommendationIds: [accepted.recommendationId],
    validationSummary: "Follow-up validation completed successfully.",
    createdBy: "usr_demo"
  });

  const report = platform.feedbackSignals.computeSignalReport([demo.analysis.analysisId]);

  assert.equal(report.analysisCount, 1);
  assert.equal(report.totalOutcomes, 1);
  assert.ok(report.totalFeedbackItems >= 1);
  assert.equal(report.overallValidationRate, 1);
  assert.ok(report.overallAcceptanceRate > 0);
  assert.ok(Object.keys(report.acceptanceByKind).length > 0);
  assert.notEqual(report.confidenceAccuracy, undefined);
  assert.equal(platform.feedbackSignals.getReport(report.reportId)?.reportId, report.reportId);
});

test("phase 10 Phase1Platform exposes rule, model, and feedback services", () => {
  const platform = createPhase1Platform();

  assert.ok(platform.ruleDrafts, "ruleDrafts service must be present on Phase1Platform");
  assert.ok(platform.modelVersions, "modelVersions service must be present on Phase1Platform");
  assert.ok(platform.feedbackSignals, "feedbackSignals service must be present on Phase1Platform");
});

test("phase 10 persistence API exposes disabled-mode fallbacks for new state stores", async () => {
  const previousPostgresUrl = process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL;

  try {
    const platform = createPhase1Platform();
    const draft = platform.ruleDrafts.createDraft({
      title: "Persistence smoke draft",
      findingType: "persistence_smoke",
      severity: "low",
      confidence: 0.5,
      reproducibility: "not_tested",
      summary: "Used to verify disabled-mode persistence semantics.",
      recommendedActions: ["Persist once Postgres is configured."],
      conditions: [{ type: "project_present", project_id: "cp_modmenu" }],
      createdBy: "usr_demo"
    });

    const shadow = platform.modelVersions.registerVersion({
      modelKey: "finding-risk-calibrator",
      version: "persistence-smoke-v1",
      task: "finding_risk_calibration",
      metrics: { precision: 0.7, recall: 0.68, f1: 0.69 },
      config: { artifactUri: "models/persistence-smoke-v1.bin" }
    });
    platform.modelVersions.recordEvaluation({
      modelId: shadow.modelId,
      datasetId: "ds_persistence_smoke",
      metrics: { precision: 0.7, recall: 0.68, f1: 0.69 },
      sampleCount: 12
    });

    const report = platform.feedbackSignals.computeSignalReport();

    assert.equal((await platform.persistence.persistRuleDraft(draft.draftId)).persisted, false);
    assert.equal((await platform.persistence.persistRuleVersionHistory("vr_missing")).persisted, false);
    assert.equal((await platform.persistence.persistModelRegistryEntry(shadow.modelId)).persisted, false);
    assert.equal((await platform.persistence.persistModelEvaluations(shadow.modelId)).persisted, false);
    assert.equal((await platform.persistence.persistFeedbackSignalReport(report.reportId)).persisted, false);
    assert.deepEqual(await platform.persistence.readRuleDrafts(), []);
    assert.equal(await platform.persistence.readRuleDraft(draft.draftId), undefined);
    assert.deepEqual(await platform.persistence.readRuleVersionHistory(draft.ruleId), []);
    assert.deepEqual(await platform.persistence.readModelRegistryEntries(), []);
    assert.deepEqual(await platform.persistence.readModelEvaluations(shadow.modelId), []);
    assert.equal(await platform.persistence.readFeedbackSignalReport(report.reportId), undefined);
  } finally {
    if (previousPostgresUrl === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previousPostgresUrl;
    }
  }
});

test("phase 10 Postgres smoke persists and rehydrates rule, model, and feedback state", async (t) => {
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const baseConnectionString = previousPostgresUrl ?? DEFAULT_POSTGRES_SMOKE_URL;

  let adminPool: Pool | undefined;
  let databaseName: string | undefined;

  try {
    try {
      const temporaryDatabase = await tryCreateTempDatabase(baseConnectionString);
      adminPool = temporaryDatabase.adminPool;
      databaseName = temporaryDatabase.databaseName;
      process.env.POSTGRES_URL = temporaryDatabase.connectionString;
    } catch (error) {
      t.skip(`Postgres smoke skipped: ${describeConnectionError(error)}`);
      return;
    }

    const source = createPhase1Platform();

    const draft = source.ruleDrafts.createDraft({
      title: "Persisted Mod Menu production rule",
      findingType: "postgres_persisted_rule",
      severity: "low",
      confidence: 0.61,
      reproducibility: "confirmed",
      summary: "Used to verify Postgres-backed rule draft persistence.",
      recommendedActions: ["Keep Mod Menu on the validated Fabric baseline."],
      conditions: [
        { type: "project_present", project_id: "cp_modmenu" },
        { type: "loader_is", loader: "fabric" }
      ],
      createdBy: "usr_demo"
    });
    source.ruleDrafts.validateDraft(draft.draftId, true);
    const promotion = source.ruleDrafts.promoteDraft({
      draftId: draft.draftId,
      promotedBy: "usr_demo",
      changeNote: "Persist and rehydrate a promoted rule."
    });

    await source.persistence.persistRuleDraft(draft.draftId);
    await source.persistence.persistRuleVersionHistory(draft.ruleId);
    await source.persistence.persistVerifiedRule(promotion.rule.rule_id);

    const deployedModel = source.modelVersions.registerVersion({
      modelKey: "finding-risk-calibrator",
      version: "postgres-smoke-v1",
      task: "finding_risk_calibration",
      metrics: { precision: 0.92, recall: 0.83, f1: 0.872 },
      config: { artifactUri: "models/finding-risk/postgres-smoke-v1.bin" }
    });
    source.modelVersions.deployVersion(deployedModel.modelId);
    source.modelVersions.recordEvaluation({
      modelId: deployedModel.modelId,
      datasetId: "ds_postgres_smoke_truth_v1",
      metrics: {
        precision: 0.91,
        recall: 0.84,
        f1: 0.8731,
        auc: 0.94,
        calibrationError: 0.03
      },
      sampleCount: 256
    });

    for (const model of source.modelVersions.listVersions("finding_risk_calibration")) {
      await source.persistence.persistModelRegistryEntry(model.modelId);
    }
    await source.persistence.persistModelEvaluations(deployedModel.modelId);

    const demo = source.createDemoFlow();
    const recommendationSet = demo.recommendationSet;
    assert.ok(recommendationSet);

    source.recommendations.submitFeedback({
      recommendationId: recommendationSet!.items[0]!.recommendationId,
      feedbackType: "accepted",
      createdBy: "usr_demo",
      note: "Persisted smoke acceptance."
    });
    source.recommendations.recordOutcome({
      recommendationSetId: recommendationSet!.recommendationSetId,
      status: "validated",
      appliedRecommendationIds: [recommendationSet!.items[0]!.recommendationId],
      validationSummary: "Persisted smoke validation outcome.",
      createdBy: "usr_demo"
    });
    const signalReport = source.feedbackSignals.computeSignalReport([demo.analysis.analysisId]);
    await source.persistence.persistFeedbackSignalReport(signalReport.reportId);

    await closePersistencePool(source);

    const target = createPhase1Platform();
    await target.persistence.hydrateAdminState();
    await target.persistence.hydrateRuleVersionHistory(draft.ruleId);
    await target.persistence.hydrateModelRegistryEntries();
    await target.persistence.hydrateModelEvaluations(deployedModel.modelId);
    await target.persistence.hydrateFeedbackSignalReport(signalReport.reportId);

    const hydratedDraft = target.ruleDrafts.getDraft(draft.draftId);
    assert.ok(hydratedDraft, "Persisted rule draft should rehydrate");
    assert.equal(hydratedDraft.status, "promoted");

    const hydratedHistory = target.ruleDrafts.getRuleHistory(draft.ruleId);
    assert.equal(hydratedHistory.length, 1);
    assert.equal(hydratedHistory[0]!.changeNote, "Persist and rehydrate a promoted rule.");

    const imported = target.imports.importModList({
      projectId: "prj_demo",
      createdBy: "usr_demo",
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      mods: [{ name: "modmenu", version: "11.0.2" }]
    });
    const hydratedFindings = target.rules.evaluate(imported.snapshot);
    assert.ok(
      hydratedFindings.some((finding) => finding.type === "postgres_persisted_rule"),
      "Rehydrated verified rule should execute after restart"
    );

    assert.equal(
      target.modelVersions.getActive("finding_risk_calibration")?.modelId,
      deployedModel.modelId,
      "Rehydrated model registry should preserve the deployed active model"
    );
    assert.equal(target.modelVersions.getEvaluations(deployedModel.modelId).length, 1);

    const hydratedReport = target.feedbackSignals.getReport(signalReport.reportId);
    assert.ok(hydratedReport, "Persisted feedback signal report should rehydrate");
    assert.equal(hydratedReport.overallValidationRate, signalReport.overallValidationRate);
    assert.equal(hydratedReport.totalFeedbackItems, signalReport.totalFeedbackItems);

    await closePersistencePool(target);
  } finally {
    if (previousPostgresUrl === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previousPostgresUrl;
    }

    if (adminPool && databaseName) {
      await dropTempDatabase(adminPool, databaseName).catch(() => undefined);
    }
  }
});
