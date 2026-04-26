import assert from "node:assert/strict";
import test from "node:test";

import type {
  GroundTruthExactPackRecord,
  PairwiseCompatibilityRecord
} from "@modcompat/domain-models";

import { createPhase1Platform } from "./index.js";

function timestamp() {
  return new Date().toISOString();
}

test("snapshot analysis serves exact empirical ground-truth records before snapshot cache", () => {
  const platform = createPhase1Platform();
  const imported = platform.imports.importModList({
    projectId: "prj_demo",
    createdBy: "usr_demo",
    environment: {
      minecraftVersion: "1.21.1",
      loader: "fabric",
      javaVersion: "21",
      side: "both"
    },
    mods: [
      { name: "fabric-api", version: "0.100.8+1.21.1" },
      { name: "modmenu", version: "11.0.2" }
    ]
  });

  const record: GroundTruthExactPackRecord = {
    groundTruthExactPackRecordId: "gxp_exact_empirical_failure",
    packFingerprint: imported.snapshot.normalizedHash,
    packSnapshotId: imported.snapshot.packSnapshotId,
    environment: imported.snapshot.environment,
    executionProfileKey: "default-v1",
    verdict: "failed_startup",
    confidence: {
      score: 0.97,
      band: "very_high",
      explanation: "Empirical startup failed.",
      primaryDrivers: ["Observed verdict: failed_startup"]
    },
    runIds: ["gtr_exact_empirical_failure"],
    latestRunId: "gtr_exact_empirical_failure",
    summary: "Forge failed during startup.",
    reproducibilityScore: 1,
    tenantId: imported.snapshot.organizationId,
    schemaVersion: 1,
    createdAt: timestamp(),
    updatedAt: timestamp()
  };
  platform.repository.groundTruthExactPackRecords.set(record.groundTruthExactPackRecordId, record);

  const result = platform.snapshotAnalysis.createAnalysisFromExactPackCache({
    projectId: imported.snapshot.projectId,
    workspaceId: "wks_demo",
    organizationId: imported.snapshot.organizationId,
    packSnapshotId: imported.snapshot.packSnapshotId,
    packFingerprint: imported.snapshot.normalizedHash,
    environment: imported.snapshot.environment
  });

  assert.ok(result);
  assert.equal(result.analysis.verdict, "known_incompatible");
  assert.equal(result.findings[0]?.type, "ground_truth_execution");
  assert.match(result.analysis.explanation ?? "", /gtr_exact_empirical_failure/);
});

test("retrieval assembly overlays pairwise predictions with settled ground truth", () => {
  const platform = createPhase1Platform();
  const snapshot = platform.snapshotAnalysis.getActiveSnapshot();
  assert.ok(snapshot);

  const pairwise: PairwiseCompatibilityRecord = {
    pairwiseCompatibilityId: "pwr_test_predicted_conflict",
    snapshotId: snapshot.snapshotId,
    leftProjectId: "cp_fabric_api",
    rightProjectId: "cp_modmenu",
    verdict: "likely_incompatible",
    confidence: {
      score: 0.8,
      band: "high",
      explanation: "Synthetic static prediction.",
      primaryDrivers: ["Synthetic prediction"]
    },
    claimIds: [],
    schemaVersion: 1,
    createdAt: timestamp()
  };
  platform.repository.pairwiseCompatibilityRecords.set(pairwise.pairwiseCompatibilityId, pairwise);
  platform.repository.pairwiseCompatibilityBySnapshot.set(snapshot.snapshotId, [
    ...(platform.repository.pairwiseCompatibilityBySnapshot.get(snapshot.snapshotId) ?? []),
    pairwise.pairwiseCompatibilityId
  ]);

  const imported = platform.imports.importModList({
    projectId: "prj_demo",
    createdBy: "usr_demo",
    environment: {
      minecraftVersion: "1.21.1",
      loader: "fabric",
      javaVersion: "21",
      side: "both"
    },
    mods: [
      { name: "fabric-api", version: "0.100.8+1.21.1" },
      { name: "modmenu", version: "11.0.2" }
    ]
  });

  const record: GroundTruthExactPackRecord = {
    groundTruthExactPackRecordId: "gxp_pair_empirical_pass",
    packFingerprint: imported.snapshot.normalizedHash,
    packSnapshotId: imported.snapshot.packSnapshotId,
    environment: imported.snapshot.environment,
    executionProfileKey: "default-v1",
    verdict: "passed_startup_and_world",
    confidence: {
      score: 0.93,
      band: "high",
      explanation: "Empirical startup and world load passed.",
      primaryDrivers: ["Observed verdict: passed_startup_and_world"]
    },
    runIds: ["gtr_pair_empirical_pass"],
    latestRunId: "gtr_pair_empirical_pass",
    summary: "Forge reached world load.",
    reproducibilityScore: 1,
    tenantId: imported.snapshot.organizationId,
    schemaVersion: 1,
    createdAt: timestamp(),
    updatedAt: timestamp()
  };
  platform.repository.groundTruthExactPackRecords.set(record.groundTruthExactPackRecordId, record);

  const result = platform.snapshotAnalysis.createAnalysisFromRetrievalAssembly({
    projectId: imported.snapshot.projectId,
    workspaceId: "wks_demo",
    organizationId: imported.snapshot.organizationId,
    packSnapshotId: imported.snapshot.packSnapshotId,
    packFingerprint: imported.snapshot.normalizedHash,
    environment: imported.snapshot.environment
  });

  assert.ok(result);
  assert.equal(result.analysis.verdict, "no_known_issue_found");
  assert.equal(result.findings.length, 0);
  assert.ok(
    result.report?.supportingPairwiseRecords?.some((record) =>
      record.confidence.primaryDrivers.includes("Run ID: gtr_pair_empirical_pass")
    )
  );
});
