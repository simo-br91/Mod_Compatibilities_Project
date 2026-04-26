/**
 * Phase 10 — Model version registry, deployment, rollback, and feedback signal aggregation.
 *
 * Covers:
 *  - ModelVersionService: register shadow versions, promote to active, roll back
 *  - Model evaluation records (offline metrics per version per dataset)
 *  - FeedbackAggregator: compute signal quality report from recommendation feedback/outcomes
 */

import { randomUUID } from "node:crypto";

import type {
  FeedbackSignalReport,
  ModelEvaluationRecord,
  ModelRegistryEntry
} from "@modcompat/domain-models";
import { now, stableHash } from "./helpers.js";
import { InMemoryPlatformRepository } from "./repository.js";

// ---------------------------------------------------------------------------
// ModelVersionService
// ---------------------------------------------------------------------------

export interface RegisterModelVersionInput {
  modelKey: string;
  version: string;
  task: ModelRegistryEntry["task"];
  metrics: Record<string, number>;
  config?: Record<string, unknown>;
}

export interface RecordEvaluationInput {
  modelId: string;
  datasetId: string;
  metrics: ModelEvaluationRecord["metrics"];
  sampleCount: number;
}

export class ModelNotFoundError extends Error {
  readonly code = "model_not_found" as const;
  constructor(identifier: string) {
    super(`Model not found: ${identifier}`);
    this.name = "ModelNotFoundError";
  }
}

export class ModelVersionConflictError extends Error {
  readonly code = "model_version_conflict" as const;
  constructor(modelKey: string, version: string, task: ModelRegistryEntry["task"]) {
    super(`Model version already exists for ${modelKey}@${version} (${task})`);
    this.name = "ModelVersionConflictError";
  }
}

