# Modpack Compatibility Platform Implementation Plan

## Purpose

This document summarizes the existing product and technical blueprints in this repository and turns them into a concrete, production-ready implementation plan for the first engineering phase of the platform.

It is intentionally faithful to the current documents. Where this plan makes an inference or recommends a specific implementation choice not fully specified in the source docs, it is labeled explicitly.

---

## 1. Relevant Documents Reviewed

### Product and architecture docs

- `Modpack_Compatibility_Platform_Docs/00_README.md`
- `Modpack_Compatibility_Platform_Docs/01_Product_and_Platform_Vision.md`
- `Modpack_Compatibility_Platform_Docs/02_System_Architecture.md`
- `Modpack_Compatibility_Platform_Docs/03_Domain_Model_and_Data_Architecture.md`
- `Modpack_Compatibility_Platform_Docs/04_Compatibility_Engine.md`
- `Modpack_Compatibility_Platform_Docs/05_Data_Pipelines_and_Ingestion.md`
- `Modpack_Compatibility_Platform_Docs/06_Recommendations_and_Automation.md`
- `Modpack_Compatibility_Platform_Docs/07_Build_Roadmap.md`
- `Modpack_Compatibility_Platform_Docs/08_Testing_Validation_and_Operations.md`
- `Modpack_Compatibility_Platform_Docs/09_Business_Risks_and_Long_Term_Vision.md`

### Technical blueprints

- `Modpack_Compatibility_Platform_Technical_Blueprints/00_README.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/01_Service_Catalog.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/02_API_Contracts.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/04_Event_Contracts.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/05_Database_Schema_Postgres.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/06_Graph_Model_Neo4j.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/07_Search_and_Indexing.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/08_Analysis_Workflows.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/09_Security_and_MultiTenancy.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/10_Diagrams.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/11_External_Source_Integration_Notes.md`
- `Modpack_Compatibility_Platform_Technical_Blueprints/12_Implementation_Backlog_By_Stream.md`

### Machine-readable assets

- `Modpack_Compatibility_Platform_Technical_Blueprints/openapi/platform.openapi.yaml`
- `Modpack_Compatibility_Platform_Technical_Blueprints/schemas/json/analysis.requested.schema.json`
- `Modpack_Compatibility_Platform_Technical_Blueprints/schemas/json/analysis.finding.emitted.schema.json`
- `Modpack_Compatibility_Platform_Technical_Blueprints/schemas/sql/postgres_core.sql`
- Mermaid diagrams under `Modpack_Compatibility_Platform_Technical_Blueprints/diagrams/`

---

## 2. Product Goals

The platform is positioned as a compatibility intelligence platform for Minecraft modpacks, not a simple dependency checker.

### Core product outcomes

- Ingest large mod lists, manifests, profile exports, repository-based pack definitions, and uploaded mod folders.
- Normalize mods, versions, loaders, and environment metadata across ecosystems such as CurseForge, Modrinth, GitHub, and user uploads.
- Detect hard incompatibilities, dependency conflicts, performance risks, crash risks, and likely stability issues.
- Explain findings clearly with evidence, provenance, scope, severity, confidence, and remediation suggestions.
- Recommend compatible alternatives, including bundle recommendations and ordered remediation plans.
- Monitor pack health over time through saved workspaces, historical analyses, diffs, alerts, CI workflows, and integrations.
- Expose the platform as infrastructure through REST APIs, webhooks, GitHub integrations, and future launcher or hosting integrations.

### Product principles preserved from the docs

- Explainability before cleverness.
- Hybrid intelligence: rules, graph reasoning, heuristics, ML, and evidence.
- Version- and environment-specific findings.
- Severity and confidence treated separately.
- Actionable outputs, not just diagnostics.
- Long-term workflow support: saved packs, diffs, monitoring, CI/CD, and automation.

---

## 3. Documented Target Architecture

### Architectural style

The documented direction is a service-oriented architecture with a limited number of bounded services, avoiding both a permanent monolith and an overly fragmented microservice approach.

