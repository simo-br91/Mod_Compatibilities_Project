/**
 * Rate limiting and quota enforcement.
 *
 * Two layers:
 *  1. SlidingWindowRateLimiter — per-key request-rate control (IP or user).
 *     Uses a simple in-memory token bucket with a sliding window.
 *  2. QuotaEnforcer — per-organization plan-based resource quotas
 *     (analyses/day, imports/day, concurrent analyses, etc.).
 *
 * Both implementations are in-memory and designed to be swapped for
 * Redis-backed variants in Phase 7.
 */

import type { RateLimitResult, QuotaPlan, QuotaUsage } from "@modcompat/api-contracts";

/** Default quota plan used when no explicit plan is provided (generous dev/self-hosted limits). */
export const DEFAULT_QUOTA_PLAN: QuotaPlan = {
  planId: "plan_default",
  name: "Default",
  maxAnalysesPerDay: 1000,
  maxImportsPerDay: 2000,
  maxConcurrentAnalyses: 10,
  maxEvidenceSyncsPerHour: 60,
  maxExportBytesPerDay: 10 * 1024 * 1024 * 1024 // 10 GB
};

// ---------------------------------------------------------------------------
// Sliding-window rate limiter
// ---------------------------------------------------------------------------

interface WindowEntry {
  /** Timestamps (ms) of requests within the current window. */
  timestamps: number[];
}

export interface RateLimitConfig {
  /** Maximum requests allowed in the window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/**
 * Token-bucket-style sliding window rate limiter keyed by an arbitrary
 * string (IP address, user ID, API key ID, etc.).
 *
 * Thread safety: Node.js is single-threaded so the Map is safe as-is.
 * Replace with a Redis ZRANGEBYSCORE + ZADD pipeline for multi-instance.
 */
export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();

  constructor(private readonly config: RateLimitConfig) {}

  /**
   * Check and record a request for `key`.
   * Returns a `RateLimitResult` describing whether the request is allowed.
   */
  check(key: string, now = Date.now()): RateLimitResult {
    const cutoff = now - this.config.windowMs;
    const entry = this.windows.get(key) ?? { timestamps: [] };

    // Evict stale timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    const remaining = Math.max(0, this.config.limit - entry.timestamps.length);
    const resetAt = new Date(now + this.config.windowMs).toISOString();

    if (entry.timestamps.length >= this.config.limit) {
      this.windows.set(key, entry);
      const oldestInWindow = entry.timestamps[0]!;
      const retryAfterMs = oldestInWindow + this.config.windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        limit: this.config.limit,
        resetAt,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    entry.timestamps.push(now);
    this.windows.set(key, entry);

    return {
      allowed: true,
      remaining: remaining - 1,
      limit: this.config.limit,
      resetAt,
    };
  }

  /**
   * Reset the window for a key (useful in tests or after a plan upgrade).
   */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Number of tracked keys (for health metrics). */
  keyCount(): number {
    return this.windows.size;
  }
}

// ---------------------------------------------------------------------------
// Predefined limiters for common gateway surfaces
// ---------------------------------------------------------------------------

/** Unauthenticated public endpoints (by IP). */
export const publicApiLimiter = new SlidingWindowRateLimiter({
  limit: 60,
  windowMs: 60_000,   // 60 req/min per IP
});

/** Authenticated endpoints (by userId/keyId). */
export const authenticatedApiLimiter = new SlidingWindowRateLimiter({
  limit: 600,
  windowMs: 60_000,   // 600 req/min per actor
});

/** Heavy write operations (analyses, imports) — per actor. */
export const writeOperationLimiter = new SlidingWindowRateLimiter({
  limit: 30,
  windowMs: 60_000,   // 30 writes/min per actor
});

/** Evidence sync trigger — per organization. */
export const evidenceSyncLimiter = new SlidingWindowRateLimiter({
  limit: 5,
  windowMs: 3_600_000, // 5 syncs/hour per org
});

// ---------------------------------------------------------------------------
// Quota enforcer
// ---------------------------------------------------------------------------

export class QuotaExceededError extends Error {
  readonly code = "quota_exceeded" as const;
  readonly quota: string;
  constructor(quota: string, message: string) {
    super(message);
    this.name = "QuotaExceededError";
    this.quota = quota;
  }
}

/**
 * Tracks per-organization resource usage against a `QuotaPlan`.
 *
 * The 24-hour windows are rolling from first-use.  For production, replace
 * the window tracking with Redis EXPIRE keys.
 */
export class QuotaEnforcer {
  /** Usage snapshots keyed by organizationId. */
  private readonly usage = new Map<string, QuotaUsage & { windowStartMs: number }>();

