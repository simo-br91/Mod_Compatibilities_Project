# Offline Knowledge Synthesis Pipeline (Pipeline 2)

## Overview

The **Offline Pipeline** (Pipeline 2) is the core knowledge synthesis engine that analyzes mod compatibility **without** running Minecraft. It:

1. **Ingests** mod metadata and evidence from multiple sources
2. **Analyzes** mod interactions to detect potential conflicts
3. **Synthesizes** compatibility verdicts into structured knowledge
4. **Builds** a frozen knowledge snapshot for serving analysis requests
5. **Generates** prioritized test candidates for the empirical runtime pipeline

This is fundamentally different from **Pipeline 1** (empirical runtime validation), which assembles selected released mod JARs in a real Forge runtime, starts Minecraft, attempts to load a world, and records the observed result. It does **not** compile arbitrary mod source code together; for this platform, runtime assembly/loading is the more useful validation target because users install released mod JARs.

---

## What the Pipeline Does (Step-by-Step)

### Step 1: Catalog Ingestion
**Input:** ~1,000 mods selected once before running the pipeline

**Mod selection criteria (in priority order):**
1. **Appears frequently together in real modpacks** — the primary signal; mods that are commonly bundled together are the ones most likely to interact and most valuable to analyze
2. **Download popularity** — secondary signal; popular mods have more users affected by incompatibilities
3. **Mature versions only** — 6+ months old; cutting-edge releases have less community knowledge

The list is generated once (`scripts/generate-mod-catalog.ts`) and stored locally. It is not re-fetched on every pipeline run. Catalogs store version-specific entries: by default the generator keeps the latest 3 mature Forge versions per mod (`--versions-per-mod 3`), and `--all-eligible-versions` can be used when you intentionally want every mature Forge version.

**Output:** Canonical project/version records in repository

### Step 2: Forge Mod Inspection (JAR Analysis)
**Input:** Forge mod JAR files from catalog versions
- **Smart Filtering:**
  - ✅ Only mods **never inspected before** (tracked in inspection history)
  - ✅ Only mods **6+ months old** (mature, released versions)
  - ✅ Only mods **with download URLs available**
  
- **What it inspects:**
  - Mixin targets (which game classes are modified)
  - Embedded libraries and their versions
  - Resource conflicts
  - Class bytecode signatures

**Output:** 
- Artifact profiles with technical conflict signatures
- Inspection history updated (prevents re-analyzing)
- Example: "OptiFine modifies chunk rendering, Sodium modifies rendering engine → conflict signature created"

> **Scope note:** JAR analysis is predictive static analysis, not a compatibility proof. It finds technical risk signals such as overlapping mixins, shared class/resource targets, embedded library conflicts, package namespace collisions, and access-transform overlap. It does not fully emulate Minecraft internals or prove runtime behavior; empirical runtime validation is still required for high-confidence outcomes.

### Step 3: Evidence Ingestion from Multiple Sources
**Input:** Knowledge from project-owned and registry-owned sources

#### 3A: CurseForge & Modrinth Descriptions and Release Notes
- Parses Modrinth project descriptions/body text and linked project URLs
- Parses recent Modrinth version changelogs for conflict notices
- Parses CurseForge descriptions and recent file changelogs when `CURSEFORGE_API_KEY` is set and the project has either a numeric CurseForge ID or a resolvable slug/name mapping
- High trust: this is the author speaking directly about their mod
- **Example findings:**
  - "This mod is incompatible with OptiFine. Use Iris instead."
  - "Known conflict with Sodium resolved in v2.1"

#### 3B: GitHub Issues & Discussions
- Discovers GitHub repositories from Modrinth `issues_url` / `source_url`
- Searches project-owned repositories first, then falls back to broad GitHub issue search within a quota-aware budget (`GITHUB_SEARCH_QUERY_BUDGET` can override issue search; `GITHUB_REPOSITORY_REQUEST_BUDGET` can override release/README fetches when authenticated)
- Extracts pair-level claims only when issue text links the source mod to another canonical mod
- **Example findings:**
  - OptiFine #5891: "incompatible with Sodium - both modify rendering"
  - Lithium #128: "compatibility confirmed with Sodium"
- Confidence scores based on issue discussion depth and resolution

#### 3C: GitHub Releases
- Fetches release notes (`body` field) for each discovered GitHub repository
- Release notes are author-written and treated at the same trust level as changelogs
- Controlled by `EvidenceSourceConfig.github_release` (enabled by default)
- Up to 8 most-recent releases per repository are fetched

