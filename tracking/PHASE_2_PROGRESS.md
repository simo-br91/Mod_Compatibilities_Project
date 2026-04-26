# Phase 2 Progress

## What was implemented

- Phase 2 shared contracts now cover richer findings with provenance and confidence inputs, artifact-analysis outputs, graph snapshots/neighborhoods, explanation paths, and persisted pack diffs.
- `packages/platform-core` now runs a deterministic Phase 2 pipeline: resolver findings, verified rules, artifact-analysis signals, graph upsert/explanation materialization, finding merge/dedupe, recommendations, and optional baseline-vs-target pack diffs.
- The gateway and web boundaries now expose the first usable graph and diff surface in the in-memory demo flow.

## Contract updates

- `schemas/json/finding.schema.json` now models `provenance`, `confidence_inputs`, and `dedupe_key`.
- Added machine-readable schemas for artifact analysis, graph persistence, and pack diffs.
- Contract validation now checks the new Phase 2 schema set alongside the existing OpenAPI, events, and SQL contracts.

## Usable flow

- A deterministic snapshot analysis now produces artifact-analysis records per resolved mod version.
- The analysis persists a graph snapshot and explanation paths that can be queried by analysis and finding.
- Findings are merged and deduplicated across resolver, verified-rule, and static-analysis output with attached provenance and confidence inputs.
- Analyses can optionally materialize a persisted pack diff against a baseline snapshot.

## Remaining gaps

- Persistence remains in-memory for the executable TypeScript slice; SQL contracts now describe the Phase 2 structures, but no Postgres or Neo4j adapter is wired yet.
- The TypeScript demo flow uses in-process deterministic services rather than cross-service RPC for the Kotlin and Go slices.
- Evidence ingestion, search-backed retrieval, and ML-based confidence calibration remain deferred to later phases.
