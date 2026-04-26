# Modpack Compatibility Platform

The repository now contains the Phase 0 scaffold, the Phase 1 deterministic workflow slice, the Phase 2 artifact/graph foundation, the Phase 3 evidence platform slice, the Phase 4 deterministic recommendation/reporting slice, the Phase 5 deterministic ML/calibration slice, and a Phase 6 deterministic operations slice with simulation replay, crash signatures, and release gating.

## Repository layout

```text
apps/          Deployable services and the web shell
packages/      Shared TypeScript libraries and contract bindings
schemas/       Canonical machine-readable contracts (JSON, SQL, OpenAPI, events)
rules/         Verified and proposed compatibility rules
models/        ML feature, training, inference, and registry assets
workflows/     Temporal workflow definitions and tests
connectors/    Source-specific ingestion integrations (CurseForge, Modrinth, GitHub)
infra/         Kubernetes, monitoring, and secret templates
scripts/       Dev, CI, backfill, and data-maintenance helpers
docs/          Documentation organized by type:
  ├─ adr/           Architecture decision records
  ├─ architecture/  Developer guides and pipeline docs
  ├─ operations/    Bootstrap, runbooks, and reliability docs
  ├─ product/       Product vision, roadmap, and business docs
  └─ technical/     API contracts, database schemas, and diagrams
fixtures/      Replayable packs, artifacts, evidence, and truth sets
tracking/      Progress reports, TODOs, and implementation plans
logs/          Application and service logs (gitignored)
```

## Quick start

1. Install Node.js 22+, `pnpm` 10+, Go 1.23+, Python 3.12+, Java 21, and Docker Desktop.
2. Copy [`.env.example`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/.env.example) to `.env` and adjust local values if needed.
3. Start local infrastructure with `docker compose up -d`.
4. Review [bootstrap.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/docs/operations/bootstrap.md) for service-specific bootstrapping.
5. Use the Phase 0 contracts in [`schemas/`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/schemas) as the implementation source of truth.

## Source of truth

Machine-readable contracts in [`schemas/`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/schemas) define the implemented subset. Technical blueprints are in [`docs/technical/`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/docs/technical/).

Progress is tracked in the [`tracking/`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/tracking/) folder (PHASE_0 through PHASE_13 progress reports, TODO, and implementation plans).

## Offline knowledge architecture

The platform is expected to evolve around two separate offline knowledge systems, not one:

1. Main offline knowledge pipeline
   This pipeline stays focused on fast offline synthesis. It builds inferred compatibility knowledge from catalog data, curated rules, evidence, artifact analysis, pairwise and fragment synthesis, coverage scopes, and exact-pack cache generation. It must not block on long-running empirical pack execution.

2. Ground-truth execution pipeline
   This is a separate, long-running command or worker that actually assembles mod combinations, launches the target runtime, and checks whether the pack starts successfully and reaches world creation/load. Its job is to accumulate empirical results over time, persist them, avoid rerunning already-settled combinations unnecessarily, and continuously add new discoveries as the search frontier expands.

These two pipelines should produce two distinct knowledge layers:

- inferred offline knowledge
  Built by the main offline synthesis pipeline without actually executing Minecraft packs.
- empirical ground-truth knowledge
  Built by the execution pipeline from real observed outcomes after trying mod combinations in practice.

The intended serving order in the platform is:

1. check empirical ground-truth knowledge first
2. if no empirical result exists, fall back to inferred offline knowledge from the main pipeline

This separation is intentional:

- the main offline pipeline should remain faster, more deterministic, and easier to rerun
- the empirical execution pipeline is slower and operationally different, so it should remain a side command / background worker
- over time, the empirical layer should grow into the highest-trust source because it is based on observed pack behavior rather than inference alone

The empirical side pipeline now has two useful entrypoints:

- `pnpm truth:run`
  Internal/discovery-oriented worker command. It can enqueue already-known pack snapshots and process them.
- `pnpm truth:run:forge-local -- --selection auto`
  The local manual entrypoint for Forge. This is the one to use when you want to try the ground-truth runner directly on your machine without thinking about internal snapshot ids first.

