# Offline-First Analysis Pipeline Blueprint

## Purpose

This document defines the target production analysis pipeline for the Modpack Compatibility Platform.

It replaces the current "compute most of the answer after the user clicks analysis" mindset with an
offline-first, knowledge-snapshot-driven architecture:

- heavy work happens before launch and on recurring background refresh cycles
- the user-facing `analysis` action is primarily a fast retrieval and scoring operation
- the platform serves answers from a versioned compatibility knowledge base
- deeper computation remains available as an internal data-production workflow, not as the default
  user request path

This is not an MVP document. It describes the full intended end-state pipeline.

---

## Product Goal

When a user submits a modpack for analysis, the platform should:

- resolve the pack quickly against a canonical mod catalog
- retrieve known compatibility knowledge immediately
- explain exact problem areas with supporting evidence
- provide recommendations and confidence
- return a result fast enough to feel instant or near-instant

The platform should avoid running expensive live computation after the user clicks `analysis` except
in explicitly defined internal or fallback cases.

---

## Design Principles

### 1. Offline-first by default

The strongest compatibility intelligence is built before the user request:

- catalog ingestion
- rule curation
- static artifact analysis
- evidence extraction
- pairwise compatibility scoring
- pack-fragment caching
- confidence synthesis

### 2. Retrieval-first user flow

The primary user request path should do:

- parsing
- normalization
- identity resolution
- fingerprinting
- database lookup
- confidence aggregation
- explanation assembly

It should not normally do:

- live web crawling
- heavy jar analysis
- expensive graph derivation from scratch
- long-running simulation
- broad recomputation across the ecosystem

### 3. Knowledge snapshots are deployable artifacts

The platform should not serve directly from a constantly mutating set of partially refreshed records.
Instead, it should publish versioned promoted knowledge snapshots that are:

- internally validated
- reproducible
- query-optimized
- rollbackable

### 4. Confidence is explicit

The system must never pretend unknown equals compatible.

Every conclusion must include:

- verdict
- confidence
- why the confidence is at that level
- evidence recency
- source trust tier
- whether the result is exact-match, inferred, or partial-match

### 5. Human curation is part of the product

High-confidence compatibility knowledge requires analyst review, especially for:

- ambiguous identity resolution
- contradictory community reports
- version-scoped exceptions
- promotion of evidence into verified rules

### 6. Canonical storage first, derived stores second

Durable source-of-truth records should live in PostgreSQL.
Derived stores such as Neo4j and OpenSearch must be rebuildable from canonical records.

---

## High-Level Architecture

The production pipeline has two distinct execution worlds:

1. `Offline knowledge production`
2. `Online user analysis retrieval`

### Offline knowledge production

This world continuously builds and refreshes the platform's compatibility intelligence.

Major functions:

- ingest metadata from external ecosystems
- build a canonical mod/version catalog
- ingest and classify compatibility evidence
- perform offline static artifact analysis
- compute compatibility knowledge and confidence
- precompute frequently used pack and fragment results
- promote validated knowledge into queryable production snapshots

### Online user analysis retrieval

This world serves user requests quickly.

Major functions:

- parse pack input
- resolve canonical identities
- compute a normalized pack fingerprint
- retrieve exact cached results or assemble a pack verdict from precomputed knowledge
- render findings, evidence, explanations, and recommendations

---

## Target User Experience

The user click flow should feel like:

1. submit pack manifest or mod list
2. wait briefly for normalization and lookup
3. receive a result immediately or near-immediately

The user should not experience:

- a visible long-running orchestration workflow
- waiting for web scrapers
- waiting for deep jar parsing
- waiting for batch inference jobs

The UI may still show:

- "resolving pack"
- "matching known compatibility data"
- "assembling evidence"

But these should correspond to fast retrieval steps.

---

## Scope Boundaries

### In scope for the production pipeline

- pre-launch ecosystem ingestion and precomputation
- recurring weekly knowledge refresh
- query-time retrieval from a prepared knowledge base
- exact and approximate compatibility lookups
- explicit verdict confidence
- internal re-analysis and refresh jobs
- versioned promoted knowledge snapshots

