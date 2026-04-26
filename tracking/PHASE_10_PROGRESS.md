# Phase 10 Progress - Intelligence Upgrade from Deterministic to Real

## Status

Core Phase 10 intelligence slice complete for the currently started implementation.

This update finishes the repo work that had already begun around:

- rule DSL validation, versioning, and promotion
- model registry deployment and rollback flow
- recommendation feedback aggregation for evaluation signals
- durable Postgres persistence hooks for the new Phase 10 rule/model/feedback state

The broader roadmap items listed in `NEXT_STEPS_TO_DONE.md` are still larger than this slice. In particular, deeper JVM artifact analysis, semantic retrieval/reranking infrastructure, offline-trained inference artifacts, and fully sandboxed real simulation execution are still future work.

---

## What Was Completed

### `packages/platform-core/src/rule-draft.ts`

- Fixed the reproducibility validation set to match the shared domain model:
  - `confirmed`
  - `likely`
  - `intermittent`
  - `not_tested`
- Rule version assignment now advances from:
  - existing promoted history
  - the currently active verified rule
  - already-created pending drafts
- Validation now rejects malformed DSL inputs more safely:
  - blank recommended actions
  - `version_range` conditions without bounds
  - `version_range` conditions with reversed bounds
- Promotion now preserves `version_range` conditions instead of silently dropping them.

### `packages/platform-core/src/helpers.ts`

- Added `compareLooseVersions(left, right)` for deterministic version ordering across loose Minecraft/mod version strings.
- Added `isVersionWithinRange(version, minVersion?, maxVersion?)` to support version-aware rule execution.

### `packages/platform-core/src/types.ts`

- Extended `VerifiedRuleDefinition.conditions` to support:
  - `version_range`

### `packages/platform-core/src/services.ts`

- `VerifiedRuleEngine` now executes `version_range` conditions against resolved snapshot mods.
- Version-aware rule matches use the mod's declared version first, then the canonical version label when available.
- Rule-emitted findings now include subjects referenced by `version_range` conditions as well as `project_present`.

### `packages/platform-core/src/model-registry.ts`

- Added idempotent model registration for identical `modelKey + version + task` payloads.
- Added `ModelVersionConflictError` when a duplicate version is registered with different metrics/config.
- Rollback now preserves the previously active model as `rollback_ready`, allowing fast roll-forward after a rollback.
- Feedback aggregation now counts unique scoped analyses instead of trusting raw input length.

### `packages/platform-core/src/index.ts`

- Barrel exports added:
  - `rule-draft.js`
  - `model-registry.js`
- `Phase1Platform` now exposes:
  - `ruleDrafts`
  - `modelVersions`
  - `feedbackSignals`

### `packages/platform-core/src/persistence.ts`

- Added incremental schema bootstrap for existing databases so the new Phase 10 tables are created even when the base schema already exists.
- Added durable Postgres persistence APIs for:
  - rule drafts
  - rule version history
  - model registry entries
  - model evaluations
  - feedback signal reports
- Added matching read/hydrate methods so persisted Phase 10 state can be reloaded into the in-memory repository after restart.
- `hydrateAdminState()` now hydrates persisted rule drafts in addition to verified rules.

### `schemas/sql/postgres_core.sql`

- Added canonical schema tables for:
  - `rule_drafts`
  - `rule_version_history`
  - `model_evaluations`
  - `feedback_signal_reports`
- Added supporting indexes for rule draft, rule history, model evaluation, and feedback report lookups.

### `apps/analysis-orchestrator/src/index.ts`

- Startup hydration now reloads persisted model registry entries before analysis execution so deployed model versions can affect live analysis after restart.

---

## Test Coverage

### `packages/platform-core/src/phase10.test.ts`

Added a real Phase 10 suite covering:

- rule draft version increments from live rules and pending drafts
- valid vs invalid rule DSL validation behavior
- promotion of version-aware rules into the verified rule engine
- model deployment and rollback state transitions
- idempotent model registration and conflict rejection
- evaluation-signal aggregation from recommendation feedback/outcomes
- disabled-mode persistence API behavior for the new Phase 10 stores
- gated live Postgres smoke for rule/model/feedback persistence round-trips using a temporary database
- `Phase1Platform` wiring for the new services

### `packages/platform-core/src/phase9-ingestion.test.ts`

- Preserved the existing Phase 9 ingestion suite after `phase10.test.ts` was repurposed for actual Phase 10 coverage.

---

## Validation

- `pnpm --filter @modcompat/platform-core test`
- Result in the current environment: 72 passing, 1 skipped
- The skipped test is the gated live Postgres smoke, which runs automatically when a reachable Postgres instance is available

---

## Scope Note

This file documents the completed Phase 10 implementation slice that was already started in the repository.

It does **not** claim that every Phase 10 roadmap item from `NEXT_STEPS_TO_DONE.md` is fully delivered yet. The remaining roadmap work is now clearer because the rule/model/feedback foundation is finished and verified.
