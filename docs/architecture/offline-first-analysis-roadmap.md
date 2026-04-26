# Offline-First Analysis Roadmap

## Purpose

This document turns the target architecture in
[offline-first-analysis-pipeline.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/docs/architecture/offline-first-analysis-pipeline.md)
into a concrete implementation roadmap for this repository.

It answers four practical questions:

1. what can be reused from the current codebase
2. what needs to be added
3. what needs to change role over time
4. in what order the work should happen to reach the target production pipeline

This roadmap is for the full production direction, not for an MVP shortcut.

---

## Current Repository Baseline

The repository already contains useful primitives for the offline-first direction.

## Strong foundations already present

### 1. Canonical catalog schema foundation

The SQL schema already includes durable structures for:

- canonical projects
- aliases
- source mappings
- canonical versions
- declared dependencies
- declared incompatibilities

Relevant file:

- [postgres_core.sql](/c:/Users/simor/Documents/Mod_Compatibilities_Project/schemas/sql/postgres_core.sql:1)

### 2. Evidence ingestion and persistence foundation

The schema and codebase already support:

- source connectors
- sync runs
- raw payload retention
- evidence documents
- evidence snippets
- search-oriented evidence records
- curation and rule promotion

Relevant files:

- [apps/evidence/README.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/apps/evidence/README.md:1)
- [postgres_core.sql](/c:/Users/simor/Documents/Mod_Compatibilities_Project/schemas/sql/postgres_core.sql:1)
- [packages/platform-core/src/connectors.ts](/c:/Users/simor/Documents/Mod_Compatibilities_Project/packages/platform-core/src/connectors.ts:1)

### 3. Admin curation foundation

The platform already has the beginnings of:

- evidence curation
- verified rule drafts
- verified rule promotion

Relevant files:

- [apps/admin/README.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/apps/admin/README.md:1)
- [packages/platform-core/src/rule-draft.ts](/c:/Users/simor/Documents/Mod_Compatibilities_Project/packages/platform-core/src/rule-draft.ts:1)

### 4. Artifact analysis foundation

The repository already includes a Java artifact-analysis service and persistence for artifact outputs.

Relevant files:

- [apps/artifact-analysis/README.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/apps/artifact-analysis/README.md:1)
- [postgres_core.sql](/c:/Users/simor/Documents/Mod_Compatibilities_Project/schemas/sql/postgres_core.sql:1)

### 5. Orchestrator and workflow foundation

The current orchestrator is oriented around request-time deterministic execution, but it already gives
the repo a durable workflow boundary, idempotency behavior, and async control-plane semantics.

Relevant files:

- [apps/analysis-orchestrator/README.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/apps/analysis-orchestrator/README.md:1)
- [packages/platform-core/src/orchestration.ts](/c:/Users/simor/Documents/Mod_Compatibilities_Project/packages/platform-core/src/orchestration.ts:1)

### 6. Persistence and release-control foundation

The repo already has:

- Postgres persistence wiring
- service-boundary persistence seams
- release manifests and release-control scripts

That matters because the new knowledge snapshot model can reuse the same operational pattern.

Relevant files:

- [packages/platform-core/src/persistence.ts](/c:/Users/simor/Documents/Mod_Compatibilities_Project/packages/platform-core/src/persistence.ts:1)
- [scripts/release/phase13_release.ts](/c:/Users/simor/Documents/Mod_Compatibilities_Project/scripts/release/phase13_release.ts:1)
- [infra/releases/README.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/releases/README.md:1)

---

## Gap Between Current State and Target State

The main gap is not that the repo lacks all building blocks.
The main gap is that the current center of gravity is still the request-time analysis pipeline.

Today, the platform is strongest at:

- importing a pack
- running a deterministic pipeline
- persisting the result
- exposing evidence/admin/service boundaries

The target platform must instead be strongest at:

- building a canonical knowledge base offline
- publishing promoted knowledge snapshots
- serving user analysis primarily through retrieval
- using heavy computation for offline enrichment, not as the normal click path

That means the roadmap is mostly about moving ownership and emphasis, not starting from zero.

---

## Strategic Migration Shape

The migration should follow this rule:

