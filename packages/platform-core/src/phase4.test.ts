import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPhase1Platform } from "./index.js";

function loadPhase4Fixtures() {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../fixtures/recommendations/phase4-feedback-fixtures.json"),
      "utf8"
    )
  ) as {
    feedback: Array<{
      feedbackType: "accepted" | "dismissed" | "helpful" | "not_helpful";
      note: string;
      createdBy: string;
    }>;
    outcome: {
      status: "validated" | "pending" | "rejected" | "deferred";
      validationSummary: string;
      createdBy: string;
    };
  };
}

test("phase 4 analysis persists recommendation sets, remediation bundles, and reports", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();

  assert.ok(demo.recommendationSet);
  assert.equal(demo.recommendationSet!.analysisId, demo.analysis.analysisId);
  assert.equal(demo.recommendationSet!.bundles.length, 2);
  assert.ok(
    demo.recommendations.every(
      (recommendation) =>
        (recommendation.findingIds?.length ?? 0) >= 0 &&
        (recommendation.steps?.length ?? 0) >= 1
    )
  );
  assert.ok(
    demo.recommendationSet!.bundles.some((bundle) => bundle.strategy === "minimal_unblock")
  );
  assert.ok(
    demo.recommendationSet!.bundles.some((bundle) => bundle.strategy === "stability_first")
  );
  assert.ok(demo.report);
  assert.equal(demo.report!.recommendationSet?.recommendationSetId, demo.recommendationSet!.recommendationSetId);
});

test("phase 4 recommendation feedback, outcomes, and exports are deterministic", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const fixtures = loadPhase4Fixtures();
  const firstRecommendation = demo.recommendations[0];

  assert.ok(firstRecommendation);
  assert.ok(demo.recommendationSet);

  const accepted = platform.recommendations.submitFeedback({
    recommendationId: firstRecommendation!.recommendationId,
    ...fixtures.feedback[0]!
  });
  const helpful = platform.recommendations.submitFeedback({
    recommendationId: firstRecommendation!.recommendationId,
    ...fixtures.feedback[1]!
  });

  const outcome = platform.recommendations.recordOutcome({
    recommendationSetId: demo.recommendationSet!.recommendationSetId,
    appliedRecommendationIds: [firstRecommendation!.recommendationId],
    ...fixtures.outcome
  });

  const report = platform.reports.getReport(demo.analysis.analysisId);
  const markdownExport = platform.reports.exportReport({
    analysisId: demo.analysis.analysisId,
    format: "markdown"
  });

  assert.equal(accepted.feedbackType, "accepted");
  assert.equal(helpful.feedbackType, "helpful");
  assert.equal(outcome.status, "validated");
  assert.equal(report.feedback.length, 2);
  assert.equal(report.latestOutcome?.outcomeId, outcome.outcomeId);
  assert.match(markdownExport.downloadUrl, /^local:\/\/reports\/.+\.md$/);
  assert.ok(markdownExport.content?.includes("Minimal unblock"));

  const updatedSet = platform.recommendations.getSetByAnalysis(demo.analysis.analysisId);
  const updatedRecommendation = updatedSet.items.find(
    (recommendation) => recommendation.recommendationId === firstRecommendation!.recommendationId
  );

  assert.equal(updatedRecommendation?.status, "applied");
});