#### 3D: GitHub READMEs
- Fetches the decoded `README.md` for each project's primary GitHub repository
- Useful for mods whose README contains a "Known Issues" or "Incompatibilities" section
- Controlled by `EvidenceSourceConfig.github_readme` (enabled by default)
- Markdown code blocks and image/link syntax are stripped before extraction

#### 3E: Linked Official Wiki / Docs
- Fetches the `wiki_url` page from Modrinth project metadata (non-GitHub URLs only)
- Disabled by default (`EvidenceSourceConfig.linked_wiki = false`) — enable only when
  scraping is appropriate and the target site is stable
- Trust tier: **maintainer**

#### 3F: Manually Curated Rules
- Verified rules maintained by developers/community
- High-precision compatibility verdicts
- Conditions can be specific (e.g., "only on Fabric 1.20.1")
- **Example:** "OptiFine incompatible with Sodium for any Minecraft version"

#### 3G: Artifact Analysis (Technical Signatures)
- Direct JAR inspection (from Step 2)
- Mixin/library overlaps discovered programmatically
- High-confidence technical risk signals, not final proof
- **Example:** "Both OptiFine and Sodium patch ChunkRenderDispatcher → conflict"

> **Note on community forums (Reddit, Discord, Curse Forums):** These are explicitly not a primary source. The noise-to-signal ratio is high and most actionable community knowledge already surfaces through GitHub issues and mod descriptions. Reddit/forum ingest is not planned.

---

### Source Registry and Trust Tiers

Each source kind can be independently enabled or disabled via `EvidenceSourceConfig` passed in `EvidenceIngestionOptions.sourceConfig`.  The defaults are in `DEFAULT_SOURCE_CONFIG`:

| Source kind            | Enabled by default | Trust tier   | Max confidence |
|------------------------|--------------------|--------------|----------------|
| `modrinth_description` | ✅                 | author       | 0.95           |
| `modrinth_changelog`   | ✅                 | author       | 0.90           |
| `curseforge_description` | ✅               | author       | 0.95           |
| `curseforge_changelog` | ✅                 | author       | 0.88           |
| `github_issue`         | ✅                 | community    | 0.78           |
| `github_release`       | ✅                 | author       | 0.88           |
| `github_readme`        | ✅                 | author       | 0.85           |
| `github_wiki`          | ❌ (opt-in)        | maintainer   | 0.82           |
| `linked_wiki`          | ❌ (opt-in)        | maintainer   | 0.75           |
| `linked_homepage`      | ❌ (opt-in)        | author       | 0.70           |

Conflict resolution: when two sources disagree on a pair verdict, the higher-trust-tier source wins.  Equal-tier ties are broken by confidence; incompatible wins on a complete tie (fail-safe default).  The losing side is flagged `isDisputed=true` with a 30% confidence penalty.

---

### Persistent Fetch State

The pipeline maintains a fetch-state cache at `.offline-cache/evidence-fetch-cache.json`.  On each run:
- Documents whose content hash has not changed since the last fetch are skipped (extraction is bypassed).
- The cache is loaded at the start of Step 3 and written back after ingestion.
- On first run or if the file is missing, all sources are fetched fresh.
- Cache hits are reported in the Step 3 log as `fetchCacheHits`.

The runner also writes JAR-analysis save points to `.offline-cache/jar-analysis-checkpoint.json`.
Each inspected version is checkpointed immediately after analysis, so a later crash can resume without
re-downloading and re-parsing JARs that already produced artifact profiles.

---

### Semantic Extraction

Claims are enriched with constraint fields when detectable in the source text:

| Field                        | Example trigger text                                    |
|------------------------------|----------------------------------------------------------|
| `fixedInVersion`             | "fixed in version 2.0", "resolved as of v1.19.4"        |
| `loaderConstraint`           | "works on Fabric but crashes on Forge"                   |
| `environmentConstraint`      | "server-side only crash", "client-side only issue"       |
| `requiresPatch`              | "requires a compatibility patch"                         |
| `minecraftVersionConstraint` | "before 1.20.1", "since 1.19"                            |
| `claimAuthorKind`            | inferred from source kind (author/maintainer/user/inferred) |
| `isDisputed`                 | set when a lower-trust source contradicts a higher-trust source |