### Primary service domains described across the docs

- API Gateway / BFF
- Identity, Workspace, and Billing
- Catalog
- Resolver
- Static Analysis
- Evidence Ingestion / Evidence Service
- Knowledge Graph
- Recommendation
- ML / NLP
- Simulation
- Notification / Webhook
- Admin / Curation
- Analysis Orchestrator or workflow layer

### Recommended language split

- TypeScript / Node.js for API gateway, BFF, workspace logic, billing, and integrations.
- Go for resolver execution, orchestration, recommendation orchestration, and high-concurrency internal APIs.
- Python for NLP, embeddings, classification, feature engineering, and model inference/training.
- Kotlin / JVM for jar inspection, metadata parsing, mixin extraction, and JVM-native artifact analysis.

### Frontend stack

- Next.js
- React
- TypeScript
- Tailwind CSS
- TanStack Query
- Zustand
- SSE or WebSocket for analysis progress

### Infrastructure and runtime

- AWS is the documented default cloud.
- EKS for service deployment.
- PostgreSQL for transactional source of truth.
- Neo4j for graph reasoning.
- OpenSearch for evidence and findings retrieval.
- Redis for caching, rate limiting, dedupe, and ephemeral state.
- S3/object storage for raw payloads, artifacts, logs, exports, and datasets.
- Kafka for event-driven orchestration and updates.
- Temporal is explicitly recommended in workflow docs for durable orchestration.
- ClickHouse is mentioned for telemetry and ecosystem analytics in product docs.

### Operating model

- Separate online and offline workloads.
- Use queue-based buffering and independently autoscaled workers.
- Treat rules and models as versioned deployable assets with rollback paths.
- Build strong observability, quality governance, and human review loops from the start.

---

## 4. Data Model and Storage Summary

### PostgreSQL responsibilities

PostgreSQL is the transactional source of truth for:

- users, organizations, memberships, plans, subscriptions, API keys
- workspaces, projects, integrations, watches
- canonical projects, versions, source mappings, aliases
- pack snapshots and environment profiles
- analyses, phases, findings, finding subjects, evidence links, actions
- recommendation sets and impacts
- evidence metadata and source sync metadata

### Graph model responsibilities

Neo4j is used for:

- dependency and incompatibility relationships
- class, mixin, and resource targeting relationships
- co-installation and replacement relationships
- explanation path queries
- neighborhood expansion for candidate generation and risk reasoning
- pack-specific active explanation subgraphs and hot graph summaries

### Search responsibilities

OpenSearch is used for:

- evidence documents and snippets
- crash signature lookup
- hybrid lexical and semantic retrieval
- indexed findings and recommendations
- faceted filtering and version/environment-aware ranking

### Other storage layers

- Redis for caches, sessions, dedupe, quotas, and transient analysis state
- S3/object storage for raw source payloads, jars, crash logs, exports, large derived outputs, and ML datasets
- Kafka for event transport and incremental update propagation
- ClickHouse for high-volume telemetry and analytics, as stated in product docs

### Canonical entities described in the docs

- CanonicalProject
- ProjectSourceMapping
- Version
- Artifact
- DependencyEdge
- Pack
- AnalysisRun
- Finding
- Evidence
- Recommendation

### Modeling principles preserved

- Internal canonical identity must not depend permanently on external naming.
- Packs are contextual environments, not just mod lists.
- Evidence is time-sensitive and must support supersession and contradiction.
- All important records should carry schema version, provenance, timestamps, and trace identifiers.

---

## 5. Documented Data Flows and Pipelines

### Ingestion pipeline

The docs describe a Bronze/Silver/Gold-style pipeline:

- Bronze: raw payloads, issue threads, changelogs, logs, and jar outputs
- Silver: normalized canonical entities and deduplicated structured evidence
- Gold: graph edges, risk features, recommendation candidates, embeddings, confidence inputs, and analysis-ready derived outputs

### Identity resolution pipeline

The documented staged approach is:

