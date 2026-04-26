# How the Two Pipelines Work — Plain English

## What we're trying to build

A system that answers: **"Will these mods work together?"**

There are two separate ways to figure that out.

---

## Pipeline 1: Ground-Truth Execution Pipeline

**What it does:** Actually *runs* Minecraft with a set of mods and records whether it crashes on startup.
Like a lab experiment — empirical, definitive.

**How it works:**
1. It receives a prioritized list of mod combinations from Pipeline 2
2. It launches Minecraft (Forge) in the background with the combination loaded
3. It checks: did the game start? Did a world load without crashing?
4. It records the result and feeds it back to the database

**Current state:** Working end-to-end.

**Scope limitation — crash detection only:** This pipeline detects whether a mod combination
crashes Minecraft on startup or world load. It does **not** test for:
- Subtle gameplay incompatibilities (items that don't work together, broken mechanics)
- Visual glitches or rendering artifacts
- Performance degradation
- Issues that only appear after extended play

A "passed" result means the combination did not crash on startup — not that the mods are
fully compatible. When you see `known_compatible` from ground-truth data, read it as
"did not crash on load."

**Scale limitation:** It's slow and resource-heavy. You can't run it for every possible combination
of the thousands of mods that exist. So you need to be smart about *which combinations to test*
— that's where Pipeline 2 comes in. Default: 10 combinations per run.

---

## Pipeline 2: Main Offline Knowledge Pipeline

**What it does:** Figures out compatibility *without* running Minecraft, by reading existing
knowledge. Like a detective piecing together clues rather than running experiments.

### Step 1 — Ingest
Pull information from external sources, in priority order:

| Source | What it provides | Priority |
|--------|-----------------|----------|
| **CurseForge / Modrinth descriptions & release notes** | Author-stated incompatibilities — the highest-trust signal short of a real test | Primary |
| **GitHub issues & discussions** | Community-reported conflict evidence, semi-structured | Primary |
| **Mod JAR files themselves** | Technical signatures — mixin overlaps, embedded libraries, class collisions | Primary |
| **Manually curated rules** | A `rules/` folder in the repo where known facts are written by hand | Primary |
| **Community forums (Reddit, Discord)** | Noisy, low signal-to-noise ratio. Most useful signals from these sources already surface through GitHub. Not a planned source. | Not planned |

### Step 2 — Analyze
Look for red flags:
- Two mods that modify the same game code (called "mixins") — likely to conflict
- Two mods that bundle the same internal library at different versions — likely to crash
- Known conflict reports from GitHub or community sources

### Step 3 — Synthesize
Combine all those signals into verdicts:
> "ModA + ModB = probably incompatible (85% confidence)"
> "ModC + ModD = probably compatible (90% confidence)"

These verdicts are stored as **pairwise records** (one record per mod pair).

### Step 4 — Build a Snapshot
Package all the verdicts into a frozen, versioned bundle called a **snapshot**.
This snapshot can be served instantly to answer compatibility questions without recomputing everything.

### Step 5 — Generate Candidates
Produce a prioritized list of mod pairs that are:
- Likely incompatible but not yet confirmed by a real test
- Or completely untested and popular enough to matter

This list is handed to Pipeline 1 so it knows what to actually run Minecraft on.

---

## How the two pipelines work together

```
Offline Pipeline (Pipeline 2)          Ground-Truth Pipeline (Pipeline 1)
──────────────────────────────         ───────────────────────────────────
Reads mod metadata & signals  ──────►  "Test these 10 risky pairs"
Infers verdicts (no game run)               ↓
Flags uncertain/risky pairs   ──────►  Launches Minecraft for each pair
                                        Tests: crash on startup / world load?
                                            ↓
                              ◄──────  Updates pairwise confidence scores
                                       in the database (crashed = 1.0 confidence
                                       incompatible, loaded = raises compatible
                                       confidence, skips retesting known pairs)
```

---

## Current Status

### Pipeline 1 (Ground-Truth)
| Component | Status |
|-----------|--------|
| Launch Minecraft + capture result | ✅ Working |
| Record results to knowledge base | ✅ Working |
| Select which pairs to test (from existing records) | ✅ Working |
| Receive a fresh candidate list from Pipeline 2 | ✅ Ready (via GET /v1/internal/snapshots/:snapshotId/candidates) |

### Pipeline 2 (Offline Knowledge)
| Step | Status |
|------|--------|
| Ingest from CurseForge / Modrinth (live) | ❌ Not built (only dummy test data) |
| Ingest from GitHub / community sources | ❌ Not built |
| Ingest manually curated rules | ✅ Rules folder exists |
| Analyze mod JAR files for technical conflicts | ✅ Built |
| Synthesize verdicts into pairwise records | ✅ Built |
| Build + promote a snapshot | ✅ Built |
| Generate candidate list for Pipeline 1 | ✅ Built |
| Save snapshots to database (survive restarts) | ✅ Wired (Postgres persistence) |

---

## Bottom Line

- **Pipeline 1 works**, but runs blind — it needs someone to tell it what to test, and the wire from Pipeline 2's candidate output to Pipeline 1's input is not yet built
- **Pipeline 2 is half-built** — the reasoning core is done, but it has no real data to reason over yet (no live mod catalog, no real evidence ingestion)

The two most important missing pieces are:
1. **Real data ingestion** — build the 1,000-mod catalog and wire CurseForge/Modrinth description parsing + GitHub issue scraping so Pipeline 2 has real knowledge to work with
2. **Candidate handoff** — make Pipeline 1 consume the prioritized candidate list from Pipeline 2, not PackSnapshots
