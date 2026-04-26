# 02. System Architecture

## 1. Architectural style

The platform should not be built as:

- a single oversized monolith forever
- or a fragmented set of tiny microservices from day one

The best fit is a **service-oriented architecture with a small number of bounded services**.

This allows:

- independent scaling of ingestion, analysis, and UI APIs
- clean boundaries for high-change domains
- operational flexibility
- long-term maintainability without early-stage service explosion

A good target is 6 to 9 core services.

---

## 2. High-level architecture

```text
Users / Web UI / APIs / Integrations
                |
        API Gateway / BFF
                |
 ------------------------------------------------
 |              |              |                |
Auth &      Workspace       Catalog         Analysis
Billing     Service         Service         Orchestrator
                                                |
                          -------------------------------------------------
                          |            |            |           |          |
                       Resolver     Static       Graph      Evidence   Recommendation
                       Service      Analysis     Service    Service    Service
                                                   \
                                                    \
                                                  ML / NLP Service
                                                        |
                                                  Simulation Service
                                                        |
                                     ------------------------------------------------
                                     |         |          |         |       |      |
                                  Postgres   Neo4j   OpenSearch   Redis    S3    Kafka
```

---

## 3. Frontend architecture

### 3.1 Stack
Recommended frontend stack:

- Next.js
- React
- TypeScript
- Tailwind CSS
- TanStack Query
- Zustand for workspace-local state
- SSE or WebSocket for live job updates

### 3.2 Frontend areas

The application should be divided into the following top-level areas:

- marketing and docs
- authentication and onboarding
- workspace dashboard
- pack import flows
- analysis report views
- graph explorer
- evidence search and inspection
- settings, API keys, integrations, and billing

### 3.3 Key frontend modules

#### Import wizard
Supports:
- manifests
- mods folders
- links
- profile imports
- repo-based imports

#### Analysis progress view
Shows:
- normalization stage
- dependency resolution stage
- graph enrichment
- evidence retrieval
- scoring
- recommendation generation

#### Findings dashboard
Shows:
- critical findings
- high-confidence findings
- performance risks
- dependency issues
- actionable summaries

#### Graph explorer
Shows:
- mod relationships
- conflict clusters
- dependency structure
- evidence edges
- indirect risk paths

#### Alternative comparison panel
Shows:
- replacement candidates
- tradeoffs
- migration cost
- compatibility impact
- expected risk reduction

#### Pack diff view
Shows:
- added, removed, updated mods
- risk score delta
- newly introduced conflicts
- resolved findings

---

## 4. Backend architecture

A language split is justified here because the platform has multiple distinct technical domains.

### 4.1 TypeScript / Node responsibilities
Use for:

- API gateway
- BFF layer
- workspace logic
- account and billing features
- integrations
- fast product iteration

### 4.2 Go responsibilities
Use for:

- analysis orchestration
- resolver execution
- recommendation orchestration
- high-concurrency service endpoints
- low-latency internal APIs

### 4.3 Python responsibilities
Use for:

- NLP pipelines
- embeddings
- classification
- relation extraction
- ML training and inference
- offline feature engineering

### 4.4 Kotlin / JVM responsibilities
Use for:

- jar inspection
- mod metadata parsing
- mixin extraction
- static analysis around Minecraft artifacts
- JVM-native simulation support

---

## 5. Core services

### 5.1 API Gateway / BFF
Responsibilities:

- auth/session integration
- request routing
- shaping data for frontend
- aggregating service responses
- rate limiting
- public API management
- progress streaming

### 5.2 Workspace Service
Responsibilities:

- user workspaces
- saved packs
- historical analyses
- comments and collaboration
- report sharing
- team/project ownership
- policy settings

### 5.3 Catalog Service
Responsibilities:

- canonical project identities
- version normalization
- loader support
- source mappings across ecosystems
- tags and functional clusters
- project health metadata

### 5.4 Resolver Service
Responsibilities:

- dependency solving
- version compatibility
- modloader constraints
- Minecraft version constraints
- Java/runtime constraints
- client/server side checks
- minimal fix path calculation