1. direct known mapping
2. artifact and metadata matching
3. semantic/contextual matching
4. confidence classification
5. manual review for ambiguous cases

### Evidence extraction pipeline

The docs describe:

- relevance classification
- entity extraction
- relation extraction
- snippet preservation with provenance
- deduplication and clustering
- contradiction and supersession handling
- trust and recency scoring

### Analysis workflow

The documented high-level sequence is:

1. accept pack input
2. normalize mods and versions
3. resolve hard constraints and explicit incompatibilities
4. enrich with catalog and graph context
5. run static artifact analysis
6. retrieve evidence neighborhoods
7. run heuristics and ML scoring
8. merge and deduplicate findings
9. generate recommendations
10. optionally run simulation
11. rescore with simulation evidence
12. materialize report and notify listeners

### Incremental re-analysis

The docs consistently require selective, event-driven re-analysis:

- detect changed projects, versions, rules, or evidence
- identify impacted saved pack snapshots
- rerun only affected analyses
- notify only when severity/confidence deltas cross thresholds

---

## 6. APIs, Events, and Contracts

### Public API surface documented

- workspace and project management
- pack imports
- analysis creation and retrieval
- findings, graph, recommendations, report export
- catalog search and resolution
- finding feedback and state changes
- integrations and webhooks

### API behavior expectations

- REST for primary product APIs
- SSE for job progress
- optional GraphQL mentioned only for future deep exploration
- versioned public APIs
- idempotency for write-heavy endpoints
- traceability and observability across long-running jobs

### Internal API surface documented

- resolver endpoints for normalize, resolve, explain
- static analysis endpoints for artifact analysis and summaries
- graph endpoints for upsert, neighborhood, and explanation
- recommendation generation endpoint

### Event contracts documented

Topic families are defined for:

- ingestion
- catalog and identity
- analysis
- graph
- recommendation
- user/workspace events

The event envelope requires:

- event id
- event type
- schema version
- occurred-at timestamp
- correlation id
- tenant id when relevant
- project id when relevant
- producer
- payload

### Machine-readable contract coverage today

- starter OpenAPI for creating analyses and retrieving analysis summaries/findings
- JSON Schemas for `analysis.requested` and `analysis.finding.emitted`
- starter SQL DDL for core transactional tables

This is enough for kickoff, but not enough for implementation completeness yet.

---

## 7. Compatibility Intelligence Stack

The documented engine is explicitly hybrid and has five layers.

### Layer A: deterministic rules

- dependency resolution
- loader, Minecraft, Java, and side validation
- explicit incompatibilities
- verified curated rules
- minimal fix path calculation

### Layer B: graph reasoning

- indirect risk paths
- cluster and neighborhood reasoning
- substitute discovery
- ecosystem stack tension
- explanation path generation

### Layer C: heuristics

- mixin/transformer overlap
- embedded library divergence
- functional duplication
- registry/resource collision
- dependency tension
- config conflict patterns
- negative co-install signal as a weak feature

### Layer D: evidence aggregation

- official metadata
- GitHub issues/comments
- changelogs and release notes
- curated community reports
- user-submitted crash logs
- known remediation examples

### Layer E: ML / AI

- hard incompatibility probability
- crash probability
- performance degradation probability
- user-visible instability probability
- recommendation improvement probability
- confidence calibration
- semantic retrieval and reranking

### Recommendation system

The recommendation layer is designed to:

- generate candidates from functional similarity, graph similarity, community replacement signals, and pack ecosystem similarity
- filter by environment and compatibility constraints
- rank by compatibility gain, feature preservation, maintenance health, adoption, migration cost, and confidence
- output single replacements, bundles, and multi-step remediation plans

### Explanation system

LLMs are allowed only for grounded summarization and explanation rewriting, never for unsupported finding generation.

---

## 8. Testing, Reliability, Security, and Operations

### Quality strategy documented

