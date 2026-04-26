/**
 * Phase 9 — Live data ingestion and evidence operations.
 *
 * Covers:
 *  - LiveConnectorAdapter interface (CurseForge, Modrinth, GitHub, community)
 *  - In-memory test adapters that produce deterministic fixture-style data
 *  - EvidenceIngestionPipeline — runs a full sync, checkpointing, error recording
 *  - ConnectorSyncScheduler — cadence, quota budget, freshness tracking
 */

import { randomUUID } from "node:crypto";

import type {
  ConnectorSyncSchedule,
  EvidenceDocument,
  EvidenceIngestionError,
  EvidenceSearchDocument,
  EvidenceSnippet,
  RawPayloadRecord,
  SourceConnector,
  SourceSyncRun,
  TrustTier
} from "@modcompat/domain-models";
import { now, stableHash } from "./helpers.js";
import { InMemoryPlatformRepository } from "./repository.js";
import { createPlatformId } from "@modcompat/id-generation";

// ---------------------------------------------------------------------------
// Connector adapter interface
// ---------------------------------------------------------------------------

/** A single raw item fetched from a connector source. */
export interface ConnectorFetchItem {
  /** Stable external ID (e.g. GitHub issue number, Modrinth thread ID). */
  externalId: string;
  contentType: "github_issue" | "github_discussion" | "release_note" | "curated_post";
  /** The raw body of the item as returned by the source API. */
  body: Record<string, unknown>;
  /** ISO timestamp the item was last modified at the source. */
  sourceUpdatedAt: string;
}

export interface ConnectorFetchResult {
  items: ConnectorFetchItem[];
  /** Opaque cursor to pass on the next call for incremental sync. */
  nextCheckpoint?: Record<string, unknown>;
  /** Whether more items are available beyond this batch. */
  hasMore: boolean;
}

/** Implemented by each connector source to abstract away their specific APIs. */
export interface LiveConnectorAdapter {
  readonly connectorName: string;
  readonly sourceType: SourceConnector["sourceType"];
  readonly trustTier: TrustTier;
  /**
   * Fetch a batch of items from the source.
   * @param checkpoint - Opaque cursor from the previous sync run; absent on the first run.
   * @param limit - Maximum items to return (quota budget).
   */
  fetchBatch(
    checkpoint: Record<string, unknown> | undefined,
    limit: number
  ): Promise<ConnectorFetchResult>;
}

// ---------------------------------------------------------------------------
// In-memory test adapters
// ---------------------------------------------------------------------------

/**
 * Deterministic CurseForge adapter for tests.
 * Simulates two pages of five items each, supporting checkpoint-based resume.
 */
export class InMemoryCurseForgeAdapter implements LiveConnectorAdapter {
  readonly connectorName = "curseforge";
  readonly sourceType = "curseforge" as const;
  readonly trustTier: TrustTier = "curated";

  private readonly items: ConnectorFetchItem[] = Array.from({ length: 10 }, (_, i) => ({
    externalId: `cf_issue_${i + 1}`,
    contentType: "release_note" as const,
    body: {
      id: i + 1,
      title: `CurseForge Release Note ${i + 1}`,
      body: `sodium is incompatible with optifine on version 1.21.1. See mod entry ${i + 1}.`,
      projectSlug: i % 2 === 0 ? "sodium" : "optifine",
      gameVersion: "1.21.1",
      updatedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`
    },
    sourceUpdatedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`
  }));

  async fetchBatch(
    checkpoint: Record<string, unknown> | undefined,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const offset = typeof checkpoint?.offset === "number" ? checkpoint.offset : 0;
    const batch = this.items.slice(offset, offset + limit);
    const nextOffset = offset + batch.length;
    const hasMore = nextOffset < this.items.length;
    return {
      items: batch,
      nextCheckpoint: hasMore ? { offset: nextOffset } : undefined,
      hasMore
    };
  }
}

/**
 * Deterministic Modrinth adapter for tests.
 * Produces community discussion items.
 */
export class InMemoryModrinthAdapter implements LiveConnectorAdapter {
  readonly connectorName = "modrinth";
  readonly sourceType = "modrinth" as const;
  readonly trustTier: TrustTier = "community";

