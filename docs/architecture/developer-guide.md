# Developer Guide

## Purpose

This guide is for engineers extending the platform during beta and launch preparation.

## Service map

- `apps/gateway`: auth, session, RBAC, rate limiting, audit logging, public API surface
- `apps/analysis-orchestrator`: analysis lifecycle and Temporal-backed execution
- `apps/evidence`: evidence sync and search boundaries
- `apps/admin`: analyst curation and rule promotion workflows
- `apps/recommendation`, `apps/graph`, `apps/simulation`: service-owned HTTP boundaries
- `packages/platform-core`: shared domain logic and persistence wiring
- `apps/web`: operator, analyst, and user-facing workflow shell

## Local workflow

- Use `pnpm typecheck` before pushing.
- Use `pnpm test:regression` for cross-phase behavior validation.
- Use `pnpm --filter @modcompat/web build` for UI changes.
- Use `pnpm runtime:staging:up` when you need the compose-backed staging topology locally.
- Use `pnpm release:verify:staging` after modifying release metadata logic.

## Auth boundary

- The gateway owns the authenticated session and cookie lifecycle.
- The web app should only depend on `/auth/login`, `/auth/logout`, and `/v1/auth/session`.
- Do not persist session JWTs in browser storage.
- New routes must respect gateway RBAC and tenant propagation headers.

## Data durability expectations

- PostgreSQL is the source of truth for durable application state.
- Redis and Temporal support orchestration and queueing, but should not become hidden primary stores.
- Neo4j and OpenSearch must be treated as derived durable stores and kept rehydratable from source records where possible.

## Release control expectations

- Every deployable release must have a manifest under `infra/releases/manifests/`.
- Every published release should have a recorded image set before promotion.
- Rollback must target a manifest version, never an ad hoc image tag with no manifest.
- Deployment target changes should update both release metadata and the relevant ADRs.

## Documentation expectations

- Update role-based docs when user-visible behavior changes.
- Add or revise an ADR when changing auth ownership, release source of truth, or cross-service contracts.
- Keep launch documents aligned with the actual pilot process and support model.