- unit tests for resolver, rules, DSL, identity resolution, graph logic, scoring, and recommendation filtering
- integration tests across import, normalization, resolver, evidence, graph, reporting, and recommendations
- end-to-end workflows for analysis, diffs, CI triggers, reanalysis, and export
- regression fixtures for historical pack cases and scoring/model/rule changes
- curated truth sets for compatibility and recommendation validation
- strategic simulation tiers rather than blanket runtime simulation

### Operational expectations

- observability by request id, analysis id, workspace id, rule version, and model version
- dashboards for API performance, freshness, graph health, drift, and recommendation outcomes
- canary and rollback support
- rules and models treated as governed assets
- human review queues for ambiguous, high-severity, or low-confidence cases

### Security and tenancy

- organization-based multi-tenancy
- global/shared catalog and public evidence; tenant-scoped workspaces, projects, uploads, reports, and private artifacts
- OAuth/OIDC for users
- scoped API keys for B2B
- mTLS or workload identity for service auth
- malware scanning and sandboxing for uploaded jars
- disposable, network-restricted simulation environments
- signed webhook secrets, quotas, rate limits, and audit logging

---

## 9. Ambiguities, Contradictions, and Missing Details

This section identifies places where the docs are directionally aligned but not fully implementation-ready.

### A. Service boundary inconsistencies

- `02_System_Architecture.md` targets 6 to 9 core services, while `01_Service_Catalog.md` names 12 services plus shared capabilities.
- The architecture docs repeatedly reference an Analysis Orchestrator, but the service catalog does not define it as a first-class service.
- Product docs describe a Workspace Service; the service catalog merges identity, workspace, and billing into one service.
- Product docs describe an Evidence Service; blueprints describe an Evidence Ingestion Service, and the sequence diagram labels evidence retrieval as a separate participant.

### B. Storage architecture mismatch

- `03_Domain_Model_and_Data_Architecture.md` includes ClickHouse for telemetry and analytics, but the technical blueprints and deployment diagram do not include it.
- The silver/gold data-layer language implies a broader data platform, but no explicit warehouse or lakehouse boundary is formally defined beyond S3, OpenSearch, Neo4j, and Postgres.

### C. API contract incompleteness

- `02_API_Contracts.md` lists a much larger surface than the starter OpenAPI file currently defines.
- SSE progress, graph retrieval, recommendations, exports, imports, workspaces, integrations, and webhook endpoints are not yet represented in machine-readable OpenAPI.
- Error contracts, pagination contracts, auth scopes, rate-limit headers, and idempotency-key headers are not yet formalized.

### D. Event contract incompleteness

- Only two JSON Schemas exist for events; the topic catalog is much broader.
- The docs specify event versioning and validation, but there is no repo structure yet for full schema evolution, compatibility testing, or consumer contract testing.

### E. Database schema gaps

- `05_Database_Schema_Postgres.md` lists many tables not present in `schemas/sql/postgres_core.sql`.
- `analyses.pack_snapshot_id` is non-null in the schema doc example but nullable in `postgres_core.sql`.
- Tenant scoping columns are described conceptually in security docs, but row-level tenant markers are not consistently present in the starter SQL.
- The docs call for provenance, schema versioning, and trace ids on records, but these are mostly absent from the starter relational DDL.

### F. Rules and DSL

- The rule engine is central to the product, but there is no documented rule DSL grammar, execution model, storage model, or rollout process beyond conceptual examples.
- Verified-rule promotion from analyst review is described, but the authoring and approval workflow is not yet specified.

### G. Static analysis depth

- Kotlin/JVM is recommended for jar and mixin analysis, but there is no concrete module boundary, parser library choice, output schema, or artifact cache policy.
- The exact definition of binary fingerprints, class target extraction, and embedded-library detection remains open.

### H. Confidence and scoring

- Severity and confidence are well described conceptually, but no canonical scoring formula, weighting strategy, or calibration artifact format is specified.
- Reproducibility is documented as a third dimension but not represented consistently across machine-readable schemas.

### I. Recommendation data model

- Recommendation bundles, migration-cost factors, and remediation plans are core product features, but the starter SQL and OpenAPI do not yet define their full shape.