### Out of scope for the primary user click path

- open-ended live crawling of web sources
- first-time deep analysis of arbitrary unseen mods
- experimental heavy simulation on demand
- broad graph construction with no pre-existing knowledge
- expensive ML feature generation that depends on request-time raw processing

---

## Core Data Layers

The platform should be organized into five logical data layers.

## 1. Catalog Layer

Purpose:
Canonical representation of mods, versions, environments, and dependencies.

Examples:

- canonical mod identity
- alias mappings
- source mappings between CurseForge and Modrinth
- version metadata
- supported Minecraft versions
- supported loaders
- Java compatibility
- dependency and incompatibility declarations
- project popularity and freshness metadata

Primary store:

- PostgreSQL

Derived stores:

- OpenSearch for search and entity lookup
- Neo4j for relationship traversal where useful

## 2. Verified Knowledge Layer

Purpose:
Store explicit structured compatibility rules that the system can trust highly.

Examples:

- hard incompatibility rules
- required dependency rules
- version-range conflict rules
- environment-scoped incompatibilities
- workaround rules
- "fixed in version X" rules
- "safe pairing" confirmations

Primary store:

- PostgreSQL

## 3. Evidence Layer

Purpose:
Store extracted compatibility claims and supporting documents from external sources.

Examples:

- GitHub issues and discussions
- changelog notes
- CurseForge/Modrinth descriptions and release notes
- Reddit/forum posts
- maintainer statements
- structured snippets and extracted claims

Primary store:

- PostgreSQL for canonical evidence records
- OpenSearch for search and snippet retrieval

## 4. Conflict Signature Layer

Purpose:
Store machine-derived technical conflict signals computed offline.

Examples:

- overlapping class targets
- overlapping mixin targets
- embedded library divergence
- resource namespace collisions
- patch target conflicts

Primary store:

- PostgreSQL for canonical signatures
- Neo4j optionally for dependency and interaction graph traversal

## 5. Result Cache Layer

Purpose:
Store fast-query pack-level and fragment-level outcomes.

Examples:

- exact pack fingerprint results
- popular pack results
- popular pairwise compatibility matrix
- fragment results for common mod subsets
- nearest-neighbor pack pattern matches

Primary store:

- PostgreSQL
- OpenSearch or Redis may be used for hot-path retrieval, but PostgreSQL remains canonical

---

## Production Verdict Model

The platform should not return a naive boolean.

Every pack-level and finding-level output should use explicit verdict states.

### Pack-level verdicts

- `known_incompatible`
- `likely_incompatible`
- `mixed_or_conditional`
- `no_known_issue_found`
- `insufficient_evidence`

### Pair-level or finding-level verdicts

- `confirmed_conflict`
- `confirmed_requirement_gap`
- `confirmed_environment_mismatch`
- `reported_conflict`
- `inferred_technical_risk`
- `reported_fixed_in_later_version`
- `unknown`

### Confidence bands

- `very_high`
- `high`
- `medium`
- `low`
- `very_low`

Each verdict must also expose a numeric confidence score and a human-readable explanation.

---

## Before Official Launch

Before launch, the platform should build a strong initial knowledge base rather than starting empty.

## Pre-launch objective

Launch with a bounded but high-confidence coverage zone, not with a claim to cover the full mod
ecosystem equally well.

Recommended initial scope dimensions:

- target Minecraft versions
- target loaders
- top N mods by usage and popularity
- recent supported versions only

Inside that scope, the system should aim for strong confidence and fast results.
Outside that scope, the system should provide best-effort retrieval with explicit lower confidence.

## Pre-launch workstreams

### 1. Canonical catalog ingestion

Ingest from:

- CurseForge
- Modrinth
- GitHub where relevant
- public manifest/index formats

Build:

- canonical project identities
- source-to-canonical mappings
- version inventories
- environment compatibility metadata
- dependency metadata
- project popularity and freshness metrics

The catalog must support:

- exact resolution
- alias lookup
- cross-source identity reconciliation
- version-range lookup
- environment filtering