**Evidence Conflict Resolution:**
If sources disagree, uses weighted scoring:
- Technical signatures (highest weight): 100%
- Curated rules: 90%
- Author descriptions/releases/readme: up to 95%
- Author changelogs: up to 90%
- GitHub issues / discussions: up to 78%

**Extraction behavior:**
- Evidence is digested into claim-level records with full provenance: source project, target project, verdict, confidence, source kind, source URL, matched pattern, supporting snippet, constraint fields
- Conditional wording such as "may conflict with" is kept lower-confidence than direct claims like "not compatible with"
- "Fixed in version X" emits a reduced-confidence incompatible claim with `fixedInVersion` set
- Loader-specific language ("works on Fabric but not Forge") sets `loaderConstraint`
- Environment-specific language ("server-side only issue") sets `environmentConstraint`
- Generic unanchored text such as "improves compatibility" is ignored unless it names another canonical mod

**Output:** 
- ~20+ verified rules synthesized
- Evidence indexed and searchable
- Confidence scores on each claim

### Step 4: Knowledge Synthesis
**Input:** All ingested evidence + rules
**Process:**
- Convert rules → promoted compatibility claims
- Scan pairwise relationships → pairwise verdict records
- Cluster 3-mod combinations → fragment verdict records
- Inspect JAR profiles → technical conflict signatures

**Output:** Four layers of synthesized knowledge:
```
Pairwise Records: (mod_a, mod_b) → verdict + confidence
  Examples:
  - (OptiFine, Sodium) → known_incompatible (0.97 confidence)
  - (Sodium, Lithium) → known_compatible (0.95 confidence)
  - (ModMenu, Fabric) → mixed_or_conditional (0.72 confidence)

Fragment Records: (mod_a, mod_b, mod_c) → cluster verdict
  Example:
  - (Sodium, Lithium, Fabric) → known_compatible (all pairs safe)

Claims: Converted from verified rules
Signatures: Detected mixin/library overlaps from JAR inspection
```

### Step 5: Snapshot Validation & Promotion
**Input:** Synthesized knowledge graph
**Validation Checks:**
1. Snapshot completeness (has all expected components)
2. Data integrity (no missing references)
3. Consistency (no contradictory verdicts)
4. Coverage (supports required Minecraft versions/loaders)

**Output:** Frozen snapshot with status
- `promoted` = Active, serving live analyses
- `rolled_back` = Demoted (older version became active)

### Step 6: Candidate Generation for Pipeline 1
**Input:** All pairwise verdicts from snapshot
**Filter:** Keep only pairs that need testing
- `known_incompatible` (highest priority: 2.0x boost)
- `likely_incompatible` (1.5x boost)
- `mixed_or_conditional` (1.2x boost)
- `insufficient_evidence` (base priority)

**Exclude:** `known_compatible` pairs (no need to test)

**Output:** Prioritized list of mod pairs for ground-truth testing
- Example: Top candidate might be (OptiFine, Sodium) with priority 1.94
- Each selected compatible version pair is tested separately. A pair such as Mod A v1 + Mod B v1 and Mod A v2 + Mod B v1 produces distinct ground-truth facts, so a later mod update can be compatible or incompatible independently of older releases.
- The local Forge runner preserves registry identity from selected projects: Modrinth-origin
  candidates download the exact selected Modrinth version without `CURSEFORGE_API_KEY`, while CurseForge remains an authenticated fallback.
- Random Forge selection uses the hydrated catalog when available, then falls back to the small
  configured smoke-test pool.

### Step 7: Persistence to Postgres
**Optional:** Store snapshot and all related data for durability
- Snapshot survives application restart
- Can be rehydrated on startup without recomputation
- Offline prediction state is treated as the current working set by default. Each run replaces
  old `offline-pipeline-*` snapshots and their large pairwise/fragment/signature tables unless
  `--keep-offline-history` is passed.
- Ground-truth pair knowledge is kept as the durable long-term corpus. Operational runner state
  is compacted by default after `truth:run`: one canonical exact-pack fact, one latest supporting
  run, one promoted empirical snapshot, and any genuinely queued work are retained.
- Query durable empirical pair knowledge through `ground_truth_pair_knowledge`.

---

## Prerequisites

### Required
- **Node.js 18+** (included if using project environment)
- **pnpm** package manager

