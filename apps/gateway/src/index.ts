import { buildGatewayApp } from "./app.js";

const app = buildGatewayApp();
const linkedInstallation = app.handlers.linkGitHubInstallation({
  installationId: "123456",
  projectId: "prj_demo",
  repositoryFullName: "demo-pack-studio/kitchen-sink-pack"
});
const webhook = app.handlers.createWebhook({
  targetUrl: "https://example.invalid/webhooks/modcompat",
  eventTypes: ["analysis.completed"],
  secret: "demo-secret"
});
const demo = app.handlers.getDemoFlow();
const primaryFinding = demo.findings[0];

if (!primaryFinding) {
  throw new Error("Gateway demo flow did not materialize any findings.");
}

const evidenceLinkedFinding =
  demo.findings.find((finding) =>
    finding.evidence.some(
      (evidence) =>
        evidence.type === "evidence_document" || evidence.type === "evidence_snippet"
    )
  ) ?? primaryFinding;
const report = await app.handlers.getAnalysisReport(demo.analysis.analysisId);
const dataset = await app.handlers.getAnalysisFeatureDataset(demo.analysis.analysisId);
const reviewSummary = await app.handlers.getPackReviewSummary(demo.analysis.analysisId);
const simulationRun = await app.handlers.getSimulationRun(demo.analysis.analysisId);
const releaseGateDecision = await app.handlers.getReleaseGateDecision(demo.analysis.analysisId);
const statusCheck = await app.handlers.getStatusCheck(demo.analysis.analysisId);
const deliveries = await app.handlers.listWebhookDeliveries(demo.analysis.analysisId);
const persistenceStatus = app.platform.persistence.getStatus();
const evidenceBoundaryMode = app.serviceBoundaries.evidence.mode;
const adminBoundaryMode = app.serviceBoundaries.admin.mode;
const recommendationBoundaryMode = app.serviceBoundaries.recommendation.mode;
const graphBoundaryMode = app.serviceBoundaries.graph.mode;
const simulationBoundaryMode = app.serviceBoundaries.simulation.mode;
const orchestratorBoundaryMode = app.serviceBoundaries.orchestrator.mode;
const artifactAnalysisBoundaryMode = app.platform.artifactAnalysis.mode;

let persistenceResult:
  | {
      enabled: boolean;
      persisted: boolean;
      hydrated: boolean;
      importCount: number;
      packDiffPersisted: boolean;
    }
  | {
      enabled: boolean;
      persisted: false;
      hydrated: false;
      reason: string;
    };

if (persistenceStatus.enabled) {
  await app.platform.persistence.ensureSchema();
  await app.platform.persistence.persistAnalysis(demo.analysis.analysisId);
  const hydrated = await app.platform.persistence.hydrateAnalysis(demo.analysis.analysisId);
  const persistedImports = await app.platform.persistence.readImportsForProject(
    demo.analysis.projectId
  );
  const persistedPackDiff = await app.platform.persistence.readPackDiffByAnalysis(
    demo.analysis.analysisId
  );
  persistenceResult = {
    enabled: true,
    persisted: true,
    hydrated: Boolean(hydrated),
    importCount: persistedImports.length,
    packDiffPersisted: Boolean(persistedPackDiff)
  };
} else {
  persistenceResult = {
    enabled: false,
    persisted: false,
    hydrated: false,
    reason: "POSTGRES_URL is not configured."
  };
}

const evidenceSync = await app.handlers.syncEvidence(["github", "curated-community"]);
const evidenceSyncReplay =
  evidenceBoundaryMode === "http"
    ? await app.handlers.syncEvidence(["github", "curated-community"])
    : undefined;
const evidenceSearch = await app.handlers.searchEvidence({
  query: "optifine fabric crash",
  limit: 3
});
const adminCuration = await app.handlers.createEvidenceCuration({
  title: "Promote OptiFine and Sodium Fabric incompatibility",
  findingType: "community_verified_incompatibility",
  severity: "high",
  summary:
    "Curated evidence confirms the combination should be treated as incompatible for Fabric packs.",
  subjectProjectIds: ["cp_optifine", "cp_sodium"],
  evidenceDocumentIds: evidenceSync.documents.slice(0, 2).map((document) => document.documentId),
  evidenceSnippetIds: [],
  createdBy: "usr_demo"
});
const adminCurationReplay =
  adminBoundaryMode === "http"
    ? await app.handlers.createEvidenceCuration({
        title: "Promote OptiFine and Sodium Fabric incompatibility",
        findingType: "community_verified_incompatibility",
        severity: "high",
        summary:
          "Curated evidence confirms the combination should be treated as incompatible for Fabric packs.",
        subjectProjectIds: ["cp_optifine", "cp_sodium"],
        evidenceDocumentIds: evidenceSync.documents
          .slice(0, 2)
          .map((document) => document.documentId),
        evidenceSnippetIds: [],
        createdBy: "usr_demo"
      })
    : undefined;
