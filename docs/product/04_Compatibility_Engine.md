# 04. Compatibility Engine

## 1. Engine philosophy

The compatibility engine must be hybrid.

A rule-only system will miss emergent behavior.  
An AI-only system will not be trustworthy.

The platform should combine:

1. deterministic rule execution
2. graph reasoning
3. heuristic inference
4. ML-based scoring
5. evidence-grounded explanation

This is the correct architecture for a category-defining system.

---

## 2. Layer A - Rule-based engine

This layer handles hard constraints and explicit declarations.

### 2.1 Responsibilities

- dependency resolution
- loader compatibility
- Minecraft version compatibility
- Java/runtime compatibility
- side mismatches
- required versus optional dependency validation
- explicit incompatibility declarations
- known verified rules
- minimal fix path generation

### 2.2 Why this layer matters
This is the most explainable and auditable layer.

It should produce findings with:

- exact rule id
- matched predicates
- mod and version scope
- rationale
- remediation options
- provenance

### 2.3 Internal rule representation
A rule should be declarative.

Example conceptually:

```text
WHEN
  loader = fabric
  AND has_mod("A")
  AND has_mod("B")
  AND version_incompatible("A", "B")
THEN
  emit finding HARD_CONFLICT
  severity = critical
  confidence = very_high
  remediation = [...]
```

### 2.4 Rule categories

#### Dependency rules
- missing required dependencies
- incompatible version ranges
- optional dependency mismatches when user-selected features depend on them

#### Environment rules
- unsupported Minecraft version
- unsupported loader
- unsupported Java/runtime
- server/client side misuse

#### Verified conflict rules
Rules encoded from highly trusted evidence or repeated reproduction.

#### Explicit source rules
Rules imported from official metadata or advisories.

---

## 3. Layer B - Knowledge graph reasoning

Rules only model declared or curated facts.  
The graph models the ecosystem structure.

### 3.1 What the graph helps detect

- indirect relationships
- multi-hop risk paths
- ecosystem stack conflicts
- subsystem overlap
- community-derived associations
- replacement patterns
- pack-level co-occurrence and anti-co-occurrence

### 3.2 Example graph reasoning pattern

Suppose:

- Mod A and Mod B target related rendering classes
- both co-occur in issue reports with similar crash signatures
- similar packs prefer A plus Z rather than A plus B
- an older issue indicates this was fixed in one version range but not another

The graph can support a finding such as:

- probable rendering subsystem conflict
- high severity
- medium or strong confidence
- version-specific
- grounded in multi-source evidence

### 3.3 Graph outputs

The graph layer should output:

- candidate conflict clusters
- explanation paths
- mod neighborhood summaries
- candidate substitute sets
- transitive dependency tension indicators

---

## 4. Layer C - Heuristic system

This layer exists because many real-world conflicts are not declared explicitly.

### 4.1 Heuristic categories

#### Mixin and transformer overlap
Detect likely risk when multiple mods modify:

- the same class
- the same method
- the same subsystem
- similar injection targets

#### Embedded library divergence
Detect when mods package incompatible versions of shared libraries and may expose them unsafely.

#### Functional duplication
Detect when multiple mods occupy the same role:

- rendering
- performance optimization
- minimaps
- inventory sorting
- world generation overhaul
- authentication / permissions
- item display overlays

#### Registry and resource collisions
Detect likely overlap in:

- namespace usage
- asset paths
- registry modifications
- datapack structures
- commands
- shader hooks
- model overrides

#### Dependency tension
Detect when one mod implies an ecosystem stack that another mod destabilizes.

#### Config conflict patterns
Detect cases where a mod combination is safe only if certain config options are disabled or aligned.

#### Negative co-install signal
Use co-install scarcity carefully as a weak signal, not proof.

### 4.2 Heuristic behavior
Heuristics should normally emit:

- soft findings
- watchlist findings
- plausibility-based findings

They should not be promoted to hard blockers unless reinforced by stronger evidence.

---

## 5. Layer D - Evidence aggregation

The engine must consume structured evidence from external sources.

### 5.1 Evidence types

- official metadata
- GitHub issues
- issue comments
- changelogs
- release notes
- curated community reports
- user-submitted crash logs
- known remediation examples

### 5.2 Evidence interpretation
Evidence should not be treated equally.

Each evidence item should carry:

- trust score
- extraction confidence
- recency
- specificity
- resolution state
- contradiction links

### 5.3 Temporal reasoning
The engine must understand:

- bug fixed in later versions
- issue only affects specific loaders
- old anecdote contradicted by recent releases
- one-off user mistakes versus reproducible incompatibility

Without this, the evidence layer becomes noisy.

---

## 6. Layer E - ML / AI scoring

The ML layer should rank and infer.  
It should not invent compatibility rules without supporting structure.

### 6.1 Main prediction tasks

- probability of hard incompatibility
- probability of startup crash
- probability of performance degradation
- probability of user-visible instability
- probability that a recommendation will improve pack health

### 6.2 Features for prediction
Use a rich feature set including:

- version compatibility
- dependency tension
- graph neighborhood features
- shared touched classes or resources
- source evidence counts
- source trust and recency
- release maturity
- popularity and ecosystem adoption
- simulation outputs
- historical co-install patterns
- text-derived relation signals

### 6.3 Model progression
A practical sequence is:

1. gradient-boosted trees
2. calibrated ensembles
3. graph embeddings
4. heterogeneous graph neural models later if justified

Start with the models that are easiest to calibrate and explain.

---

## 7. Confidence scoring

Confidence is central to product trust.

### 7.1 Separate severity from confidence

Severity answers:
- How bad is this if true?

Confidence answers:
- How likely is this to be true?

These must not be merged into one concept.

### 7.2 Confidence inputs

- explicit rule strength
- static overlap strength
- graph support strength
- number of independent evidence sources
- source trust
- recency
- simulation confirmation
- contradiction penalty
- ambiguity penalty
- calibrated ML probability

### 7.3 Example confidence bands

- 0.90 - 1.00: verified / highly reliable
- 0.75 - 0.89: strong
- 0.55 - 0.74: plausible
- 0.35 - 0.54: weak signal / expert mode
- below 0.35: usually hidden from default UI

### 7.4 Reproducibility dimension
Add a third signal where useful:

- reproduced automatically
- reproduced by trusted source
- repeated independent reports
- anecdotal only
- not reproduced

---

## 8. Explanation engine

Users need to understand why the platform believes something.

### 8.1 Explanation components

Each serious finding should include:

- summary statement
- mods and versions involved
- issue type
- why the system believes this
- evidence sources
- version or environment scope
- confidence rationale
- recommended remediation

### 8.2 Use of LLMs
LLMs should only:

- summarize structured findings
- rewrite technical details into clearer prose
- generate remediation text from grounded evidence

LLMs should never create unsupported findings.

---

## 9. Final engine output

The engine should emit a structured finding object with:

- unique id
- involved entities
- severity
- confidence
- reproducibility
- explanation
- evidence list
- recommendation candidates
- internal provenance
- engine version metadata

This makes findings traceable, testable, and reviewable.

---

## 10. Why this engine design is strong

This design is strong because it is:

- explainable
- extensible
- evidence-aware
- version-specific
- resilient to noisy data
- able to improve over time without abandoning trust

