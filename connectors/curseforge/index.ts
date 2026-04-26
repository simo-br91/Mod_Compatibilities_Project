/**
 * CurseForge connector — real HTTP adapter using CurseForge API v2.
 *
 * Docs: https://docs.curseforge.com
 *
 * Usage:
 *   import CurseForgeAdapter from "./connectors/curseforge/index.js";
 *   const adapter = new CurseForgeAdapter({ apiKey: process.env.CF_API_KEY! });
 */

import type {
  ConnectorFetchItem,
  ConnectorFetchResult,
  LiveConnectorAdapter,
} from "@modcompat/platform-core";

// ---------------------------------------------------------------------------
// CurseForge API shapes (partial — only fields we use)
// ---------------------------------------------------------------------------

interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  dateModified: string;
  dateCreated: string;
  gameId: number;
  status: number;
  [key: string]: unknown;
}

interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  releaseType: number;
  gameVersions: string[];
  changelog?: string;
  [key: string]: unknown;
}

interface CfSearchResponse {
  data: CfMod[];
  pagination: {
    index: number;
    pageSize: number;
    resultCount: number;
    totalCount: number;
  };
}

interface CfFilesResponse {
  data: CfFile[];
  pagination: {
    index: number;
    pageSize: number;
    resultCount: number;
    totalCount: number;
  };
}

// ---------------------------------------------------------------------------
// Checkpoint shape
// ---------------------------------------------------------------------------