`keep the current deterministic pipeline alive as an internal enrichment and validation engine while building the new retrieval-first serving path beside it`

This avoids a risky rewrite and lets the current pipeline help bootstrap the new knowledge base.

The migration should be additive first, then substitutive.

---

## Target Ownership Mapping

This section maps the future architecture onto the current repo.

## Services to keep and expand

### `apps/gateway`

Future role:

- public API surface
- auth/session
- pack submission entrypoint
- thin routing to analysis-serving APIs

What changes:

- reduce its reliance on orchestrator-driven request-time heavy analysis
- keep request validation, auth, tenant propagation, and response shaping

### `apps/catalog`

Future role:

- canonical identity and version metadata service
- source-to-canonical mapping APIs
- environment-aware lookup APIs
- coverage scope APIs

What changes:

- move from seam-only ownership to real production catalog ownership

### `apps/evidence`

Future role:

- source ingestion coordination
- raw payload retention
- evidence normalization storage
- evidence search and retrieval
- contradiction and freshness handling

What changes:

- move from deterministic fixture-backed behavior to real source-backed ingestion
- become one of the primary offline knowledge production services

### `apps/admin`

Future role:

- curation queue
- rule review
- contradiction resolution
- promotion workflows
- knowledge snapshot approval UX

What changes:

- extend beyond rule promotion to full knowledge governance

### `apps/artifact-analysis`

Future role:

- scheduled offline artifact scanning
- technical conflict signature production

What changes:

- stop thinking of this mainly as a request-time analyzer
- orient it around batch/offline jobs

### `apps/analysis-orchestrator`

Future role:

- offline workflow engine
- snapshot refresh orchestration
- pairwise and fragment recomputation workflows
- benchmark pack workflows
- snapshot validation and promotion pipelines

What changes:

- reduce its role as the primary user-facing heavy analysis engine
- repurpose it into the backbone of offline knowledge production

---

## New logical components likely needed

These can begin as modules in existing packages, but they should be treated as first-class platform
capabilities.

### 1. Knowledge synthesis layer

Responsibility:

- merge verified rules, evidence, technical signatures, and catalog facts
- compute pairwise outcomes
- compute fragment outcomes
- score confidence

Likely home initially:

- `packages/platform-core`

Possible future home:

- dedicated service or orchestrated job package

### 2. Snapshot assembly and promotion layer

Responsibility:

- build candidate knowledge snapshots
- validate them
- publish them
- manage rollbackable promotion state

Likely home initially:

- `packages/platform-core`
- `scripts/release/`
- `apps/analysis-orchestrator`

### 3. Analysis serving layer

Responsibility:

- exact pack lookup
- retrieval-based result assembly
- confidence explanation generation

Likely home initially:

- `apps/gateway` calling new shared serving logic in `packages/platform-core`

Possible future home:

- dedicated analysis-serving service

---

## What to Reuse vs What to Replace

## Reuse directly

- canonical catalog tables in Postgres
- evidence tables and sync-run model
- verified-rule promotion flow
- artifact-analysis technical extraction machinery
- release-control patterns and manifest concepts
- pack normalization and import primitives
- persistence seams in `packages/platform-core`

## Reuse, but change the job

- current orchestrator:
  keep it, but increasingly for offline jobs
- graph and simulation services:
  keep them for internal enrichment and benchmark workflows, not as the default user click path
- recommendation service:
  keep it, but shift recommendations to knowledge-derived and snapshot-aware generation

## De-emphasize on the normal click path

- request-time static analysis
- request-time heavy graph generation
- request-time simulation
- request-time ML-style calibration that depends on fresh feature generation

## Replace conceptually

Replace this idea:

- "user click starts the real analysis"

With this idea:

- "user click asks the system to resolve the pack against already prepared knowledge"

---

## Recommended Implementation Phases

The roadmap below is ordered for practical execution in this repo.

## Phase A. Lock the canonical serving model

Goal:
Create the serving contract for the new analysis experience before building too much machinery.

### Deliverables

- define the new analysis response schema for retrieval-based results
- define verdict enums and confidence bands
- define coverage status fields
- define snapshot version exposure in every analysis response
- define distinction between:
  - exact cached result
  - retrieval-assembled result
  - legacy live-computed result

