import { InMemoryPlatformRepository } from "./repository.js";
import { EvidenceService } from "./evidence.js";
import { PostgresPlatformPersistence } from "./persistence.js";
import { SnapshotAnalysisService } from "./snapshot-analysis.js";
import {
  ArtifactAnalysisService,
  DeterministicResolverV1,
  FindingMergeService,
  GraphService,
  ImportService,
  IntegrationService,
  MlService,
  NotificationService,
  PackDiffService,
  ReportService,
  ReleaseGateService,
  RecommendationService,
  SimulationService,
  SnapshotNormalizationService,
  StaticAuthService,
  VerifiedRuleEngine,
  WorkspaceService
} from "./services.js";
import {
  InMemoryTemporalClientAdapter,
  TemporalBackedAnalysisOrchestrator
} from "./orchestration.js";
import { InMemoryAuditLogger, buildAuditEntry } from "./audit.js";
import { QuotaEnforcer } from "./rate-limit.js";
import { assertTenantOwnership } from "./tenant.js";
import { noopWebhookTransport, WebhookDeliveryScheduler } from "./webhooks.js";
import { UploadValidationService } from "./upload-validation.js";
import { EvidenceIngestionPipeline, ConnectorSyncScheduler } from "./connectors.js";
import { RuleDraftService } from "./rule-draft.js";
import { FeedbackAggregator, ModelVersionService } from "./model-registry.js";
import { KnowledgeSynthesisService } from "./knowledge-synthesis.js";
import { CatalogIngestionService } from "./catalog-ingestion.js";
import { EvidenceIngestionService } from "./evidence-ingestion.js";
import { EvidenceSourcesService } from "./evidence-sources.js";
import { JarAnalysisService } from "./jar-analysis.js";
import { GroundTruthService } from "./ground-truth.js";
import { ModInspectionTracker } from "./mod-inspection-tracker.js";
import type { TenantContext } from "@modcompat/api-contracts";
import type { AnalysisResult, WebFlowState } from "./types.js";

export * from "./helpers.js";
export * from "./orchestration.js";
export * from "./repository.js";
export * from "./persistence.js";
export * from "./evidence.js";
export * from "./services.js";
export * from "./types.js";
export * from "./audit.js";
export * from "./rate-limit.js";
export * from "./tenant.js";
export * from "./auth.js";
export * from "./webhooks.js";
export * from "./upload-validation.js";
export * from "./connectors.js";
export * from "./rule-draft.js";
export * from "./model-registry.js";
export * from "./snapshot-analysis.js";
export * from "./knowledge-synthesis.js";
export * from "./catalog-ingestion.js";
export * from "./evidence-ingestion.js";
export * from "./evidence-sources.js";
export * from "./jar-analysis.js";
export * from "./mod-inspection-tracker.js";
export * from "./ground-truth.js";