### 2. Identity resolution and entity linking

Resolve:

- one logical mod across multiple external records
- aliases and renamed projects
- project IDs and slugs
- version records across sources where appropriate

Every mapping must retain:

- confidence
- provenance
- resolution method
- review status

Ambiguous cases must enter a manual review queue.

### 3. Verified rule authoring and curation

Create an internal workflow to populate high-confidence structured rules from:

- official maintainer statements
- validated issue tracker findings
- curated internal testing
- known dependency declarations
- existing repository rule assets

Rule types must include:

- hard incompatibility
- conditional incompatibility
- requires dependency
- environment mismatch
- version drift risk
- fix/workaround availability
- safe override or known-safe pairing

Each rule must store:

- affected projects and versions
- environment scope
- severity
- explanation
- source links
- trust tier
- review state
- verification timestamp
- expiry or freshness policy if applicable

### 4. Evidence ingestion and extraction

Before launch, the platform should gather ecosystem evidence from high-value sources.

Target sources, in priority order:

1. **CurseForge and Modrinth descriptions and release notes** — author-stated incompatibilities; highest-trust signal short of empirical testing
2. **GitHub issues and discussions** — community-reported conflicts; semi-structured and linkable
3. **Release notes and changelogs** — version-scoped fix and conflict records

Community forums (Reddit, Discord, Curse Forums) are **not a planned source**. The noise-to-signal ratio is poor and most actionable community knowledge already surfaces through GitHub issues. Adding forum scraping would require significant engineering for marginal gain.

For each source document, the platform should:

- persist the raw payload
- normalize metadata
- classify relevance
- extract entities
- extract claims
- extract environment/version scope
- preserve supporting snippets
- deduplicate near-duplicate reports
- mark contradictions or stale reports

### 5. Offline static artifact analysis

For the targeted launch coverage slice, run jar and artifact analysis offline to compute:

- overlapping mixin targets
- class collisions
- resource collisions
- embedded library divergence
- package namespace conflicts
- other structural indicators of technical incompatibility

This work should be performed as scheduled batch jobs and stored as reusable technical evidence.

### 6. Pairwise compatibility precomputation

Precompute pairwise compatibility for high-value pairs only. Target ~1,000 mods.

Selection strategy, in priority order:

- **mods that frequently co-occur in real modpacks** — primary criterion; these are the mods users will actually run together, making them the highest-value coverage
- mods with broad dependency surfaces
- performance/rendering/worldgen/core-library mods (high interaction surface)
- most issue-prone mods
- download popularity — secondary signal; popular mods matter but popularity alone does not predict incompatibility density

The pairwise matrix should not attempt to cover the full ecosystem exhaustively.

Output categories:

- confirmed compatible
- confirmed incompatible
- likely incompatible
- no known issue
- insufficient evidence

The matrix should be environment-aware and version-aware.

### 7. Limited higher-order interaction precomputation

Pure pairwise knowledge will miss real-world emergent issues.

The platform should therefore also precompute selected higher-order combinations for:

- common performance stacks
- common worldgen stacks
- common library/mod-loader combos
- popular public packs
- clusters of mods that frequently co-occur

This work should be bounded and driven by pack frequency and risk heuristics.

### 8. Pack and fragment result caching

Before launch, the platform should seed a result cache for:

- popular public packs
- common pack fragments
- highly reused mod clusters
- historical internal benchmark packs

For each cached result, store:

- normalized pack fingerprint
- environment
- verdict
- confidence
- findings
- evidence bundle references
- generated recommendations
- refresh version of the knowledge snapshot used

### 9. Knowledge promotion and publishing

Raw and intermediate records should not automatically become production-serving data.

The platform should publish versioned promoted snapshots, for example:

- `knowledge_snapshot_2026_05_01`
- `knowledge_snapshot_2026_05_08`

Each snapshot should include:

- catalog state
- verified rules
- promoted evidence claims
- technical conflict signatures
- pair matrix
- fragment cache
- pack result cache
- ranking and confidence parameters

Each snapshot must be:

- internally validated
- checksummed
- rollbackable
- query-addressable by version

---

## Recurring Offline Refresh Pipeline

After launch, the platform should keep building knowledge on a predictable cadence.

## Recommended cadence model

### Daily or every few days

- fetch new versions and metadata
- ingest new high-trust source material
- refresh hot projects
- process incremental raw payloads into evidence candidates

### Weekly

- rerun pairwise compatibility scoring for affected projects
- rerun fragment and popular pack refreshes
- regenerate promoted compatibility claims
- rebuild ranking and confidence aggregates
- publish a new promoted knowledge snapshot

### Less frequent heavy jobs

- deep artifact analysis for new or high-risk versions
- broader benchmark compatibility sweeps
- long-tail ecosystem enrichment
- higher-order interaction refreshes

## Refresh pipeline stages

1. source fetch
2. raw payload persistence
3. normalization
4. identity resolution
5. evidence extraction and deduplication
6. contradiction detection and freshness review
7. technical signature refresh
8. compatibility claim synthesis
9. pairwise and fragment recomputation for impacted scope
10. snapshot assembly
11. validation and promotion
12. serving index rebuild

## Impact-based recomputation

The refresh process must avoid global recomputation whenever possible.

A change should trigger targeted recomputation based on impacted entities:

- changed mod
- changed version
- changed dependency declaration
- new incompatibility claim
- fix claim for a known issue
- new artifact signature
- promoted verified rule

The system should compute impact sets such as:

- directly affected pairs
- affected fragment caches
- affected public pack caches
- affected derived confidence totals

---

## User Click `Analysis` Flow

The user-facing path must remain lightweight.

## Step 1. Input handling

Accept inputs such as:

- CurseForge manifest
- Modrinth index
- normalized mod list
- uploaded pack metadata

The system should immediately:

- parse the input
- validate structure
- normalize environment details
- create a canonical pack fingerprint candidate

## Step 2. Canonical resolution

Resolve each mod entry to:

- canonical project ID
- canonical version ID when possible
- source mapping
- resolution confidence

If unresolved entries remain, they must be surfaced in the result, not silently ignored.

## Step 3. Exact pack cache lookup

Check whether the normalized pack fingerprint has a production-ready cached result in the current
knowledge snapshot.

If yes:

- return the cached pack result
- include snapshot version and freshness
- surface pack-level verdict and supporting findings

## Step 4. Retrieval-based assembly

If there is no exact pack match, assemble a result from precomputed knowledge:

- verified rules
- pairwise matrix entries
- dependency and environment checks from the catalog
- promoted evidence claims
- technical conflict signatures
- fragment cache matches
- nearest relevant historical pack patterns

This must remain retrieval-driven and should not trigger heavy background work in the request path.

## Step 5. Verdict synthesis

From the retrieved knowledge, synthesize:

- pack-level verdict
- per-finding verdicts
- overall confidence
- confidence explanation
- unresolved-coverage notes
- recommended actions

## Step 6. Response delivery

Return:

- top-level verdict
- confidence band and score
- prioritized findings
- evidence references
- explanation text
- suggested fixes or substitutions
- supported scope notes
- knowledge snapshot version

The response should be fast and stable.

---

## Internal Fallbacks and Non-Primary Paths

The preferred product behavior is that nothing heavy runs after the user clicks `analysis`.
However, the system still needs well-defined non-primary paths for platform quality.

### Internal fallback path

For packs outside supported coverage or for highly novel combinations, the platform may optionally:

- store the pack for offline evaluation
- enqueue the combination for a later benchmark job
- notify internal reviewers
- improve future snapshots

This path must not block the user response.

### User-visible behavior for unsupported cases

When coverage is weak, the platform should return:

- `insufficient_evidence`
- lower confidence
- explanation of the coverage gap
- optionally "queued for future knowledge refresh" if product design allows it

It should not fabricate confidence it does not have.

---

## Confidence and Trust Model

Confidence should be synthesized from independent dimensions rather than from a single heuristic.

## Trust dimensions