const adminPromotion = await app.handlers.promoteVerifiedRule({
  curationId: adminCuration.curationId,
  promotedBy: "usr_demo"
});
const adminPromotionReplay =
  adminBoundaryMode === "http"
    ? await app.handlers.promoteVerifiedRule({
        curationId: adminCuration.curationId,
        promotedBy: "usr_demo"
      })
    : undefined;
const recommendationSet = await app.handlers.getRecommendations(demo.analysis.analysisId);
const recommendationReplay =
  recommendationBoundaryMode === "http"
    ? await app.handlers.getRecommendations(demo.analysis.analysisId)
    : undefined;
const recommendationTarget = recommendationSet.items[0];
const recommendationFeedback = recommendationTarget
  ? await app.handlers.submitRecommendationFeedback({
      recommendationId: recommendationTarget.recommendationId,
      feedbackType: "accepted",
      createdBy: "usr_demo",
      note: "Accepted during the Phase 8 service-boundary demo flow."
    })
  : undefined;
const recommendationFeedbackReplay =
  recommendationBoundaryMode === "http" && recommendationTarget
    ? await app.handlers.submitRecommendationFeedback({
        recommendationId: recommendationTarget.recommendationId,
        feedbackType: "accepted",
        createdBy: "usr_demo",
        note: "Accepted during the Phase 8 service-boundary demo flow."
      })
    : undefined;
const recommendationOutcome = recommendationTarget
  ? await app.handlers.recordRecommendationOutcome({
      recommendationSetId: recommendationSet.recommendationSetId,
      status: "validated",
      appliedRecommendationIds: [recommendationTarget.recommendationId],
      validationSummary: "Validated in the Phase 8 boundary demo.",
      createdBy: "usr_demo"
    })
  : undefined;
const recommendationOutcomeReplay =
  recommendationBoundaryMode === "http" && recommendationTarget
    ? await app.handlers.recordRecommendationOutcome({
        recommendationSetId: recommendationSet.recommendationSetId,
        status: "validated",
        appliedRecommendationIds: [recommendationTarget.recommendationId],
        validationSummary: "Validated in the Phase 8 boundary demo.",
        createdBy: "usr_demo"
      })
    : undefined;
const recommendationSetAfterWrites = recommendationTarget
  ? await app.handlers.getRecommendations(demo.analysis.analysisId)
  : recommendationSet;
const graph = await app.handlers.getAnalysisGraph(demo.analysis.analysisId);
const graphReplay =
  graphBoundaryMode === "http"
    ? await app.handlers.getAnalysisGraph(demo.analysis.analysisId)
    : undefined;
const graphNeighborhood = graph
  ? await app.handlers.getGraphNeighborhood(demo.analysis.analysisId, graph.nodes[0]!.nodeId, 2)
  : undefined;
const graphExplanation = await app.handlers.explainFinding(
  demo.analysis.analysisId,
  primaryFinding.findingId
);
const simulationBoundaryRun = await app.handlers.getSimulationRun(demo.analysis.analysisId);
const simulationReplay =
  simulationBoundaryMode === "http"
    ? await app.handlers.getSimulationRun(demo.analysis.analysisId)
    : undefined;
