# Phase 7 Progress

## Goal area

- Phase 7 source of truth: persistence and runtime wiring from `NEXT_STEPS_TO_DONE.md`
- Scope implemented as the first durable persistence slice without breaking the existing deterministic in-memory demo flow

## What was implemented

- `packages/platform-core` now includes a `PostgresPlatformPersistence` adapter that can:
  - bootstrap the canonical SQL schema from `schemas/sql/postgres_core.sql`
  - persist project prerequisites, imports, snapshots, analyses, pack diffs, and their related Phase 4-6 outputs into PostgreSQL
  - read persisted analyses back from PostgreSQL
  - hydrate persisted analyses back into the in-memory repository so existing service APIs can keep working
- The persistence adapter now seeds prerequisite relational state for rerunnable development flows, including:
  - users, organizations, memberships, workspaces, and projects
  - canonical projects, aliases, versions, source mappings, dependencies, and incompatibilities
  - model registry entries
  - simulation recipes and crash signatures
  - webhook registrations and GitHub installation links
- `Phase1Platform` now exposes `platform.persistence` alongside the existing in-memory services.
- The gateway demo entrypoint now detects whether `POSTGRES_URL` is configured and, when available, can:
  - ensure the schema exists
  - persist the generated demo imports, snapshots, analysis, and pack diff
  - rehydrate the generated analysis from PostgreSQL
  - verify persisted import and pack-diff state
- `packages/config` now loads a local root `.env` file automatically if present, so local service runs can pick up `POSTGRES_URL` and the rest of the documented infrastructure variables without extra shell setup.
- `docker-compose.yml` was corrected so local Temporal and OpenSearch services now start successfully in the documented development stack.

## Persistence slice covered

The first durable slice now targets:

- organizations, users, memberships, workspaces, and projects required by the runnable demo
- canonical catalog data required by findings, imports, diffs, and simulation outputs
- pack imports
- pack snapshots and snapshot mods
- analysis summary rows
- analysis phases
- analysis events
- findings plus subjects, evidence refs, and recommended actions
- pack diffs and diff changes
- recommendation sets, recommendation items, bundles, feedback, and latest outcome
- offline datasets, feature vectors, and calibrated finding scores
- grounded review summaries
- simulation runs
- release-gate decisions
- status checks
- webhook delivery attempts
- analysis reports

## Validation

- `pnpm contracts:check`
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts`
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts` with `POSTGRES_URL` configured and local Postgres running
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts` rerun after Temporal/OpenSearch startup fixes and import/pack-diff persistence expansion

## Validation result

- The gateway demo flow still runs successfully after the Phase 7 changes.
- The new persistence surface is detected and reported by the gateway demo output.
- The first live Postgres round-trip now succeeds:
  - schema bootstrap is idempotent across reruns
  - required parent records are persisted before analysis rows
  - duplicate snapshots and integration links are handled idempotently across reruns
  - the generated analysis can be persisted and rehydrated successfully
- The expanded runtime slice now also verifies:
  - persisted import count is `2` for the demo flow
  - persisted pack diff lookup succeeds for the demo analysis
- Gateway demo output now reports:
  - `"enabled": true`
  - `"persisted": true`
  - `"hydrated": true`
  - `"importCount": 2`
  - `"packDiffPersisted": true`
- Local infrastructure validation now also confirms:
  - Temporal starts successfully after Compose fixes
  - OpenSearch starts successfully after Compose fixes

## Remaining work inside Phase 7

- Expand persistence beyond the current slice to cover evidence indexes, graph state, explanation paths, and object-storage-backed payloads.
- Introduce real Temporal runtime wiring instead of only durable analysis record persistence.
- Add explicit runtime scripts or service commands for schema bootstrap and persistence verification.

## What is still not done

- The executable platform still uses in-memory repositories as the primary runtime path, with Postgres used as the first durable backing store rather than the sole runtime source.
- Evidence indexes, graph snapshots, explanation paths, and object-storage-backed payloads are not yet durably wired.
- Temporal is running in local infrastructure, but orchestration still uses the in-memory Temporal-style adapter instead of the live Temporal SDK/runtime path.
- The gateway and services are still not running as fully separated live service boundaries.
