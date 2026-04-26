import { createPlatformId } from "@modcompat/id-generation";
import type {
  AnalysisEvent,
  AnalysisPhase,
  AnalysisPhaseName,
  AnalysisStatus,
  Recommendation
} from "@modcompat/domain-models";
import type {
  AnalysisSummary,
  CreateAnalysisRequest,
  CreatePackDiffRequest,
  Finding
} from "@modcompat/api-contracts";
import { countBySeverity, now } from "./helpers.js";
import { EvidenceService } from "./evidence.js";
import { InMemoryPlatformRepository } from "./repository.js";
import {
  ArtifactAnalysisService,
  DeterministicResolverV1,
  FindingMergeService,
  GraphService,
  IntegrationService,
  MlService,
  NotificationService,
  PackDiffService,
  ReportService,
  ReleaseGateService,
  RecommendationService,
  SimulationService,
  VerifiedRuleEngine
} from "./services.js";
import type { AnalysisRecordInternal, AnalysisResult } from "./types.js";

export class AnalysisCancelledError extends Error {
  readonly code = "analysis_cancelled" as const;

  constructor(message = "Analysis was cancelled cooperatively between phases.") {
    super(message);
    this.name = "AnalysisCancelledError";
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AnalysisCancelledError();
  }
}

function findProject(repository: InMemoryPlatformRepository, projectId: string) {
  const project = repository.projects.get(projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  return project;
}

function findSnapshot(
  repository: InMemoryPlatformRepository,
  packSnapshotId: string
) {
  const snapshot = repository.snapshots.get(packSnapshotId);

  if (!snapshot) {
    throw new Error(`Pack snapshot not found: ${packSnapshotId}`);
  }

  return snapshot;
}

export class InMemoryTemporalClientAdapter {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  startWorkflow(workflowId: string): { workflowId: string; runId: string } {
    const execution = {
      workflowId,
      runId: createPlatformId("run"),
      status: "queued" as AnalysisStatus
    };
    this.repository.workflowExecutions.set(workflowId, execution);
    return execution;
  }

  setStatus(workflowId: string, status: AnalysisStatus) {
    const existing = this.repository.workflowExecutions.get(workflowId);

    if (!existing) {
      throw new Error(`Workflow execution not found: ${workflowId}`);
    }

    this.repository.workflowExecutions.set(workflowId, {
      ...existing,
      status
    });
  }
}

export class TemporalBackedAnalysisOrchestrator {
  constructor(
    private readonly repository: InMemoryPlatformRepository,
    private readonly temporalClient: InMemoryTemporalClientAdapter,
    private readonly resolver: DeterministicResolverV1,
    private readonly rules: VerifiedRuleEngine,
    private readonly artifactAnalysis: ArtifactAnalysisService,
    private readonly graphService: GraphService,
    private readonly findingMerge: FindingMergeService,
    private readonly evidence: EvidenceService,
    private readonly diffService: PackDiffService,
    private readonly ml: MlService,
    private readonly simulation: SimulationService,
    private readonly releaseGates: ReleaseGateService,
    private readonly integrations: IntegrationService,
    private readonly notifications: NotificationService,
    private readonly recommendations: RecommendationService,
    private readonly reports: ReportService
  ) {}

  createAnalysis(
    projectId: string,
    request: CreateAnalysisRequest,
    signal?: AbortSignal
  ): AnalysisResult {
    const project = findProject(this.repository, projectId);
    const snapshot = findSnapshot(this.repository, request.inputRef.id);
    const workflow = this.temporalClient.startWorkflow(
      `analysis-${projectId}-${request.inputRef.id}`
    );

    const summary: AnalysisSummary = {
      analysisId: createPlatformId("ana"),
      projectId,
      workspaceId: project.workspaceId,
      organizationId: project.organizationId,
      packSnapshotId: snapshot.packSnapshotId,
      status: "queued",
      trigger: request.trigger,
      analysisMode: request.analysisMode,
      createdAt: now()
    };

    const record: AnalysisRecordInternal = {
      summary,
      phases: [] as AnalysisPhase[],
      events: [] as AnalysisEvent[],
      findings: [] as Finding[],
      recommendations: [] as Recommendation[],
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
      report: undefined
    };

    this.repository.analyses.set(summary.analysisId, record);
    this.pushEvent(summary.analysisId, "analysis.queued", "Analysis queued.", undefined, {
      workflowId: workflow.workflowId,
      runId: workflow.runId
    });

    this.temporalClient.setStatus(workflow.workflowId, "running");
    record.summary = {
      ...record.summary,
      status: "running",
      startedAt: now()
    };
    this.pushEvent(summary.analysisId, "analysis.started", "Temporal workflow started.");

    this.runPhase(summary.analysisId, "normalization", () => ({
      artifacts: [{ type: "pack_snapshot", id: snapshot.packSnapshotId }]
    }));
    checkCancelled(signal);

    const findings = this.runPhase(summary.analysisId, "resolution", () => ({
      findings: this.resolver.evaluate(snapshot)
    })).findings ?? [];
    checkCancelled(signal);

    const ruleFindings = this.runPhase(summary.analysisId, "rule_evaluation", () => ({
      findings: this.rules.evaluate(snapshot)
    })).findings ?? [];
    checkCancelled(signal);

    const staticAnalysisResult = this.runPhase(summary.analysisId, "static_analysis", () => {
      const result = this.artifactAnalysis.analyze(summary.analysisId, snapshot);
      return {
        artifacts: result.artifacts.map((artifact) => ({
          type: "artifact_analysis",
          id: artifact.artifactAnalysisId
        })),
        artifactsResults: result.artifacts,
        findings: result.findings
      };
    });
    record.artifacts.push(...(staticAnalysisResult.artifactsResults ?? []));
    checkCancelled(signal);

    const graphSnapshot = this.graphService.upsertAnalysisGraph(
      summary.analysisId,
      snapshot,
      record.artifacts,
      [...findings, ...ruleFindings, ...(staticAnalysisResult.findings ?? [])]
    );
    record.graph = this.runPhase(summary.analysisId, "graph_enrichment", () => ({
      artifacts: [{ type: "graph", id: graphSnapshot.graphId }]
    }))
      ? graphSnapshot
      : undefined;
    checkCancelled(signal);

    const mergedFindings = this.runPhase(summary.analysisId, "merge_findings", () => ({
      findings: this.findingMerge.merge({
        resolverFindings: findings,
        ruleFindings,
        staticFindings: staticAnalysisResult.findings ?? [],
        graphService: this.graphService,
        analysisId: summary.analysisId
      })
    })).findings ?? [];
    checkCancelled(signal);

    const evidenceEnrichedFindings = this.runPhase(
      summary.analysisId,
      "evidence_enrichment",
      () => {
        const enriched = this.evidence.enrichFindings(summary.analysisId, mergedFindings);
        return {
          findings: enriched.findings,
          artifacts: [{ type: "evidence_bundle", id: enriched.bundleId }]
        };
      }
    ).findings ?? mergedFindings;
    checkCancelled(signal);

    const riskScoring = this.runPhase(summary.analysisId, "risk_scoring", () => {
      const result = this.ml.runRiskScoring(summary.analysisId, evidenceEnrichedFindings);
      return {
        findings: result.findings,
        dataset: result.dataset,
        featureVectors: result.featureVectors,
        calibratedScores: result.calibratedScores,
        artifacts: [
          { type: "feature_dataset", id: result.dataset.datasetId }
        ]
      };
    });
    record.featureDataset = riskScoring.dataset;
    record.featureVectors = riskScoring.featureVectors ?? [];
    record.calibratedScores = riskScoring.calibratedScores ?? [];
    const calibratedFindings = riskScoring.findings ?? evidenceEnrichedFindings;
    checkCancelled(signal);

    const postSimulationFindings =
      this.runPhase(summary.analysisId, "simulation", () => {
        const result = this.simulation.run(summary.analysisId, snapshot, calibratedFindings);
        return {
          findings: result.findings,
          simulationRun: result.simulationRun,
          artifacts: [{ type: "simulation_run", id: result.simulationRun.simulationRunId }]
        };
      }).findings ?? calibratedFindings;
    record.simulationRun = this.simulation.getRun(summary.analysisId);
    checkCancelled(signal);

    for (const finding of postSimulationFindings) {
      record.findings.push(finding);
      this.pushEvent(
        summary.analysisId,
        "analysis.finding.emitted",
        finding.title,
        undefined,
        finding as unknown as Record<string, unknown>
      );
    }

    if (request.options?.compareToSnapshotId) {
      record.packDiff = this.diffService.createDiff({
        projectId,
        baseSnapshotId: request.options.compareToSnapshotId,
        targetSnapshotId: snapshot.packSnapshotId,
        baselineAnalysisId: request.options.baselineAnalysisId,
        targetAnalysisId: summary.analysisId
      });
      this.runPhase(summary.analysisId, "pack_diff", () => ({
        artifacts: [{ type: "pack_diff", id: record.packDiff!.packDiffId }]
      }));
    }

    const generatedRecommendations = this.runPhase(
      summary.analysisId,
      "recommendation",
      () => {
        const recommendationResult = this.recommendations.generate(
          summary.analysisId,
          snapshot,
          postSimulationFindings,
          record.packDiff
        );

        return {
          recommendationResult,
          recommendations: recommendationResult.recommendations
        };
      }
    );
    const recommendationResult = generatedRecommendations.recommendationResult;
    record.recommendationSet = recommendationResult?.recommendationSet;
    record.recommendations.push(...(recommendationResult?.recommendations ?? []));
    record.reviewSummary = this.ml.createReviewSummary(
      summary.analysisId,
      postSimulationFindings,
      record.recommendations
    );
    const gateResult = this.runPhase(summary.analysisId, "release_gating", () => ({
      releaseGateDecision: this.releaseGates.evaluate(
        summary.analysisId,
        record.findings,
        record.simulationRun
      ).releaseGateDecision,
      artifacts: [
        {
          type: "release_gate",
          id: this.releaseGates.getDecision(summary.analysisId).releaseGateDecisionId
        }
      ]
    })).releaseGateDecision!;
    record.releaseGateDecision = gateResult;
    record.statusCheck = this.notifications.createStatusCheck(
      summary.analysisId,
      gateResult,
      this.integrations.getLinkByProject(projectId)?.installationId
    );
    this.notifications.fanOutAnalysisCompleted(summary.analysisId, "analysis.completed", {
      analysisId: summary.analysisId,
      releaseGateStatus: gateResult.status,
      score: record.summary.score
    });

    const report = this.runPhase(summary.analysisId, "reporting", () => ({
      report: this.reports.createReport(summary.analysisId),
      artifacts: [
        { type: "review_summary", id: record.reviewSummary!.reviewSummaryId },
        { type: "report", id: `report-${summary.analysisId}` }
      ]
    })).report;
    record.report = report;

    const counts = countBySeverity(record.findings);
    record.summary = {
      ...record.summary,
      counts,
      status: "completed",
      score: Math.max(0, 100 - counts.critical * 35 - counts.high * 20 - counts.medium * 10),
      finishedAt: now()
    };
    this.temporalClient.setStatus(workflow.workflowId, "completed");
    this.pushEvent(summary.analysisId, "analysis.completed", "Analysis completed.", undefined, {
      recommendationCount: record.recommendations.length,
      recommendationSetId: record.recommendationSet?.recommendationSetId,
      reportId: record.report?.reportId
    });

    return {
      analysis: record.summary,
      phases: record.phases,
      events: record.events,
      findings: record.findings,
      recommendations: record.recommendations,
      recommendationSet: record.recommendationSet,
      featureDataset: record.featureDataset,
      featureVectors: record.featureVectors,
      calibratedScores: record.calibratedScores,
      reviewSummary: record.reviewSummary,
      simulationRun: record.simulationRun,
      releaseGateDecision: record.releaseGateDecision,
      statusCheck: record.statusCheck,
      artifacts: record.artifacts,
      graph: record.graph,
      packDiff: record.packDiff,
      report: record.report
    };
  }

  getAnalysis(analysisId: string): AnalysisResult {
    const record = this.repository.analyses.get(analysisId);

    if (!record) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    return {
      analysis: record.summary,
      phases: record.phases,
      events: record.events,
      findings: record.findings,
      recommendations: record.recommendations,
      recommendationSet: record.recommendationSet,
      featureDataset: record.featureDataset,
      featureVectors: record.featureVectors,
      calibratedScores: record.calibratedScores,
      reviewSummary: record.reviewSummary,
      simulationRun: record.simulationRun,
      releaseGateDecision: record.releaseGateDecision,
      statusCheck: record.statusCheck,
      artifacts: record.artifacts,
      graph: record.graph,
      packDiff: record.packDiff,
      report: record.report
    };
  }

  createPackDiff(projectId: string, request: CreatePackDiffRequest) {
    return this.diffService.createDiff({
      projectId,
      ...request
    });
  }

  private runPhase(
    analysisId: string,
    phaseName: AnalysisPhaseName,
    execute: () => {
      artifacts?: Array<{ type: string; id: string }>;
      findings?: Finding[];
      recommendations?: Recommendation[];
      recommendationResult?: import("./types.js").RecommendationGenerationResult;
      artifactsResults?: import("@modcompat/domain-models").ArtifactAnalysisResult[];
      report?: import("@modcompat/api-contracts").AnalysisReport;
      dataset?: import("@modcompat/domain-models").OfflineDataset;
      featureVectors?: import("@modcompat/domain-models").FindingFeatureVector[];
      calibratedScores?: import("@modcompat/domain-models").CalibratedFindingScore[];
      reviewSummary?: import("@modcompat/domain-models").PackReviewSummary;
      simulationRun?: import("@modcompat/domain-models").SimulationRun;
      releaseGateDecision?: import("@modcompat/domain-models").ReleaseGateDecision;
    }
  ) {
    const startedAt = Date.now();
    const result = execute();
    const phase: AnalysisPhase = {
      phaseId: createPlatformId("phs"),
      analysisId,
      phaseName,
      status: "completed",
      durationMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: now(),
      artifacts: result.artifacts,
      schemaVersion: 1
    };
    const record = this.repository.analyses.get(analysisId);

    if (!record) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    record.phases.push(phase);
    this.pushEvent(
      analysisId,
      "analysis.phase.completed",
      `${phaseName} completed.`,
      phaseName,
      result.artifacts
        ? { artifacts: result.artifacts }
        : { findingCount: result.findings?.length ?? 0 }
    );
    return result;
  }

  private pushEvent(
    analysisId: string,
    eventType: AnalysisEvent["eventType"],
    message: string,
    phaseName?: AnalysisPhaseName,
    payload?: Record<string, unknown>
  ) {
    const record = this.repository.analyses.get(analysisId);

    if (!record) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    record.events.push({
      eventId: createPlatformId("evt"),
      analysisId,
      eventType,
      message,
      occurredAt: now(),
      phaseName,
      payload,
      schemaVersion: 1
    });
  }
}
