import assert from "node:assert/strict";
import test from "node:test";

import { createPhase1Platform } from "./index.js";
import type {
  GroundTruthExecutor,
  GroundTruthExecutorInput,
  GroundTruthExecutorOutput
} from "./ground-truth.js";
import { GroundTruthService } from "./ground-truth.js";
import type { PackSnapshot } from "@modcompat/domain-models";

class FakeGroundTruthExecutor implements GroundTruthExecutor {
  async execute(input: GroundTruthExecutorInput): Promise<GroundTruthExecutorOutput> {
    return {
      status: "completed",
      verdict: "passed_startup_and_world",
      reachedMainMenu: true,
      reachedWorld: true,
      exitCode: 0,
      durationMs: 1250,
      summary: `Verified ${input.snapshot.packSnapshotId} reached world load.`,
      observations: [
        {
          observationId: "obs_fake_startup",
          kind: "startup",
          status: "passed",
          summary: "Client reached startup successfully."
        },
        {
          observationId: "obs_fake_world",
          kind: "world_load",
          status: "passed",
          summary: "World creation finished successfully."
        }
      ],
      artifactDirectory: input.workdir,
      rawResult: {
        reachedMainMenu: true,
        reachedWorld: true
      }
    };
  }
}

class TrackingGroundTruthExecutor implements GroundTruthExecutor {
  maxInFlight = 0;
  private inFlight = 0;

  async execute(input: GroundTruthExecutorInput): Promise<GroundTruthExecutorOutput> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    this.inFlight -= 1;

    return {
      status: "completed",
      verdict: "passed_startup_and_world",
      reachedMainMenu: true,
      reachedWorld: true,
      exitCode: 0,
      durationMs: 25,
      summary: `Verified ${input.snapshot.packSnapshotId} reached world load.`,
      observations: [
        {
          observationId: createObservationId(input.snapshot.packSnapshotId),
          kind: "world_load",
          status: "passed",
          summary: "World creation finished successfully."
        }
      ],
      artifactDirectory: input.workdir,
      rawResult: {
        reachedMainMenu: true,
        reachedWorld: true
      }
    };
  }
}

function createObservationId(seed: string) {
  return `obs_${seed}`;
}

test("ground-truth pipeline enqueues snapshots, executes them, and builds an empirical snapshot", async () => {
  const platform = createPhase1Platform();
  const truth = new GroundTruthService(
    platform.repository,
    undefined,
    new FakeGroundTruthExecutor()
  );

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
      { name: "sodium", version: "0.6.0+mc1.21.1" },
      { name: "lithium", version: "0.15.0+mc1.21.1" }
    ]
  });

  const enqueue = truth.enqueuePackSnapshot({
    packSnapshotId: imported.snapshot.packSnapshotId,
    discoveredFrom: "test"
  });
  assert.ok(enqueue.candidate);
  assert.equal(platform.repository.groundTruthCandidates.size, 1);

  const runResult = await truth.runPending(1);
  assert.equal(runResult.attempted, 1);
  assert.equal(runResult.completed, 1);
  assert.equal(platform.repository.groundTruthRuns.size, 1);
  assert.equal(platform.repository.groundTruthExactPackRecords.size, 1);

  const record = [...platform.repository.groundTruthExactPackRecords.values()][0];
  assert.equal(record.verdict, "passed_startup_and_world");
  assert.ok(record.reproducibilityScore >= 1);

  const snapshot = truth.buildKnowledgeSnapshot({
    createdBy: "usr_demo",
    promote: true
  });
  assert.equal(snapshot.status, "promoted");
  assert.equal(snapshot.recordCount, 1);
  assert.equal(platform.repository.groundTruthKnowledgeSnapshots.size, 1);
});