### Repo touchpoints

- `schemas/openapi/platform.openapi.yaml`
- `schemas/json/analysis-report.schema.json`
- `schemas/json/finding.schema.json`
- `packages/api-contracts`
- `packages/domain-models`

### Why this phase comes first

The serving shape should guide all later storage and computation decisions.

---

## Phase B. Expand the Postgres model for knowledge snapshots and serving caches

Goal:
Make the database capable of storing the new offline-first system cleanly.

### New durable entities to add

- knowledge snapshots
- snapshot components
- snapshot validation reports
- snapshot promotion events
- pairwise compatibility records
- fragment compatibility records
- exact pack result cache
- pack benchmark records
- coverage scope records
- contradiction clusters
- promoted compatibility claims
- technical conflict signature records
- serving query indexes or lookup tables

### Repo touchpoints

- `schemas/sql/postgres_core.sql`
- `schemas/sql/migrations/`
- `packages/domain-models`
- `packages/platform-core/src/persistence.ts`

### Notes

This should be done as proper additive schema evolution, not as ad hoc table growth inside only the
runtime persistence class.

---

## Phase C. Turn `apps/catalog` into a real production service

Goal:
Make catalog identity and version resolution first-class and durable.

### Deliverables

- real CurseForge and Modrinth ingestion into canonical catalog tables
- source mapping upsert flows
- alias and slug resolution endpoints
- coverage-aware version lookup APIs
- freshness metadata for catalog entries

### Reuse

- existing canonical schema in Postgres
- connector concepts already started in `packages/platform-core`

### Repo touchpoints

- `apps/catalog/src/`
- `connectors/curseforge/`
- `connectors/modrinth/`
- `packages/platform-core/src/services.ts`
- `packages/platform-core/src/persistence.ts`

### Outcome

The user click path can resolve pack entries quickly and consistently using a real canonical catalog
instead of mostly in-memory seeded data.

---

## Phase D. Turn `apps/evidence` into real offline ingestion infrastructure

Goal:
Replace fixture-backed evidence behavior with production evidence ingestion and retrieval.

### Deliverables

- source adapters for high-priority sources
- scheduled syncs with checkpoints
- raw payload persistence
- document normalization
- snippet extraction
- claim extraction scaffolding
- contradiction and supersession storage
- evidence search backed by durable indexed data

### Reuse

- source connector and sync-run schema
- evidence document/snippet/search schema
- evidence service boundary

### Repo touchpoints

- `apps/evidence/src/`
- `packages/platform-core/src/connectors.ts`
- `connectors/github/`
- new source connectors as needed

### Important implementation note

Build sources in this order:

1. **CurseForge and Modrinth descriptions and release notes** — structured, API-accessible, author-authoritative
2. **GitHub issues/discussions** — semi-structured, high signal, linkable
3. **Changelog and release-note sources** — version-scoped, high precision

**Reddit, Discord, and community forum scraping are not planned.** The noise-to-signal ratio is
poor, engineering cost is high, and most actionable community knowledge already surfaces through
GitHub issues. Do not add these sources without clear evidence they produce signals not already
captured by the above sources.

---

## Phase E. Expand admin into a real knowledge-governance plane

Goal:
Make human review part of the production knowledge system.

### Deliverables

- identity-resolution review queue
- evidence review queue
- contradiction resolution actions
- promotion of evidence into verified claims
- rule lifecycle management
- snapshot approval UI/API

### Reuse

- current curation and verified-rule promotion flow

### Repo touchpoints

- `apps/admin/src/`
- `apps/web/src/app/(app)/admin/`
- `packages/platform-core/src/rule-draft.ts`
- `packages/platform-core/src/persistence.ts`

### Outcome

High-confidence knowledge becomes reviewable, promotable, and auditable instead of purely inferred.

---

## Phase F. Move artifact analysis to scheduled technical signature generation

Goal:
Use the current artifact-analysis stack to produce durable structural conflict signals offline.

### Deliverables

- scheduled artifact fetch/analyze workflows
- durable technical conflict signature tables
- project/version-scoped technical evidence records
- refresh logic for changed versions

### Reuse

