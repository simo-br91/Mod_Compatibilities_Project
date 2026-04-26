# Phase 6 Progress

## Goal area

- Phase 6 source of truth: simulation, release gating, and partner integrations from `IMPLEMENTATION_PLAN.md`
- Scope implemented across two slices:
  - deterministic simulation replay, simulation-result feedback into confidence, and release-gating policy evaluation
  - deterministic partner-facing surfaces for GitHub-installation linking, status-check output, and webhook registry/fan-out

## What was implemented

- `packages/platform-core` now includes a deterministic `simulation` phase that runs replayable smoke-test recipes, emits simulation observations, and reproduces known crash-signature classes for selected compatibility paths.
- Simulation output now feeds back into findings by adding simulation evidence, provenance, explanation text, and confidence inputs for affected incompatibility and overlap findings.
- A new `release_gating` phase now evaluates findings plus simulation outcomes and materializes a pass/warn/block decision with explicit reasons and blocking finding IDs.
- Reports now include simulation-run and release-gate outputs alongside findings, recommendations, grounded review summaries, and operator feedback.
- Gateway surfaces now expose:
  - `GET /v1/analyses/:analysisId/simulation`
  - `GET /v1/analyses/:analysisId/release-gate`
- Deterministic partner-facing surfaces now exist for:
  - `POST /v1/integrations/github/installations/:installationId/link`
  - `GET /v1/analyses/:analysisId/status-check`
  - `POST /v1/webhooks`
  - `GET /v1/webhooks`
  - `GET /v1/analyses/:analysisId/webhook-deliveries`
- Analysis completion now materializes a status-check result and deterministic webhook delivery attempts derived from the release-gate outcome.
- `apps/notification` is no longer a pure skeleton; it now exposes deterministic webhook and status-check boundaries on top of `platform-core`.
- `apps/simulation` is no longer a placeholder-only boundary; it now provides a deterministic simulation runner with Go tests.

## Contract updates

- Shared domain and API contracts now cover:
  - smoke-test recipes
  - crash signatures
  - simulation runs
  - release-gate decisions
  - GitHub installation links
  - webhook registrations and delivery attempts
  - status-check results
- `schemas/json/` now includes machine-readable schemas for:
  - `simulation-run`
  - `release-gate-decision`
- `schemas/openapi/platform.openapi.yaml` now documents the simulation-run and release-gate endpoints and includes simulation/gate content inside the analysis report schema.
- `schemas/openapi/platform.openapi.yaml` now also documents GitHub-installation linking, webhook delivery listing, and analysis status-check retrieval with response shapes aligned to the deterministic runtime.
- `schemas/sql/postgres_core.sql` now includes persistence contracts for smoke-test recipes, crash signatures, simulation runs, release-gate decisions, GitHub installation links, webhook registrations, webhook delivery attempts, and status-check results.
- Analysis phase enums are now aligned across runtime and contracts to include `simulation` and `release_gating`.

## Deterministic fixtures and tests

- Replayable simulation inputs live under `fixtures/simulation/phase6-simulation-fixtures.json`.
- `packages/platform-core/src/phase6.test.ts` covers:
  - deterministic simulation materialization
  - simulation evidence feeding findings
  - release-gate evaluation
  - report integration
- `apps/simulation/internal/app/service_test.go` covers the deterministic simulation worker behavior.

## Usable flow

- `platform.orchestrator.createAnalysis(...)` with `runSimulation: true` now executes:
  - `risk_scoring`
  - `simulation`
  - `recommendation`
  - `release_gating`
  - `reporting`
- `platform.simulation.getRun(...)` retrieves the deterministic simulation result for an analysis.
- `platform.releaseGates.getDecision(...)` retrieves the release-gate decision for an analysis.
- `platform.notifications.getStatusCheck(...)` retrieves the deterministic status-check result derived from the analysis release-gate outcome.
- `platform.notifications.listDeliveries(...)` retrieves replayable webhook delivery attempts for an analysis.
- `platform.integrations.linkGitHubInstallation(...)` stores the project-to-installation binding used by status-check outputs.
- `platform.reports.getReport(...)` now surfaces simulation and gate outcomes in a single report payload.

## Validation

- `pnpm contracts:check`
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts`
- `pnpm --filter @modcompat/notification exec tsx src/index.ts`
- `go test ./...` from `apps/simulation` with `GOCACHE` pointed at the workspace-local `.gocache`
- `python -m unittest discover -s tests` from `apps/ml` with `PYTHONPATH` pointed at `apps/ml/src`

## Validation blockers

- `pnpm --filter @modcompat/platform-core test` remains blocked in this sandbox because Node's test runner attempts to spawn worker processes and fails with `spawn EPERM`.
- The gateway demo path still exercised the Phase 6 TypeScript slice end to end and emitted simulation and release-gate IDs successfully.
- `pnpm --filter @modcompat/notification exec tsx src/index.ts` also hit sandbox `spawn EPERM` because `tsx`/esbuild process spawning is restricted in this environment; this is an execution-environment limitation rather than a known notification-app code failure.

## Remaining gaps

- Simulation remains deterministic and fixture-backed rather than a real sandboxed game/runtime execution environment.
- Crash signatures are replayable known-pattern matches rather than mined from live crash logs.
- Release gating is implemented as a deterministic policy engine and deterministic status-check output, not yet wired to live GitHub Checks APIs or external provider delivery.
- Webhook fan-out is implemented as deterministic local delivery recording, not real network delivery with retries, signatures, or dead-letter queues.
- Partner quotas, billing hooks, SLA controls, and broader API hardening remain deferred beyond this extended Phase 6 slice.
