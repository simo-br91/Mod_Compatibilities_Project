import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { AnalysisEnvironment, PackModReference } from "@modcompat/domain-models";

import { createPhase1Platform } from "./index.js";

interface RegressionFixtureCase {
  fixtureId: string;
  description: string;
  environment: AnalysisEnvironment;
  mods: PackModReference[];
  expected: {
    findingTypes: string[];
    severityCounts: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      info: number;
    };
    score: number;
    recommendationCount: number;
    recommendationKindCounts: Record<string, number>;
    bundleStrategies: string[];
    simulationStatus: "completed" | "failed";
    observationOutcomes: string[];
    releaseGateStatus: "pass" | "warn" | "block";
    requiredCandidateProjectIds?: string[];
    requiredRecommendationSummarySnippets?: string[];
  };
}

function loadRegressionFixtures() {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../fixtures/truth-sets/phase13-regression-fixtures.json"),
      "utf8"
    )
  ) as {
    cases: RegressionFixtureCase[];
  };
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

function runRegressionAnalysis(fixture: RegressionFixtureCase) {
  const platform = createPhase1Platform();
  platform.evidence.syncFixtures();

  const session = platform.auth.createSession();
  const imported = platform.imports.importModList({
    projectId: "prj_demo",
    createdBy: session.user.userId,
    environment: fixture.environment,
    mods: fixture.mods
  });

  const result = platform.orchestrator.createAnalysis("prj_demo", {
    trigger: "manual",
    analysisMode: "standard",
    inputRef: {
      type: "pack_snapshot",
      id: imported.snapshot.packSnapshotId
    },
    environment: imported.snapshot.environment,
    options: {
      includeAlternatives: true,
      includeLowConfidence: true,
      runSimulation: true
    }
  });

  const report = platform.reports.getReport(result.analysis.analysisId);
  return { platform, imported, result, report };
}

test("phase 13 curated pack fixtures keep findings, recommendations, simulation, and release-gate outputs stable", () => {
  const fixtures = loadRegressionFixtures();

  for (const fixture of fixtures.cases) {
    const { result, report } = runRegressionAnalysis(fixture);
    const findingTypes = result.findings.map((finding) => finding.type).sort();
    const recommendationKinds = countBy(
      result.recommendations.map((recommendation) => recommendation.kind)
    );
    const candidateProjectIds = [...new Set(
      result.recommendations.flatMap(
        (recommendation) =>
          recommendation.candidateProjects?.map((candidate) => candidate.projectId) ?? []
      )
    )].sort();
    const observationOutcomes = (result.simulationRun?.observations ?? [])
      .map((observation) => `${observation.kind}:${observation.status}`)
      .sort();
    const bundleStrategies = (result.recommendationSet?.bundles ?? [])
      .map((bundle) => bundle.strategy)
      .sort();

    assert.deepEqual(
      findingTypes,
      fixture.expected.findingTypes.slice().sort(),
      `${fixture.fixtureId}: finding types drifted`
    );
    assert.deepEqual(
      result.analysis.counts,
      fixture.expected.severityCounts,
      `${fixture.fixtureId}: severity counts drifted`
    );
    assert.equal(
      result.analysis.score,
      fixture.expected.score,
      `${fixture.fixtureId}: analysis score drifted`
    );
    assert.equal(
      result.recommendations.length,
      fixture.expected.recommendationCount,
      `${fixture.fixtureId}: recommendation count drifted`
    );
    assert.deepEqual(
      recommendationKinds,
      fixture.expected.recommendationKindCounts,
      `${fixture.fixtureId}: recommendation kind mix drifted`
    );
    assert.deepEqual(
      bundleStrategies,
      fixture.expected.bundleStrategies.slice().sort(),
      `${fixture.fixtureId}: bundle strategies drifted`
    );
    assert.equal(
      result.recommendationSet?.summary.recommendationCount,
      fixture.expected.recommendationCount,
      `${fixture.fixtureId}: recommendation-set summary count drifted`
    );
    assert.equal(
      result.recommendationSet?.summary.bundleCount,
      fixture.expected.bundleStrategies.length,
      `${fixture.fixtureId}: recommendation-set bundle count drifted`
    );
    assert.equal(
      result.simulationRun?.status,
      fixture.expected.simulationStatus,
      `${fixture.fixtureId}: simulation status drifted`
    );
    assert.deepEqual(
      observationOutcomes,
      fixture.expected.observationOutcomes.slice().sort(),
      `${fixture.fixtureId}: simulation observations drifted`
    );
    assert.equal(
      result.releaseGateDecision?.status,
      fixture.expected.releaseGateStatus,
      `${fixture.fixtureId}: release gate status drifted`
    );
    assert.equal(
      report.releaseGateDecision?.status,
      fixture.expected.releaseGateStatus,
      `${fixture.fixtureId}: report release gate status drifted`
    );
    assert.equal(
      report.simulationRun?.status,
      fixture.expected.simulationStatus,
      `${fixture.fixtureId}: report simulation status drifted`
    );
    assert.equal(
      report.findings.length,
      result.findings.length,
      `${fixture.fixtureId}: report finding count drifted`
    );
    assert.equal(
      report.recommendations.length,
      result.recommendations.length,
      `${fixture.fixtureId}: report recommendation count drifted`
    );
    assert.ok(
      report.decisionSummary.minimalUnblockSummary,
      `${fixture.fixtureId}: minimal unblock summary should be present`
    );
    assert.ok(
      report.decisionSummary.stabilityFirstSummary,
      `${fixture.fixtureId}: stability-first summary should be present`
    );
    assert.ok(
      result.phases.some((phase) => phase.phaseName === "simulation"),
      `${fixture.fixtureId}: simulation phase should be present`
    );
    assert.ok(
      result.phases.some((phase) => phase.phaseName === "recommendation"),
      `${fixture.fixtureId}: recommendation phase should be present`
    );
    assert.ok(
      result.phases.some((phase) => phase.phaseName === "release_gating"),
      `${fixture.fixtureId}: release-gating phase should be present`
    );

    if (fixture.expected.requiredCandidateProjectIds) {
      assert.deepEqual(
        candidateProjectIds,
        fixture.expected.requiredCandidateProjectIds.slice().sort(),
        `${fixture.fixtureId}: replacement candidate projects drifted`
      );
    }

    for (const snippet of fixture.expected.requiredRecommendationSummarySnippets ?? []) {
      assert.ok(
        result.recommendations.some((recommendation) => recommendation.summary.includes(snippet)),
        `${fixture.fixtureId}: expected recommendation summary snippet missing: ${snippet}`
      );
    }
  }
});