test("ground-truth enqueue dedupes generated snapshots by pack fingerprint", () => {
  const platform = createPhase1Platform();
  const truth = new GroundTruthService(
    platform.repository,
    undefined,
    new FakeGroundTruthExecutor()
  );

  const baseSnapshot: PackSnapshot = {
    packSnapshotId: "pks_pair_a",
    projectId: "prj_demo",
    organizationId: "org_demo",
    sourceType: "mod_list",
    normalizedHash: "same_pair_fingerprint",
    environment: {
      minecraftVersion: "1.20.1",
      loader: "forge",
      javaVersion: "17",
      side: "both"
    },
    mods: [
      { name: "jei", version: "1.0.0", resolutionMethod: "source_mapping", confidence: 1 },
      { name: "jade", version: "1.0.0", resolutionMethod: "source_mapping", confidence: 1 }
    ],
    createdBy: "usr_demo",
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  };
  const duplicateSnapshot: PackSnapshot = {
    ...baseSnapshot,
    packSnapshotId: "pks_pair_b"
  };

  platform.repository.snapshots.set(baseSnapshot.packSnapshotId, baseSnapshot);
  platform.repository.snapshots.set(duplicateSnapshot.packSnapshotId, duplicateSnapshot);

  const first = truth.enqueuePackSnapshot({
    packSnapshotId: baseSnapshot.packSnapshotId,
    discoveredFrom: "test"
  });
  const second = truth.enqueuePackSnapshot({
    packSnapshotId: duplicateSnapshot.packSnapshotId,
    discoveredFrom: "test"
  });

  assert.ok(first.candidate);
  assert.equal(second.candidate?.candidateId, first.candidate.candidateId);
  assert.equal(second.skipped, "existing_candidate");
  assert.equal(platform.repository.groundTruthCandidates.size, 1);
});

test("ground-truth enqueue creates separate candidates for compatible version pairs", () => {
  const platform = createPhase1Platform();
  const truth = new GroundTruthService(
    platform.repository,
    undefined,
    new FakeGroundTruthExecutor()
  );

  platform.repository.canonicalProjects.clear();
  platform.repository.canonicalVersions.clear();
  platform.repository.sourceMappings.clear();

  platform.repository.canonicalProjects.set("modrinth_alpha", {
    projectId: "modrinth_alpha",
    slug: "alpha",
    displayName: "Alpha",
    aliases: ["alpha"]
  });
  platform.repository.canonicalProjects.set("modrinth_beta", {
    projectId: "modrinth_beta",
    slug: "beta",
    displayName: "Beta",
    aliases: ["beta"]
  });

  for (const version of [
    ["modrinth_alpha_v1", "modrinth_alpha", "1.0.0"],
    ["modrinth_alpha_v2", "modrinth_alpha", "2.0.0"],
    ["modrinth_beta_v1", "modrinth_beta", "1.0.0"],
    ["modrinth_beta_v2", "modrinth_beta", "2.0.0"]
  ] as const) {
    platform.repository.canonicalVersions.set(version[0], {
      versionId: version[0],
      projectId: version[1],
      versionLabel: version[2],
      loaders: ["forge"],
      minecraftVersions: ["1.20.1"],
      javaVersions: ["17"],
      primaryFileDownloadUrl: `https://example.com/${version[0]}.jar`
    });
  }

  platform.repository.sourceMappings.set("modrinth:alpha", {
    sourceName: "modrinth",
    sourceProjectId: "alpha",
    canonicalProjectId: "modrinth_alpha"
  });
  platform.repository.sourceMappings.set("modrinth:beta", {
    sourceName: "modrinth",
    sourceProjectId: "beta",
    canonicalProjectId: "modrinth_beta"
  });

  const result = truth.enqueuePairCandidates([
    { pair: ["modrinth_alpha", "modrinth_beta"], priority: 1 }
  ]);

  assert.equal(result.enqueued, 4);
  assert.equal(result.skipped, 0);
  assert.equal(platform.repository.groundTruthCandidates.size, 4);

  const snapshots = [...platform.repository.snapshots.values()].filter(
    (snapshot) => snapshot.sourceType === "mod_list" && snapshot.mods.length === 2
  );
  const versionPairs = snapshots.map((snapshot) =>
    snapshot.mods.map((mod) => mod.canonicalVersionId).sort().join("+")
  );
  assert.ok(snapshots.every((snapshot) => snapshot.environment.loaderVersion === "47.4.20"));
  assert.deepEqual(
    new Set(versionPairs),
    new Set([
      "modrinth_alpha_v1+modrinth_beta_v1",
      "modrinth_alpha_v1+modrinth_beta_v2",
      "modrinth_alpha_v2+modrinth_beta_v1",
      "modrinth_alpha_v2+modrinth_beta_v2"
    ])
  );
});

