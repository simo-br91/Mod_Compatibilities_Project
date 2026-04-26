/**
 * Modrinth connector — real HTTP adapter using Modrinth API v2.
 *
 * Docs: https://docs.modrinth.com
 *
 * Usage:
 *   import ModrinthAdapter from "./connectors/modrinth/index.js";
 *   const adapter = new ModrinthAdapter({
 *     userAgent: "myapp/1.0 (contact@example.com)",
 *   });
 */

import type {
  ConnectorFetchItem,
  ConnectorFetchResult,
  LiveConnectorAdapter,
} from "@modcompat/platform-core";

// ---------------------------------------------------------------------------
// Modrinth API shapes (partial)
// ---------------------------------------------------------------------------

interface MrProject {
  project_id: string;
  project_type: string;
  slug: string;
  title: string;
  description: string;
  date_modified: string;
  date_created: string;
  downloads: number;
  follows: number;
  categories: string[];
  versions: string[];
  [key: string]: unknown;
}

interface MrSearchResponse {
  hits: MrProject[];
  offset: number;
  limit: number;
  total_hits: number;
}

interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  changelog: string | null;
  date_published: string;
  game_versions: string[];
  loaders: string[];
  version_type: "release" | "beta" | "alpha";
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Checkpoint shape
// ---------------------------------------------------------------------------

