# Phase 4 Progress

## Goal area

- Phase 4 source of truth: recommendations, remediation, and quality loops from `IMPLEMENTATION_PLAN.md`
- Scope implemented on top of the working Phase 3 backbone rather than a parallel prototype

## What was implemented

- `packages/platform-core` now persists deterministic recommendation sets per analysis, including ranked recommendation items, remediation steps, impacts, and bundle plans for `minimal_unblock` and `stability_first`.
- The recommendation phase now consumes merged and evidence-enriched findings, pack-diff context, canonical replacement mappings, and dependency data to generate explainable replacements and remediation plans.
- Recommendation feedback capture and outcome tracking are implemented in-memory and update recommendation status through `proposed -> accepted/dismissed -> applied`.
- Reporting is now real instead of placeholder-only: each analysis materializes a persisted report record plus deterministic `json` and `markdown` export payloads tied to findings, recommendation bundles, feedback, and the latest outcome.
- Gateway surfaces now expose recommendation feedback, recommendation outcomes, and analysis report/export routes.
- The Go recommendation service placeholder was replaced with a deterministic Phase 4 recommendation-set generator and test coverage for its minimal vertical slice.

## Contract updates

- Shared domain and API contracts now cover recommendation sets, bundles, steps, impacts, feedback, outcomes, and richer analysis reports/export responses.
- `schemas/json/` now includes machine-readable schemas for recommendation sets, recommendation feedback, recommendation outcomes, and analysis reports.
- `schemas/openapi/platform.openapi.yaml` now documents recommendation feedback submission, recommendation outcome recording, richer recommendations responses, and expanded report payloads.
- `schemas/sql/postgres_core.sql` now includes recommendation bundle, feedback, outcome, and analysis report persistence structures in addition to richer recommendation-set/item storage.
- Event contracts now allow `analysis.completed` to carry `recommendation_set_id` and `report_id`, and `recommendation.generated` to carry the full recommendation set payload.

## Deterministic fixtures and tests

- Replayable feedback/outcome fixtures live under `fixtures/recommendations/phase4-feedback-fixtures.json`.
- `packages/platform-core/src/phase4.test.ts` covers recommendation-set persistence, remediation bundle generation, feedback/outcome tracking, and deterministic report exports.
- `apps/recommendation/internal/app/service_test.go` covers the Go recommendation service bundle generation path.

## Usable flow

- `platform.orchestrator.createAnalysis(...)` now returns `recommendationSet` and `report` alongside findings, recommendations, graph, artifacts, and pack diff.
- `platform.recommendations.getSetByAnalysis(...)` retrieves the persisted recommendation set for an analysis.
- `platform.recommendations.submitFeedback(...)` and `platform.recommendations.recordOutcome(...)` provide deterministic quality-loop capture for recommendation review and validation.
- `platform.reports.getReport(...)` and `platform.reports.exportReport(...)` provide inspectable analysis reports and replayable exports.

## Validation

- `pnpm contracts:check`
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts`
- `go test ./...` from `apps/recommendation` with `GOCACHE` pointed at the workspace-local `.gocache`

## Validation blockers

- `pnpm --filter @modcompat/platform-core test` is still blocked in this sandbox because Node's test runner and inline `tsx` verification attempt to spawn worker processes and fail with `spawn EPERM`.
- The TypeScript Phase 4 runtime was still exercised successfully through the gateway entrypoint, which runs the end-to-end demo analysis and emits the new recommendation/report outputs.

## Remaining gaps

- Recommendation persistence, feedback, outcomes, and reports remain in-memory only; SQL contracts are ready, but no Postgres adapter is wired yet.
- Ranking, migration-cost estimation, and bundle assembly are deterministic heuristics rather than graph-history, telemetry, or ML-backed models.
- Report export is implemented for `json` and `markdown`; binary/PDF rendering remains deferred.
- Recommendation feedback is captured against recommendations rather than yet feeding a calibration pipeline or long-term analytics store.