interface CurseForgeCheckpoint {
  /** Pagination offset for the global mod search (used when no projectIds). */
  offset: number;
  /**
   * Per-mod file pagination: maps modId -> next page offset.
   * Only populated when projectIds/modIds are provided.
   */
  modOffsets?: Record<string, number>;
  /** Index into projectIds array for the current position. */
  modIndex?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CurseForgeAdapterConfig {
  apiKey: string;
  /** If supplied, fetch file/release entries for these specific mod IDs instead of global search. */
  projectIds?: number[];
  /** Alias for projectIds — both are accepted. */
  modIds?: number[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID = 432;

export class CurseForgeAdapter implements LiveConnectorAdapter {
  readonly connectorName = "curseforge";
  readonly sourceType = "curseforge" as const;
  readonly trustTier = "curated" as const;

  private readonly apiKey: string;
  private readonly targetModIds: number[];

  constructor(config: CurseForgeAdapterConfig) {
    this.apiKey = config.apiKey;
    this.targetModIds = [
      ...(config.projectIds ?? []),
      ...(config.modIds ?? []),
    ];
  }

  // -------------------------------------------------------------------------
  // fetchBatch
  // -------------------------------------------------------------------------

  async fetchBatch(
    checkpoint: Record<string, unknown> | undefined,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const cp = this.parseCheckpoint(checkpoint);

    if (this.targetModIds.length > 0) {
      return this.fetchModFiles(cp, limit);
    }
    return this.fetchModSearch(cp, limit);
  }

  // -------------------------------------------------------------------------
  // Global mod search (no specific mod IDs configured)
  // -------------------------------------------------------------------------

  private async fetchModSearch(
    cp: CurseForgeCheckpoint,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const offset = cp.offset;
    const url =
      `${BASE_URL}/mods/search` +
      `?gameId=${MINECRAFT_GAME_ID}` +
      `&index=${offset}` +
      `&pageSize=${limit}` +
      `&sortField=2` +      // 2 = LastUpdated
      `&sortOrder=desc`;

    const response = await this.get<CfSearchResponse>(url);

    if (response === null) {
      // Transient error — return empty with hasMore so scheduler retries
      return { items: [], hasMore: true, nextCheckpoint: cp };
    }

    const { data, pagination } = response;
    const items: ConnectorFetchItem[] = data.map((mod) => ({
      externalId: `cf_mod_${mod.id}`,
      contentType: "release_note",
      body: mod as unknown as Record<string, unknown>,
      sourceUpdatedAt: mod.dateModified,
    }));

    const nextOffset = offset + data.length;
    const hasMore = nextOffset < pagination.totalCount;

    return {
      items,
      hasMore,
      nextCheckpoint: hasMore ? { offset: nextOffset } : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Per-mod file fetch (specific mod IDs configured)
  // -------------------------------------------------------------------------

  private async fetchModFiles(
    cp: CurseForgeCheckpoint,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const modOffsets: Record<string, number> = { ...(cp.modOffsets ?? {}) };
    let modIndex = cp.modIndex ?? 0;

    const items: ConnectorFetchItem[] = [];
    let remaining = limit;

    while (modIndex < this.targetModIds.length && remaining > 0) {
      const modId = this.targetModIds[modIndex];
      const modKey = String(modId);
      const offset = modOffsets[modKey] ?? 0;

      const url =
        `${BASE_URL}/mods/${modId}/files` +
        `?pageSize=${remaining}` +
        `&index=${offset}`;

      const response = await this.get<CfFilesResponse>(url);

      if (response === null) {
        // Transient error — stop here, return what we have
        break;
      }

      const { data, pagination } = response;
      for (const file of data) {
        items.push({
          externalId: `cf_file_${file.id}`,
          contentType: "release_note",
          body: file as unknown as Record<string, unknown>,
          sourceUpdatedAt: file.fileDate,
        });
      }

      remaining -= data.length;
      const nextFileOffset = offset + data.length;
      const modHasMore = nextFileOffset < pagination.totalCount;

      if (modHasMore) {
        modOffsets[modKey] = nextFileOffset;
        // Stay on this mod next call
        break;
      } else {
        // Done with this mod — clear its offset and advance
        delete modOffsets[modKey];
        modIndex++;
      }
    }

    const hasMore = modIndex < this.targetModIds.length;
    const nextCheckpoint: CurseForgeCheckpoint = {
      offset: cp.offset,
      modOffsets: Object.keys(modOffsets).length > 0 ? modOffsets : undefined,
      modIndex,
    };

    return {
      items,
      hasMore,
      nextCheckpoint: hasMore ? nextCheckpoint : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP helper
  // -------------------------------------------------------------------------

  /**
   * Perform a GET request against the CurseForge API.
   *
   * Returns the parsed JSON body on success.
   * Returns null on transient errors (429, 5xx) so the caller can return
   * a partial result and let the scheduler retry.
   * Throws on non-recoverable errors (401, 403).
   */
  private async get<T>(url: string): Promise<T | null> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "x-api-key": this.apiKey,
          Accept: "application/json",
        },
      });
    } catch (networkErr) {
      console.error("[curseforge] Network error fetching", url, networkErr);
      return null;
    }

    if (response.status === 429) {
      console.error("[curseforge] Rate limited (429) — will retry later");
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `[curseforge] Auth error ${response.status} — check your API key`
      );
    }

    if (response.status >= 500) {
      console.error(
        `[curseforge] Server error ${response.status} for ${url} — will retry`
      );
      return null;
    }

    if (!response.ok) {
      console.error(
        `[curseforge] Unexpected status ${response.status} for ${url}`
      );
      return null;
    }

    try {
      return (await response.json()) as T;
    } catch (parseErr) {
      console.error("[curseforge] Failed to parse JSON from", url, parseErr);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Checkpoint helpers
  // -------------------------------------------------------------------------

  private parseCheckpoint(
    raw: Record<string, unknown> | undefined
  ): CurseForgeCheckpoint {
    if (!raw) return { offset: 0 };
    return {
      offset: typeof raw.offset === "number" ? raw.offset : 0,
      modOffsets:
        raw.modOffsets != null &&
        typeof raw.modOffsets === "object" &&
        !Array.isArray(raw.modOffsets)
          ? (raw.modOffsets as Record<string, number>)
          : undefined,
      modIndex:
        typeof raw.modIndex === "number" ? raw.modIndex : 0,
    };
  }
}

export default CurseForgeAdapter;
