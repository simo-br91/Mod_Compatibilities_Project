import assert from "node:assert/strict";
import test from "node:test";

import type { GroundTruthExactPackRecord, PackSnapshot } from "@modcompat/domain-models";
import { createPhase1Platform } from "./index.js";

test("generateCandidatesForPipeline1 returns prioritized mod pairs for testing", () => {
  const platform = createPhase1Platform();

  // Trigger snapshot build
  const { snapshot } = platform.knowledgeSynthesis.buildAndPromoteSnapshot({
    createdBy: "test-actor",
    versionLabel: "test-v1"
  });

  // Generate candidates
  const candidates = platform.knowledgeSynthesis.generateCandidatesForPipeline1(
    snapshot.snapshotId
  );

  // Should return an array of candidates
  assert.ok(Array.isArray(candidates));

  // Each candidate should have required fields
  for (const candidate of candidates) {
    assert.ok(Array.isArray(candidate.pair));
    assert.equal(candidate.pair.length, 2);
    assert.ok(typeof candidate.pair[0] === "string");
    assert.ok(typeof candidate.pair[1] === "string");
    assert.ok(typeof candidate.confidence === "number");
    assert.ok(candidate.confidence >= 0 && candidate.confidence <= 1);
    assert.ok(typeof candidate.verdict === "string");
    assert.ok(typeof candidate.priority === "number");
  }

  // Candidates should be sorted by priority (descending)
  if (candidates.length > 1) {
    for (let i = 0; i < candidates.length - 1; i++) {
      assert.ok(
        candidates[i]!.priority >= candidates[i + 1]!.priority,
        `Candidates should be sorted by priority descending: ${candidates[i]!.priority} >= ${candidates[i + 1]!.priority}`
      );
    }
  }
});

test("generateCandidatesForPipeline1 filters out known-compatible pairs", () => {
  const platform = createPhase1Platform();
  const { snapshot } = platform.knowledgeSynthesis.buildAndPromoteSnapshot({
    createdBy: "test-actor"
  });

  const candidates = platform.knowledgeSynthesis.generateCandidatesForPipeline1(
    snapshot.snapshotId
  );

  // All candidates should have verdicts that indicate potential issues
  const validVerdicts = [
    "known_incompatible",
    "likely_incompatible",
    "mixed_or_conditional",
    "insufficient_evidence"
  ];

  for (const candidate of candidates) {
    assert.ok(
      validVerdicts.includes(candidate.verdict),
      `Verdict "${candidate.verdict}" should be in valid list for testing`
    );
  }
});

test("generateCandidatesForPipeline1 prioritizes known incompatibilities higher", () => {
  const platform = createPhase1Platform();
  const { snapshot } = platform.knowledgeSynthesis.buildAndPromoteSnapshot({
    createdBy: "test-actor"
  });

  const candidates = platform.knowledgeSynthesis.generateCandidatesForPipeline1(
    snapshot.snapshotId
  );

  // Find candidates with different verdicts
  const knownIncompat = candidates.find((c) => c.verdict === "known_incompatible");
  const likelyIncompat = candidates.find((c) => c.verdict === "likely_incompatible");
  const insufficientEvidence = candidates.find((c) => c.verdict === "insufficient_evidence");

  // If all three exist, known should have higher priority than likely, and likely higher than insufficient
  if (knownIncompat && likelyIncompat) {
    assert.ok(
      knownIncompat.priority >= likelyIncompat.priority,
      "Known incompatibilities should have priority >= likely incompatibilities"
    );
  }

  if (likelyIncompat && insufficientEvidence) {
    assert.ok(
      likelyIncompat.priority >= insufficientEvidence.priority,
      "Likely incompatibilities should have priority >= insufficient evidence"
    );
  }
});

