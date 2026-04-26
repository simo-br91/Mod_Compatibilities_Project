# Monitoring

This directory contains the Phase 13 starter monitoring assets for the compose-backed staging runtime.

## Included assets

- `slo-targets.yaml`
  - staging SLO definitions for canary freshness, canary success, and service health
- `alerts/staging-canary.rules.yaml`
  - Prometheus-style alert rules for synthetic canary failures, stale canary data, and health probe failures
- `grafana/staging-overview.dashboard.json`
  - starter dashboard panels for the latest canary status, probe latency, freshness, and blackbox service health

## Metric sources

These assets are designed around two metric sources:

1. The textfile-style metrics emitted by `pnpm canary:staging`
2. Blackbox `healthz` probes against the staging services

The canary metrics use the following names:

- `modcompat_canary_overall_success`
- `modcompat_canary_run_timestamp_seconds`
- `modcompat_canary_started_timestamp_seconds`
- `modcompat_canary_success`
- `modcompat_canary_duration_milliseconds`

The alert rules also reference `probe_success` for service-level health checks when a blackbox exporter is available.
