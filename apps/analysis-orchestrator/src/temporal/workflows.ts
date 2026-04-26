import { proxyActivities } from "@temporalio/workflow";

import type {
  CreateAnalysisHttpRequest,
  TemporalAnalysisWorkflowResult
} from "./contracts.js";

interface AnalysisWorkflowActivities {
  executeAnalysisActivity(
    payload: CreateAnalysisHttpRequest
  ): Promise<TemporalAnalysisWorkflowResult>;
}

const { executeAnalysisActivity } = proxyActivities<AnalysisWorkflowActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "5 seconds",
  retry: {
    maximumAttempts: 1
  }
});

export async function analysisRequestWorkflow(
  payload: CreateAnalysisHttpRequest
): Promise<TemporalAnalysisWorkflowResult> {
  return executeAnalysisActivity(payload);
}