test("buildAndPromoteSnapshot carries forward empirical pair outcomes even without prior inferred evidence", () => {
  const platform = createPhase1Platform();
  const packSnapshot: PackSnapshot = {
    packSnapshotId: "pks_empirical_only_pair",
    projectId: "prj_demo",
    organizationId: "org_demo",
    sourceType: "mod_list",
    normalizedHash: "hash_empirical_only_pair",
    environment: {
      minecraftVersion: "1.21.1",
      loader: "fabric",
      javaVersion: "21",
      side: "both"
    },
    mods: [
      {
        name: "fabric-api",
        canonicalProjectId: "cp_fabric_api",
        canonicalVersionId: "ver_fabric_api_121",
        resolutionMethod: "source_mapping",
        confidence: 1
      },
      {
        name: "modmenu",
        canonicalProjectId: "cp_modmenu",
        canonicalVersionId: "ver_modmenu_121",
        resolutionMethod: "source_mapping",
        confidence: 1
      }
    ],
    createdBy: "usr_demo",
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  };
  platform.repository.snapshots.set(packSnapshot.packSnapshotId, packSnapshot);

  const exactRecord: GroundTruthExactPackRecord = {
    groundTruthExactPackRecordId: "gxp_empirical_only_pair",
    packFingerprint: packSnapshot.normalizedHash,
    packSnapshotId: packSnapshot.packSnapshotId,
    environment: packSnapshot.environment,
    executionProfileKey: "default-v1",
    verdict: "passed_startup_and_world",
    confidence: {
      score: 0.96,
      band: "very_high",
      explanation: "Empirical verification reached world load.",
      primaryDrivers: ["Empirical verification"]
    },
    runIds: ["gtr_empirical_only_pair"],
    latestRunId: "gtr_empirical_only_pair",
    summary: "Verified pair reached world load.",
    reproducibilityScore: 1,
    tenantId: "org_demo",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  platform.repository.groundTruthExactPackRecords.set(
    exactRecord.groundTruthExactPackRecordId,
    exactRecord
  );

  const { snapshot } = platform.knowledgeSynthesis.buildAndPromoteSnapshot({
    createdBy: "test-actor",
    versionLabel: "test-empirical-only-v1"
  });

  const recordIds = platform.repository.pairwiseCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [];
  const fabricatedPair = recordIds
    .map((id) => platform.repository.pairwiseCompatibilityRecords.get(id))
    .find(
      (record) =>
        record &&
        [record.leftProjectId, record.rightProjectId].sort().join("|") ===
          ["cp_fabric_api", "cp_modmenu"].sort().join("|")
    );

  assert.ok(fabricatedPair, "Expected a pairwise record synthesized from empirical-only evidence");
  assert.equal(fabricatedPair?.verdict, "no_known_issue_found");
  assert.deepEqual(fabricatedPair?.environment, packSnapshot.environment);
  assert.ok(
    fabricatedPair?.confidence.primaryDrivers.some((driver) => driver === "Run ID: gtr_empirical_only_pair")
  );
});

test("generateCandidatesForPipeline1 skips pairs that already have settled empirical results", () => {
  const platform = createPhase1Platform();
  const packSnapshot: PackSnapshot = {
    packSnapshotId: "pks_tested_pair",
    projectId: "prj_demo",
    organizationId: "org_demo",
    sourceType: "mod_list",
    normalizedHash: "hash_tested_pair",
    environment: {
      minecraftVersion: "1.20.1",
      loader: "forge",
      javaVersion: "17",
      side: "both"
    },
    mods: [
      {
        name: "optifine",
        canonicalProjectId: "cp_optifine",
        canonicalVersionId: "ver_optifine_120",
        resolutionMethod: "source_mapping",
        confidence: 1
      },
      {
        name: "sodium",
        canonicalProjectId: "cp_sodium",
        canonicalVersionId: "ver_sodium_121",
        resolutionMethod: "source_mapping",
        confidence: 1
      }
    ],
    createdBy: "usr_demo",
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  };
  platform.repository.snapshots.set(packSnapshot.packSnapshotId, packSnapshot);

  const exactRecord: GroundTruthExactPackRecord = {
    groundTruthExactPackRecordId: "gxp_tested_pair",
    packFingerprint: packSnapshot.normalizedHash,
    packSnapshotId: packSnapshot.packSnapshotId,
    environment: packSnapshot.environment,
    executionProfileKey: "default-v1",
    verdict: "failed_startup",
    confidence: {
      score: 0.97,
      band: "very_high",
      explanation: "Empirical verification failed during startup.",
      primaryDrivers: ["Empirical verification"]
    },
    runIds: ["gtr_tested_pair"],
    latestRunId: "gtr_tested_pair",
    summary: "Verified pair crashed on startup.",
    reproducibilityScore: 1,
    tenantId: "org_demo",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  platform.repository.groundTruthExactPackRecords.set(
    exactRecord.groundTruthExactPackRecordId,
    exactRecord
  );

  const { snapshot } = platform.knowledgeSynthesis.buildAndPromoteSnapshot({
    createdBy: "test-actor",
    versionLabel: "test-skip-tested-v1"
  });

  const candidates = platform.knowledgeSynthesis.generateCandidatesForPipeline1(
    snapshot.snapshotId
  );

  assert.ok(
    !candidates.some(
      (candidate) =>
        candidate.pair.sort().join("|") === ["cp_optifine", "cp_sodium"].sort().join("|")
    ),
    "Pairs with settled ground-truth results should not be re-queued"
  );
});
