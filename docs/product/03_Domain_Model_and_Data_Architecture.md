# 03. Domain Model and Data Architecture

## 1. Why the data model matters

This product will fail if it does not build a clean canonical representation of:

- projects
- versions
- artifacts
- dependencies
- incompatibilities
- evidence
- pack analyses

The platform cannot rely on raw external naming conventions forever.  
It needs its own stable internal model.

---

## 2. Polyglot persistence strategy

The system should use multiple data stores because the data shapes are fundamentally different.

### 2.1 PostgreSQL
Use for:

- users, teams, billing
- workspaces
- saved packs
- normalized mod/version entities
- rules
- findings
- remediation plans
- job records
- report metadata

### 2.2 Neo4j
Use for:

- compatibility graph
- multi-hop relationship traversal
- indirect interaction analysis
- explanation paths
- graph-driven candidate generation

### 2.3 OpenSearch
Use for:

- full-text search over issues and discussions
- evidence lookup
- crash signature search
- hybrid retrieval
- faceted filtering

### 2.4 Redis
Use for:

- hot caches
- rate limiting
- job deduplication
- sessions
- ephemeral state

### 2.5 Object storage
Use for:

- raw source payloads
- jar metadata exports
- crash logs
- report exports
- model datasets
- large normalization outputs

### 2.6 Kafka
Use for:

- ingestion events
- analysis orchestration signals
- graph update events
- recommendation refreshes
- partner notifications

### 2.7 ClickHouse
Use for:

- high-volume product analytics
- telemetry
- ecosystem trend analysis
- scoring observability

---

## 3. Core entities

### 3.1 CanonicalProject
Represents the logical mod identity.

Fields may include:

- canonical_project_id
- display_name
- aliases
- normalized_slug
- source mappings
- author/team references
- categories
- functional clusters
- loader support
- side support
- popularity metrics
- health metrics

### 3.2 ProjectSourceMapping
Maps internal project identity to external sources.

Fields:

- source_type
- external_project_id
- canonical_project_id
- confidence
- matching_method
- source_url

### 3.3 Version
Represents a logical version of a project.

Fields:

- version_id
- canonical_project_id
- display_version
- normalized_version
- release_channel
- release_date
- supported Minecraft versions
- supported loaders
- supported sides
- Java/runtime constraints
- release notes references

### 3.4 Artifact
Represents a downloadable jar or file.

Fields:

- artifact_id
- version_id
- filename
- file hash(es)
- file size
- download URL or source reference
- binary fingerprint
- manifest extraction status
- static analysis status

### 3.5 DependencyEdge
Represents a typed dependency or incompatibility relationship.

Fields:

- source_version_id
- target_project_or_version_id
- edge_type
- requiredness
- version constraints
- scope
- source provenance
- confidence

### 3.6 Pack
Represents a user-defined set of mods and environment context.

Fields:

- pack_id
- workspace_id
- title
- environment metadata
- loader
- Minecraft version
- Java version
- selected mods
- selected versions
- configs
- import source
- lock snapshot

### 3.7 AnalysisRun
Represents an executed compatibility analysis.

Fields:

- analysis_run_id
- pack_id
- status
- triggered_by
- input fingerprint
- timing metadata
- engine versions
- scoring versions
- report id

### 3.8 Finding
Represents a surfaced issue.

Fields:

- finding_id
- analysis_run_id
- finding_type
- severity
- confidence
- reproducibility
- involved entities
- explanation
- recommendation summary
- evidence references
- status

### 3.9 Evidence
Represents a structured source-backed signal.

Fields:

- evidence_id
- source_type
- source_url
- raw document id
- snippet
- extracted entities
- extraction confidence
- source trust score
- recency score
- resolution state if known

### 3.10 Recommendation
Represents a suggested fix or alternative.

Fields:

- recommendation_id
- analysis_run_id
- target_entity
- candidate_entity
- ranking score
- migration cost
- expected risk reduction
- tradeoff summary
- confidence

---

## 4. Knowledge graph model

The graph should treat relationships as first-class objects.

### 4.1 Node types
- Project
- Version
- Artifact
- Loader
- MinecraftVersion
- JavaVersion
- Pack
- Issue
- Discussion
- EvidenceSnippet
- CrashSignature
- MixinTarget
- ClassTarget
- ResourcePath
- ConfigKey
- FunctionalCluster

### 4.2 Edge types
- DEPENDS_ON
- OPTIONAL_DEPENDS_ON
- INCOMPATIBLE_WITH
- EMBEDS
- TARGETS_CLASS
- TARGETS_MIXIN
- TOUCHES_RESOURCE
- OBSERVED_IN_PACK
- CO_OCCURS_WITH
- MENTIONED_IN
- ALTERNATIVE_TO
- SIMILAR_FUNCTION_TO
- CAUSES_CRASH_SIGNATURE
- REMEDIATED_BY

### 4.3 Edge attributes
Every edge should carry:

- confidence
- source type
- trust score
- recency
- directionality
- version scope
- loader scope
- environment scope

---

## 5. Canonical identity resolution

This is one of the most important data problems in the platform.

The same logical mod may appear in many forms:

- CurseForge listing
- Modrinth listing
- GitHub repository
- renamed project
- unofficial port
- mirror
- addon or bridge mod with similar naming

### 5.1 Identity resolution signals
Use:

- direct source links
- file hashes
- manifest metadata
- project descriptions
- homepage / source / issues URLs
- author and team overlap
- artifact names
- alias tables
- semantic similarity
- human review for uncertain matches

### 5.2 Match classes
Classify identity matches as:

- exact
- strong
- plausible
- uncertain
- rejected

Never merge uncertain identities automatically without confidence-aware logic.

---

## 6. Modeling packs properly

The pack is not just a list of mods.  
It is a contextual environment.

A robust pack model should include:

- mod list
- exact versions
- loader
- Minecraft version
- Java/runtime version
- client/server mode
- optional configs
- user-uploaded crash logs
- optionally hardware/OS context for client-side issues

This matters because many compatibility issues are environment-specific.

---

## 7. Historical and temporal data

Compatibility intelligence is time-sensitive.

The data model should support:

- version-specific assertions
- time-bounded evidence
- issue resolution state
- edge aging
- historical pack analyses
- score recalculation under new evidence

The platform should not treat all evidence as permanent truth.

---

## 8. Data contracts and evolution

Every major record should include:

- schema version
- producer identifier
- timestamp
- trace id
- source provenance

This helps with long-term migration and debugging.

---

## 9. Why this data architecture is strategic

A good user interface can be copied.  
A deep, clean, canonical compatibility data model cannot be copied quickly.

The internal knowledge base becomes the core asset.