test("ground-truth runPending skips stale queued duplicates after a settled record exists", async () => {
  const platform = createPhase1Platform();
  const truth = new GroundTruthService(
    platform.repository,
    undefined,
    new FakeGroundTruthExecutor()
  );

  const baseSnapshot: PackSnapshot = {
    packSnapshotId: "pks_settled_pair_a",
    projectId: "prj_demo",
    organizationId: "org_demo",
    sourceType: "mod_list",
    normalizedHash: "settled_pair_fingerprint",
    environment: {
      minecraftVersion: "1.20.1",
      loader: "forge",
      javaVersion: "17",
      side: "both"
    },
    mods: [
      { name: "jei", version: "1.0.0", resolutionMethod: "source_mapping", confidence: 1 },
      { name: "jade", version: "1.0.0", resolutionMethod: "source_mapping", confidence: 1 }
    ],
    createdBy: "usr_demo",
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  };
  const staleDuplicateSnapshot: PackSnapshot = {
    ...baseSnapshot,
    packSnapshotId: "pks_settled_pair_b"
  };

  platform.repository.snapshots.set(baseSnapshot.packSnapshotId, baseSnapshot);
  platform.repository.snapshots.set(staleDuplicateSnapshot.packSnapshotId, staleDuplicateSnapshot);

  const first = truth.enqueuePackSnapshot({
    packSnapshotId: baseSnapshot.packSnapshotId,
    discoveredFrom: "test"
  });
  assert.ok(first.candidate);

  const firstRun = await truth.runPending(1);
  assert.equal(firstRun.attempted, 1);
  assert.equal(firstRun.completed, 1);

  const staleQueued = {
    ...first.candidate,
    candidateId: "gtc_stale_duplicate",
    packSnapshotId: staleDuplicateSnapshot.packSnapshotId,
    status: "queued" as const,
    createdAt: new Date(Date.now() + 1).toISOString(),
    updatedAt: new Date(Date.now() + 1).toISOString()
  };
  platform.repository.groundTruthCandidates.set(staleQueued.candidateId, staleQueued);

  const secondRun = await truth.runPending(1);
  assert.equal(secondRun.attempted, 0);
  assert.equal(platform.repository.groundTruthCandidates.get(staleQueued.candidateId)?.status, "skipped");
});

test("ground-truth runPending respects configured concurrency", async () => {
  const platform = createPhase1Platform();
  const executor = new TrackingGroundTruthExecutor();
  const truth = new GroundTruthService(platform.repository, undefined, executor);

  for (const suffix of ["a", "b", "c"] as const) {
    const snapshot: PackSnapshot = {
      packSnapshotId: `pks_parallel_${suffix}`,
      projectId: "prj_demo",
      organizationId: "org_demo",
      sourceType: "mod_list",
      normalizedHash: `parallel_fingerprint_${suffix}`,
      environment: {
        minecraftVersion: "1.20.1",
        loader: "forge",
        javaVersion: "17",
        side: "both"
      },
      mods: [
        { name: `mod_${suffix}_1`, version: "1.0.0", resolutionMethod: "source_mapping", confidence: 1 },
        { name: `mod_${suffix}_2`, version: "1.0.0", resolutionMethod: "source_mapping", confidence: 1 }
      ],
      createdBy: "usr_demo",
      schemaVersion: 1,
      createdAt: new Date().toISOString()
    };
    platform.repository.snapshots.set(snapshot.packSnapshotId, snapshot);
    const enqueue = truth.enqueuePackSnapshot({
      packSnapshotId: snapshot.packSnapshotId,
      discoveredFrom: "test"
    });
    assert.ok(enqueue.candidate);
  }

  const runResult = await truth.runPending(3, { concurrency: 2 });
  assert.equal(runResult.attempted, 3);
  assert.equal(runResult.completed, 3);
  assert.equal(executor.maxInFlight, 2);
});
