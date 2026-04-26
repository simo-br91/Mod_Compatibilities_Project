# 02. API Contracts

This file defines the external and internal API surface at a product-design level.
The detailed starter OpenAPI file is in `openapi/platform.openapi.yaml`.

## API style
- Public/product API: REST + SSE for job progress
- Internal service APIs: REST or gRPC depending on call pattern
- Event-driven updates: Kafka + webhook fan-out

## Public resources
### Workspaces
- `POST /v1/workspaces`
- `GET /v1/workspaces/{workspaceId}`
- `GET /v1/workspaces/{workspaceId}/projects`

### Projects
- `POST /v1/projects`
- `GET /v1/projects/{projectId}`
- `PATCH /v1/projects/{projectId}`

### Pack imports
- `POST /v1/projects/{projectId}/imports`
- `POST /v1/projects/{projectId}/imports/manifest`
- `POST /v1/projects/{projectId}/imports/mod-list`
- `POST /v1/projects/{projectId}/imports/upload-url`

### Analyses
- `POST /v1/projects/{projectId}/analyses`
- `GET /v1/analyses/{analysisId}`
- `GET /v1/analyses/{analysisId}/findings`
- `GET /v1/analyses/{analysisId}/graph`
- `GET /v1/analyses/{analysisId}/recommendations`
- `GET /v1/analyses/{analysisId}/events/stream`

### Catalog lookups
- `GET /v1/catalog/projects/search`
- `GET /v1/catalog/projects/{projectKey}`
- `GET /v1/catalog/versions/{versionId}`
- `POST /v1/catalog/resolve`

### Findings
- `PATCH /v1/findings/{findingId}` for ignore, mute, resolve, note
- `POST /v1/findings/{findingId}/feedback`

### Reports
- `GET /v1/analyses/{analysisId}/report`
- `GET /v1/analyses/{analysisId}/report/export?format=json|pdf|markdown`

### Integrations
- `POST /v1/integrations/github/installations/{installationId}/link`
- `POST /v1/webhooks`
- `GET /v1/webhooks`

## Example: create analysis
```http
POST /v1/projects/proj_123/analyses
Content-Type: application/json
Authorization: Bearer <token>

{
  "trigger": "manual",
  "analysis_mode": "deep",
  "input_ref": {
    "type": "pack_snapshot",
    "id": "snap_8a91"
  },
  "environment": {
    "minecraft_version": "1.20.1",
    "loader": "forge",
    "java_version": "17",
    "side": "both"
  },
  "options": {
    "run_simulation": true,
    "include_alternatives": true,
    "include_low_confidence": false
  }
}
```

### Response
```json
{
  "analysis_id": "ana_01JX...",
  "status": "queued",
  "queue_position": 2,
  "progress_stream_url": "/v1/analyses/ana_01JX.../events/stream"
}
```

## Example: findings payload
```json
{
  "items": [
    {
      "finding_id": "fnd_01",
      "type": "hard_conflict",
      "severity": "critical",
      "confidence": 0.97,
      "reproducibility": "not_tested",
      "title": "Likely renderer stack conflict",
      "summary": "Two rendering mods target overlapping hooks and are not recommended together.",
      "scope": {
        "minecraft_version": "1.20.1",
        "loader": "fabric"
      },
      "subjects": [
        {"project_id": "prj_a", "version_id": "ver_a"},
        {"project_id": "prj_b", "version_id": "ver_b"}
      ],
      "evidence": [
        {"type": "rule", "id": "RULE-RENDER-004"},
        {"type": "issue", "id": "evd_8821"}
      ],
      "recommended_actions": [
        "Remove Mod B",
        "Replace Mod B with candidate rec_1002"
      ]
    }
  ],
  "next_cursor": null
}
```

## Internal service API guidance
### Resolver Service
- `POST /internal/resolve`
- `POST /internal/normalize-pack`
- `POST /internal/explain-conflicts`

### Static Analysis Service
- `POST /internal/analyze-artifact`
- `GET /internal/artifacts/{artifactId}/summary`

### Graph Service
- `POST /internal/graph/upsert`
- `GET /internal/graph/neighborhood`
- `POST /internal/graph/explanations`

### Recommendation Service
- `POST /internal/recommendations/generate`

## Idempotency
The following endpoints must support idempotency keys:
- import creation
- analysis creation
- webhook registration
- user report submission

## API versioning
Use URI versioning for public APIs.
Use explicit schema-version headers for internal APIs and event payloads.
