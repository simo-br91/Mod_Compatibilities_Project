import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPhase1Platform } from "./index.js";

function loadPhase5TruthSet() {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../fixtures/ml/phase5-analysis-truth-set.json"),
      "utf8"
    )
  ) as {
    expected: {
      top_risk_finding_type: string;
      required_bundle_strategy: "minimal_unblock" | "stability_first";
      summary_must_cite: string[];
    };
  };
}

test("phase 5 analysis materializes feature datasets, calibrated scores, and grounded review summaries", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const truth = loadPhase5TruthSet();

  assert.ok(demo.featureDataset);
  assert.ok(demo.featureVectors);
  assert.ok(demo.calibratedScores);
  assert.ok(demo.reviewSummary);
  assert.ok(demo.phases.some((phase) => phase.phaseName === "risk_scoring"));
  assert.equal(demo.featureDataset!.summary.rowCount, demo.findings.length);
  assert.equal(demo.calibratedScores!.length, demo.findings.length);
  assert.equal(
    demo.recommendationSet!.bundles.some(
      (bundle) => bundle.strategy === truth.expected.required_bundle_strategy
    ),
    true
  );

  const topFinding = demo.findings
    .slice()
    .sort((left, right) => right.confidence - left.confidence)[0];

  assert.equal(topFinding?.type, truth.expected.top_risk_finding_type);
});

test("phase 5 grounded summaries remain cited and report surfaces include review output", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const report = platform.reports.getReport(demo.analysis.analysisId);
  const dataset = platform.ml.getDatasetForAnalysis(demo.analysis.analysisId);
  const review = platform.ml.getReviewSummary(demo.analysis.analysisId);

  assert.ok(review.sections.length >= 1);
  assert.ok(
    review.sections.every((section) =>
      section.citations.some((citation) => citation.citationType === "finding")
    )
  );
  assert.ok(
    review.sections.some((section) =>
      section.citations.some((citation) => citation.citationType === "recommendation")
    )
  );
  assert.equal(report.reviewSummary?.reviewSummaryId, review.reviewSummaryId);
  assert.equal(dataset.featureVectors.length, demo.findings.length);
});
