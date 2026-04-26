import { createPlatformId } from "@modcompat/id-generation";
import type {
  AnalysisEnvironment,
  AnalysisVerdict,
  ConfidenceSummary,
  ExactPackAnalysisCacheRecord,
  FragmentCompatibilityRecord,
  GroundTruthExactPackRecord,
  GroundTruthVerdict,
  KnowledgeSnapshot,
  PairwiseCompatibilityRecord,
  PromotedCompatibilityClaim,
  SupportedCoverageScope,
  TechnicalConflictSignature
} from "@modcompat/domain-models";
import type { AnalysisReport, AnalysisSummary, Finding } from "@modcompat/api-contracts";

import { now, stableHash } from "./helpers.js";
import { InMemoryPlatformRepository } from "./repository.js";
import type { AnalysisResult } from "./types.js";

function toConfidenceBand(score: number): ConfidenceSummary["band"] {
  if (score >= 0.95) {
    return "very_high";
  }
  if (score >= 0.8) {
    return "high";
  }
  if (score >= 0.6) {
    return "medium";
  }
  if (score >= 0.35) {
    return "low";
  }
  return "very_low";
}

function deriveSeverity(verdict: PromotedCompatibilityClaim["findingVerdict"]): Finding["severity"] {
  switch (verdict) {
    case "confirmed_conflict":
    case "confirmed_environment_mismatch":
      return "critical";
    case "confirmed_requirement_gap":
    case "reported_conflict":
    case "inferred_technical_risk":
      return "high";
    case "reported_fixed_in_later_version":
      return "medium";
    default:
      return "low";
  }
}

function isSettledGroundTruth(record: GroundTruthExactPackRecord) {
  return record.verdict !== "inconclusive" && record.verdict !== "timed_out";
}

function sideMatches(recordSide: string | undefined, requestedSide: string | undefined) {
  return !recordSide || !requestedSide || recordSide === "both" || requestedSide === "both" || recordSide === requestedSide;
}

function environmentsMatch(left: AnalysisEnvironment, right: AnalysisEnvironment) {
  return (
    left.minecraftVersion === right.minecraftVersion &&
    left.loader === right.loader &&
    (!left.loaderVersion || !right.loaderVersion || left.loaderVersion === right.loaderVersion) &&
    left.javaVersion === right.javaVersion &&
    sideMatches(left.side, right.side)
  );
}

function groundTruthVerdictToAnalysisVerdict(verdict: GroundTruthVerdict): AnalysisVerdict {
  return verdict === "passed_startup_and_world" ? "no_known_issue_found" : "known_incompatible";
}

function groundTruthScopeNote(verdict: GroundTruthVerdict) {
  return verdict === "passed_startup_and_world"
    ? "Did not crash on startup or world load (crash-detection only, not a full compatibility guarantee)."
    : "Crashed on startup or world load.";
}