  private readonly items: ConnectorFetchItem[] = Array.from({ length: 6 }, (_, i) => ({
    externalId: `mr_thread_${i + 1}`,
    contentType: "github_discussion" as const,
    body: {
      id: `mr_${i + 1}`,
      title: `Modrinth Discussion ${i + 1}`,
      body: `Users report sodium and modmenu crash on fabric loader ${i + 1}.0.`,
      projectId: i % 2 === 0 ? "sodium" : "modmenu",
      loaderVersion: `${i + 1}.0.0`,
      updatedAt: `2024-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`
    },
    sourceUpdatedAt: `2024-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`
  }));

  async fetchBatch(
    checkpoint: Record<string, unknown> | undefined,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const offset = typeof checkpoint?.offset === "number" ? checkpoint.offset : 0;
    const batch = this.items.slice(offset, offset + limit);
    const nextOffset = offset + batch.length;
    const hasMore = nextOffset < this.items.length;
    return {
      items: batch,
      nextCheckpoint: hasMore ? { offset: nextOffset } : undefined,
      hasMore
    };
  }
}

/**
 * Deterministic GitHub adapter for tests.
 * Produces maintainer-level issues and discussions.
 */
export class InMemoryGitHubAdapter implements LiveConnectorAdapter {
  readonly connectorName = "github";
  readonly sourceType = "github" as const;
  readonly trustTier: TrustTier = "maintainer";

  private readonly items: ConnectorFetchItem[] = Array.from({ length: 8 }, (_, i) => ({
    externalId: `gh_issue_${i + 1}`,
    contentType: (i % 2 === 0 ? "github_issue" : "github_discussion") as ConnectorFetchItem["contentType"],
    body: {
      number: i + 1,
      title: `GitHub Issue ${i + 1}: Incompatibility Report`,
      body: `sodium version 0.6.0 is incompatible with optifine HD_U_I6. Issue ${i + 1}.`,
      state: "open",
      repo: "sodium-fabric",
      updatedAt: `2024-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`
    },
    sourceUpdatedAt: `2024-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`
  }));

  /** Adapter that always fails on the item with this externalId (for error injection tests). */
  failOnExternalId?: string;

  async fetchBatch(
    checkpoint: Record<string, unknown> | undefined,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const offset = typeof checkpoint?.offset === "number" ? checkpoint.offset : 0;
    const batch = this.items.slice(offset, offset + limit);
    const nextOffset = offset + batch.length;
    const hasMore = nextOffset < this.items.length;
    return {
      items: batch,
      nextCheckpoint: hasMore ? { offset: nextOffset } : undefined,
      hasMore
    };
  }
}

/** Adapter that always throws on every fetch (for testing sync failure paths). */
export class FailingConnectorAdapter implements LiveConnectorAdapter {
  readonly connectorName = "failing-connector";
  readonly sourceType = "github" as const;
  readonly trustTier: TrustTier = "community";