### J. Simulation design

- Simulation is a major differentiator, but the docs do not yet specify runtime images, modpack assembly rules, budget policies, environment matrices, or artifact retention rules.

### K. Source integration specifics

- External source notes mention current CurseForge, Modrinth, and GitHub constraints, but refresh policy, quota budgeting, checkpoint format, and connector retry semantics are not yet standardized in config or schema.
- Community-source ingestion is mentioned, but source allowlists, ingestion trust tiers, and moderation policy are still underdefined.

### L. Source-of-truth governance

- The repo contains product docs, blueprint docs, diagrams, SQL, JSON Schemas, and OpenAPI, but there is not yet an explicit precedence rule when documents diverge.

---

## 10. Opinionated Production-Ready Decisions

These decisions are recommended to make implementation practical while staying faithful to the docs.

### Decision 1

Treat the system as a modular monorepo with independently deployable services, not as many separate repositories.

Reason: the repo is currently blueprint-driven, contracts are still evolving, and strong shared schemas/contracts are more important than repo-level isolation at this stage.

### Decision 2

Make Temporal the authoritative workflow engine for analysis and re-analysis orchestration.

Reason: it is already explicitly named in the workflow docs and fits long-running, retry-heavy, stateful analysis jobs.

### Decision 3

Define the first implementation service split as:

- `gateway`
- `workspace`
- `catalog`
- `analysis-orchestrator`
- `resolver`
- `artifact-analysis`
- `evidence`
- `graph`
- `recommendation`
- `ml`
- `simulation`
- `notification`
- `admin`

Inference: this keeps the blueprint naming coherent while preserving the smaller bounded-service principle operationally via one repo and phased rollout.

### Decision 4

Use PostgreSQL as the initial system of record, with Neo4j and OpenSearch treated as derived stores populated from events and backfills.

Reason: this matches the transactional-source-of-truth language in the blueprint docs and simplifies recovery.

### Decision 5

Defer ClickHouse until platform telemetry volume justifies it.

Inference: the product docs mention it, but the technical blueprints do not operationalize it. The platform should reserve a place for it in the architecture, but not block Phase 1 on it.

### Decision 6

Treat rules, model versions, and schema contracts as first-class versioned assets under source control with CI validation and rollout metadata.

Reason: this is explicitly implied throughout the docs and is necessary for trust and rollback.

---

## 11. Proposed Implementation Plan by Phase

This plan is aligned to the documented roadmap, but converted into concrete production workstreams.

### Phase 0: Contract and platform baseline

Goal: turn the existing blueprint set into implementation-grade contracts and repo scaffolding.

Deliver:

- finalize service boundaries and naming
- define source-of-truth precedence for docs vs machine-readable contracts
- expand OpenAPI to cover the documented public API surface
- expand JSON Schemas for the documented event topics
- create migration-managed Postgres schema from current DDL
- define canonical IDs, envelope conventions, trace-id standards, and tenant-scoping conventions
- stand up monorepo CI, formatting, linting, testing, build, and container conventions
- provision Terraform baseline for networking, EKS, Postgres, Redis, S3, Kafka, OpenSearch, and secrets

Exit criteria:

- contracts compile and validate in CI
- initial dev/staging environments exist
- service skeletons and shared libraries are in place

### Phase 1: Workspace, catalog, import, and deterministic analysis foundation

Goal: ship a usable baseline that imports packs, normalizes them, resolves hard constraints, and renders persisted reports.

Deliver:

- auth, orgs, workspaces, projects, RBAC, API keys
- pack import endpoints and object-storage upload flow
- pack snapshot model and normalization pipeline
- catalog ingestion for CurseForge and Modrinth metadata
- canonical identity resolution v1
- resolver service v1 for dependency, loader, Minecraft, Java, and side checks
- basic rule engine framework and verified-rule storage
- analysis orchestrator using Temporal
- persisted analyses, phases, findings, and report APIs
- Next.js shell for import, progress, and findings dashboard

