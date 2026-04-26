# Phase 13 Progress - CI and Release Engineering Slice

## Status

Multiple concrete Phase 13 delivery slices are now in place.

This update does not claim that all of Phase 13 is complete. It establishes the first real automated CI workflow for the repository, adds a dispatchable staging smoke workflow for the live service topology, adds a curated regression-fixture gate for analysis quality, introduces a compose-backed backend staging deployment path, and fixes the immediate repo issues that were blocking a practical multi-language validation pass.

It now also includes a completed local Docker-backed validation pass for the compose runtime, a staging canary gate with emitted monitoring metrics, release-state verification, and a gateway smoke-flow fix so the live linked-evidence assertion uses an evidence-backed demo finding instead of depending on unstable finding ordering.

The reliability slice also surfaced and fixed an admin-service replay bug where failed write requests could still populate the in-memory idempotency cache before persistence completed.

The larger post-Phase-13 platform steps that still remain include:

- broader end-to-end and expanded regression coverage beyond the initial curated pack fixtures
- remote image publishing, persistent deployment targets, and true historical image rollback

---

## What Was Completed

### `.github/workflows/ci.yml`

Added the repository's first GitHub Actions CI workflow with separate jobs for:

- Node/TypeScript contract validation, repo-wide typechecking, tests, and web build
- Go test execution across:
  - `apps/analysis-orchestrator`
  - `apps/graph`
  - `apps/recommendation`
  - `apps/resolver`
  - `apps/simulation`
- Python ML unit tests
- JVM artifact-analysis tests

The Node job provisions PostgreSQL as a workflow service and exports `POSTGRES_URL` so the live `platform-core` Postgres smoke test can execute in CI instead of staying skipped.

### `.github/workflows/staging-smoke.yml`

Added a dedicated GitHub Actions staging smoke workflow that can be launched with `workflow_dispatch`.

This job provisions PostgreSQL, sets up Node, pnpm, Go, and Java, then runs the repository's new staging smoke runner against the live multi-service topology. It also uploads the generated smoke logs as a workflow artifact on both success and failure so startup/runtime issues are inspectable after the run.

### `scripts/staging/phase13_smoke.ts`

Added a reusable staging smoke runner that:

- waits for a reachable `POSTGRES_URL`
- compiles and starts the JVM artifact-analysis HTTP service
- starts the live evidence, admin, orchestrator, recommendation, graph, and simulation services
- waits for each service's `/healthz` endpoint
- executes the gateway demo flow against the active HTTP boundaries
- validates that persistence, replay behavior, asynchronous orchestration, and cross-service outputs all succeeded
- writes per-service logs under `.staging-smoke-logs/`

The runner also supports `--dry-run`, which prints the exact topology and commands that would be started without launching services. This makes it usable both for GitHub Actions and for local environment validation before running the full smoke path.

It now also supports `--probe-only`, which skips local process startup and validates already-deployed services. This is what the release workflow uses after deploying the compose-backed staging runtime.

### `fixtures/truth-sets/phase13-regression-fixtures.json`

Added a curated Phase 13 regression truth set with three representative pack fixtures:

- a healthy Fabric baseline
- an OptiFine + Sodium incompatibility pack
- an OptiFine version-drift edge case

Each fixture captures the expected stable outputs for:

- emitted finding types
- severity counts and overall score
- recommendation counts and recommendation-kind mix
- simulation observation outcomes
- release gate status

### `packages/platform-core/src/phase13-regression.test.ts`

Added a dedicated regression suite that executes full import-to-analysis flows for the curated pack fixtures and asserts stable:

- findings
- recommendations and recommendation bundles
- simulation results
- release gate decisions
- report wiring for the same outputs

This makes recommendation quality and simulation drift visible through a single deterministic quality gate instead of only through ad hoc demo validation.

### Regression scripts and CI wiring

Added a dedicated `test:regression` script at both the repository root and `@modcompat/platform-core`, then wired that script into `.github/workflows/ci.yml` as an explicit curated regression-fixture step.

The regression suite is still covered by the normal Node test run, but the separate CI step makes this quality gate visible in workflow results and easier to rerun locally.

### Release manifest and environment state

Added a first Phase 13 deployment-control slice under `infra/releases/`:

- `infra/releases/manifests/` for versioned release bundle manifests
- `infra/releases/environments/staging.json` for the staging environment pointer and rollback history

These manifests capture:

- release version
- git SHA and ref
- required validation checks
- deployable service inventory
- infrastructure dependency inventory

### `scripts/release/phase13_release.ts`

Added a dedicated release utility with:

- `bundle`
- `status`
- `deploy`
- `rollback`

This gives the repository a real, versioned release-control path for staging promotion and rollback state changes, even before container publishing and cluster apply automation are defined.

### `docker-compose.staging.yml` and `docker/`

Added the first repo-native deployable backend runtime assets for staging:

- `docker-compose.staging.yml` to run the backend service topology alongside the existing infrastructure compose stack
- `docker/node-service.Dockerfile` for the TypeScript HTTP services
- `docker/go-service.Dockerfile` for the Go services
- `docker/artifact-analysis.Dockerfile` for the JVM artifact-analysis HTTP service
- `.dockerignore` to keep the build context manageable

This creates a real containerized backend staging runtime that can be brought up with:

- `docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d --build`

The base infrastructure compose file now keeps Kafka behind an optional profile because the currently validated Phase 13 runtime does not consume it yet, and the previous pinned image path no longer resolves cleanly for default local startup.

### `.github/workflows/release-staging.yml`

Added the first staging release workflow with manual `workflow_dispatch` actions for:

- `deploy`
- `rollback`

The deploy path:

- runs contracts, typecheck, curated regression, web build, and staging smoke
- deploys the backend staging topology through Docker Compose on the GitHub Actions runner
- runs a staging canary against the deployed runtime and emits JSON/Prometheus-style probe artifacts
- runs the staging smoke runner in `--probe-only` mode against the deployed services
- creates a versioned release manifest
- promotes the release into the staging environment state
- verifies the resulting release control-plane references
- uploads release metadata as an artifact
- commits the updated release metadata back to the branch

The rollback path:

- restores staging to the previous or explicitly requested release version
- records the rollback in environment history
- uploads release metadata as an artifact
- commits the rollback state change back to the branch

Because the workflow does not yet publish versioned images to a remote registry, rollback currently updates tracked release state rather than redeploying a previously published image set.

### `scripts/staging/phase13_canary.ts`

Added a lightweight staging canary runner that:

- waits for PostgreSQL connectivity
- verifies `/healthz` on the artifact-analysis, evidence, admin, orchestrator, recommendation, graph, and simulation services
- executes a sample artifact-analysis overlap/divergence request
- executes evidence sync and search probes
- executes admin curation and promotion probes
- writes both a JSON report and Prometheus-style metrics output for the latest run

This gives the release workflow a fast pre-smoke gate and provides concrete monitoring artifacts for later scraping and dashboard wiring.

### Release-state verification

Extended the Phase 13 release utility with a `verify` command and added `pnpm release:verify:staging`.

This validates that:

- referenced release manifests exist
- compose files referenced by manifests are still present
- service health URLs are parseable
- operator probe commands are declared
- environment history does not point at missing manifest paths

That makes the release-control slice safer to operate and gives the repo a concrete disaster-recovery validation entrypoint for its current release metadata model.

### Monitoring and runbook assets

Added repo-native monitoring and operator assets under `infra/monitoring/` and `docs/operations/reliability.md` for:

- staging canary SLOs
- alert rules
- a starter Grafana dashboard
- runbook guidance for canary, health, and release-control failures
- release-control-plane disaster-recovery validation guidance

### Operations docs

Added `docs/operations/release-management.md` and linked it from `bootstrap.md` so operators have a documented manual path for release bundling, promotion, and rollback.

### `apps/analysis-orchestrator/package.json`

Added a real `test` script so the orchestrator HTTP/service tests participate in repo-level `pnpm test` execution and in CI without requiring one-off commands.

Added a `typecheck` script together with a dedicated `tsconfig.json` so the hybrid Go/TypeScript orchestrator is part of the repo-wide TypeScript validation path.

### `apps/web/next.config.mjs`

Replaced the unsupported `next.config.ts` entrypoint with `next.config.mjs` so `next build` can run in CI and locally on supported Next.js configuration paths.

### TypeScript workspace configs and scripts

Added missing TypeScript project configs and `typecheck` scripts across the monorepo so `pnpm typecheck` now validates the active TypeScript packages and service apps directly instead of relying on incidental transitive compilation.

This also included:

- enabling `.ts` import-path support in the shared base TypeScript config
- removing overly narrow `rootDir` settings that broke workspace-package imports
- fixing stale type mismatches in gateway, orchestrator, and `platform-core`

---

## Validation Notes

Validated or investigated the commands needed for this Phase 13 slice in the current environment:

- `pnpm contracts:check` passes
- `pnpm typecheck` passes in an unrestricted local run and is now suitable for CI gating
- `pnpm test` passes in an unrestricted local run after the new `analysis-orchestrator` test script was added
- `pnpm test:regression` is now the dedicated entrypoint for the curated pack-fixture regression gate
- `pnpm release:status -- --environment staging` now exposes the tracked staging release pointer
- `pnpm release:bundle`, `pnpm release:deploy:staging`, and `pnpm release:rollback:staging` now provide local and workflow entrypoints for release control
- `pnpm release:verify:staging` now validates release manifests and environment-state references before operators trust a promotion or rollback state
- `docker compose -f docker-compose.yml -f docker-compose.staging.yml config` resolves successfully for the new compose-backed staging runtime
- `pnpm runtime:staging:up` now completes successfully against a live local Docker Desktop daemon after making Kafka opt-in for the default runtime
- `pnpm canary:staging` is now the lightweight pre-smoke runtime gate and emits both `.phase13-canary-report.json` and `.phase13-canary.prom`
- `pnpm smoke:staging -- --probe-only` now passes against the running local compose-backed staging stack
- `pnpm runtime:staging:down` is the local cleanup path for the validated stack
- `pnpm --filter @modcompat/web build` passes after replacing `next.config.ts` with `next.config.mjs`
- `pnpm smoke:staging -- --dry-run` now runs successfully in an unrestricted local run and prints the expected live service topology
- the live Docker-backed smoke pass surfaced and fixed a real gateway bug where linked-evidence validation depended on `demo.findings[0]` instead of selecting an evidence-backed finding
- the live Docker-backed canary pass surfaced and fixed an admin replay-cache bug where failed write requests could be cached before persistence completed
- Python ML tests pass when `PYTHONPATH=apps/ml/src` is set
- Go tests pass for the tracked Go services when a writable local cache directory is provided in this sandboxed environment
- local child-process restrictions in the default sandbox were the main reason the Node test and Next.js build checks previously appeared unstable; unrestricted validation confirms the repo commands themselves are now working for this slice

The JVM artifact-analysis test job was wired for CI, but it was not validated locally in this environment because Gradle is not installed outside GitHub Actions setup steps.

---

## Scope Note

This file documents the completed Phase 13 CI/bootstrap, curated regression-fixture, staging-smoke, and first release-control slices only.

It does **not** claim that the full release-readiness roadmap from `NEXT_STEPS_TO_DONE.md` is finished yet. What is now in place is the first automated, multi-language merge-validation foundation that later Phase 13 work can build on.
