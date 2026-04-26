import assert from "node:assert/strict";
import test from "node:test";

import {
  createPhase1Platform,
  InMemoryCurseForgeAdapter,
  InMemoryModrinthAdapter,
  InMemoryGitHubAdapter,
  FailingConnectorAdapter,
  EvidenceIngestionPipeline,
  ConnectorSyncScheduler
} from "./index.js";

// ---------------------------------------------------------------------------
// Ingestion pipeline — happy path
// ---------------------------------------------------------------------------

test("phase 9 connector sync creates sync run, raw payloads, documents, and snippets", async () => {
  const platform = createPhase1Platform();
  const adapter = new InMemoryCurseForgeAdapter();
  const result = await platform.ingestion.runSync(adapter, { maxItemsPerRun: 10 });

  assert.equal(result.status, "completed");
  assert.ok(result.rawPayloadCount > 0, "Must ingest at least one raw payload");
  assert.ok(result.documentCount > 0, "Must produce at least one evidence document");
  assert.ok(result.snippetCount > 0, "Must produce at least one snippet");
  assert.equal(result.errorCount, 0, "No errors expected for well-formed adapter");

  // Verify sync run is persisted and complete
  const syncRun = platform.ingestion.getSyncRun(result.syncRunId);
  assert.ok(syncRun, "Sync run must be stored in the repository");
  assert.equal(syncRun.status, "completed");
  assert.ok(syncRun.finishedAt, "Completed run must have finishedAt set");
  assert.equal(syncRun.stats.rawPayloadCount, result.rawPayloadCount);
  assert.equal(syncRun.stats.documentCount, result.documentCount);

  // Verify raw payloads and documents are in the repo
  assert.ok(platform.repository.rawPayloads.size >= result.rawPayloadCount);
  assert.ok(platform.repository.evidenceDocuments.size >= result.documentCount);
  assert.ok(platform.repository.evidenceSnippets.size >= result.snippetCount);
});

test("phase 9 connector sync correctly assigns trust tier from connector type", async () => {
  const platform = createPhase1Platform();

  const curseForgeAdapter = new InMemoryCurseForgeAdapter(); // tier: curated
  const modrinthAdapter = new InMemoryModrinthAdapter();     // tier: community
  const githubAdapter = new InMemoryGitHubAdapter();         // tier: maintainer

  await platform.ingestion.runSync(curseForgeAdapter, { maxItemsPerRun: 5 });
  await platform.ingestion.runSync(modrinthAdapter, { maxItemsPerRun: 5 });
  await platform.ingestion.runSync(githubAdapter, { maxItemsPerRun: 5 });

  const cfConnector = platform.ingestion.getConnector("curseforge");
  const mrConnector = platform.ingestion.getConnector("modrinth");
  const ghConnector = platform.ingestion.getConnector("github");

  assert.equal(cfConnector?.trustTier, "curated");
  assert.equal(mrConnector?.trustTier, "community");
  assert.equal(ghConnector?.trustTier, "maintainer");

  // Trust scores in documents should reflect the tiers
  const allDocs = [...platform.repository.evidenceDocuments.values()];
  const cfDocs = allDocs.filter((d) => d.connectorId === cfConnector?.connectorId);
  const mrDocs = allDocs.filter((d) => d.connectorId === mrConnector?.connectorId);
  const ghDocs = allDocs.filter((d) => d.connectorId === ghConnector?.connectorId);

  assert.ok(cfDocs.every((d) => d.trust.tier === "curated"));
  assert.ok(mrDocs.every((d) => d.trust.tier === "community"));
  assert.ok(ghDocs.every((d) => d.trust.tier === "maintainer"));

  // Maintainer trust score > curated > community
  const ghScore = ghDocs[0]!.trust.score;
  const cfScore = cfDocs[0]!.trust.score;
  const mrScore = mrDocs[0]!.trust.score;
  assert.ok(ghScore > cfScore, "maintainer trust score must exceed curated");
  assert.ok(cfScore > mrScore, "curated trust score must exceed community");
});

// ---------------------------------------------------------------------------
// Checkpointing — incremental sync
// ---------------------------------------------------------------------------

test("phase 9 second sync resumes from checkpoint and skips already-ingested items", async () => {
  const platform = createPhase1Platform();
  const adapter = new InMemoryCurseForgeAdapter(); // 10 items total

  // First sync: ingest 5 items
  const first = await platform.ingestion.runSync(adapter, { maxItemsPerRun: 5 });
  assert.equal(first.status, "completed");
  assert.equal(first.documentCount, 5);

  // Second sync: should pick up from checkpoint (items 6–10) and not re-ingest the first 5
  const second = await platform.ingestion.runSync(adapter, { maxItemsPerRun: 10 });
  assert.equal(second.status, "completed");
  assert.equal(second.documentCount, 5, "Second run must ingest only the remaining 5 items");

  // Total documents = 10 (5 per run, no duplicates)
  const cfConnector = platform.ingestion.getConnector("curseforge");
  const allDocs = [...platform.repository.evidenceDocuments.values()].filter(
    (d) => d.connectorId === cfConnector?.connectorId
  );
  assert.equal(allDocs.length, 10, "Total documents after two runs must be 10 with no duplicates");
});