### 5.5 Static Analysis Service
Responsibilities:

- metadata extraction from jars
- mixin target extraction
- embedded dependency inspection
- shaded library detection
- class/package touchpoint extraction
- binary fingerprint generation

### 5.6 Evidence Service
Responsibilities:

- external source ingestion
- evidence normalization
- search indexing
- evidence freshness tracking
- relevance and trust metadata

### 5.7 Graph Service
Responsibilities:

- maintain compatibility graph
- provide path-based explanations
- support neighborhood lookups
- support transitive risk queries
- surface graph-derived candidate relationships

### 5.8 Recommendation Service
Responsibilities:

- find candidate substitutes
- estimate compatibility improvement
- rank alternatives
- compute migration cost
- assemble remediation plans

### 5.9 ML / NLP Service
Responsibilities:

- document classification
- entity extraction
- relation extraction
- semantic retrieval
- risk scoring models
- recommendation reranking
- confidence calibration support

### 5.10 Simulation Service
Responsibilities:

- smoke testing packs in controlled environments
- startup validation
- crash log capture
- reproduction attempts for high-value analyses
- result feedback into scoring system

---

## 6. API strategy

### 6.1 External API style
Use:

- REST for most platform operations
- webhooks for asynchronous updates
- optionally GraphQL for deep report exploration or partner tooling

### 6.2 Internal service communication
Use:

- gRPC or well-defined JSON RPC over internal mesh for low-latency service-to-service interactions
- Kafka for event-driven updates and asynchronous workflows

### 6.3 API design principles
All APIs should be:

- versioned
- idempotent where possible
- traceable
- observable
- designed around job orchestration for long-running analyses

---

## 7. Infrastructure architecture

### 7.1 Recommended cloud strategy
AWS is the most practical default.

A representative deployment would use:

- EKS for container orchestration
- RDS PostgreSQL
- Redis/ElastiCache
- S3 for object storage
- MSK/Kafka
- OpenSearch
- managed or self-hosted Neo4j
- IAM-based secret and access control

### 7.2 Online versus offline separation
Online workloads:
- report retrieval
- user actions
- smaller analyses
- APIs
- graph lookup

Offline workloads:
- ingestion
- NLP enrichment
- model retraining
- simulation
- large backfills
- graph reweighting

This separation is essential for reliability.

### 7.3 Scaling strategy
The platform must scale independently across:

- API concurrency
- ingestion throughput
- analysis throughput
- simulation capacity
- evidence indexing
- graph workload

Use queue-based buffering and autoscaling worker pools.

### 7.4 Caching layers
Use Redis and service-local caches for:

- normalized mod metadata
- hot dependency chains
- graph neighborhoods
- recent report results
- recommendation candidate sets

### 7.5 Queues and jobs
Use Kafka or queue abstractions for:

- analysis requests
- ingestion events
- evidence extraction
- recommendation refreshes
- graph updates
- webhook notifications

---

## 8. Performance design principles

### 8.1 Avoid naive pairwise explosion
A large pack can contain hundreds of mods.  
A naive all-pairs comparison becomes expensive and noisy.

Instead:

1. resolve hard constraints first
2. identify shared subsystems and candidate hotspots
3. expand through graph neighborhoods
4. score only high-value candidate interactions

### 8.2 Incremental re-analysis
When a pack changes:

- do not recompute everything
- re-score only affected areas
- compare with previous results
- propagate changes selectively

### 8.3 Workload-aware execution
Some analyses should be synchronous enough for good UX.
Others should run as background jobs with progress updates.

---

## 9. Security and tenancy

The system should support:

- team-based multi-tenancy
- isolated workspace data
- signed object storage URLs
- encrypted secrets
- per-tenant quotas and rate limits
- API key management
- audit trails for analysis results and access

---

## 10. Architectural outcome

The final system is not just an app.  
It is a platform with:

- product-facing SaaS workflows
- partner-facing APIs
- data and graph intelligence
- operational analysis pipelines
- long-term integration potential with the ecosystem