### Optional (Postgres Persistence)
- **PostgreSQL 13+** running and accessible
- **POSTGRES_URL** environment variable set (e.g., `postgres://user:pass@localhost:5432/modcompat`)

### Not Required (These are optional for full pipeline)
- Docker (only needed for service boundaries, not for in-process mode)
- Ground-truth executor (Pipeline 1 runs separately)

---

## Running the Pipeline

### Command

```bash
# Basic run (in-memory only)
npx tsx scripts/offline-pipeline/run.ts

# With Postgres persistence (requires POSTGRES_URL set)
POSTGRES_URL="postgres://localhost/modcompat" npx tsx scripts/offline-pipeline/run.ts

# Dry-run (don't persist to Postgres)
npx tsx scripts/offline-pipeline/run.ts --dry-run

# Skip persistence altogether
npx tsx scripts/offline-pipeline/run.ts --no-persist

# Verbose logging
npx tsx scripts/offline-pipeline/run.ts --verbose

# Keep old offline prediction snapshots instead of replacing the current working set
npx tsx scripts/offline-pipeline/run.ts --keep-offline-history
```

### Expected Output

The pipeline logs each step and concludes with a summary:

```
==============================================================================
OFFLINE PIPELINE EXECUTION SUMMARY
==============================================================================
{
  "status": "success",
  "snapshot": {
    "id": "snap_synth_...",
    "version": "offline-pipeline-2026-04-19",
    "status": "promoted",
    "composition": {
      "claims": 12,
      "pairwise": 45,
      "fragments": 8,
      "signatures": 23
    },
    "validation": {
      "status": "passed",
      "checks": 4
    }
  },
  "candidates": {
    "total": 8,
    "byVerdict": {
      "known_incompatible": 2,
      "likely_incompatible": 3,
      "mixed_or_conditional": 2,
      "insufficient_evidence": 1
    }
  },
  "persistence": {
    "enabled": true,
    "persisted": true
  }
}
==============================================================================
```

---

## What Happens Next?

After the offline pipeline completes:

### 1. Empirical Runtime Pipeline Takes Over
The generated candidates are fed to the empirical validation pipeline:
```
GET /v1/internal/snapshots/{snapshotId}/candidates
  Returns the top N candidates (default: 10)

Empirical Runtime Executor:
  - Selects top N candidates by priority score
  - Assembles the released mod JARs into an isolated Forge runtime
  - Launches Minecraft / Forge with the mod combination loaded
  - Tests: does the game start up? Does a world load without crashing?
  - Records empirical result: passed / crashed / timed-out
```

> **Important scope note:** Empirical runtime validation detects **startup crashes and load-time failures only**. It does not compile mod source, test gameplay correctness, visual glitches, performance issues, or subtle behavioral incompatibilities that only appear during play. A "passed" result means the released mod JAR combination did not crash on startup/world load in the tested environment - not that the mods are universally compatible.

### 2. Results Feed Back to Knowledge Base
Empirical runtime results are stored as durable exact-pack facts:
- Crashed on load -> records `failed_startup` or `failed_world_load`
- Loaded successfully -> records `passed_startup_and_world`
- The query-friendly view `ground_truth_pair_knowledge` exposes one compact row per tested
  project-version pair and exact environment, including Minecraft version, loader, loader version,
  Java version, and side
- Offline-snapshot ground-truth candidate generation only enqueues runtime environments with a known
  loader version. Today the default Forge runtime is Minecraft `1.20.1` / Forge `47.4.20`; add more
  entries to `GROUND_TRUTH_FORGE_VERSION_BY_MINECRAFT` only when matching local runtime templates exist.
- Snapshot analysis and future candidate generation read these facts before trusting offline predictions

### 3. Next Pipeline Run Uses Enhanced Knowledge
On the next offline pipeline run:
- Empirically validated pairs have higher confidence and are treated as facts
- The candidate generator skips already-confirmed pairs
- Remaining uncertain pairs get better prioritization as the knowledge base grows

By default, `truth:run` compacts operational history after each batch so the database remains a
knowledge base rather than a runner log. Pass `--keep-operational-history` only when debugging the
runner itself.

For higher-throughput environments such as a Linux cloud worker, `truth:run` also supports
`--concurrency N` (or `GROUND_TRUTH_CONCURRENCY=N`) to run multiple isolated Forge candidates at
the same time. Keep the Forge template launch command blank in `.env` to auto-detect the right
launcher for the host OS (`run.bat` on Windows, `run.sh` on Linux).

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success (all steps completed) |
| `1` | Validation failed or synthesis error |
| `2` | Fatal error (missing config, database error) |