export class SnapshotAnalysisService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  getActiveSnapshot(): KnowledgeSnapshot | undefined {
    return [...this.repository.knowledgeSnapshots.values()]
      .filter((snapshot) => snapshot.status === "promoted")
      .sort((left, right) => {
        const leftTimestamp = left.activatedAt ?? left.createdAt;
        const rightTimestamp = right.activatedAt ?? right.createdAt;
        return rightTimestamp.localeCompare(leftTimestamp);
      })[0];
  }

  getCoverageScopeForSnapshot(snapshot: KnowledgeSnapshot): SupportedCoverageScope | undefined {
    if (!snapshot.coverageScopeId) {
      return undefined;
    }

    return this.repository.coverageScopes.get(snapshot.coverageScopeId);
  }

  findExactPackCache(
    packFingerprint: string,
    snapshot = this.getActiveSnapshot()
  ): ExactPackAnalysisCacheRecord | undefined {
    if (!snapshot) {
      return undefined;
    }

    const cacheIds = this.repository.exactPackAnalysisCacheBySnapshot.get(snapshot.snapshotId) ?? [];
    for (const cacheId of cacheIds) {
      const cache = this.repository.exactPackAnalysisCache.get(cacheId);
      if (cache?.packFingerprint === packFingerprint) {
        return cache;
      }
    }

    return undefined;
  }

  findEmpiricalExactPackRecord(
    packFingerprint: string,
    environment: AnalysisEnvironment
  ): GroundTruthExactPackRecord | undefined {
    return [...this.repository.groundTruthExactPackRecords.values()]
      .filter((record) =>
        record.packFingerprint === packFingerprint &&
        isSettledGroundTruth(record) &&
        environmentsMatch(record.environment, environment)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  createAnalysisFromExactPackCache(input: {
    projectId: string;
    workspaceId: string;
    organizationId: string;
    packSnapshotId: string;
    packFingerprint: string;
    environment: AnalysisEnvironment;
  }): AnalysisResult | undefined {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return undefined;
    }

    const empiricalRecord = this.findEmpiricalExactPackRecord(
      input.packFingerprint,
      input.environment
    );
    if (empiricalRecord) {
      return this.createAnalysisFromEmpiricalExactPackRecord(input, snapshot, empiricalRecord);
    }

    const exactPackCache = this.findExactPackCache(input.packFingerprint, snapshot);
    if (!exactPackCache) {
      return undefined;
    }

    const coverageScope = this.getCoverageScopeForSnapshot(snapshot);
    const packSnapshot = this.repository.snapshots.get(input.packSnapshotId);
    const matchingClaims = packSnapshot
      ? this.findMatchingClaimsForSnapshot(snapshot.snapshotId, packSnapshot)
      : [];
    const findings = matchingClaims.map((claim) => this.materializeFinding(claim, snapshot.version));
    const recommendationItems = this.buildRecommendationsForPack(packSnapshot?.packSnapshotId);

    const analysis: AnalysisSummary = {
      analysisId: createPlatformId("ana"),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      packSnapshotId: input.packSnapshotId,
      status: "completed",
      trigger: "manual",
      analysisMode: "fast",
      verdict: exactPackCache.verdict,
      confidence: exactPackCache.confidence,
      coverageStatus: exactPackCache.coverageStatus,
      servingMode: "snapshot_exact_pack",
      knowledgeSnapshotVersion: snapshot.version,
      explanation: exactPackCache.explanation,
      counts: {
        critical: findings.filter((finding) => finding.severity === "critical").length,
        high: findings.filter((finding) => finding.severity === "high").length,
        medium: findings.filter((finding) => finding.severity === "medium").length,
        low: findings.filter((finding) => finding.severity === "low").length,
        info: findings.filter((finding) => finding.severity === "info").length
      },
      score: Math.max(
        0,
        100 - findings.filter((finding) => finding.severity === "critical").length * 35 -
          findings.filter((finding) => finding.severity === "high").length * 20 -
          findings.filter((finding) => finding.severity === "medium").length * 10
      ),
      createdAt: now(),
      startedAt: now(),
      finishedAt: now()
    };

    const report: AnalysisReport = {
      reportId: `report-${analysis.analysisId}`,
      analysis,
      knowledgeSnapshot: snapshot,
      exactPackCacheHit: exactPackCache,
      supportingClaims: matchingClaims,
      coverageScope,
      findings,
      recommendations: recommendationItems,
      decisionSummary: {
        minimalUnblockSummary:
          exactPackCache.verdict === "known_incompatible"
            ? "The pack matches a known incompatible combination in the promoted knowledge snapshot."
            : "The promoted knowledge snapshot did not identify a hard incompatibility.",
        stabilityFirstSummary: exactPackCache.explanation
      },
      feedback: []
    };

    const result: AnalysisResult = {
      analysis,
      phases: [],
      events: [],
      findings,
      recommendations: recommendationItems,
      report
    };

    this.repository.analyses.set(analysis.analysisId, {
      summary: analysis,
      phases: [],
      events: [],
      findings,
      recommendations: recommendationItems,
      recommendationSet: undefined,
      featureDataset: undefined,
      featureVectors: [],
      calibratedScores: [],
      reviewSummary: undefined,
      simulationRun: undefined,
      releaseGateDecision: undefined,
      statusCheck: undefined,
      artifacts: [],
      graph: undefined,
      explanationPaths: new Map(),
      packDiff: undefined,
      report
    });
    this.repository.reports.set(analysis.analysisId, report);

    return result;
  }

  private createAnalysisFromEmpiricalExactPackRecord(
    input: {
      projectId: string;
      workspaceId: string;
      organizationId: string;
      packSnapshotId: string;
      packFingerprint: string;
      environment: AnalysisEnvironment;
    },
    snapshot: KnowledgeSnapshot,
    record: GroundTruthExactPackRecord
  ): AnalysisResult {
    const coverageScope = this.getCoverageScopeForSnapshot(snapshot);
    const packSnapshot = this.repository.snapshots.get(input.packSnapshotId);
    const verdict = groundTruthVerdictToAnalysisVerdict(record.verdict);
    const findings = record.verdict === "passed_startup_and_world" || !packSnapshot
      ? []
      : [this.materializeGroundTruthFinding(record, packSnapshot, snapshot.version)];
    const recommendationItems = this.buildRecommendationsForPack(packSnapshot?.packSnapshotId);
    const explanation = `Served from empirical ground-truth run ${record.latestRunId}. ${groundTruthScopeNote(record.verdict)}`;

    const analysis: AnalysisSummary = {
      analysisId: createPlatformId("ana"),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      packSnapshotId: input.packSnapshotId,
      status: "completed",
      trigger: "manual",
      analysisMode: "fast",
      verdict,
      confidence: {
        ...record.confidence,
        explanation
      },
      coverageStatus: "high_confidence_coverage",
      servingMode: "snapshot_exact_pack",
      knowledgeSnapshotVersion: snapshot.version,
      explanation,
      counts: {
        critical: findings.filter((finding) => finding.severity === "critical").length,
        high: findings.filter((finding) => finding.severity === "high").length,
        medium: findings.filter((finding) => finding.severity === "medium").length,
        low: findings.filter((finding) => finding.severity === "low").length,
        info: findings.filter((finding) => finding.severity === "info").length
      },
      score: verdict === "known_incompatible" ? 0 : 100,
      createdAt: now(),
      startedAt: now(),
      finishedAt: now()
    };

    const report: AnalysisReport = {
      reportId: `report-${analysis.analysisId}`,
      analysis,
      knowledgeSnapshot: snapshot,
      coverageScope,
      findings,
      recommendations: recommendationItems,
      decisionSummary: {
        minimalUnblockSummary:
          verdict === "known_incompatible"
            ? "Empirical ground-truth execution observed a startup/world-load failure."
            : "Empirical ground-truth execution reached startup and world load.",
        stabilityFirstSummary: explanation
      },
      feedback: []
    };

    const result: AnalysisResult = {
      analysis,
      phases: [],
      events: [],
      findings,
      recommendations: recommendationItems,
      report
    };

    this.repository.analyses.set(analysis.analysisId, {
      summary: analysis,
      phases: [],
      events: [],
      findings,
      recommendations: recommendationItems,
      recommendationSet: undefined,
      featureDataset: undefined,
      featureVectors: [],
      calibratedScores: [],
      reviewSummary: undefined,
      simulationRun: undefined,
      releaseGateDecision: undefined,
      statusCheck: undefined,
      artifacts: [],
      graph: undefined,
      explanationPaths: new Map(),
      packDiff: undefined,
      report
    });
    this.repository.reports.set(analysis.analysisId, report);

    return result;
  }

  private buildRecommendationsForPack(packSnapshotId?: string) {
    if (!packSnapshotId) {
      return [];
    }

    const snapshot = this.repository.snapshots.get(packSnapshotId);
    if (!snapshot) {
      return [];
    }

    const recommendations: AnalysisResult["recommendations"] = [];
    for (const mod of snapshot.mods) {
      const project = mod.canonicalProjectId
        ? this.repository.canonicalProjects.get(mod.canonicalProjectId)
        : undefined;
      if (!project?.recommendedReplacementProjectIds?.length) {
        continue;
      }

      recommendations.push({
        recommendationId: createPlatformId("rec"),
        kind: "remediation_plan",
        rank: recommendations.length + 1,
        confidence: 0.82,
        summary: `Review ${project.displayName} in this pack`,
        rationale:
          `${project.displayName} is associated with known compatibility risks in the promoted snapshot. ` +
          `Preferred alternatives include ${project.recommendedReplacementProjectIds
            .map(
              (replacementId) =>
                this.repository.canonicalProjects.get(replacementId)?.displayName ?? replacementId
            )
            .join(", ")}.`,
        status: "proposed",
        candidateProjects: project.recommendedReplacementProjectIds.map((replacementId) => ({
          projectId: replacementId,
          relation: "alternative"
        })),
        migrationCost: "medium",
        expectedCompatibilityGain: 0.75,
        steps: [
          {
            stepId: createPlatformId("stp"),
            action: "verify_pack",
            summary: `Replace or remove ${project.displayName} and re-check the pack against the latest snapshot.`
          }
        ]
      });
    }

    return recommendations;
  }

  private findMatchingClaimsForSnapshot(snapshotId: string, packSnapshot: NonNullable<ReturnType<typeof this.repository.snapshots.get>>) {
    const claimIds = this.repository.promotedCompatibilityClaimsBySnapshot.get(snapshotId) ?? [];
    const projectIds = new Set(
      packSnapshot.mods
        .map((mod) => mod.canonicalProjectId)
        .filter((value): value is string => Boolean(value))
    );
    const versionIds = new Set(
      packSnapshot.mods
        .map((mod) => mod.canonicalVersionId)
        .filter((value): value is string => Boolean(value))
    );

    return claimIds
      .map((claimId) => this.repository.promotedCompatibilityClaims.get(claimId))
      .filter((claim): claim is PromotedCompatibilityClaim => Boolean(claim))
      .filter((claim) => {
        const subjectProjectMatch =
          claim.subjectProjectIds.length === 0 ||
          claim.subjectProjectIds.every((projectId) => projectIds.has(projectId));
        const subjectVersionMatch =
          claim.subjectVersionIds.length === 0 ||
          claim.subjectVersionIds.every((versionId) => versionIds.has(versionId));

        return subjectProjectMatch && subjectVersionMatch;
      });
  }

  // -----------------------------------------------------------------------
  // Retrieval-assembly path helpers
  // -----------------------------------------------------------------------

  private deriveCoverageStatus(
    packProjectIds: string[],
    packEnvironment: AnalysisEnvironment,
    coverageScope: SupportedCoverageScope | undefined
  ): "high_confidence_coverage" | "best_effort_coverage" | "outside_validated_coverage" {
    if (!coverageScope) {
      return "outside_validated_coverage";
    }

    const envOk =
      coverageScope.supportedMinecraftVersions.includes(packEnvironment.minecraftVersion) &&
      coverageScope.supportedLoaders.includes(packEnvironment.loader);

    if (!envOk) {
      return "outside_validated_coverage";
    }

    const supported = new Set(coverageScope.supportedProjectIds);
    const uncovered = packProjectIds.filter((id) => !supported.has(id));

    if (uncovered.length === 0) {
      return "high_confidence_coverage";
    }
    if (uncovered.length < packProjectIds.length) {
      return "best_effort_coverage";
    }
    return "outside_validated_coverage";
  }

  private findMatchingPairwiseRecords(
    snapshotId: string,
    packProjectIds: Set<string>,
    environment: AnalysisEnvironment
  ): PairwiseCompatibilityRecord[] {
    const ids = this.repository.pairwiseCompatibilityBySnapshot.get(snapshotId) ?? [];
    const records = ids
      .map((id) => this.repository.pairwiseCompatibilityRecords.get(id))
      .filter((r): r is PairwiseCompatibilityRecord => Boolean(r))
      .filter((r) => packProjectIds.has(r.leftProjectId) && packProjectIds.has(r.rightProjectId));

    return this.overlayGroundTruthOnPairwiseRecords(snapshotId, packProjectIds, environment, records);
  }

  private overlayGroundTruthOnPairwiseRecords(
    snapshotId: string,
    packProjectIds: Set<string>,
    environment: AnalysisEnvironment,
    records: PairwiseCompatibilityRecord[]
  ): PairwiseCompatibilityRecord[] {
    const byPair = new Map(
      records.map((record) => [
        [record.leftProjectId, record.rightProjectId].sort().join("|"),
        record
      ])
    );

    for (const outcome of this.findEmpiricalPairOutcomes(packProjectIds, environment)) {
      const key = outcome.projectIds.join("|");
      const existing = byPair.get(key);
      byPair.set(
        key,
        this.applyEmpiricalPairOutcome(snapshotId, outcome, existing)
      );
    }

    return [...byPair.values()];
  }

  private findEmpiricalPairOutcomes(
    packProjectIds: Set<string>,
    environment: AnalysisEnvironment
  ): Array<{ projectIds: [string, string]; record: GroundTruthExactPackRecord }> {
    const outcomes = new Map<string, { projectIds: [string, string]; record: GroundTruthExactPackRecord }>();

    for (const record of this.repository.groundTruthExactPackRecords.values()) {
      if (!isSettledGroundTruth(record) || !environmentsMatch(record.environment, environment)) {
        continue;
      }

      const snapshot = this.repository.snapshots.get(record.packSnapshotId);
      if (!snapshot) {
        continue;
      }

      const projectIds = snapshot.mods
        .map((mod) => mod.canonicalProjectId)
        .filter((id): id is string => Boolean(id));
      if (projectIds.length !== 2 || projectIds.some((id) => !packProjectIds.has(id))) {
        continue;
      }

      const pair = [...projectIds].sort() as [string, string];
      const key = pair.join("|");
      const existing = outcomes.get(key);
      if (!existing || record.updatedAt.localeCompare(existing.record.updatedAt) > 0) {
        outcomes.set(key, { projectIds: pair, record });
      }
    }

    return [...outcomes.values()];
  }

  private applyEmpiricalPairOutcome(
    snapshotId: string,
    outcome: { projectIds: [string, string]; record: GroundTruthExactPackRecord },
    existing?: PairwiseCompatibilityRecord
  ): PairwiseCompatibilityRecord {
    const [leftProjectId, rightProjectId] = outcome.projectIds;
    const verdict = groundTruthVerdictToAnalysisVerdict(outcome.record.verdict);
    const explanation = `Ground-truth execution (${outcome.record.verdict}). ${groundTruthScopeNote(outcome.record.verdict)}`;

    return {
      pairwiseCompatibilityId:
        existing?.pairwiseCompatibilityId ??
        `pwr_gt_overlay_${stableHash({
          snapshotId,
          leftProjectId,
          rightProjectId,
          latestRunId: outcome.record.latestRunId
        }).slice(0, 16)}`,
      snapshotId,
      leftProjectId: existing?.leftProjectId ?? leftProjectId,
      leftVersionId: existing?.leftVersionId,
      rightProjectId: existing?.rightProjectId ?? rightProjectId,
      rightVersionId: existing?.rightVersionId,
      environment: outcome.record.environment,
      verdict,
      confidence: {
        score: outcome.record.confidence.score,
        band: outcome.record.confidence.band,
        explanation,
        primaryDrivers: [
          `Ground-truth verdict: ${outcome.record.verdict}`,
          `Run ID: ${outcome.record.latestRunId}`,
          groundTruthScopeNote(outcome.record.verdict)
        ]
      },
      claimIds: existing?.claimIds ?? [],
      recommendationIds: existing?.recommendationIds,
      schemaVersion: existing?.schemaVersion ?? 1,
      createdAt: existing?.createdAt ?? outcome.record.updatedAt
    };
  }

  private findMatchingFragmentRecords(
    snapshotId: string,
    packProjectIds: Set<string>
  ): FragmentCompatibilityRecord[] {
    const ids = this.repository.fragmentCompatibilityBySnapshot.get(snapshotId) ?? [];
    return ids
      .map((id) => this.repository.fragmentCompatibilityRecords.get(id))
      .filter((r): r is FragmentCompatibilityRecord => Boolean(r))
      .filter((r) => r.projectIds.length > 0 && r.projectIds.every((id) => packProjectIds.has(id)));
  }

  private findRelevantSignatures(
    snapshotId: string,
    packProjectIds: Set<string>
  ): TechnicalConflictSignature[] {
    const ids = this.repository.technicalConflictSignaturesBySnapshot.get(snapshotId) ?? [];
    return ids
      .map((id) => this.repository.technicalConflictSignatures.get(id))
      .filter((s): s is TechnicalConflictSignature => Boolean(s))
      .filter((s) => s.projectIds.length > 0 && s.projectIds.every((id) => packProjectIds.has(id)));
  }

  private materializePairwiseFinding(
    record: PairwiseCompatibilityRecord,
    snapshotVersion: string
  ): Finding | undefined {
    if (record.verdict === "no_known_issue_found" || record.verdict === "insufficient_evidence") {
      return undefined;
    }

    const left = this.repository.canonicalProjects.get(record.leftProjectId);
    const right = this.repository.canonicalProjects.get(record.rightProjectId);

    const severity: Finding["severity"] =
      record.verdict === "known_incompatible"
        ? "critical"
        : record.verdict === "likely_incompatible"
          ? "high"
          : "medium";

    const verdict: NonNullable<Finding["verdict"]> =
      record.verdict === "known_incompatible"
        ? "confirmed_conflict"
        : record.verdict === "likely_incompatible"
          ? "reported_conflict"
          : "inferred_technical_risk";

    return {
      findingId: createPlatformId("fnd"),
      type: "pairwise_incompatibility",
      severity,
      confidence: record.confidence.score,
      confidenceBand: record.confidence.band,
      verdict,
      reproducibility: "confirmed",
      title: `Pairwise ${record.verdict.replace(/_/g, " ")}: ${left?.displayName ?? record.leftProjectId} ↔ ${right?.displayName ?? record.rightProjectId}`,
      summary: `Pairwise compatibility record indicates ${record.verdict} between these mods.`,
      explanation: `Snapshot ${snapshotVersion} pairwise record: ${record.verdict} (confidence ${record.confidence.band}).`,
      knowledgeSnapshotVersion: snapshotVersion,
      evidence: [],
      subjects: [
        {
          projectId: record.leftProjectId,
          versionId: record.leftVersionId,
          relation: "primary" as const
        },
        {
          projectId: record.rightProjectId,
          versionId: record.rightVersionId,
          relation: "primary" as const
        }
      ],
      recommendedActions: [],
      provenance: [
        {
          kind: "evidence",
          sourceId: record.pairwiseCompatibilityId,
          sourceType: "pairwise_record"
        }
      ],
      confidenceInputs: [
        {
          source: "evidence" as const,
          value: record.confidence.score,
          weight: 1,
          rationale: "Pairwise compatibility record"
        }
      ]
    };
  }

  private materializeFragmentFinding(
    record: FragmentCompatibilityRecord,
    snapshotVersion: string
  ): Finding | undefined {
    if (record.verdict === "no_known_issue_found" || record.verdict === "insufficient_evidence") {
      return undefined;
    }

    const severity: Finding["severity"] =
      record.verdict === "known_incompatible"
        ? "critical"
        : record.verdict === "likely_incompatible"
          ? "high"
          : "medium";

    const verdict: NonNullable<Finding["verdict"]> =
      record.verdict === "known_incompatible" ? "confirmed_conflict" : "reported_conflict";

    return {
      findingId: createPlatformId("fnd"),
      type: "fragment_incompatibility",
      severity,
      confidence: record.confidence.score,
      confidenceBand: record.confidence.band,
      verdict,
      reproducibility: "confirmed",
      title: `Fragment compatibility issue in ${record.projectIds.length}-mod subset`,
      summary: `A known-conflicting mod subset is present in this pack.`,
      explanation: `Snapshot ${snapshotVersion} fragment record: ${record.verdict} for a ${record.projectIds.length}-mod subset.`,
      knowledgeSnapshotVersion: snapshotVersion,
      evidence: [],
      subjects: record.projectIds.map((id) => ({ projectId: id, relation: "primary" as const })),
      recommendedActions: [],
      provenance: [
        {
          kind: "evidence",
          sourceId: record.fragmentCompatibilityId,
          sourceType: "fragment_record"
        }
      ],
      confidenceInputs: [
        {
          source: "evidence" as const,
          value: record.confidence.score,
          weight: 1,
          rationale: "Fragment compatibility record"
        }
      ]
    };
  }

  private materializeSignatureFinding(
    sig: TechnicalConflictSignature,
    snapshotVersion: string
  ): Finding {
    const projectNames = sig.projectIds.map(
      (id) => this.repository.canonicalProjects.get(id)?.displayName ?? id
    );

    return {
      findingId: createPlatformId("fnd"),
      type: "technical_conflict_signature",
      severity: "high",
      confidence: sig.confidence.score,
      confidenceBand: sig.confidence.band,
      verdict: "inferred_technical_risk",
      reproducibility: "confirmed",
      title: `Technical ${sig.signatureType.replace(/_/g, " ")}: ${projectNames.join(" ↔ ")}`,
      summary: sig.targetRef
        ? `Both mods target ${sig.targetRef} with incompatible modifications.`
        : `Structural ${sig.signatureType} detected between mods.`,
      explanation: `${sig.confidence.explanation} (snapshot ${snapshotVersion})`,
      knowledgeSnapshotVersion: snapshotVersion,
      evidence: sig.evidenceRefs,
      subjects: sig.projectIds.map((id) => ({ projectId: id, relation: "primary" as const })),
      recommendedActions: [],
      provenance: [
        {
          kind: "static_analysis",
          sourceId: sig.technicalConflictSignatureId,
          sourceType: "technical_signature"
        }
      ],
      confidenceInputs: sig.confidence.primaryDrivers.map((driver) => ({
        source: "evidence" as const,
        value: sig.confidence.score,
        weight: 1,
        rationale: driver
      }))
    };
  }

  private materializeGroundTruthFinding(
    record: GroundTruthExactPackRecord,
    packSnapshot: NonNullable<ReturnType<typeof this.repository.snapshots.get>>,
    snapshotVersion: string
  ): Finding {
    const severity: Finding["severity"] =
      record.verdict === "failed_startup" || record.verdict === "failed_world_load"
        ? "critical"
        : "medium";
    const subjects = packSnapshot.mods
      .map((mod) => ({
        projectId: mod.canonicalProjectId ?? mod.name,
        versionId: mod.canonicalVersionId,
        relation: "primary" as const
      }));

    return {
      findingId: createPlatformId("fnd"),
      type: "ground_truth_execution",
      severity,
      confidence: record.confidence.score,
      confidenceBand: record.confidence.band,
      verdict: record.verdict === "failed_startup" || record.verdict === "failed_world_load"
        ? "confirmed_conflict"
        : "unknown",
      reproducibility: record.reproducibilityScore >= 1 ? "confirmed" : "likely",
      title: `Empirical result: ${record.verdict.replace(/_/g, " ")}`,
      summary: record.summary,
      explanation: `Ground-truth run ${record.latestRunId}: ${record.summary}`,
      knowledgeSnapshotVersion: snapshotVersion,
      evidence: [{ type: "ground_truth", id: record.groundTruthExactPackRecordId }],
      subjects,
      recommendedActions: [],
      provenance: [
        {
          kind: "ground_truth",
          sourceId: record.groundTruthExactPackRecordId,
          sourceType: "ground_truth_exact_pack_record"
        }
      ],
      confidenceInputs: record.confidence.primaryDrivers.map((driver) => ({
        source: "ground_truth" as const,
        value: record.confidence.score,
        weight: 1,
        rationale: driver
      }))
    };
  }

  private deriveAssemblyVerdictAndConfidence(
    claims: PromotedCompatibilityClaim[],
    pairwiseRecords: PairwiseCompatibilityRecord[],
    fragmentRecords: FragmentCompatibilityRecord[],
    conflictFindings: Finding[],
    coverageStatus: "high_confidence_coverage" | "best_effort_coverage" | "outside_validated_coverage"
  ): { verdict: AnalysisVerdict; confidence: ConfidenceSummary } {
    const allScores: number[] = [
      ...claims.map((c) => c.confidence.score),
      ...pairwiseRecords.map((r) => r.confidence.score),
      ...fragmentRecords.map((r) => r.confidence.score)
    ];

    const baseScore =
      allScores.length > 0
        ? allScores.reduce((a, b) => a + b, 0) / allScores.length
        : 0.5;

    const coverageFactor =
      coverageStatus === "high_confidence_coverage"
        ? 1.0
        : coverageStatus === "best_effort_coverage"
          ? 0.85
          : 0.65;

    const finalScore = Math.min(0.99, baseScore * coverageFactor);

    const criticalCount = conflictFindings.filter((f) => f.severity === "critical").length;
    const highCount = conflictFindings.filter((f) => f.severity === "high").length;
    const hasFriendlyPairwise = pairwiseRecords.some((r) => r.verdict === "no_known_issue_found");
    const hasFriendlyFragment = fragmentRecords.some((r) => r.verdict === "no_known_issue_found");

    let verdict: AnalysisVerdict;
    if (criticalCount > 0) {
      verdict = "known_incompatible";
    } else if (highCount > 0) {
      verdict =
        hasFriendlyPairwise || hasFriendlyFragment ? "mixed_or_conditional" : "likely_incompatible";
    } else if (conflictFindings.length > 0) {
      verdict = "mixed_or_conditional";
    } else if (allScores.length > 0) {
      verdict = "no_known_issue_found";
    } else {
      verdict = "insufficient_evidence";
    }

    const drivers: string[] = [];
    if (claims.length > 0) drivers.push(`${claims.length} promoted claim(s)`);
    if (pairwiseRecords.length > 0) drivers.push(`${pairwiseRecords.length} pairwise record(s)`);
    if (fragmentRecords.length > 0) drivers.push(`${fragmentRecords.length} fragment record(s)`);
    drivers.push(`Coverage: ${coverageStatus}`);

    return {
      verdict,
      confidence: {
        score: finalScore,
        band: toConfidenceBand(finalScore),
        explanation: `Assembled from snapshot knowledge: ${drivers.slice(0, -1).join(", ") || "coverage scope only"}. ${drivers[drivers.length - 1]}.`,
        primaryDrivers: drivers
      }
    };
  }

  createAnalysisFromRetrievalAssembly(input: {
    projectId: string;
    workspaceId: string;
    organizationId: string;
    packSnapshotId: string;
    packFingerprint: string;
    environment: AnalysisEnvironment;
  }): AnalysisResult | undefined {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return undefined;
    }

    const packSnapshot = this.repository.snapshots.get(input.packSnapshotId);
    if (!packSnapshot) {
      return undefined;
    }

    const packProjectIds = new Set(
      packSnapshot.mods
        .map((m) => m.canonicalProjectId)
        .filter((id): id is string => Boolean(id))
    );

    if (packProjectIds.size === 0) {
      return undefined;
    }

    const coverageScope = this.getCoverageScopeForSnapshot(snapshot);
    const coverageStatus = this.deriveCoverageStatus(
      [...packProjectIds],
      input.environment,
      coverageScope
    );

    const matchingClaims = this.findMatchingClaimsForSnapshot(snapshot.snapshotId, packSnapshot);
    const pairwiseRecords = this.findMatchingPairwiseRecords(
      snapshot.snapshotId,
      packProjectIds,
      input.environment
    );
    const fragmentRecords = this.findMatchingFragmentRecords(snapshot.snapshotId, packProjectIds);
    const empiricallyClearedPairKeys = new Set(
      pairwiseRecords
        .filter((record) =>
          record.verdict === "no_known_issue_found" &&
          record.confidence.primaryDrivers.some((driver) => driver.startsWith("Run ID:"))
        )
        .map((record) => [record.leftProjectId, record.rightProjectId].sort().join("|"))
    );
    const signatures = this.findRelevantSignatures(snapshot.snapshotId, packProjectIds)
      .filter((signature) => {
        if (signature.projectIds.length !== 2) {
          return true;
        }
        return !empiricallyClearedPairKeys.has([...signature.projectIds].sort().join("|"));
      });

    // Require at least some applicable knowledge before serving from snapshot
    const hasKnowledge =
      matchingClaims.length > 0 ||
      pairwiseRecords.length > 0 ||
      fragmentRecords.length > 0 ||
      coverageStatus === "high_confidence_coverage";
    if (!hasKnowledge) {
      return undefined;
    }

    // Signatures already referenced by claims don't need duplicate findings
    const coveredSignatureIds = new Set(
      matchingClaims.flatMap((c) =>
        c.evidenceRefs.filter((r) => r.type === "static_analysis").map((r) => r.id)
      )
    );

    const rawFindings: Finding[] = [
      ...matchingClaims.map((c) => this.materializeFinding(c, snapshot.version)),
      ...pairwiseRecords
        .map((r) => this.materializePairwiseFinding(r, snapshot.version))
        .filter((f): f is Finding => f !== undefined),
      ...fragmentRecords
        .map((r) => this.materializeFragmentFinding(r, snapshot.version))
        .filter((f): f is Finding => f !== undefined),
      ...signatures
        .filter((s) => !coveredSignatureIds.has(s.technicalConflictSignatureId))
        .map((s) => this.materializeSignatureFinding(s, snapshot.version))
    ];

    // Deduplicate by type + subject project IDs
    const seenKeys = new Set<string>();
    const findings = rawFindings.filter((f) => {
      const key = `${f.type}:${f.subjects.map((s) => s.projectId).sort().join(",")}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    const conflictFindings = findings.filter(
      (f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium"
    );

    const { verdict, confidence } = this.deriveAssemblyVerdictAndConfidence(
      matchingClaims,
      pairwiseRecords,
      fragmentRecords,
      conflictFindings,
      coverageStatus
    );

    const recommendationItems = this.buildRecommendationsForPack(input.packSnapshotId);

    const analysis: AnalysisSummary = {
      analysisId: createPlatformId("ana"),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      packSnapshotId: input.packSnapshotId,
      status: "completed",
      trigger: "manual",
      analysisMode: "fast",
      verdict,
      confidence,
      coverageStatus,
      servingMode: "snapshot_retrieval_assembly",
      knowledgeSnapshotVersion: snapshot.version,
      explanation: confidence.explanation,
      counts: {
        critical: findings.filter((f) => f.severity === "critical").length,
        high: findings.filter((f) => f.severity === "high").length,
        medium: findings.filter((f) => f.severity === "medium").length,
        low: findings.filter((f) => f.severity === "low").length,
        info: findings.filter((f) => f.severity === "info").length
      },
      score: Math.max(
        0,
        100 -
          findings.filter((f) => f.severity === "critical").length * 35 -
          findings.filter((f) => f.severity === "high").length * 20 -
          findings.filter((f) => f.severity === "medium").length * 10
      ),
      createdAt: now(),
      startedAt: now(),
      finishedAt: now()
    };

    const verdictSummary =
      verdict === "known_incompatible"
        ? `The pack contains a known incompatible combination (assembled from snapshot ${snapshot.version}).`
        : verdict === "likely_incompatible"
          ? `The pack likely contains incompatible mods (assembled from snapshot ${snapshot.version}).`
          : verdict === "mixed_or_conditional"
            ? `Mixed compatibility signals detected in the pack (assembled from snapshot ${snapshot.version}).`
            : `No known incompatibilities found in the snapshot knowledge base.`;

    const report: AnalysisReport = {
      reportId: `report-${analysis.analysisId}`,
      analysis,
      knowledgeSnapshot: snapshot,
      supportingClaims: matchingClaims,
      supportingPairwiseRecords: pairwiseRecords,
      supportingTechnicalSignatures: signatures,
      coverageScope,
      findings,
      recommendations: recommendationItems,
      decisionSummary: {
        minimalUnblockSummary: verdictSummary,
        stabilityFirstSummary: confidence.explanation
      },
      feedback: []
    };

    const result: AnalysisResult = {
      analysis,
      phases: [],
      events: [],
      findings,
      recommendations: recommendationItems,
      report
    };

    this.repository.analyses.set(analysis.analysisId, {
      summary: analysis,
      phases: [],
      events: [],
      findings,
      recommendations: recommendationItems,
      recommendationSet: undefined,
      featureDataset: undefined,
      featureVectors: [],
      calibratedScores: [],
      reviewSummary: undefined,
      simulationRun: undefined,
      releaseGateDecision: undefined,
      statusCheck: undefined,
      artifacts: [],
      graph: undefined,
      explanationPaths: new Map(),
      packDiff: undefined,
      report
    });
    this.repository.reports.set(analysis.analysisId, report);

    return result;
  }

  private materializeFinding(
    claim: PromotedCompatibilityClaim,
    snapshotVersion: string
  ): Finding {
    return {
      findingId: createPlatformId("fnd"),
      type: claim.findingType,
      severity: claim.severity ?? deriveSeverity(claim.findingVerdict),
      confidence: claim.confidence.score,
      confidenceBand: claim.confidence.band,
      verdict: claim.findingVerdict,
      reproducibility: "confirmed",
      title: claim.explanation,
      summary: claim.explanation,
      explanation: `${claim.explanation} This result was served from promoted knowledge snapshot ${snapshotVersion}.`,
      freshnessSummary: claim.freshnessSummary,
      knowledgeSnapshotVersion: snapshotVersion,
      evidence: claim.evidenceRefs,
      subjects: [
        ...claim.subjectProjectIds.map((projectId) => ({
          projectId,
          relation: "primary" as const
        })),
        ...claim.subjectVersionIds.map((versionId) => ({
          projectId:
            this.repository.canonicalVersions.get(versionId)?.projectId ?? "unknown_project",
          versionId,
          relation: "secondary" as const
        }))
      ],
      recommendedActions: [claim.explanation],
      provenance: claim.sourceKinds.map((sourceKind) => ({
        kind:
          sourceKind === "verified_rule"
            ? "verified_rule"
            : sourceKind === "technical_signature"
              ? "static_analysis"
              : sourceKind === "catalog"
                ? "resolver"
                : "evidence",
        sourceId: claim.promotedClaimId,
        sourceType: sourceKind
      })),
      confidenceInputs: claim.confidence.primaryDrivers.map((driver) => ({
        source: "evidence" as const,
        value: claim.confidence.score,
        weight: 1,
        rationale: driver
      }))
    };
  }
}
