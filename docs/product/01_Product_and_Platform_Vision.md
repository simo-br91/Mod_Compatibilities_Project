# 01. Product and Platform Vision

## 1. Product thesis

This platform should not be positioned as a simple dependency checker.

It should be positioned as a **compatibility intelligence platform for Minecraft modpacks**.

The product promise is:

- ingest a mod list, manifest, profile, or mods folder
- normalize mods and versions across ecosystems
- detect hard conflicts and probable incompatibilities
- identify performance and stability risks
- explain findings clearly
- suggest alternatives and remediation paths
- monitor pack health over time
- expose APIs and integrations so the product becomes infrastructure for the ecosystem

This is what makes the product strategically meaningful.

---

## 2. Core product value

Users come with one practical problem:

> “I want to know whether my modpack is safe, coherent, and maintainable before I publish or update it.”

The platform should answer:

- Will this pack resolve?
- What is likely to break?
- What is likely to degrade performance?
- Which risks are verified versus inferred?
- What is the minimum fix path?
- What are the best alternatives?
- What changed since the last healthy build?

---

## 3. Full feature set

### 3.1 Pack ingestion

The platform should support all serious entry points:

- paste mod names
- paste CurseForge or Modrinth links
- upload a mods folder
- upload a manifest
- import from CurseForge profile exports
- import from Modrinth projects
- import launcher profiles
- connect GitHub repositories for pack manifests and configs
- reanalyze packs automatically on changes

### 3.2 Pack analysis outputs

The analysis result should have multiple views for different audiences.

#### Executive summary
For casual users and quick triage:

- overall pack health score
- compatibility score
- critical blockers
- high-risk findings
- dependency completeness
- recommended next actions

#### Technical findings
For serious pack creators:

- exact mods and versions involved
- severity
- confidence
- evidence sources
- explanation
- remediation suggestions
- alternative recommendations

#### Deep technical view
For experts:

- dependency trees
- loader and version constraints
- mixin and bytecode overlap indicators
- shared resources or registry touchpoints
- crash signature associations
- graph exploration

### 3.3 Collaboration and pack lifecycle

To become a long-term tool, the platform must support ongoing workflows:

- saved workspaces
- historical pack versions
- diffs between pack revisions
- release candidates
- regression alerts
- annotations and comments
- sharing reports publicly or privately
- team workflows
- exportable reports
- quality gates before release

### 3.4 AI and automation features

Advanced features should include:

- natural-language explanation of findings
- generated remediation plans
- config conflict hints
- duplicate function detection
- “best compatible stack” recommendations
- pack optimization advice
- crash log interpretation
- what-changed summaries between analyses

### 3.5 Integrations

Strategic integrations include:

- GitHub App
- GitHub Actions
- Discord notifications
- CurseForge import
- Modrinth import
- launcher plugins
- server hosting platform hooks
- REST API
- webhooks

---

## 4. User personas

### 4.1 Casual modder
Needs:

- minimal setup
- simple upload or import
- traffic-light results
- plain-English explanations
- direct suggestions

### 4.2 Serious modpack creator
Needs:

- detailed version-aware analysis
- change impact analysis
- evidence-backed findings
- confidence scores
- pack monitoring
- alternatives and migration tradeoffs

### 4.3 Server/community operator
Needs:

- server-specific warnings
- update safety
- performance and crash risk
- alerting
- exportable results

### 4.4 Launcher/platform partner
Needs:

- API-first integration
- large-scale throughput
- stable contracts
- SLAs
- embeddable analysis services

### 4.5 Mod developer
Needs:

- visibility into recurring compatibility incidents
- evidence tied to their mod
- structured advisories
- ecosystem analytics
- verified notices and fixes

---

## 5. UX flows

### 5.1 One-shot analysis
1. User imports a pack
2. Platform normalizes all projects and versions
3. Resolver checks compatibility constraints
4. Evidence and graph layers enrich analysis
5. Findings are scored
6. Alternatives are ranked
7. Results are rendered in a structured report

### 5.2 Iterative curation
1. User opens a report
2. User removes or replaces mods
3. Platform re-runs targeted analysis
4. User compares health and risk deltas
5. User saves a candidate build

### 5.3 Continuous integration workflow
1. A pack repository changes
2. Webhook triggers analysis
3. Platform comments on the PR or reports status
4. Policies determine whether changes should be blocked
5. Team reviews findings before merging

---

## 6. Positioning

This company should position itself as:

- **the compatibility and reliability layer for modpacks**
- **the CI/CD and observability platform for modpack creators**
- **the intelligence engine behind launcher and platform compatibility checks**

This is stronger than being “a checker.”

---

## 7. Naming ideas

Potential names:

- Packwise
- ModGuard
- ModAtlas
- PackSentinel
- PackIntel
- ModGraph
- PackDoctor

Strongest directions:

- **Packwise** for product-led SaaS
- **ModGuard API** for partner-facing platform
- **ModAtlas** if the knowledge-graph angle is central

---

## 8. Product principles

The product should follow these principles:

1. **Explainability before cleverness**  
   Findings must be source-backed and legible.

2. **Hybrid intelligence**  
   Rules, graph reasoning, heuristics, and ML should work together.

3. **Version specificity matters**  
   “This mod is bad” is not useful.  
   “This version of this mod is risky under these conditions” is useful.

4. **Confidence must be visible**  
   Users need to know whether something is verified, strong, plausible, or weak.

5. **Reports should be actionable**  
   Users need remediation, not only detection.

6. **The platform should fit real creator workflows**  
   That means history, monitoring, diffs, CI, and integrations.