---

## Monitoring & Debugging

### Check Logs
The pipeline outputs structured logs at each step. Set log level:
```bash
LOG_LEVEL=debug npx tsx scripts/offline-pipeline/run.ts
```

### Verify Postgres Persistence
If you have `POSTGRES_URL` set, verify data was written:
```bash
psql $POSTGRES_URL -c "SELECT COUNT(*) FROM knowledge_snapshots;"
psql $POSTGRES_URL -c "SELECT COUNT(*) FROM pairwise_compatibility_records;"
```

### See Active Snapshot
Check which snapshot is currently serving analyses:
```bash
curl -X GET http://localhost:3000/v1/internal/snapshots/active \
  -H "x-tenant-id: org_demo" \
  -H "x-actor-id: usr_demo" \
  -H "x-actor-role: owner"
```

---

## Current Data & Evidence Sources (Demo Mode)

The offline pipeline currently runs on **seeded test data**, but demonstrates all 3 primary evidence sources:

### Mods in Catalog
- OptiFine
- Sodium
- Lithium
- ModMenu
- Fabric API

### Evidence Sources Ingested

#### Mod Descriptions & Release Notes (examples)
- Sodium description: "Incompatible with OptiFine. Use Iris Shaders for shader support." (confidence: 0.97)
- OptiFine changelog: "Known conflict with Sodium rendering engine" (confidence: 0.95)

#### GitHub Issues & Discussions (examples)
- OptiFine #5891: "incompatible with Sodium - both modify rendering" (confidence: 0.95)
- Lithium #128: "compatibility confirmed with Sodium" (confidence: 0.98)
- Cloth Config #342: "ModMenu interaction conditional" (confidence: 0.65)

#### Manually Curated Rules
- ~5 verified rules (fabric/loader conditions)
- High-precision verdicts maintained by developers

#### Technical Signatures (JAR Inspection)
- ~3 artifact conflict signatures detected automatically
- Mixin overlaps between OptiFine and Sodium
- Library version conflicts detected

### Mod Inspection Filter
- **Total versions in catalog:** 8
- **Already inspected:** 0 (on first run)
- **Too new (< 6 months):** ~3 versions
- **No download URL:** 0
- **Ready to inspect:** ~5 versions

### Synthesis Results
- **Pairwise Records:** 45 total
  - OptiFine ↔ Sodium: `known_incompatible` (0.97 confidence, from technical signatures + mod description)
  - Sodium ↔ Lithium: `known_compatible` (0.95 confidence, from GitHub discussion)
  - OptiFine ↔ ModMenu: `likely_incompatible` (0.72 confidence, from GitHub discussion)
  - ... and 42 more pairs
- **Fragment Records:** 8 total (3-mod clusters)
- **Generated Rules:** 6 from mod descriptions + GitHub
- **Final Claims:** 12 total

---

## Intentionally Excluded Sources

| Source                          | Reason for exclusion                                                                 |
|---------------------------------|--------------------------------------------------------------------------------------|
| Reddit / Discord / Curse Forums | High noise-to-signal ratio; most actionable knowledge already surfaces via GitHub issues and mod descriptions |
| Modrinth comment threads        | No stable public comments API; comment quality is highly variable                   |
| CurseForge comment sections     | API does not expose comments; scraping is brittle and against ToS                   |
| LLM-based claim extraction      | Optional/configurable future enhancement; not default to keep pipeline deterministic |

## Future Enhancements

### LLM-based semantic extraction (optional)
- The claim extraction layer is currently pattern-based and deterministic.
- An LLM extractor could handle long issue threads, nuanced wording, and multi-mod claims more robustly.
- Design requirement: results must be cached (by content hash) so the pipeline remains repeatable offline; raw evidence provenance must be preserved.

### Phase L: Advanced Analysis
- Graph algorithms (find transitive incompatibilities)
- ML-based confidence calibration
- Simulation-based predictions

---

## Questions?

- **What is Pipeline 1?** See [PIPELINES_EXPLAINED.md](docs/architecture/PIPELINES_EXPLAINED.md)
- **How do I set up Postgres?** See docker-compose.yml or the staging runtime setup
- **Can I modify the seeded data?** Yes, edit `packages/platform-core/src/repository.ts` fixture methods