test("phase 9 third sync on exhausted source produces zero new documents", async () => {
  const platform = createPhase1Platform();
  const adapter = new InMemoryCurseForgeAdapter(); // 10 items total

  await platform.ingestion.runSync(adapter, { maxItemsPerRun: 10 });
  const third = await platform.ingestion.runSync(adapter, { maxItemsPerRun: 10 });

  assert.equal(third.documentCount, 0, "No new documents when all items are already ingested");
  assert.equal(third.status, "completed");
});

// ---------------------------------------------------------------------------
// Ingestion error recording
// ---------------------------------------------------------------------------

test("phase 9 ingestion errors are recorded per sync run but do not abort the run", async () => {
  // Use a GitHub adapter and use the repository to inject a doc-level error
  // We'll test the error recording via the pipeline's error path by using a custom adapter
  // that produces one malformed item alongside valid items.
  const platform = createPhase1Platform();

  const adapter: typeof InMemoryGitHubAdapter.prototype & { failOnExternalId?: string } =
    new InMemoryGitHubAdapter();

  // Monkey-patch the adapter to throw on the 3rd item
  const originalFetch = adapter.fetchBatch.bind(adapter);
  let callCount = 0;
  adapter.fetchBatch = async (checkpoint, limit) => {
    const result = await originalFetch(checkpoint, limit);
    // Replace item at index 2 with a malformed body that will cause normalization to throw
    if (callCount === 0 && result.items.length >= 3) {
      result.items[2] = {
        ...result.items[2]!,
        // null body triggers a TypeError in JSON.stringify path
        body: null as unknown as Record<string, unknown>
      };
    }
    callCount++;
    return result;
  };

  const result = await platform.ingestion.runSync(adapter, { maxItemsPerRun: 8 });

  // Run should still complete
  assert.equal(result.status, "completed");
  // Some documents should have been ingested (the non-failing ones)
  assert.ok(result.documentCount > 0, "Non-failing items must still be ingested");
  // Errors should be recorded
  assert.ok(result.errorCount > 0, "Failing item must produce an ingestion error");

  const errors = platform.ingestion.getErrors(result.syncRunId);
  assert.ok(errors.length > 0, "Errors must be retrievable by sync run ID");
  assert.ok(errors[0]!.syncRunId === result.syncRunId);
  assert.ok(errors[0]!.retryable === true);
});

// ---------------------------------------------------------------------------
// Adapter-level failure (sync run marked failed)
// ---------------------------------------------------------------------------

test("phase 9 adapter fetch failure marks sync run as failed and connector as degraded", async () => {
  const platform = createPhase1Platform();
  const adapter = new FailingConnectorAdapter();

  const result = await platform.ingestion.runSync(adapter);

  assert.equal(result.status, "failed");
  assert.equal(result.documentCount, 0);
  assert.equal(result.errorCount, 1);

  const syncRun = platform.ingestion.getSyncRun(result.syncRunId);
  assert.equal(syncRun?.status, "failed");
  assert.ok(syncRun?.finishedAt, "Failed run must still have finishedAt set");

  const connector = platform.ingestion.getConnector("failing-connector");
  assert.equal(connector?.status, "degraded", "Connector must be marked degraded after adapter failure");

  const errors = platform.ingestion.getErrors(result.syncRunId);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.errorCode, "adapter_fetch_error");
});

// ---------------------------------------------------------------------------
// Evidence freshness
// ---------------------------------------------------------------------------

test("phase 9 connector lastSyncAt is updated after a successful sync", async () => {
  const platform = createPhase1Platform();
  const adapter = new InMemoryModrinthAdapter();

  const before = Date.now();
  await platform.ingestion.runSync(adapter, { maxItemsPerRun: 3 });
  const after = Date.now();

  const connector = platform.ingestion.getConnector("modrinth");
  assert.ok(connector?.lastSyncAt, "lastSyncAt must be set after a successful sync");

  const syncTime = new Date(connector.lastSyncAt!).getTime();
  assert.ok(
    syncTime >= before && syncTime <= after,
    "lastSyncAt must be within the sync execution window"
  );
});

test("phase 9 failed sync does not update connector lastSyncAt", async () => {
  const platform = createPhase1Platform();
  const adapter = new FailingConnectorAdapter();

  await platform.ingestion.runSync(adapter);

  const connector = platform.ingestion.getConnector("failing-connector");
  assert.equal(connector?.lastSyncAt, undefined, "Failed sync must not update lastSyncAt");
});

// ---------------------------------------------------------------------------
// ConnectorSyncScheduler
// ---------------------------------------------------------------------------