export class Phase1Platform {
  readonly repository = new InMemoryPlatformRepository();
  readonly persistence = new PostgresPlatformPersistence(this.repository);
  readonly auditLogger = new InMemoryAuditLogger();
  readonly quota = new QuotaEnforcer();
  readonly auth = new StaticAuthService(this.repository);
  readonly workspace = new WorkspaceService(this.repository);
  readonly normalization = new SnapshotNormalizationService(this.repository);
  readonly imports = new ImportService(this.repository, this.normalization);
  readonly resolver = new DeterministicResolverV1(this.repository);
  readonly rules = new VerifiedRuleEngine(this.repository);
  readonly artifactAnalysis = new ArtifactAnalysisService(this.repository);
  readonly graph = new GraphService(this.repository);
  readonly findingMerge = new FindingMergeService();
  readonly evidence = new EvidenceService(this.repository);
  readonly diffs = new PackDiffService(this.repository);
  readonly integrations = new IntegrationService(this.repository);
  readonly notifications = new NotificationService(this.repository);
  readonly ml = new MlService(this.repository);
  readonly simulation = new SimulationService(this.repository);
  readonly releaseGates = new ReleaseGateService(this.repository);
  readonly recommendations = new RecommendationService(this.repository);
  readonly reports = new ReportService(this.repository, this.recommendations, this.ml);
  readonly webhookScheduler = new WebhookDeliveryScheduler(noopWebhookTransport);
  readonly uploadValidation = new UploadValidationService();
  readonly ingestion = new EvidenceIngestionPipeline(this.repository);
  readonly syncScheduler = new ConnectorSyncScheduler(this.repository);
  readonly ruleDrafts = new RuleDraftService(this.repository);
  readonly modelVersions = new ModelVersionService(this.repository);
  readonly feedbackSignals = new FeedbackAggregator(this.repository);
  readonly snapshotAnalysis = new SnapshotAnalysisService(this.repository);
  readonly knowledgeSynthesis = new KnowledgeSynthesisService(this.repository);
  readonly catalogIngestion = new CatalogIngestionService(this.repository);
  readonly evidenceIngestion = new EvidenceIngestionService(this.repository);
  readonly evidenceSources = new EvidenceSourcesService(this.repository);
  readonly jarAnalysis = new JarAnalysisService(this.repository, this.evidenceIngestion);
  readonly modInspectionTracker = new ModInspectionTracker(this.repository);
  readonly groundTruth = new GroundTruthService(this.repository, this.persistence);
  readonly temporal = new InMemoryTemporalClientAdapter(this.repository);
  readonly orchestrator = new TemporalBackedAnalysisOrchestrator(
    this.repository,
    this.temporal,
    this.resolver,
    this.rules,
    this.artifactAnalysis,
    this.graph,
    this.findingMerge,
    this.evidence,
    this.diffs,
    this.ml,
    this.simulation,
    this.releaseGates,
    this.integrations,
    this.notifications,
    this.recommendations,
    this.reports
  );

  cacheAnalysisResult(result: AnalysisResult) {
    const analysisId = result.analysis.analysisId;
    this.repository.analyses.set(analysisId, {
      summary: result.analysis,
      phases: result.phases,
      events: result.events,
      findings: result.findings,
      recommendations: result.recommendations,
      recommendationSet: result.recommendationSet,
      featureDataset: result.featureDataset,
      featureVectors: result.featureVectors ?? [],
      calibratedScores: result.calibratedScores ?? [],
      reviewSummary: result.reviewSummary,
      simulationRun: result.simulationRun,
      releaseGateDecision: result.releaseGateDecision,
      statusCheck: result.statusCheck,
      artifacts: result.artifacts ?? [],
      graph: result.graph,
      explanationPaths: new Map(),
      packDiff: result.packDiff,
      report: result.report
    });

    if (result.artifacts?.length) {
      this.repository.artifactAnalyses.set(analysisId, result.artifacts);
    }

    if (result.graph) {
      this.repository.graphSnapshots.set(analysisId, result.graph);
    }

    if (result.recommendationSet) {
      this.repository.recommendationSets.set(
        result.recommendationSet.recommendationSetId,
        result.recommendationSet
      );
      this.repository.recommendationSetsByAnalysis.set(
        analysisId,
        result.recommendationSet.recommendationSetId
      );
    }

    if (result.featureDataset) {
      this.repository.featureDatasets.set(result.featureDataset.datasetId, result.featureDataset);
      this.repository.featureDatasetsByAnalysis.set(analysisId, result.featureDataset.datasetId);
    }

    if (result.featureVectors?.length) {
      this.repository.findingFeatureVectors.set(analysisId, result.featureVectors);
    }

    if (result.calibratedScores?.length) {
      this.repository.calibratedFindingScores.set(analysisId, result.calibratedScores);
    }

    if (result.reviewSummary) {
      this.repository.reviewSummaries.set(analysisId, result.reviewSummary);
    }

    if (result.simulationRun) {
      this.repository.simulationRuns.set(analysisId, result.simulationRun);
    }

    if (result.releaseGateDecision) {
      this.repository.releaseGateDecisions.set(analysisId, result.releaseGateDecision);
    }

    if (result.statusCheck) {
      this.repository.statusChecks.set(analysisId, result.statusCheck);
    }

    if (result.packDiff) {
      this.repository.packDiffs.set(result.packDiff.packDiffId, result.packDiff);
    }

    if (result.report) {
      this.repository.reports.set(analysisId, result.report);
    }

    return result;
  }

