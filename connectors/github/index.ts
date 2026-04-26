/**
 * GitHub connector — real HTTP adapter using GitHub REST API v3.
 *
 * Docs: https://docs.github.com/en/rest
 *
 * Usage:
 *   import GitHubAdapter from "./connectors/github/index.js";
 *   const adapter = new GitHubAdapter({
 *     token: process.env.GITHUB_TOKEN!,
 *     repos: ["sodium-fabric/sodium-fabric", "CaffeineMC/sodium"],
 *     labels: ["incompatibility", "mod-conflict"],
 *   });
 */

import type {
  ConnectorFetchItem,
  ConnectorFetchResult,
  LiveConnectorAdapter,
} from "@modcompat/platform-core";

// ---------------------------------------------------------------------------
// GitHub API shapes (partial)
// ---------------------------------------------------------------------------

interface GhUser {
  login: string;
  id: number;
  html_url: string;
}

interface GhLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: GhUser | null;
  labels: GhLabel[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: {
    url: string;
    html_url: string;
    merged_at: string | null;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Checkpoint shape
// ---------------------------------------------------------------------------

interface GitHubCheckpoint {
  /** Index into the repos array currently being synced. */
  repoIndex: number;
  /** GitHub issues page number (1-based) for the current repo. */
  page: number;
  /**
   * ISO timestamp — only issues updated after this time are fetched.
   * Advances to the latest updatedAt seen across all items.
   */
  since: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GitHubAdapterConfig {
  /** Personal access token or fine-grained PAT with issues:read scope. */
  token: string;
  /**
   * List of repositories in "owner/repo" format.
   * e.g. ["sodium-fabric/sodium-fabric", "LambdAurora/LambDynamicLights"]
   */
  repos: string[];
  /**
   * Optional label filter — only issues tagged with at least one of these
   * labels are returned.  Passed as a comma-joined list to the API.
   */
  labels?: string[];
  /**
   * Optional ISO timestamp for the initial incremental window.
   * On subsequent runs the adapter advances this from the checkpoint.
   */
  since?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.github.com";
/** Stop fetching more items for this batch when remaining rate limit is below this. */
const RATE_LIMIT_SAFETY_MARGIN = 10;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GitHubAdapter implements LiveConnectorAdapter {
  readonly connectorName = "github";
  readonly sourceType = "github" as const;
  readonly trustTier = "maintainer" as const;

  private readonly token: string;
  private readonly repos: string[];
  private readonly labels: string[];
  private readonly initialSince: string;

  constructor(config: GitHubAdapterConfig) {
    this.token = config.token;
    this.repos = config.repos;
    this.labels = config.labels ?? [];
    // Default: sync from 90 days ago if no since provided
    this.initialSince =
      config.since ??
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  // -------------------------------------------------------------------------
  // fetchBatch
  // -------------------------------------------------------------------------

  async fetchBatch(
    checkpoint: Record<string, unknown> | undefined,
    limit: number
  ): Promise<ConnectorFetchResult> {
    const cp = this.parseCheckpoint(checkpoint);

    const items: ConnectorFetchItem[] = [];
    let { repoIndex, page, since } = cp;
    let remaining = limit;
    let rateLimited = false;
    let latestUpdated = since;

    while (repoIndex < this.repos.length && remaining > 0 && !rateLimited) {
      const repo = this.repos[repoIndex];
      const perPage = Math.min(remaining, 100); // GitHub max per_page is 100

      const labelParam =
        this.labels.length > 0
          ? `&labels=${encodeURIComponent(this.labels.join(","))}`
          : "";

      const url =
        `${BASE_URL}/repos/${repo}/issues` +
        `?state=all` +
        `&per_page=${perPage}` +
        `&page=${page}` +
        `&since=${encodeURIComponent(since)}` +
        `&sort=updated` +
        `&direction=desc` +
        labelParam;

      const result = await this.getIssues(url);

      if (result === "rate_limited") {
        rateLimited = true;
        break;
      }

      if (result === null) {
        // Transient error — stop and return what we have
        break;
      }

      const { issues, rateLimitRemaining } = result;

      // Map issues to ConnectorFetchItems
      for (const issue of issues) {
        const repoKey = repo.replace("/", "_");
        const contentType: ConnectorFetchItem["contentType"] =
          issue.pull_request ? "release_note" : "github_issue";

        items.push({
          externalId: `gh_issue_${repoKey}_${issue.number}`,
          contentType,
          body: {
            number: issue.number,
            title: issue.title,
            body: issue.body ?? "",
            state: issue.state,
            labels: issue.labels.map((l) => l.name),
            url: issue.html_url,
            repo,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            closedAt: issue.closed_at,
            author: issue.user?.login ?? null,
            isPullRequest: !!issue.pull_request,
          },
          sourceUpdatedAt: issue.updated_at,
        });

        if (issue.updated_at > latestUpdated) {
          latestUpdated = issue.updated_at;
        }
      }

      remaining -= issues.length;

      // Bail out early if rate limit is getting low
      if (
        rateLimitRemaining !== null &&
        rateLimitRemaining < RATE_LIMIT_SAFETY_MARGIN
      ) {
        console.error(
          `[github] Rate limit nearly exhausted (${rateLimitRemaining} remaining) — stopping early`
        );
        rateLimited = true;
        break;
      }

      // If we got a full page, there may be more
      if (issues.length === perPage) {
        page++;
        // Advance checkpoint — we will resume on the next page of this repo
        break;
      } else {
        // Fewer results than requested — this repo is done, move to the next
        repoIndex++;
        page = 1;
      }
    }

    const hasMore =
      rateLimited ||
      repoIndex < this.repos.length ||
      // If we broke out because page advanced, hasMore is true too
      (repoIndex < this.repos.length);

    // Build next checkpoint
    const nextCheckpoint: GitHubCheckpoint = {
      repoIndex,
      page,
      // Advance since only when we've finished all repos cleanly
      since: repoIndex >= this.repos.length ? latestUpdated : since,
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

  private async getIssues(url: string): Promise<
    | {
        issues: GhIssue[];
        rateLimitRemaining: number | null;
      }
    | "rate_limited"
    | null
  > {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (networkErr) {
      console.error("[github] Network error fetching", url, networkErr);
      return null;
    }

    // Parse rate limit headers
    const rateLimitRemaining = this.parseIntHeader(
      response.headers.get("X-RateLimit-Remaining")
    );

    // Primary rate limit
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      console.error(
        `[github] Rate limited (429) — retry after ${retryAfter ?? "unknown"}s`
      );
      return "rate_limited";
    }

    // Secondary rate limit (403 with Retry-After)
    if (response.status === 403) {
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        console.error(
          `[github] Secondary rate limit (403) — retry after ${retryAfter}s`
        );
        return "rate_limited";
      }
      throw new Error(
        `[github] Auth error 403 for ${url} — check your token permissions`
      );
    }

    if (response.status === 401) {
      throw new Error(`[github] Auth error 401 — invalid token`);
    }

    if (response.status === 404) {
      console.error(`[github] 404 for ${url} — repo not found or no access`);
      // Return empty so the caller moves on to the next repo
      return { issues: [], rateLimitRemaining };
    }

    if (response.status >= 500) {
      console.error(
        `[github] Server error ${response.status} for ${url} — will retry`
      );
      return null;
    }

    if (!response.ok) {
      console.error(
        `[github] Unexpected status ${response.status} for ${url}`
      );
      return null;
    }

    let issues: GhIssue[];
    try {
      issues = (await response.json()) as GhIssue[];
    } catch (parseErr) {
      console.error("[github] Failed to parse JSON from", url, parseErr);
      return null;
    }

    return { issues, rateLimitRemaining };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private parseIntHeader(value: string | null): number | null {
    if (value === null) return null;
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  private parseCheckpoint(
    raw: Record<string, unknown> | undefined
  ): GitHubCheckpoint {
    if (!raw) {
      return {
        repoIndex: 0,
        page: 1,
        since: this.initialSince,
      };
    }
    return {
      repoIndex: typeof raw.repoIndex === "number" ? raw.repoIndex : 0,
      page: typeof raw.page === "number" ? raw.page : 1,
      since:
        typeof raw.since === "string" ? raw.since : this.initialSince,
    };
  }
}

export default GitHubAdapter;
