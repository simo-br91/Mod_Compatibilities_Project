import { readFileSync, writeFileSync } from "node:fs";
import type { InMemoryPlatformRepository } from "./repository.js";

/**
 * Tracks which mods have been inspected for JAR analysis.
 * - Persists inspection history to disk across runs (when persistencePath is provided)
 * - Skips versions released within the last 6 months (too new, still changing)
 * - Prevents re-inspecting already-successfully-analyzed versions
 */

export interface ModInspectionRecord {
  versionId: string;
  projectId: string;
  lastInspectedAt: string;
  inspectionCount: number;
  inspectionStatus: "success" | "failed" | "skipped";
  lastErrorMessage?: string;
}

export interface InspectionCandidate {
  versionId: string;
  projectId: string;
  versionLabel: string;
  primaryFileDownloadUrl?: string;
}

export interface InspectionCandidates {
  candidates: InspectionCandidate[];
  skippedAlready: number;
  skippedTooNew: number;
  skippedNoDownload: number;
}

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

export class ModInspectionTracker {
  private inspectionHistory: Map<string, ModInspectionRecord>;
  private readonly persistencePath: string | null;

  constructor(
    private readonly repository: InMemoryPlatformRepository,
    options?: { persistencePath?: string }
  ) {
    this.persistencePath = options?.persistencePath ?? null;
    this.inspectionHistory = new Map();
    if (this.persistencePath) {
      this.loadHistory();
    }
  }

  private loadHistory(): void {
    if (!this.persistencePath) return;
    try {
      const raw = readFileSync(this.persistencePath, "utf8");
      const records = JSON.parse(raw) as ModInspectionRecord[];
      for (const record of records) {
        this.inspectionHistory.set(record.versionId, record);
      }
    } catch {
      // File doesn't exist yet or is corrupt — start fresh
    }
  }

  private saveHistory(): void {
    if (!this.persistencePath) return;
    try {
      const records = [...this.inspectionHistory.values()];
      writeFileSync(this.persistencePath, JSON.stringify(records, null, 2), "utf8");
    } catch {
      // Persistence failure is non-fatal — in-memory state is still correct
    }
  }

  importRecords(records: ModInspectionRecord[]): void {
    for (const record of records) {
      this.inspectionHistory.set(record.versionId, record);
    }
    this.saveHistory();
  }

  getAllRecords(): ModInspectionRecord[] {
    return [...this.inspectionHistory.values()];
  }

  /**
   * Record that a mod version was inspected and persist to disk.
   */
  recordInspection(
    versionId: string,
    projectId: string,
    status: "success" | "failed" | "skipped",
    errorMessage?: string
  ): void {
    const existing = this.inspectionHistory.get(versionId);
    const record: ModInspectionRecord = {
      versionId,
      projectId,
      lastInspectedAt: new Date().toISOString(),
      inspectionCount: (existing?.inspectionCount ?? 0) + 1,
      inspectionStatus: status,
      lastErrorMessage: errorMessage
    };
    this.inspectionHistory.set(versionId, record);
    this.saveHistory();
  }

  /**
   * Get inspection history for a version
   */
  getInspectionRecord(versionId: string): ModInspectionRecord | undefined {
    return this.inspectionHistory.get(versionId);
  }

  /**
   * Check if a version has been successfully inspected before
   */
  isAlreadyInspected(versionId: string): boolean {
    const record = this.inspectionHistory.get(versionId);
    return record !== undefined && record.inspectionStatus === "success";
  }

  /**
   * Return versions that are candidates for JAR inspection:
   * - Not already successfully inspected (checked against persisted history)
   * - Released at least 6 months ago (stable, unlikely to have breaking updates soon)
   * - Have a download URL available
   *
   * Versions without a releaseDate are included conservatively (cannot determine age).
   */
  getCandidatesForInspection(): InspectionCandidates {
    const candidates: InspectionCandidate[] = [];
    let skippedAlready = 0;
    let skippedTooNew = 0;
    let skippedNoDownload = 0;

    const now = Date.now();

    for (const version of this.repository.canonicalVersions.values()) {
      if (this.isAlreadyInspected(version.versionId)) {
        skippedAlready++;
        continue;
      }

      if (version.releaseDate) {
        const age = now - new Date(version.releaseDate).getTime();
        if (age < SIX_MONTHS_MS) {
          skippedTooNew++;
          continue;
        }
      }

      if (!version.primaryFileDownloadUrl) {
        skippedNoDownload++;
        continue;
      }

      candidates.push({
        versionId: version.versionId,
        projectId: version.projectId,
        versionLabel: version.versionLabel,
        primaryFileDownloadUrl: version.primaryFileDownloadUrl
      });
    }

    return {
      candidates,
      skippedAlready,
      skippedTooNew,
      skippedNoDownload
    };
  }

  /**
   * Get summary of inspection status
   */
  getSummary(): {
    totalInspected: number;
    totalSuccessful: number;
    totalFailed: number;
    totalSkipped: number;
  } {
    let totalSuccessful = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (const record of this.inspectionHistory.values()) {
      if (record.inspectionStatus === "success") totalSuccessful++;
      else if (record.inspectionStatus === "failed") totalFailed++;
      else if (record.inspectionStatus === "skipped") totalSkipped++;
    }

    return {
      totalInspected: this.inspectionHistory.size,
      totalSuccessful,
      totalFailed,
      totalSkipped
    };
  }
}
