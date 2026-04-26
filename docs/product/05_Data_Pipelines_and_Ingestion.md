# 05. Data Pipelines and Ingestion

## 1. Data platform objective

The platform needs a continuous intelligence pipeline, not occasional scraping.

Its job is to:

- ingest metadata from multiple sources
- normalize entities
- resolve identities
- extract compatibility signals
- update graph relationships
- refresh search indices
- trigger pack re-analysis when needed

This pipeline is part of the product core.

---

## 2. Pipeline layers

### 2.1 Bronze layer
Raw data storage:

- source JSON payloads
- issue pages
- discussion threads
- changelogs
- release notes
- uploaded logs
- jar analysis outputs

### 2.2 Silver layer
Normalized data:

- canonical projects
- versions
- artifacts
- structured documents
- cleaned timestamps
- normalized environment metadata
- deduplicated evidence records

### 2.3 Gold layer
Analysis-ready outputs:

- graph edges
- risk features
- embedding stores
- recommendation candidates
- confidence inputs
- source trust aggregates

---

## 3. Connector architecture

Each external source should have its own connector.

### 3.1 Connector responsibilities

- polling or delta fetching
- respect rate limits
- incremental retrieval
- raw payload persistence
- normalization trigger publishing
- freshness tracking
- error and retry handling

### 3.2 Connector design principles

- source-specific logic should not leak into the rest of the platform
- retries should be idempotent
- every payload should be traceable
- fetch failures should degrade gracefully
- popular entities should refresh more often than cold entities

---

## 4. Identity resolution pipeline

This is one of the hardest and most critical data workflows.

### 4.1 Input problem
A single logical mod may correspond to several external records.

### 4.2 Resolution stages

1. exact direct linking  
   For example: source URL references, known mappings.

2. artifact and metadata matching  
   File names, hashes, manifest metadata, authors, homepages.

3. semantic and contextual matching  
   Description similarity, tag overlap, dependency overlap.

4. confidence classification  
   exact / strong / plausible / uncertain.

5. manual review queue  
   Required for ambiguous cases.

### 4.3 Output
Identity resolution should produce:

- canonical entity mapping
- confidence
- supporting evidence
- provenance
- review status

---

## 5. Document ingestion and NLP pipeline

### 5.1 Relevance classifier
Classify whether a document is about:

- compatibility
- crash
- dependency issue
- performance issue
- feature request
- setup mistake
- support noise
- duplicate or spam

### 5.2 Entity extraction
Extract:

- mod names
- versions
- loaders
- Minecraft version
- Java version
- platform/environment context
- crash terms
- substitute mods
- config keys

### 5.3 Relation extraction
Extract claims such as:

- X conflicts with Y
- X requires Y
- issue fixed by replacing X with Z
- only broken on specific versions
- only broken in a given environment

### 5.4 Snippet preservation
For every extracted claim store:

- exact snippet
- normalized entities
- source link
- extraction confidence
- timestamp
- thread context
- resolution context if available

### 5.5 Deduplication
Cluster duplicate reports using:

- semantic similarity
- overlapping entities
- same issue or thread references
- same crash signatures
- same version/environment context

---

## 6. Contradiction handling

Not every conflict report remains true over time.

The pipeline must detect:

- superseded reports
- resolved issues
- version-scoped fixes
- conflicting community claims
- stale discussions that no longer apply

This is essential for reducing false positives.

---

## 7. Event-driven update model

The system should react to meaningful changes.

### 7.1 Example events

- new_version_detected
- new_issue_detected
- evidence_extracted
- finding_rule_changed
- graph_edge_updated
- pack_saved
- pack_reanalysis_requested
- simulation_completed

### 7.2 Why events matter
Events allow:

- incremental updates
- selective re-analysis
- loose coupling between services
- easier observability
- asynchronous scaling

---

## 8. Freshness strategy

Not all mods should be refreshed equally.

### 8.1 High priority
Refresh more often for:

- highly popular mods
- frequently updated mods
- mods present in many user packs
- mods with active issue traffic

### 8.2 Medium priority
Refresh on a normal cadence for:

- moderately used stable projects
- less active but relevant projects

### 8.3 Low priority
Refresh infrequently for:

- abandoned or archival projects
- cold long-tail entries

This controls cost while preserving value.

---

## 9. Re-analysis strategy

When the knowledge base changes, the platform should not rerun every pack.

Instead:

1. detect impacted mods or versions
2. find stored packs containing them
3. compute whether changes affect active findings
4. re-run only relevant analyses
5. notify users if scores changed materially

---

## 10. Source trust model

Every source should have a trust score model.

Example dimensions:

- source type
- official versus community origin
- resolution state
- author credibility if known
- repetition across independent sources
- recency
- history of accuracy

This should feed into the confidence engine.

---

## 11. Internal curation workflows

The platform should include internal tools for analysts to:

- review ambiguous identity matches
- approve or reject extracted relationships
- promote strong findings into verified rules
- link contradictions
- annotate special cases
- flag bad sources

This human-in-the-loop layer improves long-term quality.

---

## 12. Why the pipeline is a moat

A competitor can build a UI quickly.  
They cannot quickly replicate:

- a canonical catalog
- ongoing ingestion
- normalized evidence
- trust-aware extraction
- graph relationships
- re-analysis logic
- curated rules and feedback loops

That ongoing intelligence system is the moat.