Exit criteria:

- a user can import a pack and run deterministic analysis end to end
- analyses are traceable and replayable
- core API and event contracts are live and tested

### Phase 2: Artifact intelligence and graph reasoning foundation

Goal: move from metadata-only checks to deeper compatibility reasoning.

Deliver:

- artifact-analysis service for jar metadata, mixin extraction, class/resource targeting, and embedded-library detection
- graph schema and upsert pipelines
- explanation-path APIs and graph neighborhoods
- finding merge/dedupe logic across rule and static-analysis outputs
- pack diff workflows
- richer findings model with provenance and confidence inputs

Exit criteria:

- the system surfaces non-trivial indirect risks
- findings include graph/static-analysis-backed explanations
- graph-derived reasoning materially improves recall without exploding noise

### Phase 3: Evidence platform and trust-aware retrieval

Goal: ingest public ecosystem evidence and make it operationally useful.

Deliver:

- connector framework for GitHub and curated community sources
- raw payload retention and sync-run tracking
- document normalization, relevance classification, entity extraction, relation extraction, and dedupe
- contradiction/supersession handling
- OpenSearch evidence indexes and retrieval APIs
- analyst/admin curation surfaces
- verified-rule promotion workflows

Exit criteria:

- evidence improves finding quality on curated truth sets
- source freshness and trust are measurable
- ambiguous mappings and low-confidence evidence can be reviewed by humans

### Phase 4: Recommendations, remediation, and quality loops

Goal: turn the platform into a workflow tool, not just a diagnostics engine.

Deliver:

- recommendation candidate generation from graph, functional clusters, and ecosystem history
- hard/soft filtering and reranking
- migration-cost model v1
- recommendation bundles and remediation plan generation
- recommendation feedback capture and outcome tracking
- exportable reports with decision-aid recommendation sections

Exit criteria:

- recommendations are persisted, explainable, and measured
- minimal unblock and stability-first plans are available

### Phase 5: ML, calibration, and grounded AI UX

Goal: improve recall, ranking, and summarization without sacrificing trust.

Deliver:

- feature pipelines and offline datasets
- first calibrated risk models
- confidence calibration framework
- semantic retrieval and reranking
- grounded explanation generation and pack review summaries
- model registry, rollout, drift monitoring, and rollback support

Exit criteria:

- ML improves ranking/coverage on validation sets
- explanations remain grounded in structured evidence
- model releases are observable and reversible

### Phase 6: Simulation, release gating, and partner integrations

Goal: make the platform operationally indispensable.

Deliver:

- sandboxed simulation workers and smoke-test recipes
- startup validation and crash signature extraction
- simulation-result feedback into confidence scoring
- GitHub App, status checks, and webhook fan-out
- release-gating policies
- partner-facing API hardening, quotas, billing hooks, and SLA controls

Exit criteria:

- simulation is safe, budgeted, and useful
- CI and partner workflows are reliable
- the platform supports recurring production use by creators and integrators

---

## 12. Proposed Repository Structure

The repo should remain a monorepo, with strong separation between services, shared contracts, infrastructure, docs, and deployable assets.

```text
/apps
  /web
  /gateway
  /workspace
  /catalog
  /analysis-orchestrator
  /resolver
  /artifact-analysis
  /evidence
  /graph
  /recommendation
  /ml
  /simulation
  /notification
  /admin

/packages
  /api-contracts
  /event-contracts
  /domain-models
  /auth
  /config
  /observability
  /id-generation
  /client-sdks
  /rule-engine-sdk
  /testing-fixtures

/schemas
  /openapi
  /events
  /json
  /sql
  /graphql

/rules
  /verified
  /proposed
  /tests

/models
  /features
  /training
  /inference
  /evaluation
  /registry

/workflows
  /temporal
  /definitions
  /tests

/connectors
  /curseforge
  /modrinth
  /github
  /community

/infra
  /terraform
  /kubernetes
  /monitoring
  /secrets

/scripts
  /dev
  /ci
  /backfills
  /data-maintenance

/docs
  /product
  /architecture
  /data
  /operations
  /adr
  /rfcs

/fixtures
  /packs
  /artifacts
  /evidence
  /truth-sets
  /simulation
```

