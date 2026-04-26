# 01. Service Catalog

## Architecture style
Use a service-oriented architecture with a limited number of high-cohesion services.

Do not start with a giant monolith that mixes ingestion, report APIs, batch NLP, graph updates, and simulation.
Do not over-fragment into dozens of tiny services either.

A good long-term split is:

1. API Gateway / BFF
2. Identity, Workspace, Billing Service
3. Catalog Service
4. Resolver Service
5. Static Analysis Service
6. Evidence Ingestion Service
7. Knowledge Graph Service
8. Recommendation Service
9. ML / NLP Service
10. Simulation Service
11. Notification / Webhook Service
12. Admin / Curation Service

## 1. API Gateway / BFF
### Responsibilities
- authenticate requests
- authorize by org/workspace/project
- aggregate downstream results
- expose report-friendly payloads
- stream job progress over SSE/WebSocket
- enforce public API quotas

### Does not own
- persistent domain logic
- scoring logic
- ingestion workflows

## 2. Identity, Workspace, Billing Service
### Responsibilities
- users, organizations, memberships
- roles and permissions
- projects and workspaces
- API keys
- plan limits
- usage metering
- billing events

## 3. Catalog Service
### Responsibilities
- canonical mod/project identity
- cross-platform source mappings
- versions, files, aliases
- loader / Minecraft support metadata
- popularity and health summaries

### Core outputs
- canonical project record
- canonical version record
- search and lookup endpoints
- identity resolution decisions

## 4. Resolver Service
### Responsibilities
- dependency solving
- version compatibility solving
- loader / Minecraft / Java constraints
- optional vs required vs incompatible handling
- pack normalization into an internal lock model

### Notes
This service should be deterministic and highly testable.

## 5. Static Analysis Service
### Responsibilities
- parse jar-level metadata
- inspect mixin configs and loader metadata
- compute binary fingerprints
- detect embedded libraries
- extract class / package / resource targets

### Inputs
- uploaded jars
- resolved artifact URLs
- cached object-store artifacts

## 6. Evidence Ingestion Service
### Responsibilities
- fetch metadata from CurseForge, Modrinth, GitHub, and selected public community sources
- store raw payloads
- emit normalized evidence documents
- deduplicate repeated reports
- track source freshness and failures

## 7. Knowledge Graph Service
### Responsibilities
- maintain graph edges and weights
- serve neighborhood and explanation-path queries
- store conflict, dependency, co-installation, and substitute relationships

## 8. Recommendation Service
### Responsibilities
- candidate generation for replacements
- multi-factor ranking
- migration-cost estimation
- explanation assembly for suggested alternatives

## 9. ML / NLP Service
### Responsibilities
- relevance classification
- entity and relation extraction
- embedding generation
- risk prediction inference
- calibration and drift checks

## 10. Simulation Service
### Responsibilities
- ephemeral pack smoke tests
- server startup validation
- controlled client-launch validation when feasible
- crash signature extraction
- structured simulation outcomes

## 11. Notification / Webhook Service
### Responsibilities
- alert fan-out
- webhook retries
- email / Discord / Slack integrations
- event subscription registry

## 12. Admin / Curation Service
### Responsibilities
- human-reviewed rules
- evidence moderation
- source trust overrides
- analyst notes
- disputed finding workflows

## Shared platform capabilities
Every service should inherit platform standards for:
- tracing
- metrics
- structured logging
- idempotency
- retry policy
- dead-letter handling
- feature flags
- schema versioning
