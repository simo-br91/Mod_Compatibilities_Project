import assert from "node:assert/strict";
import test from "node:test";

import { createPhase1Platform } from "./index.js";

test("phase 2 demo analysis produces artifacts, graph, and diff output", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();

  assert.ok(demo.artifacts && demo.artifacts.length > 0);
  assert.ok(demo.graph && demo.graph.nodes.length > 0);
  assert.ok(demo.packDiff && demo.packDiff.changes.length > 0);
  assert.ok(
    demo.findings.some((finding) =>
      ["mixin_overlap", "embedded_library_divergence", "resource_collision"].includes(
        finding.type
      )
    )
  );
});

test("graph neighborhood and explanations are retrievable", () => {
  const platform = createPhase1Platform();
  const demo = platform.createDemoFlow();
  const firstFinding = demo.findings[0];

  assert.ok(demo.graph);
  const neighborhood = platform.graph.getNeighborhood(
    demo.analysis.analysisId,
    demo.graph!.nodes[0]!.nodeId,
    2
  );
  const explanation = platform.graph.explainFinding(
    demo.analysis.analysisId,
    firstFinding!.findingId
  );

  assert.ok(neighborhood.nodes.length >= 1);
  assert.equal(explanation.findingId, firstFinding!.findingId);
});