export class ModelVersionService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  /**
   * Register a new model version with status "shadow".
   * Shadow models are evaluated offline and never serve live traffic.
   */
  registerVersion(input: RegisterModelVersionInput): ModelRegistryEntry {
    const existing = [...this.repository.modelRegistry.values()].find(
      (entry) =>
        entry.modelKey === input.modelKey &&
        entry.version === input.version &&
        entry.task === input.task
    );
    if (existing) {
      const existingShape = stableHash({
        metrics: existing.metrics,
        config: existing.config
      });
      const incomingShape = stableHash({
        metrics: input.metrics,
        config: input.config ?? {}
      });

      if (existingShape !== incomingShape) {
        throw new ModelVersionConflictError(input.modelKey, input.version, input.task);
      }

      return existing;
    }

    const modelId = `mdl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const entry: ModelRegistryEntry = {
      schemaVersion: 1,
      modelId,
      modelKey: input.modelKey,
      version: input.version,
      task: input.task,
      status: "shadow",
      metrics: input.metrics,
      config: input.config ?? {},
      createdAt: now()
    };
    this.repository.modelRegistry.set(modelId, entry);
    return entry;
  }

  /**
   * Deploy a shadow model to "active".
   * The currently active model for the same task is moved to "rollback_ready".
   * Any previous "rollback_ready" model is demoted to "shadow".
   */
  deployVersion(modelId: string): ModelRegistryEntry {
    const target = this.requireModel(modelId);
    if (target.status === "active") {
      return target; // Already active — idempotent
    }

    const allEntries = [...this.repository.modelRegistry.values()];

    // Demote previous rollback_ready to shadow
    for (const entry of allEntries) {
      if (entry.task === target.task && entry.status === "rollback_ready") {
        this.repository.modelRegistry.set(entry.modelId, { ...entry, status: "shadow" });
      }
    }

    // Demote current active to rollback_ready
    for (const entry of allEntries) {
      if (entry.task === target.task && entry.status === "active" && entry.modelId !== modelId) {
        this.repository.modelRegistry.set(entry.modelId, { ...entry, status: "rollback_ready" });
      }
    }

    // Activate target
    const activated: ModelRegistryEntry = { ...target, status: "active" };
    this.repository.modelRegistry.set(modelId, activated);
    return activated;
  }

  /**
   * Roll back to the "rollback_ready" model for a given task.
   * The currently active model is demoted to "shadow".
   * Throws if there is no rollback_ready model available.
   */
  rollback(task: ModelRegistryEntry["task"]): ModelRegistryEntry {
    const allEntries = [...this.repository.modelRegistry.values()];
    const rollbackTarget = allEntries
      .filter((entry) => entry.task === task && entry.status === "rollback_ready")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!rollbackTarget) {
      throw new ModelNotFoundError(`No rollback_ready model for task "${task}"`);
    }

    // Keep the current active model ready for an immediate roll-forward.
    for (const entry of allEntries) {
      if (entry.task === task && entry.status === "active") {
        this.repository.modelRegistry.set(entry.modelId, {
          ...entry,
          status: "rollback_ready"
        });
      }
      if (
        entry.task === task &&
        entry.status === "rollback_ready" &&
        entry.modelId !== rollbackTarget.modelId
      ) {
        this.repository.modelRegistry.set(entry.modelId, { ...entry, status: "shadow" });
      }
    }

    // Promote rollback target
    const restored: ModelRegistryEntry = { ...rollbackTarget, status: "active" };
    this.repository.modelRegistry.set(rollbackTarget.modelId, restored);
    return restored;
  }

  /**
   * Record evaluation metrics for a model version on a specific dataset.
   */
  recordEvaluation(input: RecordEvaluationInput): ModelEvaluationRecord {
    this.requireModel(input.modelId); // Validate model exists

    const evaluation: ModelEvaluationRecord = {
      schemaVersion: 1,
      evaluationId: `eval_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      modelId: input.modelId,
      datasetId: input.datasetId,
      metrics: input.metrics,
      sampleCount: input.sampleCount,
      evaluatedAt: now()
    };

    const existing = this.repository.modelEvaluations.get(input.modelId) ?? [];
    existing.push(evaluation);
    this.repository.modelEvaluations.set(input.modelId, existing);
    return evaluation;
  }

  /** Get the currently active model for a task. */
  getActive(task: ModelRegistryEntry["task"]): ModelRegistryEntry | undefined {
    return [...this.repository.modelRegistry.values()].find(
      (e) => e.task === task && e.status === "active"
    );
  }

  /** List all model versions, optionally filtered by task. */
  listVersions(task?: ModelRegistryEntry["task"]): ModelRegistryEntry[] {
    const all = [...this.repository.modelRegistry.values()];
    return task ? all.filter((e) => e.task === task) : all;
  }

  /** Get evaluation history for a model. */
  getEvaluations(modelId: string): ModelEvaluationRecord[] {
    return this.repository.modelEvaluations.get(modelId) ?? [];
  }

  private requireModel(modelId: string): ModelRegistryEntry {
    const entry = this.repository.modelRegistry.get(modelId);
    if (!entry) throw new ModelNotFoundError(modelId);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// FeedbackAggregator
// ---------------------------------------------------------------------------

export class FeedbackAggregator {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  /**
   * Compute a feedback signal report from all recommendation feedback and outcomes
   * in the repository. Optionally scoped to a set of analysisIds.
   */
  computeSignalReport(analysisIds?: string[]): FeedbackSignalReport {
    const allFeedback = [...this.repository.recommendationFeedback.values()];
    const allOutcomes = [...this.repository.recommendationOutcomes.values()];
    const allSets = [...this.repository.recommendationSets.values()];

    const scopedSetIds = analysisIds
      ? new Set(
          allSets
            .filter((s) => analysisIds.includes(s.analysisId))
            .map((s) => s.recommendationSetId)
        )
      : undefined;

    const feedbackItems = scopedSetIds
      ? allFeedback.filter((f) => scopedSetIds.has(f.recommendationSetId))
      : allFeedback;

    const outcomes = scopedSetIds
      ? allOutcomes.filter((o) => scopedSetIds.has(o.recommendationSetId))
      : allOutcomes;

    const analysisCount = analysisIds
      ? new Set(
          allSets
            .filter((s) => analysisIds.includes(s.analysisId))
            .map((s) => s.analysisId)
        ).size
      : new Set(allSets.map((s) => s.analysisId)).size;

    // Overall acceptance rate
    const totalFeedback = feedbackItems.length;
    const acceptedCount = feedbackItems.filter((f) => f.feedbackType === "accepted").length;
    const dismissedCount = feedbackItems.filter((f) => f.feedbackType === "dismissed").length;
    const overallAcceptanceRate =
      totalFeedback > 0 ? acceptedCount / totalFeedback : 0;

    // Validation rate
    const totalOutcomes = outcomes.length;
    const validatedOutcomes = outcomes.filter((o) => o.status === "validated").length;
    const overallValidationRate =
      totalOutcomes > 0 ? validatedOutcomes / totalOutcomes : 0;

    // Per-kind breakdown using recommendation sets to find recommendation kinds
    const acceptanceByKind: FeedbackSignalReport["acceptanceByKind"] = {};
    for (const feedback of feedbackItems) {
      // Find the recommendation to get its kind
      const set = this.repository.recommendationSets.get(feedback.recommendationSetId);
      const rec = set?.items.find((r) => r.recommendationId === feedback.recommendationId);
      const kind = rec?.kind ?? "unknown";

      const bucket = acceptanceByKind[kind] ?? { accepted: 0, dismissed: 0, rate: 0 };
      if (feedback.feedbackType === "accepted") bucket.accepted++;
      if (feedback.feedbackType === "dismissed") bucket.dismissed++;
      const total = bucket.accepted + bucket.dismissed;
      bucket.rate = total > 0 ? bucket.accepted / total : 0;
      acceptanceByKind[kind] = bucket;
    }

    // Confidence accuracy: compare calibrated scores vs actual outcomes
    let confidenceAccuracy: number | undefined;
    const calibratedByFinding = new Map<string, number>();
    for (const scores of this.repository.calibratedFindingScores.values()) {
      for (const s of scores) {
        calibratedByFinding.set(s.findingId, s.predictedRiskScore);
      }
    }
    if (calibratedByFinding.size > 0 && totalOutcomes > 0) {
      // Simple proxy: how often did high-risk findings get validated outcomes
      const highRiskThreshold = 0.6;
      let correctPredictions = 0;
      let total = 0;
      for (const outcome of outcomes) {
        const set = this.repository.recommendationSets.get(outcome.recommendationSetId);
        if (!set) continue;
        // If outcome is validated, the findings were real risks — check if calibrated scores agreed
        const analysis = this.repository.analyses.get(set.analysisId);
        if (!analysis) continue;
        for (const finding of analysis.findings) {
          const score = calibratedByFinding.get(finding.findingId) ?? 0;
          const predicted = score >= highRiskThreshold;
          const actual = outcome.status === "validated";
          if (predicted === actual) correctPredictions++;
          total++;
        }
      }
      confidenceAccuracy = total > 0 ? correctPredictions / total : undefined;
    }

    const reportId = `rpt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const report: FeedbackSignalReport = {
      reportId,
      generatedAt: now(),
      analysisCount,
      totalFeedbackItems: totalFeedback,
      totalOutcomes,
      overallAcceptanceRate,
      overallValidationRate,
      acceptanceByKind,
      confidenceAccuracy
    };

    this.repository.feedbackSignalReports.set(reportId, report);
    return report;
  }

  /** Retrieve a previously computed signal report. */
  getReport(reportId: string): FeedbackSignalReport | undefined {
    return this.repository.feedbackSignalReports.get(reportId);
  }
}