- source type
- author role if inferable
- official vs community source
- internal validation state
- number of independent corroborating sources
- recency
- environment specificity
- version specificity
- contradiction count
- technical evidence support

## Suggested trust hierarchy

Highest trust:

- verified internal rule
- explicit maintainer statement
- internally validated technical conflict
- repeated reproducible issue reports with clear environment scope

Medium trust:

- multiple community reports with good agreement
- strong inferred conflict signatures
- partial version-scope evidence

Low trust:

- single anecdotal user post
- vague report with missing environment details
- stale evidence with no follow-up

## Confidence synthesis inputs

Each finding should retain structured confidence inputs such as:

- exact version match
- exact loader match
- exact Minecraft version match
- direct verified rule present
- number of corroborating sources
- technical signature match
- freshness score
- contradiction penalty
- unresolved identity penalty
- pack fragment prior

The platform should compute:

- finding confidence
- pack-level confidence
- explanation string listing the strongest contributors

---

## Recommendation Pipeline

Recommendations should be generated from precomputed knowledge, not from heavy online reasoning.

## Recommendation sources

- verified workaround rules
- known safe replacement mappings
- dependency repair guidance
- version upgrade or downgrade suggestions
- known safe environment combinations
- historical successful pack fragment alternatives

## Recommendation ranking factors

- confidence of the underlying finding
- severity reduction potential
- simplicity of the fix
- popularity and known safety of the replacement
- number of affected mods
- whether the recommendation stays inside the same loader and version family

## Recommendation output

Each recommendation should expose:

- action type
- target mods and versions
- rationale
- confidence
- expected impact
- supporting evidence

---

## Data Model Requirements

The existing repository already contains part of the necessary model surface. The production pipeline
should extend it with durable structures that support the offline-first design.

## Required durable entities

### Catalog entities

- canonical project
- canonical version
- source mapping
- dependency
- incompatibility declaration
- environment support declaration
- popularity metric
- freshness status

### Evidence entities

- source connector
- source sync run
- raw payload
- normalized evidence document
- evidence snippet
- extracted claim
- contradiction cluster
- evidence trust assessment

### Knowledge entities

- verified compatibility rule
- promoted claim
- technical conflict signature
- pairwise compatibility record
- fragment compatibility record
- pack benchmark result
- confidence explanation record

### Snapshot entities

- knowledge snapshot
- snapshot component manifest
- snapshot validation report
- snapshot promotion event
- snapshot rollback event

### Serving entities

- exact pack result cache
- query fingerprint index
- supported coverage scope record
- nearest-pattern match cache

## Important modeling rules

- every claim must have provenance
- every promoted record must link to its source evidence or technical basis
- every serving result must reference the snapshot version used
- every version-scoped statement must store the exact scope it applies to
- stale evidence must not be silently mixed with fresh evidence

---

## Service Responsibilities

The target architecture should evolve the current services toward clear ownership.

## Gateway

Owns:

- auth and session
- public API surface
- request validation
- request routing
- tenant propagation

Should not own:

- heavy compatibility computation
- direct source ingestion logic

## Catalog service or module

Owns:

- canonical mod/version metadata
- source mappings
- dependency and environment compatibility records
- resolution APIs

May initially live in existing shared platform code, but should have explicit ownership boundaries.

## Evidence service

Owns:

- raw source ingestion persistence
- evidence normalization
- snippet storage
- search and evidence retrieval
- extracted claim storage

## Admin service

Owns:

- human review queues
- curation workflows
- promotion of evidence into verified rules
- contradiction resolution decisions
- snapshot promotion approvals

## Artifact analysis service

Owns:

- offline jar and artifact signature extraction
- structural conflict signature generation

This service should mainly serve offline jobs, not user-time requests.

## Knowledge synthesis service

Owns:

- claim scoring
- pairwise compatibility computation
- fragment and pack cache generation
- confidence aggregation
- snapshot assembly

This may be implemented as a dedicated new service or as a scheduled workflow layer around existing
shared code.

## Analysis serving service

Owns:

- exact pack result lookup
- retrieval-based verdict assembly for cache misses
- confidence explanation generation from stored knowledge

