import type {
  AnalysisEnvironment,
  EvidenceRef,
  FindingSubject,
  Reproducibility,
  Severity
} from "@modcompat/domain-models";

export interface RuleContext {
  analysisId: string;
  environment: AnalysisEnvironment;
  subjectIds: string[];
}

export interface RuleMatch {
  ruleId: string;
  findingType: string;
  severity: Severity;
  confidence: number;
  reproducibility: Reproducibility;
  title: string;
  summary: string;
  subjects: FindingSubject[];
  evidence: EvidenceRef[];
  recommendedActions: string[];
}

export interface RuleEvaluator {
  evaluate(context: RuleContext): Promise<RuleMatch[]>;
}