### Repository structure rationale

- `apps/` holds independently deployable services and the web app.
- `packages/` holds shared code that must stay version-aligned.
- `schemas/` becomes the canonical home for machine-readable contracts.
- `rules/` and `models/` keep logic assets governed separately from service code.
- `workflows/` isolates Temporal orchestration.
- `connectors/` isolates source-specific integration logic.
- `fixtures/` supports replayable regression and truth-set testing from day one.

---

## 13. Immediate Next Documentation Work

Before writing significant platform code, the following documentation and contract work should be completed:

- formal source-of-truth and precedence policy
- complete service ownership and naming decisions
- expanded OpenAPI specification
- complete event schema set
- initial ADRs for monorepo, Temporal, polyglot language split, and storage-of-record choices
- rule DSL specification
- artifact-analysis output schema
- recommendation and remediation JSON shapes
- tenant-scoping and audit-field conventions
- simulation safety and sandbox design note

---

## 14. Recommended Source of Truth

The documents should be treated with the following precedence:

### Product source of truth

`Modpack_Compatibility_Platform_Docs/01_Product_and_Platform_Vision.md`

This should be the source of truth for product intent, personas, UX goals, platform positioning, and the definition of what the platform is meant to do.

### System architecture source of truth

`Modpack_Compatibility_Platform_Docs/02_System_Architecture.md`
`Modpack_Compatibility_Platform_Docs/03_Domain_Model_and_Data_Architecture.md`
`Modpack_Compatibility_Platform_Docs/04_Compatibility_Engine.md`
`Modpack_Compatibility_Platform_Docs/05_Data_Pipelines_and_Ingestion.md`
`Modpack_Compatibility_Platform_Docs/06_Recommendations_and_Automation.md`

These should be treated as the source of truth for architecture, data model intent, analysis methodology, ingestion model, and recommendation behavior.

### Implementation contract source of truth

For anything machine-readable, the source of truth should be the contract files themselves once expanded and maintained:

- `Modpack_Compatibility_Platform_Technical_Blueprints/openapi/platform.openapi.yaml`
- `Modpack_Compatibility_Platform_Technical_Blueprints/schemas/json/*.json`
- `Modpack_Compatibility_Platform_Technical_Blueprints/schemas/sql/*.sql`

Current caveat: these machine-readable contracts are still incomplete relative to the prose docs, so the prose architecture docs currently define intent while the machine-readable files define only the implemented subset.

### Technical implementation guide

`Modpack_Compatibility_Platform_Technical_Blueprints/01_Service_Catalog.md`
`Modpack_Compatibility_Platform_Technical_Blueprints/08_Analysis_Workflows.md`
`Modpack_Compatibility_Platform_Technical_Blueprints/09_Security_and_MultiTenancy.md`

These should be treated as the implementation guide for service boundaries, orchestration flow, and tenancy/security posture.

### Recommended explicit governance rule

If prose docs and machine-readable contracts diverge:

1. Product behavior follows the product and architecture docs until an ADR updates that intent.
2. Implemented API/event/database behavior follows the machine-readable contract currently checked into the repo.
3. Divergence should be resolved immediately by updating both sides in the same change.

This governance rule is an inference and should be adopted formally as an ADR.

---

## 15. Final Assessment

This repository already defines a strong production-oriented vision. It is not an MVP sketch. The most important next step is not writing all platform code immediately; it is tightening the contract layer and service boundaries so implementation can proceed without ambiguity.

The strongest architectural throughline across the docs is:

- canonical catalog and identity resolution
- deterministic resolver and rule engine
- graph- and evidence-backed enrichment
- confidence-aware findings and recommendations
- event-driven incremental re-analysis
- operational rigor equal to a reliability platform

That should remain the backbone of the implementation.
