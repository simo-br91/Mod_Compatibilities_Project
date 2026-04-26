# Reliability

## Goal

Phase 13 now includes a repo-native reliability slice for the compose-backed staging runtime:

- a lightweight pre-promotion canary
- emitted canary artifacts for monitoring
- starter SLO, alert, and dashboard assets
- release-state verification for rollback and disaster-recovery drills

These assets are sized to the repository's current maturity. They do not replace a persistent production monitoring stack yet, but they do give the repo concrete operator signals and validation entrypoints.

## Canary

Run the staging canary against an already-running compose-backed runtime:

```bash
pnpm canary:staging
```

Useful options:

```bash
pnpm canary:staging -- --dry-run
pnpm canary:staging -- --report-path tmp/canary.json --metrics-path tmp/canary.prom
```

The canary verifies:

- PostgreSQL connectivity
- `/healthz` on artifact-analysis, evidence, admin, orchestrator, recommendation, graph, and simulation
- a sample artifact-analysis overlap/divergence request
- evidence sync and evidence search
- admin evidence curation and verified-rule promotion

Outputs:

- `.phase13-canary-report.json`
- `.phase13-canary.prom`

The Prometheus-style output is intended for a textfile collector or equivalent synthetic metric ingestion path.

## Release Verification

Validate the current release-control-plane references:

```bash
pnpm release:verify:staging
```

This verifies:

- current and previous release manifests exist
- release history paths still point to real manifest files
- referenced compose files still exist
- service health URLs parse correctly
- declared probe commands are present

This is the current repo's disaster-recovery validation path for release metadata. It validates the release-control plane, not a full data-plane restore for Postgres, Redis, Neo4j, or object storage.

## Monitoring Assets

Starter monitoring assets live under [`infra/monitoring/`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/monitoring).

- [`README.md`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/monitoring/README.md)
- [`slo-targets.yaml`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/monitoring/slo-targets.yaml)
- [`alerts/staging-canary.rules.yaml`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/monitoring/alerts/staging-canary.rules.yaml)
- [`grafana/staging-overview.dashboard.json`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/monitoring/grafana/staging-overview.dashboard.json)

These assets assume either:

- the staging canary metrics are ingested from the generated `.prom` file
- service `healthz` endpoints are blackbox-probed into Prometheus

## Runbook

If `pnpm canary:staging` fails:

- check `.phase13-canary-report.json` first for the failing probe and exact error
- if the failure is a health probe, inspect `docker compose -f docker-compose.yml -f docker-compose.staging.yml ps`
- if the failure is a service operation probe, inspect `docker compose -f docker-compose.yml -f docker-compose.staging.yml logs --no-color <service>`
- rerun `pnpm smoke:staging -- --probe-only` only after the canary is green again

If `pnpm release:verify:staging` fails:

- repair or restore the missing manifest referenced in `infra/releases/`
- do not trust rollback state until the verification output is clean
- if the current environment state is incorrect, fix it through the release utility rather than hand-editing JSON unless you are in an emergency recovery flow

If a rollback is needed:

```bash
pnpm release:status -- --environment staging
pnpm release:verify:staging
pnpm release:rollback:staging -- --actor <name> --reason "Rollback staging release"
pnpm release:verify:staging
```

## Current boundary

The current reliability slice is strong for the repo's compose-backed staging model, but these later platform steps still live outside this Phase 13 scope:

- persistent remote metric storage and alert routing
- automated database backup/restore drills for the runtime data plane
- remote image publishing and historical image redeploy rollback
- production traffic shaping or cluster-level canary rollout control