Both commands ultimately use the concrete local Forge runner at [`scripts/ground_truth/forge_runner.ts`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/scripts/ground_truth/forge_runner.ts). It expects:

- `POSTGRES_URL` pointing at the shared Postgres database you want to keep as the durable source of empirical truth
- `GROUND_TRUTH_FORGE_TEMPLATE_DIR` pointing at a prepared Forge server directory
- `CURSEFORGE_API_KEY` only when the runner needs CurseForge resolution. Modrinth-origin candidates from the offline pipeline can resolve/download through Modrinth without a CurseForge key.

For local development, you can still point `POSTGRES_URL` at the Postgres container from [`docker-compose.yml`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/docker-compose.yml):

- host: `localhost`
- port: `5432`
- database: `modcompat`
- default URL: `postgres://postgres:postgres@localhost:5432/modcompat`

The offline synthesis and ground-truth entrypoints now treat Postgres persistence as the default mode. If you intentionally want a local non-persistent run, pass `--allow-ephemeral`.

`pnpm truth:run:forge-local` does not start the gateway/admin/platform web services. It is just a local script that:

1. chooses mods
2. creates an internal pack snapshot record
3. enqueues one ground-truth candidate
4. runs the Forge server locally
5. writes the result into Postgres

For now, candidate selection supports:

- explicit mods: `pnpm truth:run:forge-local -- --mods "balm,placebo"`
- inferred-knowledge first, then random fallback: `pnpm truth:run:forge-local -- --selection auto`
- random-only smoke test: `pnpm truth:run:forge-local -- --selection random --random-count 2`

A "snapshot" here is only the internal normalized database record for one exact mod list plus environment. The local Forge command creates that snapshot for you automatically, so you do not need to provide a snapshot id manually.

The Forge runner copies the template server into an isolated workdir, downloads the target mod jars into `mods/`, starts the server with `run.bat nogui` by default, waits for the server-ready "Done" line, then records the result as empirical knowledge in Postgres tables such as `ground_truth_candidates`, `ground_truth_runs`, `ground_truth_exact_pack_records`, and `ground_truth_knowledge_snapshots`.

## Current empirical status

As of April 19, 2026, the local Forge ground-truth side pipeline is runnable on this machine and is persisting real results to Postgres.

What is already working:

- `pnpm truth:run:forge-local` is the main local manual command for empirical Forge testing.
- It creates the internal pack snapshot for you automatically from either:
  - `--mods "modA,modB"`
  - `--selection random`
  - `--selection auto`
- It does not start the platform web services. It only imports the mod list, runs the local Forge test, and writes findings into Postgres.
- The local Forge server template lives at [`runtime/forge-1.20.1-server-template`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/runtime/forge-1.20.1-server-template).
- The runner uses CurseForge resolution directly from [`scripts/ground_truth/forge_runner.ts`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/scripts/ground_truth/forge_runner.ts), including a small fallback map for known Forge mods in the current smoke-test pool.
- The runner now patches the copied `run.bat` to remove the Windows `pause` behavior that previously caused false timeouts after successful runs.
- The runner also writes a minimal `server.properties` so the local test boot is cleaner.

Verified successful empirical example:

- command:
  `pnpm truth:run:forge-local -- --mods "curios,collective" --force`
- observed result in Postgres:
  - `status = completed`
  - `verdict = passed_startup_and_world`
  - `reached_main_menu = true`
  - `reached_world = true`
- latest successful run id:
  `gtr_vj83ljkx`

Important command behavior:

- By default, the command dedupes exact packs that already have a settled empirical verdict.
- `timed_out` no longer counts as settled.
- Use `--force` when you intentionally want to rerun the same exact mod combination after a runner change or for reproducibility checks.

Current known limitations:

- Right now the local smoke-test flow is still centered on random explicit mod combinations or direct manual picks.
- The next step is to choose higher-value candidates from the inferred offline knowledge layer instead of mostly random smoke tests.
- Modrinth-origin candidates now keep their `sourceProjectId` through the local Forge path, so run2 catalogs can feed run3 without relying on CurseForge search. CurseForge remains a fallback when `CURSEFORGE_API_KEY` is configured.
