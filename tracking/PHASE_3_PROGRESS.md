# Phase 3 Progress

## What was implemented

- `packages/platform-core` now includes a deterministic Phase 3 evidence platform slice with fixture-backed connectors, sync-run tracking, raw payload retention, document/snippet normalization, indexing, search, and analyst curation.
- The evidence pipeline ingests replayable GitHub and curated-community fixtures, extracts entities and relations, assigns trust and recency signals, clusters related evidence, and marks contradiction/supersession state.
- The analysis orchestrator now runs an `evidence_enrichment` phase that retrieves finding-linked evidence and folds it into finding explanations, provenance, confidence inputs, and evidence references.
- Gateway, evidence, and admin app boundaries now expose usable route/handler surfaces for sync, evidence search, finding-linked lookup, analyst curation, and verified-rule promotion.

## Contract updates

- Shared TypeScript contracts now cover source connectors, sync runs, raw payload records, evidence documents/snippets, search hits, and analyst curation records.
- `schemas/json/` now includes machine-readable schemas for source sync runs, evidence documents, and evidence search responses.
- `schemas/openapi/platform.openapi.yaml` now documents evidence sync/search, finding-linked evidence lookup, and evidence-curation / verified-rule-promotion APIs.
- `schemas/sql/postgres_core.sql` now includes raw payload retention, richer evidence metadata, search-document persistence, and curation workflow tables.

## Usable flow

- Deterministic evidence fixtures live under `fixtures/evidence/phase3-evidence-fixtures.json`.
- `platform.evidence.syncFixtures()` materializes connector runs, raw payloads, normalized documents, normalized snippets, contradiction/supersession metadata, and search documents.
- `platform.evidence.search(...)` performs deterministic OpenSearch-style lookup across `evidence-documents` and `evidence-snippets`.
- `platform.evidence.getFindingEvidence(...)` retrieves evidence scoped to an existing analysis finding.
- `platform.evidence.createCuration(...)` and `platform.evidence.promoteVerifiedRule(...)` provide the first analyst-to-verified-rule workflow and feed the existing verified rule engine.

## Validation

- `pnpm --filter @modcompat/platform-core test`
- `pnpm contracts:check`
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts`
- `pnpm --filter @modcompat/evidence exec tsx src/index.ts`
- `pnpm --filter @modcompat/admin exec tsx src/index.ts`

## Remaining gaps

- Persistence for the executable slice is still in-memory; SQL contracts were updated, but no Postgres/OpenSearch adapters are wired yet.
- Connector execution is deterministic and fixture-backed rather than live GitHub/network sync.
- Entity extraction, relation extraction, contradiction handling, and relevance classification are heuristic and inspectable rather than ML-backed.
- Verified-rule promotion updates the in-memory registry used by the demo/runtime flow; filesystem-backed authoring and approval history remain deferred.
