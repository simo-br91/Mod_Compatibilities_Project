import { createPhase1Platform } from "../../packages/platform-core/src/index.js";
import { loadLocalEnvFile } from "../load_local_env.ts";

loadLocalEnvFile();

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
      continue;
    }
    args.set(key, next);
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // How many combinations to actually run Minecraft for this invocation (default 10).
  // Each run launches Forge, loads a world, and records whether it crashed.
  const limit = Number(args.get("limit") ?? 10);
  const concurrency = Number(args.get("concurrency") ?? process.env.GROUND_TRUTH_CONCURRENCY ?? 1);
  const discoverLimit = Number(args.get("discover-limit") ?? 100);

  // --snapshot-id <id>         Run a specific user pack snapshot.
  // --offline-snapshot <id>    Feed from the offline synthesis pipeline's candidate list.
  //                            This is the primary usage: run the offline pipeline first,
  //                            then pass its snapshot ID here to test the top candidates.
  const snapshotId =
    typeof args.get("snapshot-id") === "string" ? String(args.get("snapshot-id")) : undefined;
  const offlineSnapshotId =
    typeof args.get("offline-snapshot") === "string"
      ? String(args.get("offline-snapshot"))
      : undefined;

  const promoteSnapshot = args.get("no-promote") !== true;
  const buildSnapshot = args.get("no-build-snapshot") !== true;
  const compactKnowledge = args.get("keep-operational-history") !== true;
  const allowEphemeral = args.get("allow-ephemeral") === true;
  const createdBy =
    typeof args.get("created-by") === "string"
      ? String(args.get("created-by"))
      : "ground-truth-runner";

  const platform = createPhase1Platform();

  if (!platform.persistence.isEnabled() && !allowEphemeral) {
    throw new Error(
      "POSTGRES_URL is required for the default ground-truth workflow. " +
      "Configure a shared/remote Postgres connection in .env or pass --allow-ephemeral " +
      "if you intentionally want a non-persistent local-only run."
    );
  }

  if (platform.persistence.isEnabled()) {
    await platform.persistence.ensureSchema();
    await platform.persistence.hydrateCatalogState();
    await platform.groundTruth.hydrateState();
  }

  if (!platform.persistence.isEnabled() && offlineSnapshotId) {
    throw new Error(
      "--offline-snapshot requires Postgres persistence so the offline knowledge snapshot can be hydrated."
    );
  }

  if (snapshotId) {
    if (!platform.repository.snapshots.has(snapshotId) && platform.persistence.isEnabled()) {
      await platform.persistence.hydrateSnapshot(snapshotId);
    }
    const enqueueResult = platform.groundTruth.enqueuePackSnapshot({
      packSnapshotId: snapshotId,
      discoveredFrom: "manual_snapshot"
    });
    if (enqueueResult.candidate && platform.persistence.isEnabled()) {
      await platform.persistence.persistPackSnapshot(enqueueResult.candidate.packSnapshotId);
      await platform.persistence.persistGroundTruthCandidate(enqueueResult.candidate);
    }
  } else if (offlineSnapshotId) {
    // Hydrate the offline snapshot's pairwise records from the DB if not already in memory.
    if (
      platform.persistence.isEnabled() &&
      !platform.repository.pairwiseCompatibilityBySnapshot.has(offlineSnapshotId)
    ) {
      await platform.persistence.hydrateKnowledgeSnapshotById(offlineSnapshotId);
    }

    const candidates = platform.knowledgeSynthesis.generateCandidatesForPipeline1(offlineSnapshotId);

    const enqueueResult = platform.groundTruth.enqueuePairCandidates(
      candidates,
      "offline_candidate"
    );

    console.log(
      JSON.stringify(
        {
          phase: "discovery",
          source: "offline_snapshot",
          offlineSnapshotId,
          ...enqueueResult
        },
        null,
        2
      )
    );
  } else {
    if (platform.persistence.isEnabled()) {
      const recentSnapshotIds = await platform.persistence.readRecentSnapshotIds(discoverLimit);
      for (const packSnapshotId of recentSnapshotIds) {
        if (!platform.repository.snapshots.has(packSnapshotId)) {
          await platform.persistence.hydrateSnapshot(packSnapshotId);
        }
      }
    }

    const discovery = platform.groundTruth.enqueueDiscoveredPackSnapshots(discoverLimit);
    console.log(
      JSON.stringify(
        {
          phase: "discovery",
          source: "pack_snapshot_discovery",
          ...discovery
        },
        null,
        2
      )
    );
  }

  const runResult = await platform.groundTruth.runPending(limit, {
    requireSnapshotInMemory: true,
    concurrency
  });

  let empiricalSnapshot:
    | ReturnType<typeof platform.groundTruth.buildKnowledgeSnapshot>
    | undefined;
  let compaction:
    | Awaited<ReturnType<typeof platform.persistence.compactGroundTruthKnowledgeState>>
    | undefined;
  if (buildSnapshot) {
    empiricalSnapshot = platform.groundTruth.buildKnowledgeSnapshot({
      createdBy,
      promote: promoteSnapshot
    });
    if (platform.persistence.isEnabled()) {
      await platform.persistence.persistGroundTruthKnowledgeSnapshot(empiricalSnapshot);
      for (const record of platform.repository.groundTruthExactPackRecords.values()) {
        await platform.persistence.persistGroundTruthExactPackRecord(record);
      }
      if (compactKnowledge) {
        compaction = await platform.persistence.compactGroundTruthKnowledgeState();
        await platform.persistence.hydrateGroundTruthState();
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        phase: "execution",
        attempted: runResult.attempted,
        concurrency,
        completed: runResult.completed,
        failed: runResult.failed,
        timedOut: runResult.timedOut,
        runIds: runResult.runs.map((run) => run.groundTruthRunId),
        exactPackRecordCount: platform.repository.groundTruthExactPackRecords.size,
        compaction,
        empiricalSnapshot: empiricalSnapshot
          ? {
              groundTruthSnapshotId: empiricalSnapshot.groundTruthSnapshotId,
              version: empiricalSnapshot.version,
              status: empiricalSnapshot.status,
              recordCount: empiricalSnapshot.recordCount
            }
          : undefined
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
