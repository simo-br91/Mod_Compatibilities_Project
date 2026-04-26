# 04. Event Contracts

The platform should be event-driven for ingestion, analysis orchestration, graph updates, and notifications.

## Event design principles
- immutable payloads
- append-only topics
- explicit schema versioning
- idempotent consumers
- correlation IDs on every event
- tenant and project scoping when user-generated

## Recommended topics
### Ingestion
- `source.fetch.requested`
- `source.fetch.completed`
- `source.fetch.failed`
- `document.normalized`
- `evidence.extracted`

### Catalog and identity
- `catalog.project.upserted`
- `catalog.version.upserted`
- `identity.resolution.completed`

### Analysis
- `analysis.requested`
- `analysis.started`
- `analysis.phase.completed`
- `analysis.finding.emitted`
- `analysis.completed`
- `analysis.failed`

### Graph
- `graph.edge.upserted`
- `graph.edge.retracted`
- `graph.snapshot.materialized`

### Recommendation
- `recommendation.generated`

### User and workspace
- `workspace.limit.reached`
- `project.watch.updated`
- `webhook.delivery.failed`

## Base event envelope
```json
{
  "event_id": "evt_01JX...",
  "event_type": "analysis.requested",
  "schema_version": 1,
  "occurred_at": "2026-04-06T18:00:00Z",
  "correlation_id": "corr_01JX...",
  "tenant_id": "org_123",
  "project_id": "proj_123",
  "producer": "api-gateway",
  "payload": {}
}
```

## Example: analysis.requested
```json
{
  "event_id": "evt_ana_req_1",
  "event_type": "analysis.requested",
  "schema_version": 1,
  "occurred_at": "2026-04-06T18:00:00Z",
  "correlation_id": "corr_ana_7",
  "tenant_id": "org_123",
  "project_id": "proj_123",
  "producer": "api-gateway",
  "payload": {
    "analysis_id": "ana_123",
    "analysis_mode": "deep",
    "environment": {
      "minecraft_version": "1.20.1",
      "loader": "forge",
      "java_version": "17",
      "side": "both"
    },
    "options": {
      "run_simulation": true,
      "include_alternatives": true
    },
    "input_ref": {
      "type": "pack_snapshot",
      "id": "snap_001"
    }
  }
}
```

## Example: analysis.phase.completed
```json
{
  "event_id": "evt_ana_phase_1",
  "event_type": "analysis.phase.completed",
  "schema_version": 1,
  "occurred_at": "2026-04-06T18:00:17Z",
  "correlation_id": "corr_ana_7",
  "tenant_id": "org_123",
  "project_id": "proj_123",
  "producer": "analysis-orchestrator",
  "payload": {
    "analysis_id": "ana_123",
    "phase": "static_analysis",
    "status": "completed",
    "duration_ms": 11340,
    "artifacts": [
      {"type": "static_summary", "id": "sas_981"}
    ]
  }
}
```

## Example: analysis.finding.emitted
```json
{
  "event_id": "evt_find_1",
  "event_type": "analysis.finding.emitted",
  "schema_version": 1,
  "occurred_at": "2026-04-06T18:00:26Z",
  "correlation_id": "corr_ana_7",
  "tenant_id": "org_123",
  "project_id": "proj_123",
  "producer": "analysis-engine",
  "payload": {
    "analysis_id": "ana_123",
    "finding_id": "fnd_001",
    "finding_type": "soft_conflict",
    "severity": "high",
    "confidence": 0.81,
    "subjects": [
      {"project_id": "mod_a", "version_id": "v1"},
      {"project_id": "mod_b", "version_id": "v9"}
    ]
  }
}
```

## Delivery semantics
- at-least-once delivery
- consumer-side dedupe based on `event_id`
- retry with exponential backoff
- dead-letter topics for poison messages

## Schema management
Maintain machine-readable schemas under `schemas/json/` and validate at publish and consume time.