  createDemoFlow(): WebFlowState {
    this.evidence.syncFixtures();
    const session = this.auth.createSession();
    const baseline = this.imports.importModList({
      projectId: "prj_demo",
      createdBy: session.user.userId,
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      mods: [
        { name: "sodium", version: "0.6.0+mc1.21.1" },
        { name: "modmenu", version: "11.0.2" }
      ]
    });
    const importResult = this.imports.importModList({
      projectId: "prj_demo",
      createdBy: session.user.userId,
      environment: {
        minecraftVersion: "1.21.1",
        loader: "fabric",
        javaVersion: "21",
        side: "both"
      },
      mods: [
        { name: "sodium", version: "0.6.0+mc1.21.1" },
        { name: "optifine", version: "HD_U_I6" },
        { name: "modmenu", version: "11.0.2" }
      ]
    });
    this.auditLogger.record(buildAuditEntry(
      {
        organizationId: "org_demo",
        actorId: session.user.userId,
        actorKind: "user",
        role: "owner",
        permissions: [],
        requestId: `req_demo_import_${importResult.importRecord.importId}`,
        traceId: `trace_demo_import_${importResult.importRecord.importId}`
      },
      "import.created",
      {
        resourceKind: "import",
        resourceId: importResult.importRecord.importId,
        outcome: "success"
      }
    ));
    this.quota.recordImport("org_demo");
    const analysisResult = this.orchestrator.createAnalysis("prj_demo", {
      trigger: "manual",
      analysisMode: "standard",
      inputRef: {
        type: "pack_snapshot",
        id: importResult.snapshot.packSnapshotId
      },
      environment: importResult.snapshot.environment,
      options: {
        includeAlternatives: true,
        includeLowConfidence: true,
        runSimulation: true,
        compareToSnapshotId: baseline.snapshot.packSnapshotId
      }
    });

    this.auditLogger.record(buildAuditEntry(
      {
        organizationId: "org_demo",
        actorId: session.user.userId,
        actorKind: "user",
        role: "owner",
        permissions: [],
        requestId: `req_demo_analysis_${analysisResult.analysis.analysisId}`,
        traceId: `trace_demo_analysis_${analysisResult.analysis.analysisId}`
      },
      "analysis.created",
      {
        resourceKind: "analysis",
        resourceId: analysisResult.analysis.analysisId,
        outcome: "success"
      }
    ));
    this.quota.recordAnalysisStarted("org_demo");
    this.quota.recordAnalysisFinished("org_demo");

    return {
      session,
      importRecord: importResult.importRecord,
      snapshot: importResult.snapshot,
      analysis: analysisResult.analysis,
      phases: analysisResult.phases,
      events: analysisResult.events,
      findings: analysisResult.findings,
      recommendations: analysisResult.recommendations,
      recommendationSet: analysisResult.recommendationSet,
      featureDataset: analysisResult.featureDataset,
      featureVectors: analysisResult.featureVectors,
      calibratedScores: analysisResult.calibratedScores,
      reviewSummary: analysisResult.reviewSummary,
      simulationRun: analysisResult.simulationRun,
      releaseGateDecision: analysisResult.releaseGateDecision,
      statusCheck: analysisResult.statusCheck,
      artifacts: analysisResult.artifacts,
      graph: analysisResult.graph,
      packDiff: analysisResult.packDiff,
      report: analysisResult.report
    };
  }

  getTenantScopedAnalysis(analysisId: string, context: TenantContext): ReturnType<Phase1Platform["orchestrator"]["getAnalysis"]> {
    const record = this.repository.analyses.get(analysisId);
    if (!record) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }
    assertTenantOwnership(
      { tenantId: record.summary.organizationId, schemaVersion: 1 },
      { organizationId: context.organizationId } as TenantContext,
      "analysis",
      analysisId
    );
    return this.orchestrator.getAnalysis(analysisId);
  }
}

export function createPhase1Platform(): Phase1Platform {
  return new Phase1Platform();
}
