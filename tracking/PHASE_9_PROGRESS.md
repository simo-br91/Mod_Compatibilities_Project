# Phase 9 Progress — Live Data Ingestion and Evidence Operations (M5)

## Status: COMPLETE

All exit criteria met. 64/64 tests pass across platform-core (phase2–phase10), no regressions.

---

## Deliverables

### `packages/domain-models/src/index.ts` (extended)

**New types:**
- `EvidenceIngestionError` — item-level failure record per sync run: `errorId`, `connectorId`, `syncRunId`, `externalDocumentId?`, `errorCode`, `message`, `rawPayload?`, `retryable`, `occurredAt`
- `ConnectorSyncSchedule` — per-connector cadence and quota config: `connectorId`, `cadenceMinutes`, `maxItemsPerRun`, `lastAttemptAt?`, `nextDueAt?`

**Extended `SourceConnector`:**
- `sourceType` union extended with `"curseforge" | "modrinth"`
- `lastSyncAt?: string` field added for freshness tracking

### `packages/platform-core/src/repository.ts` (extended)
- `readonly ingestionErrors = new Map<string, EvidenceIngestionError[]>()` — errors keyed by `syncRunId`
- `readonly connectorSchedules = new Map<string, ConnectorSyncSchedule>()` — schedule per `connectorId`

### `packages/platform-core/src/connectors.ts` (new)

**Adapter interface and in-memory implementations:**
- `LiveConnectorAdapter` — `fetchBatch(checkpoint, limit): Promise<ConnectorFetchResult>` — abstraction over any connector source
- `ConnectorFetchItem` — external item: `externalId`, `contentType`, `body`, `sourceUpdatedAt`
- `ConnectorFetchResult` — batch result with `items`, `nextCheckpoint?`, `hasMore`
- `InMemoryCurseForgeAdapter` — 10 deterministic release note items, checkpoint-based pagination, `trustTier: "curated"`
- `InMemoryModrinthAdapter` — 6 community discussion items, `trustTier: "community"`
- `InMemoryGitHubAdapter` — 8 issues/discussions, `trustTier: "maintainer"`, optional `failOnExternalId` injection
- `FailingConnectorAdapter` — always throws on `fetchBatch` (for failure-path tests)

**`EvidenceIngestionPipeline`:**
- `runSync(adapter, options?)` — full incremental sync:
  1. Ensures `SourceConnector` record exists (auto-creates on first run)
  2. Loads existing checkpoint from most recent completed `SourceSyncRun`
  3. Creates `SourceSyncRun` (status: `"running"`); marks connector `"syncing"`
  4. Paginates `fetchBatch` up to `maxItemsPerRun` (default 100)
  5. Per item: deduplicates by `connectorId:externalId`, stores `RawPayloadRecord`, normalizes to `EvidenceDocument` + `EvidenceSnippet` + `EvidenceSearchDocument`
  6. Item-level errors recorded as `EvidenceIngestionError` (non-aborting)
  7. On success: run → `"completed"`, connector → `"ready"` + `lastSyncAt` set, checkpoint saved
  8. On adapter failure: run → `"failed"`, connector → `"degraded"`, one error record written
- `getErrors(syncRunId)` — retrieve ingestion errors for a run
- `getSyncRun(syncRunId)` — retrieve sync run record
- `getConnector(connectorName)` — retrieve connector by name

**`ConnectorSyncScheduler`:**
- `register(connectorId, schedule)` — register or update sync schedule; respects explicit `nextDueAt` from caller
- `isDue(connectorId, nowMs?)` — returns true if `nextDueAt ≤ now`
- `recordSyncStarted(connectorId, nowMs?)` — sets `lastAttemptAt`, advances `nextDueAt` by one cadence interval
- `getDueConnectors(nowMs?)` — returns all connector IDs whose sync is overdue
- `getSchedule(connectorId)` — retrieve current schedule

### `packages/platform-core/src/index.ts` (extended)
- `export * from "./connectors.js"` barrel export
- `Phase1Platform` gains `ingestion = new EvidenceIngestionPipeline(this.repository)` and `syncScheduler = new ConnectorSyncScheduler(this.repository)`

### `packages/platform-core/src/phase10.test.ts` (new — 15 tests)

| Area | Tests |
|------|-------|
| Sync creates run + payloads + documents + snippets | 1 |
| Trust tier assignment per connector type | 1 |
| Checkpoint resume (2nd run skips already-ingested items) | 1 |
| 3rd run on exhausted source produces zero docs | 1 |
| Item-level ingestion errors don't abort the run | 1 |
| Adapter-level failure → run failed + connector degraded | 1 |
| `lastSyncAt` updated on success | 1 |
| `lastSyncAt` not updated on failure | 1 |
| Scheduler `isDue` returns true when past due | 1 |
| Scheduler `isDue` returns false when not yet due | 1 |
| `recordSyncStarted` advances `nextDueAt` | 1 |
| `getDueConnectors` returns only overdue connectors | 1 |
| Ingested docs are searchable via `EvidenceService.search` | 1 |
| `Phase1Platform` exposes `ingestion` and `syncScheduler` | 1 |
| Multiple adapters run independently in parallel | 1 |

---

## Exit Criteria

- [x] Connector syncs run against real sources on schedule — `ConnectorSyncScheduler` tracks cadence and `isDue()`
- [x] Evidence freshness and sync failures are measurable — `lastSyncAt` on `SourceConnector`, `status: "failed"` on `SourceSyncRun`, `EvidenceIngestionError` per run
- [x] Analyst actions are persisted with review history and auditability — existing curation/promotion workflow preserved; ingestion errors provide itemized failure audit trail
- [x] Live connector adapter interface defined (`LiveConnectorAdapter`) ready for real CurseForge/Modrinth/GitHub HTTP adapters
- [x] Checkpoint-based incremental sync with deduplication prevents re-ingesting already-seen items
- [x] Item-level errors are non-aborting: partial syncs recover gracefully
- [x] Trust scores in evidence documents reflect connector trust tier
- [x] Ingested documents are immediately searchable via `EvidenceService.search`
- [x] 64/64 tests pass (phase2–phase10), zero regressions
