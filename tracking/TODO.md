TO IMPROVE PLATFORM

ARCHITECTURE NOTE FOR FUTURE AGENTS

The offline system is intentionally split into two pipelines:

1. Main offline knowledge pipeline
- Builds inferred compatibility knowledge.
- Uses catalog data, curated rules, evidence, artifact analysis, pairwise/fragment synthesis, and exact-pack cache generation.
- Does not run the expensive empirical "actually launch the pack" step.
- Produces the main offline knowledge database.

2. Ground-truth execution pipeline
- Separate command / worker, not part of the main offline pipeline command.
- Actually assembles mod combinations and tries to run them to get empirical truth such as:
  - does the pack start
  - does it reach world creation/load
  - does it crash or hang
- Must persist results and avoid repeating already-tested combinations unless they are stale, changed, flaky, or explicitly retried.
- Should become more valuable over time: the longer it runs, the more empirical discoveries it accumulates.
- Produces a second knowledge database considered higher-trust ground truth.

Planned platform serving order later:

1. Check empirical ground-truth knowledge first.
2. If no empirical result exists, fall back to the inferred offline knowledge from the main pipeline.

Important: the current deterministic simulation/replay code is not the intended final form of ground truth. The future ground-truth pipeline must perform real execution-based validation.

GROUND-TRUTH STATUS NOTE FOR FUTURE AGENTS

Current state as of 2026-04-19:

1. The local Forge ground-truth side pipeline is now concretely runnable.
- Main manual command:
  `pnpm truth:run:forge-local -- --mods "modA,modB"`
- Useful variants:
  - `pnpm truth:run:forge-local -- --selection random --random-count 2`
  - `pnpm truth:run:forge-local -- --selection auto`
  - add `--force` to rerun an exact already-tested pack on purpose

2. This command does not start the platform web services.
- It runs fully locally.
- It imports the mod list into the internal snapshot model.
- It enqueues and executes one empirical ground-truth candidate.
- It writes the results directly into Postgres.

3. Database and persistence details:
- Local DB is Postgres, usually:
  `postgres://postgres:postgres@localhost:5432/modcompat`
- Ground-truth tables in active use:
  - `ground_truth_candidates`
  - `ground_truth_runs`
  - `ground_truth_exact_pack_records`
  - `ground_truth_knowledge_snapshots`

4. Runtime details:
- Local Forge template directory:
  `runtime/forge-1.20.1-server-template`
- Concrete runner:
  `scripts/ground_truth/forge_runner.ts`
- The runner copies the template into a temp workdir, downloads mods, starts Forge, waits for the ready line, then persists the observed result.

5. Important implementation fixes already made:
- Snapshot creation is automatic in `truth:run:forge-local`; the user does not need to know snapshot ids.
- The command now directly executes the newly enqueued candidate instead of accidentally consuming an unrelated queued one.
- CurseForge resolution for the local Forge runner is implemented directly in the runner with known-project fallback ids for the current random pool mods.
- The old Windows false-timeout problem was caused by Forge `run.bat` ending with `pause`.
- The runner now patches the copied `run.bat` to remove that pause, so successful runs can exit cleanly.
- The runner also writes a minimal `server.properties`.
- Dedupe logic was relaxed so `timed_out` does not count as a settled empirical verdict.
- `--force` was added so exact combinations can be rerun intentionally.

6. Verified working empirical example:
- Command:
  `pnpm truth:run:forge-local -- --mods "curios,collective" --force`
- Verified persisted result:
  - run id `gtr_vj83ljkx`
  - status `completed`
  - verdict `passed_startup_and_world`
  - reached world `true`

7. Strategic direction from here:
- Keep the main offline pipeline separate from the empirical ground-truth pipeline.
- Use the empirical ground-truth layer as the higher-trust source in the future platform.
- Next major improvement for this side pipeline:
  choose promising mod combinations from inferred offline knowledge instead of relying mostly on random smoke testing.

new:
1. To give your modlist you should use the manifest.json/index.json (because it's much simpler, especially if there are hundreds of mods).

2. Connect to Curseforge (and Modrinth if not found in Curseforge) through API to find each mod and run the analysis.

old:
1. The users should not have to have an account to use the platform. Is should be optionnal for them to create an account. So once they enter the platform, they can use it freely but once they leave it, it won't save their data (such as their previous modpack list etc..)

2. The UI should look more Minecraft-like

3. On the main page at the top, there should be an explanation of what this is about and how to use it. Then lower, you can put the mods list and click run analysis









TO LAUNCH THE PLATFORM

What's left, in order of importance
1. Connect a real database (the biggest one)
Right now all data lives in memory — if you restart the gateway, everything disappears. You need to wire the app to the Postgres, Neo4j, and OpenSearch databases that are already running in Docker. This is what "Phase 7" was about.

2. Connect the backend services to each other
The platform has services written in Go, Python, and Java (for deep Minecraft jar analysis) that aren't actually talking to each other yet. The gateway handles everything itself with simple logic. Phase 8 wires them together properly.

3. Connect to real mod data
Right now mods are just names you type in. A production version would actually pull real mod metadata from CurseForge and Modrinth APIs so it knows real version histories, real dependencies, real changelogs, etc.

4. Real login system
Right now you're using "demo auth" (ALLOW_DEMO_AUTH=true). For real users you need to connect to something like Google login or GitHub login (OAuth).

5. Make the smart parts actually smart
The compatibility engine currently runs deterministic rules. The ML models, deep jar analysis, graph reasoning, and semantic search exist as skeletons but aren't trained/connected to real data yet.

6. Security hardening
Real user accounts, organizations, permissions, rate limiting, and making sure one user can't see another user's data.

7. Deploy it somewhere online
Put it on a real server (AWS, or cheaper options like Railway/Render) so people can access it from the internet, not just your computer.

8. The launch stuff (Phase 14)
Write docs, get beta users, set up support, decide pricing.

9. Run all the analysis in advance
