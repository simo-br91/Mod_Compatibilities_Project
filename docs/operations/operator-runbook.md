# Operator Runbook

## Purpose

This runbook is for operators responsible for staging readiness, release promotion,
rollback, incident coordination, and service health verification.

## Daily checks

- Confirm the gateway, evidence, admin, orchestrator, recommendation, graph,
  simulation, and artifact-analysis health endpoints respond as expected.
- Verify PostgreSQL, Redis, Temporal, Neo4j, OpenSearch, and object storage are healthy.
- Review evidence sync failures, webhook DLQ entries, and recent audit events.
- Confirm the current staging release version and image set with `pnpm release:status -- --environment staging`.
- Review the current rollback candidates before making any promotion decision.

## Promotion checklist

- Run `pnpm contracts:check`.
- Run `pnpm typecheck`.
- Run `pnpm test:regression`.
- Run `pnpm --filter @modcompat/web build`.
- Run `pnpm canary:staging`.
- Run `pnpm smoke:staging -- --probe-only`.
- Create a release manifest with `pnpm release:bundle`.
- Record the published image set with `pnpm release:publish:staging`.
- Promote with `pnpm release:deploy:staging`.
- Verify the environment metadata with `pnpm release:verify:staging`.

## Rollback checklist

- Identify the rollback target from `rollbackCandidates` or choose an explicit release version.
- Confirm the target manifest still exists under `infra/releases/manifests/`.
- Confirm the image set in that manifest is marked as published.
- Record the rollback reason in the command line and in the incident log.
- Run `pnpm release:rollback:staging`.
- Re-run canary and probe validation after the rollback is complete.

## Incident severities

- `SEV-1`: user-facing outage, widespread auth failure, data corruption risk, or failed rollback.
- `SEV-2`: degraded ingestion, critical connector drift, delayed recommendations, or release gate regressions.
- `SEV-3`: isolated customer issue, false positive cluster, or partial integration failure.

## Required evidence during incident handling

- release version
- manifest path
- current image set
- affected tenant or project IDs
- timestamps in UTC
- canary or smoke output
- gateway request IDs or trace IDs where available

## Dependencies that must stay green

- PostgreSQL for durable state and analysis persistence
- Redis for queueing and transient coordination
- Temporal for orchestration execution
- Neo4j for graph derivation reads and writes
- OpenSearch for evidence search and finding lookup
- object storage for raw payloads and artifacts
- GHCR access for image publication

## Escalation path

- Operator owns first triage and gathers evidence.
- Service owner joins within the active SLA window for the impacted subsystem.
- Product and analyst leads join when customer-visible findings quality is affected.
- Rollback is preferred over hot patching whenever the issue touches auth, persistence,
  release gating, or evidence integrity.