  private getOrCreate(organizationId: string, now: number) {
    const existing = this.usage.get(organizationId);
    const DAY_MS = 86_400_000;

    if (!existing || now - existing.windowStartMs >= DAY_MS) {
      const fresh: QuotaUsage & { windowStartMs: number } = {
        organizationId,
        windowStartsAt: new Date(now).toISOString(),
        windowStartMs: now,
        analysesUsed: 0,
        importsUsed: 0,
        concurrentAnalyses: 0,
        evidenceSyncsUsed: 0,
        exportBytesUsed: 0,
      };
      this.usage.set(organizationId, fresh);
      return fresh;
    }
    return existing;
  }

  /**
   * Assert that starting a new analysis is within quota.
   * Call BEFORE launching the analysis and then `recordAnalysisStarted()`.
   */
  assertCanStartAnalysis(organizationId: string, plan: QuotaPlan, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    if (u.analysesUsed >= plan.maxAnalysesPerDay) {
      throw new QuotaExceededError(
        "analyses_per_day",
        `Analysis quota exceeded: ${u.analysesUsed}/${plan.maxAnalysesPerDay} used today.`
      );
    }
    if (u.concurrentAnalyses >= plan.maxConcurrentAnalyses) {
      throw new QuotaExceededError(
        "concurrent_analyses",
        `Concurrent analysis limit reached: ${u.concurrentAnalyses}/${plan.maxConcurrentAnalyses}.`
      );
    }
  }

  recordAnalysisStarted(organizationId: string, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    u.analysesUsed += 1;
    u.concurrentAnalyses += 1;
  }

  recordAnalysisFinished(organizationId: string, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    u.concurrentAnalyses = Math.max(0, u.concurrentAnalyses - 1);
  }

  assertCanImport(organizationId: string, plan: QuotaPlan, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    if (u.importsUsed >= plan.maxImportsPerDay) {
      throw new QuotaExceededError(
        "imports_per_day",
        `Import quota exceeded: ${u.importsUsed}/${plan.maxImportsPerDay} used today.`
      );
    }
  }

  recordImport(organizationId: string, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    u.importsUsed += 1;
  }

  assertCanSyncEvidence(organizationId: string, plan: QuotaPlan, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    if (u.evidenceSyncsUsed >= plan.maxEvidenceSyncsPerHour) {
      throw new QuotaExceededError(
        "evidence_syncs_per_hour",
        `Evidence sync quota exceeded: ${u.evidenceSyncsUsed}/${plan.maxEvidenceSyncsPerHour} used this hour.`
      );
    }
  }

  recordEvidenceSync(organizationId: string, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    u.evidenceSyncsUsed += 1;
  }

  assertCanExport(organizationId: string, plan: QuotaPlan, exportBytes: number, now = Date.now()): void {
    if (plan.maxExportBytesPerDay === 0) return; // unlimited
    const u = this.getOrCreate(organizationId, now);
    if (u.exportBytesUsed + exportBytes > plan.maxExportBytesPerDay) {
      throw new QuotaExceededError(
        "export_bytes_per_day",
        `Export quota exceeded: ${u.exportBytesUsed}/${plan.maxExportBytesPerDay} bytes used today.`
      );
    }
  }

  recordExport(organizationId: string, exportBytes: number, now = Date.now()): void {
    const u = this.getOrCreate(organizationId, now);
    u.exportBytesUsed += exportBytes;
  }

  getUsage(organizationId: string, now = Date.now()): QuotaUsage {
    const u = this.getOrCreate(organizationId, now);
    return {
      organizationId: u.organizationId,
      windowStartsAt: u.windowStartsAt,
      analysesUsed: u.analysesUsed,
      importsUsed: u.importsUsed,
      concurrentAnalyses: u.concurrentAnalyses,
      evidenceSyncsUsed: u.evidenceSyncsUsed,
      exportBytesUsed: u.exportBytesUsed,
    };
  }

  /** Reset all usage — useful in tests. */
  resetAll(): void {
    this.usage.clear();
  }
}

// ---------------------------------------------------------------------------
// Default quota plans
// ---------------------------------------------------------------------------

export const DEFAULT_PLANS: Record<string, QuotaPlan> = {
  free: {
    planId: "plan_free",
    name: "Free",
    maxAnalysesPerDay: 10,
    maxImportsPerDay: 20,
    maxConcurrentAnalyses: 2,
    maxEvidenceSyncsPerHour: 2,
    maxExportBytesPerDay: 10 * 1024 * 1024, // 10 MB
  },
  pro: {
    planId: "plan_pro",
    name: "Pro",
    maxAnalysesPerDay: 200,
    maxImportsPerDay: 500,
    maxConcurrentAnalyses: 10,
    maxEvidenceSyncsPerHour: 20,
    maxExportBytesPerDay: 500 * 1024 * 1024, // 500 MB
  },
  enterprise: {
    planId: "plan_enterprise",
    name: "Enterprise",
    maxAnalysesPerDay: 5000,
    maxImportsPerDay: 10000,
    maxConcurrentAnalyses: 100,
    maxEvidenceSyncsPerHour: 100,
    maxExportBytesPerDay: 0, // unlimited
  },
};