  async fetchBatch(): Promise<ConnectorFetchResult> {
    throw new Error("Simulated connector fetch failure");
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function trustScoreForTier(tier: TrustTier): number {
  const scores: Record<TrustTier, number> = {
    official: 1.0,
    maintainer: 0.85,
    curated: 0.7,
    community: 0.5
  };
  return scores[tier];
}

function recencyScore(sourceUpdatedAt: string, nowMs = Date.now()): number {
  const ageMs = nowMs - new Date(sourceUpdatedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / 365);
}

function normalizeItem(
  item: ConnectorFetchItem,
  connector: SourceConnector,
  syncRunId: string,
  rawPayloadId: string
): { document: EvidenceDocument; snippets: EvidenceSnippet[] } {
  const documentId = createPlatformId("doc");
  const title =
    typeof item.body.title === "string" ? item.body.title : `[${connector.connectorName}] ${item.externalId}`;
  const bodyText =
    typeof item.body.body === "string" ? item.body.body : JSON.stringify(item.body);

  const tier = connector.trustTier;
  const trustScore = trustScoreForTier(tier);
  const relatedProjectIds = extractProjectRefs(bodyText);
  const clusterId = stableHash({
    title: title.toLowerCase(),
    relatedProjectIds: relatedProjectIds.slice().sort(),
    findingTypes: ["incompatibility"]
  }).slice(0, 16);

  const document: EvidenceDocument = {
    schemaVersion: 1,
    documentId,
    connectorId: connector.connectorId,
    syncRunId,
    rawPayloadId,
    externalDocumentId: item.externalId,
    kind: item.contentType,
    title,
    sourceUrl: sourceUrlForItem(connector.connectorName, item),
    publishedAt: item.sourceUpdatedAt,
    updatedAt: item.sourceUpdatedAt,
    harvestedAt: now(),
    trust: {
      tier,
      score: trustScore,
      signals: [`connector_tier_${tier}`]
    },
    recencyScore: recencyScore(item.sourceUpdatedAt),
    relevance: "supporting",
    stance: "neutral",
    summary: title,
    content: bodyText,
    tags: [],
    relatedProjectIds,
    relatedVersionIds: [],
    findingTypes: ["incompatibility"],
    extractedEntities: [],
    extractedRelations: [],
    provenance: {
      connectorName: connector.connectorName,
      syncRunId,
      externalDocumentId: item.externalId,
      rawPayloadId
    },
    clusterId,
    duplicateDocumentIds: [],
    contradictedByDocumentIds: [],
    createdAt: now()
  };

  const snippetText = bodyText.slice(0, 500);
  const snippet: EvidenceSnippet = {
    schemaVersion: 1,
    snippetId: createPlatformId("snp"),
    documentId,
    kind: "summary",
    text: snippetText,
    textHash: stableHash(snippetText),
    relevance: "supporting",
    stance: "neutral",
    trustScore,
    relatedProjectIds: document.relatedProjectIds,
    relatedVersionIds: [],
    extractedEntities: [],
    extractedRelations: [],
    contradictionDocumentIds: [],
    createdAt: now()
  };

  return { document, snippets: [snippet] };
}

const PROJECT_SLUGS = ["sodium", "optifine", "modmenu", "fabric", "forge"];

function extractProjectRefs(text: string): string[] {
  const lower = text.toLowerCase();
  return PROJECT_SLUGS.filter((slug) => lower.includes(slug));
}

function sourceUrlForItem(connectorName: string, item: ConnectorFetchItem): string {
  const body = item.body;

  if (typeof body.url === "string" && body.url.length > 0) {
    return body.url;
  }

  if (
    connectorName === "github" &&
    typeof body.repo === "string" &&
    typeof body.number === "number"
  ) {
    return `https://github.com/${body.repo}/issues/${body.number}`;
  }

  if (connectorName === "modrinth") {
    if (typeof body.slug === "string" && body.slug.length > 0) {
      return `https://modrinth.com/mod/${body.slug}`;
    }
    if (typeof body.project_id === "string" && typeof body.id === "string") {
      return `https://modrinth.com/project/${body.project_id}/version/${body.id}`;
    }
    if (typeof body.project_id === "string" && body.project_id.length > 0) {
      return `https://modrinth.com/project/${body.project_id}`;
    }
  }

  if (connectorName === "curseforge") {
    if (typeof body.slug === "string" && body.slug.length > 0) {
      return `https://www.curseforge.com/minecraft/mc-mods/${body.slug}`;
    }
    if (typeof body.modId === "number" && typeof body.id === "number") {
      return `https://www.curseforge.com/minecraft/mc-mods/${body.modId}/files/${body.id}`;
    }
    if (typeof body.id === "number") {
      return `https://www.curseforge.com/minecraft/mc-mods/${body.id}`;
    }
  }

  return `https://source.example/${connectorName}/${item.externalId}`;
}

// ---------------------------------------------------------------------------
// EvidenceIngestionPipeline
// ---------------------------------------------------------------------------

export interface IngestionRunResult {
  syncRunId: string;
  connectorId: string;
  status: SourceSyncRun["status"];
  rawPayloadCount: number;
  documentCount: number;
  snippetCount: number;
  errorCount: number;
  checkpoint?: Record<string, unknown>;
}

export class EvidenceIngestionPipeline {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  /**
   * Run a full incremental sync for a connector using the supplied adapter.
   * Errors on individual items are recorded but do not abort the run.
   * The run is marked "failed" only if the adapter itself throws.
   */
  async runSync(
    adapter: LiveConnectorAdapter,
    options: { maxItemsPerRun?: number } = {}
  ): Promise<IngestionRunResult> {
    const limit = options.maxItemsPerRun ?? 100;

    // Ensure connector record exists
    let connector = this.repository.sourceConnectorsByName.get(adapter.connectorName);
    if (!connector) {
      connector = {
        schemaVersion: 1,
        connectorId: createPlatformId("src"),
        connectorName: adapter.connectorName,
        sourceType: adapter.sourceType,
        status: "ready",
        trustTier: adapter.trustTier,
        createdAt: now(),
        updatedAt: now()
      };
      this.repository.sourceConnectors.set(connector.connectorId, connector);
      this.repository.sourceConnectorsByName.set(connector.connectorName, connector);
    }

    // Load existing checkpoint from the most recent completed run for this connector
    const existingCheckpoint = this.loadCheckpoint(connector.connectorId);

    const syncRunId = createPlatformId("run");
    const syncRun: SourceSyncRun = {
      schemaVersion: 1,
      syncRunId,
      connectorId: connector.connectorId,
      status: "running",
      startedAt: now(),
      checkpoint: existingCheckpoint,
      stats: {
        rawPayloadCount: 0,
        documentCount: 0,
        snippetCount: 0,
        contradictionCount: 0,
        supersessionCount: 0
      },
      createdAt: now()
    };
    this.repository.sourceSyncRuns.set(syncRunId, syncRun);

    // Update connector status to syncing
    const updatedConnector: SourceConnector = { ...connector, status: "syncing", updatedAt: now() };
    this.repository.sourceConnectors.set(connector.connectorId, updatedConnector);
    this.repository.sourceConnectorsByName.set(connector.connectorName, updatedConnector);

    const errors: EvidenceIngestionError[] = [];
    let rawPayloadCount = 0;
    let documentCount = 0;
    let snippetCount = 0;
    let checkpoint: Record<string, unknown> | undefined = existingCheckpoint;

    try {
      let fetched = 0;
      let hasMore = true;

      while (hasMore && fetched < limit) {
        const batchLimit = Math.min(limit - fetched, 50);
        const result = await adapter.fetchBatch(checkpoint, batchLimit);

        for (const item of result.items) {
          try {
            // Deduplicate by externalId
            const dedupeKey = `${connector.connectorId}:${item.externalId}`;
            if (this.repository.evidenceDocumentsByExternalRef.has(dedupeKey)) {
              continue;
            }

            const rawPayloadId = createPlatformId("raw");
            const rawPayload: RawPayloadRecord = {
              schemaVersion: 1,
              rawPayloadId,
              connectorId: connector.connectorId,
              syncRunId,
              externalDocumentId: item.externalId,
              contentType: item.contentType,
              checksum: stableHash(JSON.stringify(item.body)),
              body: item.body,
              fetchedAt: now(),
              createdAt: now()
            };
            this.repository.rawPayloads.set(rawPayloadId, rawPayload);
            rawPayloadCount++;

            const { document, snippets } = normalizeItem(
              item,
              updatedConnector,
              syncRunId,
              rawPayloadId
            );
            this.repository.evidenceDocuments.set(document.documentId, document);
            this.repository.evidenceDocumentsByExternalRef.set(dedupeKey, document.documentId);
            documentCount++;

            // Build search document
            const searchDoc: EvidenceSearchDocument = {
              index: "evidence-documents",
              id: document.documentId,
              documentId: document.documentId,
              title: document.title,
              text: document.content,
              connectorId: document.connectorId,
              trustTier: document.trust.tier,
              trustScore: document.trust.score,
              recencyScore: document.recencyScore,
              relevance: document.relevance,
              stance: document.stance,
              findingTypes: document.findingTypes,
              relatedProjectIds: document.relatedProjectIds,
              relatedVersionIds: document.relatedVersionIds,
              clusterId: document.clusterId,
              contradictedByDocumentIds: document.contradictedByDocumentIds,
              supersededByDocumentId: document.supersededByDocumentId,
              sourceUrl: document.sourceUrl,
              publishedAt: document.publishedAt
            };
            this.repository.evidenceSearchDocuments.set(document.documentId, searchDoc);

            for (const snippet of snippets) {
              this.repository.evidenceSnippets.set(snippet.snippetId, snippet);
              snippetCount++;
            }
          } catch (err) {
            const ingestionError: EvidenceIngestionError = {
              schemaVersion: 1,
              errorId: randomUUID(),
              connectorId: connector.connectorId,
              syncRunId,
              externalDocumentId: item.externalId,
              errorCode: "normalization_error",
              message: err instanceof Error ? err.message : String(err),
              rawPayload: item.body,
              retryable: true,
              occurredAt: now()
            };
            errors.push(ingestionError);
          }

          fetched++;
        }

        checkpoint = result.nextCheckpoint ?? checkpoint;
        hasMore = result.hasMore && result.items.length > 0;
      }

      // Persist errors
      if (errors.length > 0) {
        this.repository.ingestionErrors.set(syncRunId, errors);
      }

      // Complete the run
      const completedRun: SourceSyncRun = {
        ...syncRun,
        status: "completed",
        finishedAt: now(),
        checkpoint,
        stats: {
          rawPayloadCount,
          documentCount,
          snippetCount,
          contradictionCount: 0,
          supersessionCount: 0
        }
      };
      this.repository.sourceSyncRuns.set(syncRunId, completedRun);

      // Update connector: ready + lastSyncAt
      const readyConnector: SourceConnector = {
        ...updatedConnector,
        status: "ready",
        lastSyncAt: now(),
        updatedAt: now()
      };
      this.repository.sourceConnectors.set(connector.connectorId, readyConnector);
      this.repository.sourceConnectorsByName.set(connector.connectorName, readyConnector);

      // Persist checkpoint for next run
      this.saveCheckpoint(connector.connectorId, checkpoint);

      return {
        syncRunId,
        connectorId: connector.connectorId,
        status: "completed",
        rawPayloadCount,
        documentCount,
        snippetCount,
        errorCount: errors.length,
        checkpoint
      };
    } catch (err) {
      // Adapter-level failure — mark run as failed
      const failedRun: SourceSyncRun = {
        ...syncRun,
        status: "failed",
        finishedAt: now(),
        stats: {
          rawPayloadCount,
          documentCount,
          snippetCount,
          contradictionCount: 0,
          supersessionCount: 0
        }
      };
      this.repository.sourceSyncRuns.set(syncRunId, failedRun);

      const ingestionError: EvidenceIngestionError = {
        schemaVersion: 1,
        errorId: randomUUID(),
        connectorId: connector.connectorId,
        syncRunId,
        errorCode: "adapter_fetch_error",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        occurredAt: now()
      };
      this.repository.ingestionErrors.set(syncRunId, [ingestionError]);

      // Mark connector as degraded
      const degradedConnector: SourceConnector = {
        ...updatedConnector,
        status: "degraded",
        updatedAt: now()
      };
      this.repository.sourceConnectors.set(connector.connectorId, degradedConnector);
      this.repository.sourceConnectorsByName.set(connector.connectorName, degradedConnector);

      return {
        syncRunId,
        connectorId: connector.connectorId,
        status: "failed",
        rawPayloadCount,
        documentCount,
        snippetCount,
        errorCount: 1,
        checkpoint
      };
    }
  }

  getErrors(syncRunId: string): EvidenceIngestionError[] {
    return this.repository.ingestionErrors.get(syncRunId) ?? [];
  }

  getSyncRun(syncRunId: string): SourceSyncRun | undefined {
    return this.repository.sourceSyncRuns.get(syncRunId);
  }

  getConnector(connectorName: string): SourceConnector | undefined {
    return this.repository.sourceConnectorsByName.get(connectorName);
  }

  private loadCheckpoint(connectorId: string): Record<string, unknown> | undefined {
    // Find the most recent completed run for this connector
    const runs = [...this.repository.sourceSyncRuns.values()]
      .filter((r) => r.connectorId === connectorId && r.status === "completed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs[0]?.checkpoint;
  }

  private saveCheckpoint(connectorId: string, checkpoint: Record<string, unknown> | undefined) {
    // The checkpoint is embedded in the completed SourceSyncRun — nothing extra needed
    // This method is a hook for future Redis-backed checkpoint storage
    void connectorId;
    void checkpoint;
  }
}

// ---------------------------------------------------------------------------
// ConnectorSyncScheduler
// ---------------------------------------------------------------------------

export class ConnectorSyncScheduler {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  /**
   * Register or update the sync schedule for a connector.
   */
  register(connectorId: string, schedule: Omit<ConnectorSyncSchedule, "connectorId">): void {
    const existing = this.repository.connectorSchedules.get(connectorId);
    this.repository.connectorSchedules.set(connectorId, {
      ...schedule,
      connectorId,
      lastAttemptAt: existing?.lastAttemptAt,
      // Priority: explicit value from caller > preserved from existing > computed from cadence
      nextDueAt: schedule.nextDueAt ?? existing?.nextDueAt ?? this.computeNextDueAt(schedule.cadenceMinutes)
    });
  }

  /**
   * Returns true if the connector is due for a sync.
   */
  isDue(connectorId: string, nowMs = Date.now()): boolean {
    const schedule = this.repository.connectorSchedules.get(connectorId);
    if (!schedule) return false;
    if (!schedule.nextDueAt) return true;
    return new Date(schedule.nextDueAt).getTime() <= nowMs;
  }

  /**
   * Record that a sync attempt has started.  Updates lastAttemptAt and
   * advances nextDueAt by one cadence interval.
   */
  recordSyncStarted(connectorId: string, nowMs = Date.now()): void {
    const schedule = this.repository.connectorSchedules.get(connectorId);
    if (!schedule) return;
    const nowIso = new Date(nowMs).toISOString();
    this.repository.connectorSchedules.set(connectorId, {
      ...schedule,
      lastAttemptAt: nowIso,
      nextDueAt: this.computeNextDueAt(schedule.cadenceMinutes, nowMs)
    });
  }

  /**
   * Return all connectors whose sync is currently due.
   */
  getDueConnectors(nowMs = Date.now()): string[] {
    return [...this.repository.connectorSchedules.entries()]
      .filter(([id]) => this.isDue(id, nowMs))
      .map(([id]) => id);
  }

  getSchedule(connectorId: string): ConnectorSyncSchedule | undefined {
    return this.repository.connectorSchedules.get(connectorId);
  }

  private computeNextDueAt(cadenceMinutes: number, fromMs = Date.now()): string {
    return new Date(fromMs + cadenceMinutes * 60 * 1000).toISOString();
  }
}
