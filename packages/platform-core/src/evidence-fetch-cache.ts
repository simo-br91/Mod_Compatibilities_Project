/**
 * Persistent source-fetch state for the offline evidence pipeline.
 *
 * Tracks URL → {contentHash, fetchedAt, extractionStatus} so repeat pipeline runs
 * skip re-processing documents whose content has not changed since the last run.
 *
 * The cache is intentionally kept outside evidence-sources.ts so it can be
 * serialized to/from disk by the pipeline runner without coupling the extraction
 * logic to the filesystem.
 *
 * Usage pattern (in the pipeline runner):
 *   const cache = EvidenceFetchCache.fromJSON(loadCacheFile());
 *   await platform.evidenceSources.ingestFromAllSources({ fetchCache: cache });
 *   saveCacheFile(cache.toJSON());
 */

export type FetchCacheExtractionStatus = "pending" | "success" | "skipped" | "failed";

export interface FetchCacheRecord {
  /** Stable hash of the raw content body — used to detect unchanged documents. */
  contentHash: string;
  /** ISO-8601 timestamp of the last fetch. */
  fetchedAt: string;
  /** Result of the extraction step for this document. */
  extractionStatus: FetchCacheExtractionStatus;
}

export class EvidenceFetchCache {
  private readonly cache = new Map<string, FetchCacheRecord>();
  private _hits = 0;

  /** True if url has ever been recorded (regardless of hash). */
  has(url: string): boolean {
    return this.cache.has(url);
  }

  /**
   * True if url was previously fetched AND the supplied hash matches the stored one.
   * A match means the document body has not changed — the caller should skip extraction.
   */
  isUnchanged(url: string, newContentHash: string): boolean {
    const record = this.cache.get(url);
    if (record && record.contentHash === newContentHash) {
      this._hits++;
      return true;
    }
    return false;
  }

  /**
   * Record a completed fetch.  Call this after fetching (and optionally extracting)
   * a document so future runs can skip unchanged content.
   */
  record(
    url: string,
    contentHash: string,
    status: FetchCacheExtractionStatus = "success"
  ): void {
    this.cache.set(url, {
      contentHash,
      fetchedAt: new Date().toISOString(),
      extractionStatus: status
    });
  }

  get(url: string): FetchCacheRecord | undefined {
    return this.cache.get(url);
  }

  /** Number of distinct URLs recorded in this session. */
  get size(): number {
    return this.cache.size;
  }

  /** Number of isUnchanged() calls that returned true (cache hits) in this session. */
  get hits(): number {
    return this._hits;
  }

  // -------------------------------------------------------------------------
  // Serialization (for disk persistence)
  // -------------------------------------------------------------------------

  toJSON(): Record<string, FetchCacheRecord> {
    return Object.fromEntries(this.cache);
  }

  static fromJSON(data: Record<string, FetchCacheRecord>): EvidenceFetchCache {
    const cache = new EvidenceFetchCache();
    for (const [url, record] of Object.entries(data)) {
      cache.cache.set(url, record);
    }
    return cache;
  }
}
