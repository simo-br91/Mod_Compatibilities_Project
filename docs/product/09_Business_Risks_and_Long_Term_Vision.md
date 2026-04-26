# 09. Business, Risks, and Long-Term Vision

## 1. Business model

This product can support multiple revenue streams.

### 1.1 Creator SaaS
Plans for individual creators and small teams.

Possible tiers:

- Free
- Pro Creator
- Team / Studio

Features can scale across:

- analysis limits
- saved workspaces
- private reports
- monitoring
- CI integrations
- advanced recommendations
- team collaboration

### 1.2 API revenue
Offer paid API products for:

- pack analysis
- compatibility lookups
- recommendation generation
- issue evidence retrieval
- webhook updates

Potential customers:

- launchers
- hosting platforms
- server providers
- modpack platforms
- larger creator communities

### 1.3 Enterprise / partner revenue
Longer-term opportunities include:

- white-label compatibility intelligence
- managed preflight checks
- enterprise SLAs
- dedicated support and onboarding
- ecosystem analytics and advisories

---

## 2. Strategic positioning

The company should not position itself as:

- a mod repository
- a launcher competitor
- a simple search tool

It should position itself as:

- the compatibility intelligence layer
- the reliability platform for modpacks
- the CI and observability stack for pack creation and release

That framing creates a better moat.

---

## 3. Why the problem is extremely hard

This problem is hard because compatibility issues are often:

- emergent
- runtime-specific
- version-specific
- environment-specific
- under-documented
- scattered across fragmented sources
- influenced by bytecode modification and shared subsystem behavior

There is no perfect centralized truth source.

---

## 4. Major risks

### 4.1 False positives
If the platform over-warns, creators will stop trusting it.

### 4.2 False negatives
Some real conflicts will always be missed because they are:

- rare
- environment-specific
- not publicly discussed
- only visible at runtime

### 4.3 Data quality risk
Public community data can be noisy, stale, contradictory, and anecdotal.

### 4.4 Identity resolution risk
Incorrect canonical mapping can poison the graph and contaminate findings.

### 4.5 Operational complexity
A product with ingestion, graph analysis, ML, simulation, and APIs can become operationally heavy quickly.

### 4.6 Simulation cost
Runtime validation is expensive and still incomplete.

### 4.7 Ecosystem dependency risk
Platform value depends partly on third-party ecosystems and their metadata quality.

---

## 5. Honest limitations

Even a very strong platform will not guarantee perfect compatibility.

It will still struggle with:

- obscure pack-specific config interactions
- hardware/driver-specific graphical issues
- private community knowledge that is not publicly accessible
- brand-new regressions before evidence accumulates
- complex group interactions that only emerge in real runtime scenarios

The platform should communicate this honestly.

---

## 6. Defensibility

The moat comes from accumulated infrastructure and intelligence:

- canonical mod identity graph
- structured compatibility evidence
- curated verified rules
- historical pack analyses
- source trust modeling
- recommendation feedback loops
- partner integrations
- creator workflow lock-in

A polished UI alone is not the moat.  
The intelligence substrate is.

---

## 7. Go-to-market direction

### 7.1 Start with serious pack creators
They feel the pain sharply and can validate product depth.

### 7.2 Expand to teams and communities
Offer:

- collaboration
- release gates
- monitoring
- shared workspaces

### 7.3 Expand to platforms
Once the engine is strong enough, move into:

- launcher integrations
- server host integrations
- B2B API relationships

That is where the platform layer emerges.

---

## 8. Long-term vision

### 8.1 Launcher-native compatibility analysis
Users should be able to see warnings and fix suggestions before they install or update packs.

### 8.2 Continuous monitoring
A pack should be monitored over time, not analyzed only once.

### 8.3 Auto-fix workflows
Long term, the platform should be able to:

- generate fix suggestions automatically
- rewrite manifests
- create pull requests
- run validation
- ask for final user approval

### 8.4 Mod developer advisory layer
Mod authors should eventually be able to:

- view conflict clusters involving their mods
- publish advisories
- validate or contest findings
- improve metadata to reduce uncertainty

### 8.5 Open compatibility standard
The strongest long-term move is to define a compatibility advisory schema the ecosystem can adopt.

That would turn the company from a product into infrastructure.

---

## 9. Final strategic statement

The category-defining version of this company is not:

> “We check whether mods work together.”

It is:

> “We make modpacks reliable by turning fragmented ecosystem knowledge into explainable compatibility intelligence.”

That is the right long-term vision.