This may eventually absorb part of the current orchestrator's public role for user-facing analysis.

## Orchestrator

In the target state, the orchestrator should primarily own:

- offline workflows
- refresh pipelines
- benchmark jobs
- snapshot publication pipelines
- internal evaluation tasks

The orchestrator should no longer be the main engine for heavy request-time user analysis.

---

## Storage and Indexing Strategy

## PostgreSQL

Source of truth for:

- catalog records
- evidence records
- knowledge records
- caches
- snapshots
- review states
- audit history

## OpenSearch

Used for:

- evidence search
- snippet retrieval
- fast text and entity lookups
- optional serving-time retrieval optimization

Must remain rebuildable from PostgreSQL.

## Neo4j

Used for:

- dependency and interaction graph exploration
- selective higher-order relationship analysis
- analyst investigation tooling

Must remain derived, not canonical.

## Redis

Optional for:

- hot query caching
- snapshot metadata caching
- short-lived lookup acceleration

Must not become the only place where a result exists.

---

## Workflow Definitions

The platform should define explicit workflows for the following.

## 1. Source ingestion workflow

Responsibilities:

- fetch incremental source data
- persist raw payloads
- update connector checkpoints
- capture failures and freshness

## 2. Evidence normalization workflow

Responsibilities:

- classify documents
- extract entities and claims
- create snippets
- deduplicate duplicates
- attach trust metadata

## 3. Artifact signature workflow

Responsibilities:

- fetch or load targeted artifacts
- analyze jars offline
- compute structural signatures
- persist technical conflict records

## 4. Compatibility synthesis workflow

Responsibilities:

- merge catalog, evidence, verified rules, and technical signals
- compute pairwise outcomes
- compute fragment outcomes
- score confidence

## 5. Pack benchmark workflow (ground-truth execution)

Responsibilities:

- receive a prioritized list of mod combinations from the offline knowledge pipeline
- launch Minecraft (Forge) with each combination and attempt a world load
- record whether the combination crashed on startup or loaded successfully
- update pairwise confidence scores in the database based on results

**Scope note:** This workflow detects **startup crashes and load-time failures only**. It does not
validate gameplay correctness, rendering, performance, or issues that emerge during play.
A successful load raises confidence that the combination is compatible at the load boundary —
not that it is fully compatible for all use cases. Results are labeled accordingly.

## 6. Snapshot promotion workflow

Responsibilities:

- assemble candidate knowledge snapshot
- run validation suite
- produce manifest and integrity hashes
- request approval
- promote snapshot for serving

## 7. Impacted-cache refresh workflow

Responsibilities:

- detect which packs, pairs, and fragments are affected by new knowledge
- recompute only impacted serving records

---

## Snapshot Promotion Model

Knowledge should be served from promoted snapshots, not from partially refreshed working tables.

## Snapshot stages

- `draft`
- `validated`
- `approved`
- `promoted`
- `rolled_back`

## Snapshot validation gates

Each candidate snapshot should be checked for:

- schema integrity
- referential integrity
- evidence provenance coverage
- no missing referenced entities
- contradiction-rate thresholds
- minimum freshness coverage for hot projects
- regression checks against known benchmark packs
- deterministic serving reproducibility

## Promotion rules

- only one snapshot is active for production serving at a time
- promotion must be auditable
- rollback must be possible without re-running all jobs

---

## Supported Coverage Model

The platform must explicitly store and serve its coverage zone.

## Coverage dimensions

- supported Minecraft versions
- supported loaders
- supported project set
- supported version freshness windows
- supported confidence guarantees

## Why this matters

Coverage awareness prevents the product from over-claiming.
It also lets the UI say:

- "high-confidence coverage"
- "best-effort coverage"
- "outside validated coverage"

---

## API and Response Expectations

The production analysis response should include more than just findings.

## Required response fields

- `analysisId` or equivalent request record
- `knowledgeSnapshotVersion`
- `packFingerprint`
- `verdict`
- `confidenceBand`
- `confidenceScore`
- `coverageStatus`
- `findings`
- `recommendations`
- `unresolvedEntries`
- `evidenceSummary`
- `freshnessSummary`
- `explanation`

