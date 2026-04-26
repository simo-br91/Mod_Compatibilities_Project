import type {
  AnalysisEnvironment,
  AnalysisMode,
  ConfidenceInput,
  EvidenceRef,
  FindingSubject,
  FindingProvenance,
  Reproducibility,
  Severity
} from "@modcompat/domain-models";

export interface EventEnvelope<TPayload> {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  correlationId: string;
  traceId: string;
  tenantId?: string;
  organizationId?: string;
  workspaceId?: string;
  projectId?: string;
  producer: string;
  payload: TPayload;
}

export interface AnalysisRequestedPayload {
  analysisId: string;
  trigger: "manual" | "webhook" | "scheduled" | "api";
  analysisMode: AnalysisMode;
  inputRef: {
    type: "pack_snapshot" | "import" | "manifest" | "uploaded_mods";
    id: string;
  };
  environment: AnalysisEnvironment;
  options?: {
    runSimulation?: boolean;
    includeAlternatives?: boolean;
    includeLowConfidence?: boolean;
  };
}

export interface AnalysisPhaseCompletedPayload {
  analysisId: string;
  phase:
    | "normalization"
    | "resolution"
    | "static_analysis"
    | "graph_enrichment"
    | "merge_findings"
    | "evidence_enrichment"
    | "simulation"
    | "pack_diff"
    | "risk_scoring"
    | "recommendation"
    | "release_gating"
    | "reporting";
  status: "completed" | "skipped" | "failed";
  durationMs: number;
  artifacts?: Array<{ type: string; id: string }>;
}

export interface AnalysisFindingEmittedPayload {
  analysisId: string;
  findingId: string;
  findingType: string;
  severity: Severity;
  confidence: number;
  reproducibility: Reproducibility;
  title: string;
  summary?: string;
  explanation?: string;
  subjects: FindingSubject[];
  evidence?: EvidenceRef[];
  recommendedActions?: string[];
  provenance?: FindingProvenance[];
  confidenceInputs?: ConfidenceInput[];
  dedupeKey?: string;
}

export interface AnalysisCompletedPayload {
  analysisId: string;
  status: "completed" | "failed";
  score?: number;
  counts?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  finishedAt: string;
  recommendationSetId?: string;
  reportId?: string;
}
