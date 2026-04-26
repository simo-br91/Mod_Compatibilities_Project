# 06. Recommendations and Automation

## 1. Recommendation philosophy

The recommendation system should not behave like a simple “similar mods” search.

Its job is to answer:

- what should replace this mod or mod stack?
- which replacement improves compatibility the most?
- what do we lose or gain?
- how expensive is the migration?
- what new risks would be introduced?

That makes it operationally useful.

---

## 2. Candidate generation

Candidate replacements should be generated from multiple signals.

### 2.1 Functional similarity
Use:

- categories
- descriptions
- tags
- shared use cases
- shared ecosystems
- similar subsystem targets

### 2.2 Graph similarity
Use:

- dependency neighborhood similarity
- co-install patterns
- alternative edges
- shared functional cluster membership
- shared upstream or downstream relationships

### 2.3 Community replacement signals
Use evidence such as:

- “use X instead of Y”
- migration advice in issues or discussions
- stable replacement patterns in similar packs

### 2.4 Pack ecosystem similarity
Use historical pack composition data to find:

- common substitute stacks
- popular compatible combinations
- safe ecosystem bundles

---

## 3. Candidate filtering

A recommendation candidate should be eliminated if it fails important constraints.

### 3.1 Hard filters

- incompatible loader
- incompatible Minecraft version
- incompatible Java/runtime
- wrong side support
- missing required pack dependencies
- introduces new critical blockers
- low project health or maintenance threshold if the product policy requires it

### 3.2 Soft filters

- high migration cost
- severe feature loss
- weak community trust
- immature release channel
- poor ecosystem adoption

---

## 4. Recommendation ranking

The ranking function should balance multiple goals.

### 4.1 Ranking dimensions

- compatibility gain
- feature similarity
- maintenance health
- adoption and trust
- performance impact
- ecosystem fit
- migration cost
- dependency burden
- save/world compatibility risk
- confidence in the recommendation

### 4.2 Recommendation bundles
Sometimes the right recommendation is not one mod but a set.

Examples:

- replace a renderer stack with a safer renderer stack
- replace a utility mod plus add a companion mod
- downgrade one mod and upgrade another to restore stability

The recommendation engine should support bundle recommendations.

---

## 5. Migration cost modeling

A recommendation is not useful if it ignores migration pain.

### 5.1 Migration cost inputs

- config rewrite needs
- dependency stack changes
- save/world compatibility risk
- feature loss or behavior change
- user familiarity cost
- ecosystem integration complexity

### 5.2 Cost categories

- low
- moderate
- high
- very high

The UI should communicate this clearly.

---

## 6. Recommendation output format

Each recommendation should include:

- recommended replacement or replacement bundle
- why it was selected
- compatibility improvement estimate
- expected risk reduction
- migration cost
- what is preserved
- what is lost
- extra required mods if any
- confidence

This should read like a decision aid, not a search result.

---

## 7. Remediation planning

The system should be able to assemble a remediation plan, not only isolated suggestions.

### 7.1 Plan types

#### Minimal unblock plan
Smallest set of changes to remove blockers.

#### Stability-first plan
Prefer safer, more mature replacements even if functionality changes slightly.

#### Feature-preserving plan
Try to preserve original user intent while removing incompatibilities.

#### Performance-first plan
Optimize for a smoother runtime profile.

### 7.2 Plan output
A remediation plan should include:

- ordered steps
- dependency implications
- expected score improvement
- optional follow-up checks
- warnings about tradeoffs

---

## 8. AI-assisted automation

### 8.1 Explanation generation
Generate human-readable rationale from structured findings.

### 8.2 Pack review summaries
Summarize:
- what changed
- what is now riskier
- what is safer
- what the user should inspect first

### 8.3 Config guidance
Where rules or evidence support it, suggest config changes required to reduce risk.

### 8.4 Future auto-fix mode
Long term, the platform should support:

- manifest rewrite suggestions
- pull-request creation
- candidate pack variants
- automated verification after changes
- user approval before applying final changes

---

## 9. Recommendation quality loop

The platform should learn from outcome signals.

### 9.1 Outcome signals

- recommendation accepted
- recommendation rejected
- pack stability improved
- new findings disappeared
- user reported recommendation failure
- recommendation caused new issues

### 9.2 Use of feedback
Use these outcomes to improve:

- reranking
- migration cost estimation
- substitute pair confidence
- recommendation bundle quality

---

## 10. Why this system matters

Detection alone creates a diagnostic tool.  
Detection plus ranked remediation creates a product creators can depend on.

That is the difference between a useful report and a workflow tool.