## Finding-level response expectations

Each finding should include:

- finding type
- affected mods and versions
- environment scope
- severity
- verdict
- confidence
- why it was produced
- supporting evidence references
- whether it came from a verified rule, community evidence, or technical signature

---

## Observability and Quality Gates

The platform needs strong telemetry for both knowledge production and serving quality.

## Core production metrics

- source fetch success rate
- evidence extraction throughput
- evidence contradiction rate
- snapshot build duration
- snapshot validation pass rate
- number of promoted verified rules
- pairwise matrix coverage
- fragment cache hit rate
- exact pack cache hit rate
- user analysis latency
- percentage of results returned without heavy fallback
- confidence distribution by verdict type

## Core serving SLIs

- p50/p95 user analysis latency
- exact pack cache hit ratio
- retrieval-assembled response ratio
- unsupported coverage response ratio
- stale snapshot serving incidents

## Quality monitoring

The platform should continuously measure:

- false positive reports
- false negative reports
- rule regression rate
- evidence aging rate
- unsupported-yet-common mod frequency

---

## Security and Compliance Considerations

The pipeline should respect source policies and data governance.

Requirements:

- store source provenance and fetch timestamps
- respect rate limits and usage terms of external connectors
- avoid storing disallowed private content
- support source-specific takedown or exclusion policies
- keep analyst actions auditable
- separate tenant data from global knowledge assets where required

---

## Rollout Strategy

This document describes the end-state architecture. Implementation should still be phased in a way
that preserves product continuity.

## Recommended migration direction

1. build the canonical catalog and knowledge snapshot model first
2. promote verified rules and evidence into structured knowledge
3. add pairwise and fragment serving records
4. shift user-facing analysis toward retrieval-first behavior
5. repurpose the orchestrator toward offline refresh and benchmark jobs
6. retain heavy computation as an internal enrichment pipeline rather than a blocking user path

## Migration rule

At every step, the platform should be able to explain whether a result came from:

- legacy live computation
- promoted snapshot lookup
- retrieval-based knowledge synthesis

This is essential during transition.

---

## Acceptance Criteria for the Target State

The platform can be considered aligned with this architecture when all of the following are true.

## Product behavior

- most user analyses complete from retrieval and scoring, not heavy live computation
- exact pack and common-fragment results are fast
- unsupported cases are explicitly labeled instead of over-claimed
- users see clear evidence and confidence reasoning

## Data behavior

- the system maintains a canonical cross-source mod catalog
- evidence is ingested continuously and deduplicated
- verified rules are curated and promoted
- pairwise and fragment knowledge are versioned in snapshots
- serving indexes are built from promoted snapshots

## Operational behavior

- weekly knowledge refresh runs successfully
- snapshot promotion and rollback are operationally safe
- query latency remains low and predictable
- heavy offline work does not block user requests

## Quality behavior

- benchmark packs are used to regression-test promoted snapshots
- confidence is calibrated and explainable
- contradiction handling reduces stale false positives
- source freshness is visible in outputs and monitoring

---

## Explicit Non-Goals

This architecture does not aim to:

- guarantee correctness for every arbitrary pack in existence
- replace human judgment in ambiguous ecosystem cases
- infer universal compatibility from absence of evidence
- run unbounded live computation for every request

Instead, it aims to:

- maximize launch-time trust
- maximize speed and smoothness
- grow confidence through continuous knowledge accumulation
- keep product honesty when coverage is incomplete

---

## Summary

The strongest production pipeline for this project is:

- offline-first
- knowledge-snapshot-driven
- confidence-aware
- retrieval-based at user request time
- continuously refreshed on a weekly cadence
- backed by curated rules, ecosystem evidence, technical conflict signatures, and cached pack results

In this model, the platform's moat is not only the UI or the current orchestrator.
The moat is the continuously improving compatibility knowledge system and the promoted snapshots that
make fast, trustworthy analysis possible.