- `apps/artifact-analysis`
- artifact output persistence model already present in schema

### Repo touchpoints

- `apps/artifact-analysis/src/main/`
- `apps/analysis-orchestrator`
- `packages/platform-core/src/services.ts`
- schema additions for durable signature records

### Important role change

Artifact analysis should become an offline enrichment producer, not a required runtime dependency for
the normal `analysis` click path.

---

## Phase G. Build the knowledge synthesis engine

Goal:
Create the central engine that converts raw ingredients into production-serving compatibility
knowledge.

### Responsibilities

- merge catalog facts
- merge verified rules
- merge promoted evidence claims
- merge technical conflict signatures
- compute trust-weighted and freshness-aware compatibility claims
- compute pairwise outcomes
- compute fragment outcomes
- score finding and pack-level confidence

### Likely initial home

- `packages/platform-core`

### Suggested module boundaries

- `knowledge/claims.ts`
- `knowledge/confidence.ts`
- `knowledge/pairs.ts`
- `knowledge/fragments.ts`
- `knowledge/coverage.ts`
- `knowledge/snapshots.ts`

### Why it belongs in shared code first

This logic will need to be reused by:

- offline workflows
- snapshot validation
- serving assembly
- regression tests

---

## Phase H. Build the exact-pack and fragment cache pipeline

Goal:
Precompute and store fast-serving results for common packs and common mod clusters.

### Deliverables

- normalized pack fingerprint storage
- pack benchmark tables
- exact pack cache generation jobs
- fragment cache generation jobs
- nearest-pattern lookup support where useful

### Inputs

- mods that frequently co-occur in real modpacks (primary selection signal)
- popular public packs
- internal benchmark packs
- common co-occurrence clusters
- high-risk mod stacks (performance/rendering/worldgen mods with high interaction surface)

### Repo touchpoints

- new benchmark fixtures under `fixtures/`
- new orchestrator workflows
- new persistence methods
- possibly new scripts under `scripts/`

---

## Phase I. Build the knowledge snapshot system

Goal:
Introduce the promoted snapshot model that becomes the source of serving truth.

### Deliverables

- snapshot draft assembly
- snapshot validation reports
- snapshot promotion state
- snapshot rollback support
- serving pointer to active snapshot

### Reuse

- release-control concepts already established in Phase 13

### Repo touchpoints

- `infra/releases/`
- `scripts/release/`
- `apps/analysis-orchestrator`
- `packages/platform-core/src/persistence.ts`

### Design recommendation

Treat knowledge snapshots similarly to release manifests:

- versioned
- validated
- promotable
- rollbackable

This will make ops more coherent across the platform.

---

## Phase J. Introduce retrieval-first analysis serving

Goal:
Make the user-facing `analysis` request query the promoted snapshot rather than trigger heavy live
computation.

### Serving flow to implement

1. parse input
2. normalize and resolve canonical identities
3. compute pack fingerprint
4. check exact pack cache in active snapshot
5. if no exact hit, assemble result from:
   - verified rules
   - pair matrix
   - fragment matches
   - promoted evidence claims
   - technical conflict signatures
   - catalog dependency and environment rules
6. synthesize verdict and confidence
7. return immediately

### Initial implementation location

- gateway request path plus shared serving logic in `packages/platform-core`

### Longer-term option

- dedicated analysis-serving service

### Migration requirement

The response must indicate whether it came from:

- exact cache
- retrieval assembly
- legacy live computation fallback

---

## Phase K. Repurpose the orchestrator fully toward offline workflows

Goal:
Shift the orchestrator from primary request-time executor to primary offline pipeline owner.

### New orchestrator responsibilities

- source refresh workflows
- impact-based recomputation
- artifact-analysis batch workflows
- pairwise recomputation workflows
- fragment and pack cache rebuild workflows
- ground-truth execution workflows (launch Minecraft, test mod combination, record crash/pass result)
- snapshot validation and promotion workflows

Note: ground-truth execution detects startup crashes and load-time failures only — not full gameplay
compatibility. Results are labeled accordingly and feed back into pairwise confidence scores.

### Existing responsibilities to de-emphasize

- user-triggered heavy deterministic pipeline as the default path

### Repo touchpoints