const orchestratorImport = app.handlers.importModList({
  projectId: "prj_demo",
  createdBy: "usr_demo",
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
const orchestratedAnalysis = await app.handlers.createAnalysis("prj_demo", {
  trigger: "manual",
  analysisMode: "standard",
  inputRef: {
    type: "pack_snapshot",
    id: orchestratorImport.snapshot.packSnapshotId
  },
  environment: orchestratorImport.snapshot.environment,
  options: {
    includeAlternatives: true,
    includeLowConfidence: true,
    runSimulation: true
  }
});
const orchestratedReplay =
  orchestratorBoundaryMode === "http"
    ? await app.handlers.createAnalysis("prj_demo", {
        trigger: "manual",
        analysisMode: "standard",
        inputRef: {
          type: "pack_snapshot",
          id: orchestratorImport.snapshot.packSnapshotId
        },
        environment: orchestratorImport.snapshot.environment,
        options: {
          includeAlternatives: true,
          includeLowConfidence: true,
          runSimulation: true
        }
      })
    : undefined;
const orchestratorReadback = await app.handlers.getAnalysis(
  orchestratedAnalysis.analysis.analysisId
);
const orchestratedRecommendations = await app.handlers.getRecommendations(
  orchestratedAnalysis.analysis.analysisId
);
const orchestratedSimulation = await app.handlers.getSimulationRun(
  orchestratedAnalysis.analysis.analysisId
);
const orchestratedGraph = await app.handlers.getAnalysisGraph(
  orchestratedAnalysis.analysis.analysisId
);
const cancellableImport =
  orchestratorBoundaryMode === "http"
    ? app.handlers.importModList({
        projectId: "prj_demo",
        createdBy: "usr_demo",
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
      })
    : undefined;
const cancellationSubmission =
  orchestratorBoundaryMode === "http" && cancellableImport
    ? await app.handlers.submitAnalysisRequest("prj_demo", {
        trigger: "manual",
        analysisMode: "standard",
        inputRef: {
          type: "pack_snapshot",
          id: cancellableImport.snapshot.packSnapshotId
        },
        environment: cancellableImport.snapshot.environment,
        options: {
          includeAlternatives: true,
          includeLowConfidence: true,
          runSimulation: true
        }
      })
    : undefined;
const cancellationResult =
  orchestratorBoundaryMode === "http" &&
  cancellationSubmission &&
  !("analysis" in cancellationSubmission)
    ? await app.handlers.cancelAnalysisRequest(cancellationSubmission.idempotencyKey)
    : undefined;
const cancellationStatus =
  orchestratorBoundaryMode === "http" &&
  cancellationSubmission &&
  !("analysis" in cancellationSubmission)
    ? await app.handlers.getAnalysisRequestStatus(cancellationSubmission.idempotencyKey)
    : undefined;

let evidenceBoundaryResult:
  | {
      mode: "in-process";
      syncedDocuments: number;
      searchHits: number;
      linkedHits: number;
    }
  | {
      mode: "http";
      baseUrl: string;
      syncedDocuments: number;
      searchHits: number;
      replaySameDocumentIds: boolean;
      linkedHits?: number;
      linkedLookupSkipped?: string;
    };

let adminBoundaryResult:
  | {
      mode: "in-process";
      curationStatus: string;
      promotedRuleId: string;
      repositoryRuleVersion: number;
    }
  | {
      mode: "http";
      baseUrl: string;
      curationStatus: string;
      promotedRuleId: string;
      repositoryRuleVersion?: number;
      curationReplaySameId: boolean;
      promotionReplaySameRule: boolean;
    };

let recommendationBoundaryResult:
  | {
      mode: "in-process";
      itemCount: number;
      bundleCount: number;
      firstRecommendationStatus?: string;
    }
  | {
      mode: "http";
      baseUrl: string;
      itemCount: number;
      bundleCount: number;
      replaySameSetId: boolean;
      feedbackReplaySameId?: boolean;
      outcomeReplaySameId?: boolean;
      firstRecommendationStatus?: string;
    };

let graphBoundaryResult:
  | {
      mode: "in-process";
      nodeCount: number;
      edgeCount: number;
      neighborhoodNodeCount: number;
      explanationNodeCount: number;
    }
  | {
      mode: "http";
      baseUrl: string;
      nodeCount: number;
      edgeCount: number;
      neighborhoodNodeCount: number;
      explanationNodeCount: number;
      replaySameShape: boolean;
    };

let simulationBoundaryResult:
  | {
      mode: "in-process";
      status: string;
      observationCount: number;
    }
  | {
      mode: "http";
      baseUrl: string;
      status: string;
      observationCount: number;
      replaySameRunId: boolean;
    };

let orchestratorBoundaryResult:
  | {
      mode: "in-process";
      analysisId: string;
      status: string;
      findingCount: number;
      recommendationCount: number;
      simulationStatus: string;
      graphNodeCount: number;
      idempotentReplaySameAnalysis?: boolean;
      asyncSubmission?: false;
    }
  | {
      mode: "http";
      baseUrl: string;
      analysisId: string;
      status: string;
      findingCount: number;
      recommendationCount: number;
      simulationStatus: string;
      graphNodeCount: number;
      idempotentReplaySameAnalysis: boolean;
      asyncSubmission: true;
      cancelledRequestStatus?: string;
      cancelledBeforeExecution?: boolean;
    };

if (evidenceBoundaryMode === "http") {
  const remoteBoundary = app.serviceBoundaries.evidence;
  const canLookupLinkedEvidence = persistenceStatus.enabled && demo.findings.length > 0;
    if (canLookupLinkedEvidence) {
      const linkedEvidence = await app.handlers.getFindingEvidence(
        demo.analysis.analysisId,
        evidenceLinkedFinding.findingId,
        3
      );
      evidenceBoundaryResult = {
      mode: "http",
      baseUrl: remoteBoundary.baseUrl,
      syncedDocuments: evidenceSync.documents.length,
      searchHits: evidenceSearch.hits.length,
      replaySameDocumentIds:
        evidenceSyncReplay?.documents.map((document) => document.documentId).join(",") ===
        evidenceSync.documents.map((document) => document.documentId).join(","),
      linkedHits: linkedEvidence.hits.length
    };
  } else {
    evidenceBoundaryResult = {
      mode: "http",
      baseUrl: remoteBoundary.baseUrl,
      syncedDocuments: evidenceSync.documents.length,
      searchHits: evidenceSearch.hits.length,
      replaySameDocumentIds:
        evidenceSyncReplay?.documents.map((document) => document.documentId).join(",") ===
        evidenceSync.documents.map((document) => document.documentId).join(","),
      linkedLookupSkipped:
        "Remote finding-linked evidence lookup requires POSTGRES_URL-backed analysis hydration."
    };
  }
} else {
  const linkedEvidence = await app.handlers.getFindingEvidence(
    demo.analysis.analysisId,
    evidenceLinkedFinding.findingId,
    3
  );
  evidenceBoundaryResult = {
    mode: "in-process",
    syncedDocuments: evidenceSync.documents.length,
    searchHits: evidenceSearch.hits.length,
    linkedHits: linkedEvidence.hits.length
  };
}

const promotedRule = app.platform.repository.verifiedRules.find(
  (rule) => rule.rule_id === adminPromotion.rule.ruleId
);
if (adminBoundaryMode === "http") {
  const remoteBoundary = app.serviceBoundaries.admin;
  adminBoundaryResult = {
    mode: "http",
    baseUrl: remoteBoundary.baseUrl,
    curationStatus: adminPromotion.curation.status,
    promotedRuleId: adminPromotion.rule.ruleId,
    repositoryRuleVersion: promotedRule?.version,
    curationReplaySameId:
      adminCurationReplay?.curationId === adminCuration.curationId,
    promotionReplaySameRule:
      adminPromotionReplay?.rule.ruleId === adminPromotion.rule.ruleId
  };
} else {
  adminBoundaryResult = {
    mode: "in-process",
    curationStatus: adminPromotion.curation.status,
    promotedRuleId: adminPromotion.rule.ruleId,
    repositoryRuleVersion: promotedRule?.version ?? 0
  };
}

if (recommendationBoundaryMode === "http") {
  const remoteBoundary = app.serviceBoundaries.recommendation;
  recommendationBoundaryResult = {
    mode: "http",
    baseUrl: remoteBoundary.baseUrl,
    itemCount: recommendationSet.items.length,
    bundleCount: recommendationSet.bundles.length,
    replaySameSetId:
      recommendationReplay?.recommendationSetId === recommendationSet.recommendationSetId,
    feedbackReplaySameId:
      recommendationFeedbackReplay?.feedbackId === recommendationFeedback?.feedbackId,
    outcomeReplaySameId:
      recommendationOutcomeReplay?.outcomeId === recommendationOutcome?.outcomeId,
    firstRecommendationStatus: recommendationSetAfterWrites.items[0]?.status
  };
} else {
  recommendationBoundaryResult = {
    mode: "in-process",
    itemCount: recommendationSet.items.length,
    bundleCount: recommendationSet.bundles.length,
    firstRecommendationStatus: recommendationSetAfterWrites.items[0]?.status
  };
}

if (graphBoundaryMode === "http") {
  const remoteBoundary = app.serviceBoundaries.graph;
  graphBoundaryResult = {
    mode: "http",
    baseUrl: remoteBoundary.baseUrl,
    nodeCount: graph?.nodes.length ?? 0,
    edgeCount: graph?.edges.length ?? 0,
    neighborhoodNodeCount: graphNeighborhood?.nodes.length ?? 0,
    explanationNodeCount: graphExplanation.nodes.length,
    replaySameShape:
      (graphReplay?.nodes.length ?? 0) === (graph?.nodes.length ?? 0) &&
      (graphReplay?.edges.length ?? 0) === (graph?.edges.length ?? 0)
  };
} else {
  graphBoundaryResult = {
    mode: "in-process",
    nodeCount: graph?.nodes.length ?? 0,
    edgeCount: graph?.edges.length ?? 0,
    neighborhoodNodeCount: graphNeighborhood?.nodes.length ?? 0,
    explanationNodeCount: graphExplanation.nodes.length
  };
}

if (simulationBoundaryMode === "http") {
  const remoteBoundary = app.serviceBoundaries.simulation;
  simulationBoundaryResult = {
    mode: "http",
    baseUrl: remoteBoundary.baseUrl,
    status: simulationBoundaryRun.status,
    observationCount: simulationBoundaryRun.observations.length,
    replaySameRunId: simulationReplay?.simulationRunId === simulationBoundaryRun.simulationRunId
  };
} else {
  simulationBoundaryResult = {
    mode: "in-process",
    status: simulationBoundaryRun.status,
    observationCount: simulationBoundaryRun.observations.length
  };
}

if (orchestratorBoundaryMode === "http") {
  const remoteBoundary = app.serviceBoundaries.orchestrator;
  orchestratorBoundaryResult = {
    mode: "http",
    baseUrl: remoteBoundary.baseUrl,
    analysisId: orchestratorReadback.analysis.analysisId,
    status: orchestratorReadback.analysis.status,
    findingCount: orchestratorReadback.findings.length,
    recommendationCount: orchestratedRecommendations.items.length,
    simulationStatus: orchestratedSimulation.status,
    graphNodeCount: orchestratedGraph?.nodes.length ?? 0,
    idempotentReplaySameAnalysis:
      orchestratedReplay?.analysis.analysisId === orchestratedAnalysis.analysis.analysisId
    ,
    asyncSubmission: true,
    cancelledRequestStatus: cancellationStatus?.status,
    cancelledBeforeExecution: cancellationResult?.status === "cancelled"
  };
} else {
  orchestratorBoundaryResult = {
    mode: "in-process",
    analysisId: orchestratorReadback.analysis.analysisId,
    status: orchestratorReadback.analysis.status,
    findingCount: orchestratorReadback.findings.length,
    recommendationCount: orchestratedRecommendations.items.length,
    simulationStatus: orchestratedSimulation.status,
    graphNodeCount: orchestratedGraph?.nodes.length ?? 0,
    asyncSubmission: false
  };
}

console.log(
  JSON.stringify({
    service: app.config.serviceName,
    status: "phase6-ready",
    routes: app.routes,
    demo: {
      importId: demo.importRecord.importId,
      analysisId: demo.analysis.analysisId,
      findingCount: demo.findings.length,
      recommendationCount: demo.recommendations.length,
      recommendationBundleCount: demo.recommendationSet?.bundles.length ?? 0,
      reportId: report.reportId,
      datasetId: dataset.dataset.datasetId,
      featureVectorCount: dataset.featureVectors.length,
      reviewSummaryId: reviewSummary.reviewSummaryId,
      simulationRunId: simulationRun.simulationRunId,
      releaseGateStatus: releaseGateDecision.status,
      statusCheckId: statusCheck.statusCheckId,
      githubInstallationId: linkedInstallation.installationId,
      webhookId: webhook.webhookId,
      webhookDeliveryCount: deliveries.length
    },
    persistence: persistenceResult,
    serviceBoundaries: {
      artifactAnalysis: {
        mode: artifactAnalysisBoundaryMode
      },
      evidence: evidenceBoundaryResult,
      admin: adminBoundaryResult,
      recommendation: recommendationBoundaryResult,
      graph: graphBoundaryResult,
      simulation: simulationBoundaryResult,
      orchestrator: orchestratorBoundaryResult
    }
  })
);
