# 07. Build Roadmap

## 1. Roadmap principle

The goal is not to build a toy first and “figure it out later.”

The goal is to build in a phased but strategically correct sequence so that:

- foundations do not need major rewrites
- the knowledge base becomes valuable early
- the product can grow from creator tool into platform

---

## 2. Phase 1 - Foundation platform

### 2.1 Objectives
Establish the technical and data foundation.

### 2.2 Components to build

#### Product surface
- user auth
- organizations/workspaces
- project dashboard
- pack import flows
- saved analysis jobs
- report rendering shell

#### Platform core
- API gateway
- workspace service
- job orchestration
- object storage
- Postgres
- Redis
- Kafka/event bus
- CI/CD baseline
- observability baseline
- infrastructure as code

#### Data foundation
- catalog schema
- connectors for major sources
- raw payload storage
- canonical project and version normalization
- identity resolution v1

#### Analysis foundation
- resolver service v1
- rule engine framework
- basic findings format
- deterministic incompatibility reporting

### 2.3 Dependencies
This phase depends only on product definition and initial technical decisions.

### 2.4 Exit criteria
- packs can be imported
- normalized manifests can be produced
- deterministic compatibility checks work
- saved analyses and reports exist
- source ingestion runs reliably

---

## 3. Phase 2 - Core compatibility engine

### 3.1 Objectives
Move beyond explicit metadata and into real compatibility intelligence.

### 3.2 Components to build

#### Static analysis
- jar parsing
- metadata extraction
- mixin target extraction
- embedded library inspection
- resource and class touchpoint analysis

#### Knowledge graph
- graph schema
- graph ingestion
- graph service API
- explanation path logic

#### Findings system
- severity model
- confidence model v1
- evidence references
- provenance tracking

#### Product features
- richer findings dashboard
- dependency graph exploration
- pack diffing
- recommendation v1

### 3.3 Dependencies
Requires:
- canonical catalog
- resolver foundation
- raw artifact handling
- initial report UI

### 3.4 Exit criteria
- indirect risk signals appear
- graph-backed explanations are available
- recommendations go beyond naive category matching

---

## 4. Phase 3 - Data intelligence layer

### 4.1 Objectives
Turn public ecosystem signals into structured evidence.

### 4.2 Components to build

#### Ingestion expansion
- issue/discussion connectors
- changelog and release note connectors
- user-submitted evidence flows

#### NLP and extraction
- relevance classifier
- entity extraction
- relation extraction
- duplicate clustering
- contradiction handling

#### Internal tooling
- analyst review dashboards
- curation workflows
- source trust controls
- verified rule promotion workflow

#### Search
- evidence indexing
- source filtering
- crash signature lookup

### 4.3 Dependencies
Requires:
- graph storage
- raw document storage
- canonical identity resolution
- event-driven pipeline backbone

### 4.4 Exit criteria
- community evidence materially improves finding coverage
- stale or contradictory reports are managed
- analyst curation becomes part of system quality control

---

## 5. Phase 4 - ML and AI layer

### 5.1 Objectives
Use machine learning to improve ranking, recall, and recommendation quality without sacrificing trust.

### 5.2 Components to build

#### Feature platform
- training data generation
- feature store
- pack and finding telemetry
- offline evaluation pipelines

#### ML systems
- pairwise risk model
- group-risk enrichment
- confidence calibration
- semantic retrieval
- recommendation reranker

#### AI UX
- grounded explanation generator
- pack summary generator
- remediation narrative generation

#### Quality systems
- drift monitoring
- model versioning
- rollback strategy
- active learning loop

### 5.3 Dependencies
Requires:
- labeled data
- mature evidence pipeline
- stable finding schema
- historical outcome telemetry

### 5.4 Exit criteria
- AI measurably improves ranking and recall
- confidence remains calibrated
- explanations stay evidence-grounded

---

## 6. Phase 5 - Simulation, ecosystem integration, and scale

### 6.1 Objectives
Make the platform operationally indispensable.

### 6.2 Components to build

#### Simulation
- ephemeral runtime environments
- startup smoke tests
- server/client validation workflows
- log capture and clustering
- result feedback into scoring

#### Ecosystem integrations
- GitHub App
- CI status checks
- Discord/webhooks
- launcher integrations
- hosting-platform integrations
- enterprise API layer

#### Commercial systems
- billing
- quotas
- plan enforcement
- organization permissions
- SLA support
- partner controls

#### Public trust features
- compatibility advisories
- verified findings
- public report sharing
- ecosystem explorer

### 6.3 Dependencies
Requires all prior phases.

### 6.4 Exit criteria
- platform supports recurring workflows
- partner integrations function reliably
- monetization infrastructure is ready
- operational maturity is acceptable for scale

---

## 7. Suggested execution order inside teams

### 7.1 Platform team
Focus:
- infra
- auth
- workspaces
- APIs
- CI/CD
- reliability

### 7.2 Data platform team
Focus:
- ingestion
- normalization
- graph population
- evidence indexing
- freshness and quality

### 7.3 Compatibility intelligence team
Focus:
- resolver
- rules
- static analysis
- scoring
- recommendations

### 7.4 ML and intelligence team
Focus:
- NLP
- embeddings
- predictive models
- ranking
- calibration

### 7.5 Product and UX team
Focus:
- import flows
- report UX
- graph visualization
- remediation workflows
- collaboration features

---

## 8. Roadmap discipline

Every phase should ship with:

- documented contracts
- measurable quality criteria
- backfill strategy
- migration plan if schemas evolve
- regression tests
- observability hooks

That is how a complex platform avoids accidental entropy.