- `apps/analysis-orchestrator/src/temporal/`
- `workflows/definitions/`
- `workflows/temporal/`

### Practical transition rule

Keep the current deterministic live analysis workflow available as:

- internal benchmarking
- bootstrap generation of initial pack caches
- fallback enrichment path for unsupported cases

But stop centering the product UX around it.

---

## Phase L. Re-scope graph, simulation, ML, and recommendation services

Goal:
Align advanced services with the offline-first serving model.

### Graph

Future role:

- analyst investigation
- offline relationship derivation
- higher-order interaction analysis

Not primary role:

- mandatory runtime generation for every user request

### Simulation

Future role:

- offline benchmark validation
- pack confidence reinforcement
- validation of high-risk combinations

Not primary role:

- standard request-time execution

### ML

Future role:

- claim classification support
- evidence scoring support
- confidence calibration
- contradiction detection support

Not primary role:

- live heavy feature generation after a user click

### Recommendation

Future role:

- produce precomputed recommendation templates and ranking inputs
- assemble retrieval-based recommendations from known safe alternatives and fixes

Not primary role:

- depend on fresh heavy upstream analysis to generate each result

---

## Recommended Delivery Order

If the team wants the strongest path with the least architectural thrash, implement in this order:

1. Phase A: serving contract
2. Phase B: database model for snapshots and serving caches
3. Phase C: real catalog ingestion and resolution
4. Phase D: real evidence ingestion and retrieval
5. Phase E: admin review and promotion expansion
6. Phase F: offline artifact signature generation
7. Phase G: knowledge synthesis engine
8. Phase I: snapshot model and promotion pipeline
9. Phase H: exact-pack and fragment cache generation
10. Phase J: retrieval-first user serving path
11. Phase K: orchestrator repurposing
12. Phase L: advanced-service role realignment

This order is deliberate:

- first define the serving goal
- then create the durable storage
- then make the data sources real
- then synthesize knowledge
- then publish snapshots
- then switch the user path

---

## Concrete Repo Work Breakdown

This section groups the work by repository area.

## `schemas/`

Add:

- snapshot tables
- pairwise compatibility tables
- fragment compatibility tables
- pack benchmark/cache tables
- promoted claim tables
- contradiction cluster tables
- coverage scope tables
- technical conflict signature tables

Also update JSON/OpenAPI contracts for:

- retrieval-first analysis response
- verdict enums
- confidence and coverage fields

## `packages/domain-models`

Add types for:

- knowledge snapshot
- promoted claim
- pairwise compatibility record
- fragment compatibility record
- exact pack cache record
- coverage scope
- technical conflict signature
- contradiction cluster

## `packages/api-contracts`

Add or revise contracts for:

- pack analysis retrieval response
- snapshot-aware findings
- coverage metadata
- confidence explanation

## `packages/platform-core`

This package should become the first implementation home for:

- knowledge synthesis logic
- confidence calculation
- retrieval serving logic
- snapshot assembly logic
- exact-pack cache generation
- fragment cache generation

It should also be split more clearly by concern so offline-first logic is easier to reason about.

## `apps/catalog`

Implement:

- ingestion routes or internal job endpoints
- resolution APIs
- canonical lookup APIs
- coverage lookup APIs

## `apps/evidence`

Implement:

- production connectors
- extraction and normalization flows
- contradiction handling APIs
- search and evidence retrieval optimized for serving

## `apps/admin`

Implement:

- review queues
- promotion actions
- snapshot approval actions
- moderation and contradiction resolution

## `apps/analysis-orchestrator`

Implement:

- offline refresh workflows
- impact-based recomputation workflows
- snapshot build workflows
- benchmark workflows

## `apps/web`

Implement UI changes for:

- coverage messaging
- confidence explanation
- evidence freshness
- admin review queues
- snapshot promotion/status views

## `scripts/`

Add scripts for:

- backfills
- bootstrap catalog ingestion
- pre-launch ecosystem seeding
- snapshot dry runs
- benchmark generation

## `fixtures/`

Expand with:

- benchmark packs
- pairwise truth fixtures
- contradiction fixtures
- snapshot regression fixtures

---

## How the Current Deterministic Pipeline Should Be Used During Migration