test("phase 9 sync scheduler isDue returns true when next due time has passed", () => {
  const platform = createPhase1Platform();
  const connectorId = "src_scheduler_test";

  platform.syncScheduler.register(connectorId, {
    cadenceMinutes: 60,
    maxItemsPerRun: 100,
    // Set nextDueAt to the past so it's immediately due
    nextDueAt: new Date(Date.now() - 1000).toISOString()
  });

  assert.ok(platform.syncScheduler.isDue(connectorId), "Connector must be due when nextDueAt is in the past");
});

test("phase 9 sync scheduler isDue returns false when next due time is in the future", () => {
  const platform = createPhase1Platform();
  const connectorId = "src_scheduler_future";

  platform.syncScheduler.register(connectorId, {
    cadenceMinutes: 60,
    maxItemsPerRun: 100,
    nextDueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });

  assert.equal(
    platform.syncScheduler.isDue(connectorId),
    false,
    "Connector must not be due when nextDueAt is in the future"
  );
});

test("phase 9 recordSyncStarted advances the next due time by one cadence interval", () => {
  const platform = createPhase1Platform();
  const connectorId = "src_scheduler_advance";
  const cadenceMinutes = 30;

  platform.syncScheduler.register(connectorId, { cadenceMinutes, maxItemsPerRun: 50 });

  const before = Date.now();
  platform.syncScheduler.recordSyncStarted(connectorId);
  const after = Date.now();

  const schedule = platform.syncScheduler.getSchedule(connectorId);
  assert.ok(schedule?.lastAttemptAt, "lastAttemptAt must be set after recordSyncStarted");
  assert.ok(schedule?.nextDueAt, "nextDueAt must be set");

  const nextMs = new Date(schedule.nextDueAt!).getTime();
  assert.ok(
    nextMs >= before + cadenceMinutes * 60 * 1000 &&
    nextMs <= after + cadenceMinutes * 60 * 1000,
    "nextDueAt must be approximately one cadence interval in the future"
  );
});

test("phase 9 getDueConnectors returns only connectors whose sync is due", () => {
  const platform = createPhase1Platform();

  platform.syncScheduler.register("src_due_1", {
    cadenceMinutes: 60,
    maxItemsPerRun: 100,
    nextDueAt: new Date(Date.now() - 1000).toISOString()
  });
  platform.syncScheduler.register("src_due_2", {
    cadenceMinutes: 60,
    maxItemsPerRun: 100,
    nextDueAt: new Date(Date.now() - 2000).toISOString()
  });
  platform.syncScheduler.register("src_not_due", {
    cadenceMinutes: 60,
    maxItemsPerRun: 100,
    nextDueAt: new Date(Date.now() + 60_000).toISOString()
  });

  const due = platform.syncScheduler.getDueConnectors();
  assert.ok(due.includes("src_due_1"));
  assert.ok(due.includes("src_due_2"));
  assert.ok(!due.includes("src_not_due"));
});

// ---------------------------------------------------------------------------
// Search index populated by ingestion
// ---------------------------------------------------------------------------

test("phase 9 ingested evidence documents are searchable through EvidenceService", async () => {
  const platform = createPhase1Platform();
  const adapter = new InMemoryGitHubAdapter();

  await platform.ingestion.runSync(adapter, { maxItemsPerRun: 8 });

  const result = platform.evidence.search({
    query: "sodium optifine incompatible",
    limit: 10
  });

  assert.ok(result.total > 0, "Ingested evidence must be searchable");
  assert.ok(result.hits.length > 0, "Search must return hits for query matching ingested content");
});

// ---------------------------------------------------------------------------
// Phase1Platform integration — ingestion and scheduler wired
// ---------------------------------------------------------------------------

test("phase 9 Phase1Platform exposes ingestion and syncScheduler", () => {
  const platform = createPhase1Platform();
  assert.ok(platform.ingestion, "ingestion pipeline must be present on Phase1Platform");
  assert.ok(platform.syncScheduler, "syncScheduler must be present on Phase1Platform");
});

test("phase 9 multiple connector adapters can run independently on the same platform", async () => {
  const platform = createPhase1Platform();

  const [cfResult, mrResult, ghResult] = await Promise.all([
    platform.ingestion.runSync(new InMemoryCurseForgeAdapter(), { maxItemsPerRun: 10 }),
    platform.ingestion.runSync(new InMemoryModrinthAdapter(), { maxItemsPerRun: 6 }),
    platform.ingestion.runSync(new InMemoryGitHubAdapter(), { maxItemsPerRun: 8 })
  ]);

  assert.equal(cfResult.status, "completed");
  assert.equal(mrResult.status, "completed");
  assert.equal(ghResult.status, "completed");

  // Each connector's sync run is independent
  assert.notEqual(cfResult.syncRunId, mrResult.syncRunId);
  assert.notEqual(mrResult.syncRunId, ghResult.syncRunId);

  // Total documents = sum of all three adapters (no cross-connector deduplication)
  const totalDocs = cfResult.documentCount + mrResult.documentCount + ghResult.documentCount;
  assert.equal(platform.repository.evidenceDocuments.size, totalDocs);
});