interface ModrinthCheckpoint {
  /** Offset into the global search results page (used when no projectIds). */
  offset: number;
  /** ISO timestamp of the latest item seen — for future incremental filtering. */
  lastUpdated?: string;
  /**
   * Per-project version pagination: maps projectId -> next version offset.
   * Only populated when projectIds are configured.
   */
  projectOffsets?: Record<string, number>;
  /** Index into projectIds array being processed. */
  projectIndex?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ModrinthAdapterConfig {
  /**
   * Required by Modrinth ToS.  Format: "appname/version (contact)"
   * The adapter wraps this in "modcompat-platform/1.0 ({userAgent})".
   */
  userAgent: string;
  /** Optional — fetch version entries for these specific project IDs. */
  projectIds?: string[];
  /**
   * Optional facets for the search endpoint.
   * Defaults to [["project_type:mod"]].
   * See https://docs.modrinth.com/#tag/project_result_model for options.
   */
  facets?: string[][];
  /** Optional API key for higher rate limits (read-only endpoints are public). */
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const BASE_V2 = "https://api.modrinth.com/v2";
const BASE_V3 = "https://api.modrinth.com/v3";

export class ModrinthAdapter implements LiveConnectorAdapter {
  readonly connectorName = "modrinth";
  readonly sourceType = "modrinth" as const;
  readonly trustTier = "community" as const;

  private readonly userAgent: string;
  private readonly projectIds: string[];
  private readonly facets: string[][];
  private readonly apiKey: string | undefined;

  constructor(config: ModrinthAdapterConfig) {
    this.userAgent = `modcompat-platform/1.0 (${config.userAgent})`;
    this.projectIds = config.projectIds ?? [];
    this.facets = config.facets ?? [["project_type:mod"]];
    this.apiKey = config.apiKey;
  }

  // -------------------------------------------------------------------------
  // fetchBatch
  // -------------------------------------------------------------------------

  async fetchBatch(
    checkpoint: Record<string, unknown> | undefined,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const cp = this.parseCheckpoint(checkpoint);

    if (this.projectIds.length > 0) {
      return this.fetchProjectVersions(cp, limit);
    }
    return this.fetchSearch(cp, limit);
  }

  // -------------------------------------------------------------------------
  // Global project search
  // -------------------------------------------------------------------------

  private async fetchSearch(
    cp: ModrinthCheckpoint,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const facetsEncoded = JSON.stringify(this.facets);
    const url =
      `${BASE_V2}/search` +
      `?limit=${limit}` +
      `&offset=${cp.offset}` +
      `&facets=${encodeURIComponent(facetsEncoded)}`;

    const result = await this.get<MrSearchResponse>(url);
    if (result === null) {
      return { items: [], hasMore: true, nextCheckpoint: cp };
    }

    const { hits, total_hits } = result;
    const items: ConnectorFetchItem[] = hits.map((project) => ({
      externalId: `mr_proj_${project.project_id}`,
      contentType: "curated_post",
      body: project as unknown as Record<string, unknown>,
      sourceUpdatedAt: project.date_modified,
    }));

    const nextOffset = cp.offset + hits.length;
    const hasMore = nextOffset < total_hits;

    return {
      items,
      hasMore,
      nextCheckpoint: hasMore
        ? {
            offset: nextOffset,
            lastUpdated: hits[0]?.date_modified ?? cp.lastUpdated,
          }
        : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Per-project version fetch
  // -------------------------------------------------------------------------

  private async fetchProjectVersions(
    cp: ModrinthCheckpoint,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const projectOffsets: Record<string, number> = {
      ...(cp.projectOffsets ?? {}),
    };
    let projectIndex = cp.projectIndex ?? 0;

    const items: ConnectorFetchItem[] = [];
    let remaining = limit;
    let latestUpdated = cp.lastUpdated;

    while (projectIndex < this.projectIds.length && remaining > 0) {
      const projectId = this.projectIds[projectIndex];
      const key = projectId;
      const offset = projectOffsets[key] ?? 0;

      const url =
        `${BASE_V2}/project/${encodeURIComponent(projectId)}/version` +
        `?limit=${remaining}` +
        `&offset=${offset}`;

      const versions = await this.get<MrVersion[]>(url);

      if (versions === null) {
        // Transient error — stop here, return what we have
        break;
      }

      for (const ver of versions) {
        items.push({
          externalId: `mr_ver_${ver.id}`,
          contentType: "release_note",
          body: ver as unknown as Record<string, unknown>,
          sourceUpdatedAt: ver.date_published,
        });
        if (
          !latestUpdated ||
          ver.date_published > latestUpdated
        ) {
          latestUpdated = ver.date_published;
        }
      }

      // Modrinth version endpoint returns an array without a total_count.
      // If we received fewer items than we asked for, the project has no more
      // versions to page through.
      const requested = remaining;
      remaining -= versions.length;
      const modHasMore = versions.length >= requested;

      if (modHasMore) {
        projectOffsets[key] = offset + versions.length;
        break;
      } else {
        delete projectOffsets[key];
        projectIndex++;
      }
    }

    const hasMore = projectIndex < this.projectIds.length;
    const nextCheckpoint: ModrinthCheckpoint = {
      offset: cp.offset,
      lastUpdated: latestUpdated,
      projectOffsets:
        Object.keys(projectOffsets).length > 0 ? projectOffsets : undefined,
      projectIndex,
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
   * Performs a GET request against the Modrinth API.
   *
   * Returns null on transient failures (429, 5xx) so the caller can signal
   * hasMore=true and let the scheduler retry.
   * Throws on non-recoverable errors (401, 403).
   */
  private async get<T>(url: string): Promise<T | null> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = this.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (networkErr) {
      console.error("[modrinth] Network error fetching", url, networkErr);
      return null;
    }

    // Respect rate limit headers
    const remaining = response.headers.get("X-Ratelimit-Remaining");
    const reset = response.headers.get("X-Ratelimit-Reset");
    if (remaining !== null && Number(remaining) <= 5) {
      console.error(
        `[modrinth] Rate limit nearly exhausted (${remaining} remaining, resets at ${reset})`
      );
      // Return null to signal the caller to back off
      return null;
    }

    if (response.status === 429) {
      console.error(`[modrinth] Rate limited (429) — will retry later`);
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `[modrinth] Auth error ${response.status} for ${url}`
      );
    }

    if (response.status === 404) {
      // Project/version not found — treat as empty, not an error
      console.error(`[modrinth] 404 for ${url} — skipping`);
      return null;
    }

    if (response.status >= 500) {
      console.error(
        `[modrinth] Server error ${response.status} for ${url} — will retry`
      );
      return null;
    }

    if (!response.ok) {
      console.error(
        `[modrinth] Unexpected status ${response.status} for ${url}`
      );
      return null;
    }

    try {
      return (await response.json()) as T;
    } catch (parseErr) {
      console.error("[modrinth] Failed to parse JSON from", url, parseErr);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // v3 thread fetch (alpha — graceful fallback)
  // -------------------------------------------------------------------------

  /**
   * Attempt to fetch a Modrinth v3 thread.  Returns null on any failure since
   * the v3 API is alpha and subject to breaking changes.
   */
  async fetchThread(threadId: string): Promise<Record<string, unknown> | null> {
    const url = `${BASE_V3}/thread/${encodeURIComponent(threadId)}`;
    try {
      const result = await this.get<Record<string, unknown>>(url);
      return result;
    } catch {
      // v3 is alpha — swallow errors silently
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Checkpoint helpers
  // -------------------------------------------------------------------------

  private parseCheckpoint(
    raw: Record<string, unknown> | undefined
  ): ModrinthCheckpoint {
    if (!raw) return { offset: 0 };
    return {
      offset: typeof raw.offset === "number" ? raw.offset : 0,
      lastUpdated:
        typeof raw.lastUpdated === "string" ? raw.lastUpdated : undefined,
      projectOffsets:
        raw.projectOffsets != null &&
        typeof raw.projectOffsets === "object" &&
        !Array.isArray(raw.projectOffsets)
          ? (raw.projectOffsets as Record<string, number>)
          : undefined,
      projectIndex:
        typeof raw.projectIndex === "number" ? raw.projectIndex : 0,
    };
  }
}

export default ModrinthAdapter;