The current pipeline in
[orchestration.ts](/c:/Users/simor/Documents/Mod_Compatibilities_Project/packages/platform-core/src/orchestration.ts:1)
should not be discarded early.

It should serve three migration roles:

### 1. Bootstrap producer

Use it to generate initial benchmark pack results and seed early exact-pack caches.

### 2. Regression oracle

Use it to compare retrieval-based results against legacy deterministic outputs on known packs.

### 3. Internal enrichment fallback

Use it for internal offline jobs when the platform encounters novel or under-covered cases.

It should gradually stop being the default runtime experience for end users, but it remains valuable
as an internal system.

---

## Suggested Success Milestones

These milestones are repo-specific checkpoints that show the migration is working.

## Milestone 1. Catalog truth becomes real

You know this milestone is reached when:

- `apps/catalog` resolves real CurseForge/Modrinth data
- pack imports no longer depend mainly on demo-seeded catalog entries

## Milestone 2. Evidence truth becomes real

You know this milestone is reached when:

- `apps/evidence` persists real external source documents
- evidence search returns real normalized records, not only deterministic fixtures

## Milestone 3. Snapshot model exists

You know this milestone is reached when:

- a candidate knowledge snapshot can be assembled and validated
- the serving layer can point to a specific active snapshot version

## Milestone 4. Retrieval-first serving works

You know this milestone is reached when:

- a user pack can receive a verdict from exact-pack cache or retrieval assembly without triggering the
  heavy deterministic pipeline

## Milestone 5. Weekly refresh is real

You know this milestone is reached when:

- orchestrator-owned refresh workflows update data and promote a new snapshot on a recurring cadence

## Milestone 6. Heavy click-path analysis is no longer the default

You know this milestone is reached when:

- most user analyses are served from snapshots and caches
- the heavy deterministic pipeline is only used for internal enrichment or exceptional fallback

---

## Key Risks and How to Manage Them

## Risk 1. Trying to precompute the full ecosystem

Problem:

- combinatorics will explode

Mitigation:

- define supported coverage explicitly
- prioritize high-value mods, versions, and clusters

## Risk 2. Noisy community evidence poisoning results

Problem:

- low-quality reports can produce false positives

Mitigation:

- strong trust model
- contradiction handling
- admin review and promotion gates

## Risk 3. Keeping too much logic in request-time services

Problem:

- the product feels slow and operationally brittle

Mitigation:

- treat offline workflows as the main computation path
- gate new online logic carefully

## Risk 4. Building snapshots too late in the migration

Problem:

- teams end up serving from drifting mutable data and never complete the architecture

Mitigation:

- introduce the snapshot model early, even if the first snapshots are simple

## Risk 5. Rewriting instead of evolving

Problem:

- progress stalls

Mitigation:

- reuse current services and persistence seams
- change roles gradually

---

## Definition of Done for the Migration

This roadmap can be considered complete when all of the following are true.

## Serving behavior

- user analysis is retrieval-first
- exact pack cache and fragment retrieval handle the common path
- unsupported coverage is explicit and honest

## Data behavior

- canonical catalog is real and continuously refreshed
- evidence ingestion is real and continuously refreshed
- technical signatures are produced offline
- verified knowledge is reviewable and promoted
- active snapshots govern serving behavior

## Workflow behavior

- orchestrator owns weekly refresh, recomputation, benchmark, and snapshot promotion workflows
- heavy legacy analysis is internal-only or exceptional fallback

## Operational behavior

- snapshots can be promoted and rolled back safely
- latency is low and predictable
- observability clearly separates snapshot-served vs fallback results

---

## Final Recommendation

For this repository, the strongest implementation strategy is not to discard the current system.
It is to invert it.

Today:

- the deterministic orchestrated analysis is the center
- evidence, admin, catalog, and artifact-analysis mostly support it

Target state:

- catalog, evidence, admin, artifact-analysis, and knowledge synthesis become the center
- promoted knowledge snapshots become the serving truth
- the orchestrator becomes the offline production backbone
- the old deterministic pipeline becomes a bootstrap, benchmark, and fallback engine

That is the cleanest path from the repo you have now to the product behavior you want.
