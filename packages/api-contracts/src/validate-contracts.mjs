import { access } from "node:fs/promises";
import { constants } from "node:fs";

const requiredFiles = [
  "../../../schemas/openapi/platform.openapi.yaml",
  "../../../schemas/events/analysis.requested.schema.json",
  "../../../schemas/events/analysis.finding.emitted.schema.json",
  "../../../schemas/json/artifact-analysis.schema.json",
  "../../../schemas/json/analysis-report.schema.json",
  "../../../schemas/json/calibrated-finding-score.schema.json",
  "../../../schemas/json/evidence-document.schema.json",
  "../../../schemas/json/evidence-search-response.schema.json",
  "../../../schemas/json/finding-feature-vector.schema.json",
  "../../../schemas/json/graph.snapshot.schema.json",
  "../../../schemas/json/offline-dataset.schema.json",
  "../../../schemas/json/pack-diff.schema.json",
  "../../../schemas/json/release-gate-decision.schema.json",
  "../../../schemas/json/pack-review-summary.schema.json",
  "../../../schemas/json/knowledge-snapshot.schema.json",
  "../../../schemas/json/recommendation-feedback.schema.json",
  "../../../schemas/json/recommendation-outcome.schema.json",
  "../../../schemas/json/recommendation-set.schema.json",
  "../../../schemas/json/recommendation.schema.json",
  "../../../schemas/json/retrieval-analysis-response.schema.json",
  "../../../schemas/json/simulation-run.schema.json",
  "../../../schemas/json/supported-coverage-scope.schema.json",
  "../../../schemas/json/source-sync-run.schema.json",
  "../../../schemas/sql/postgres_core.sql"
];

await Promise.all(
  requiredFiles.map(async (file) => {
    await access(new URL(file, import.meta.url), constants.R_OK);
  })
);

console.log("Contracts are present.");
