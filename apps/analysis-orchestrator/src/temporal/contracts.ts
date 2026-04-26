import type { CreateAnalysisRequest } from "../../../../packages/api-contracts/src/index.ts";
import type { AnalysisResult } from "../../../../packages/platform-core/src/index.ts";

export interface CreateAnalysisHttpRequest {
  projectId: string;
  request: CreateAnalysisRequest;
}

export interface TemporalAnalysisWorkflowResult {
  analysisId: string;
  result: AnalysisResult;
}
