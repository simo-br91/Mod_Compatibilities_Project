# 05. Database Schema — PostgreSQL

PostgreSQL is the transactional source of truth for core platform data.

## Schema groups
- identity and tenancy
- workspace and project data
- canonical catalog
- pack snapshots
- analyses and findings
- recommendations
- evidence metadata
- audit and usage data

## Key table list
### Identity / tenancy
- `users`
- `organizations`
- `organization_memberships`
- `api_keys`
- `plans`
- `subscriptions`

### Workspace and projects
- `workspaces`
- `projects`
- `project_integrations`
- `project_watches`

### Catalog
- `canonical_projects`
- `project_aliases`
- `project_source_mappings`
- `canonical_versions`
- `version_files`
- `declared_dependencies`
- `declared_incompatibilities`

### Pack model
- `pack_snapshots`
- `pack_snapshot_mods`
- `pack_snapshot_configs`
- `pack_environment_profiles`

### Analysis
- `analyses`
- `analysis_phases`
- `findings`
- `finding_subjects`
- `finding_evidence`
- `finding_actions`

### Recommendation
- `recommendation_sets`
- `recommendations`
- `recommendation_impacts`

### Evidence and source metadata
- `evidence_documents`
- `evidence_snippets`
- `source_connectors`
- `source_sync_runs`

## Example relational model
### canonical_projects
```sql
CREATE TABLE canonical_projects (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  project_type        TEXT NOT NULL,
  functional_cluster  TEXT,
  client_side_support TEXT,
  server_side_support TEXT,
  maintenance_score   NUMERIC(5,2),
  popularity_score    NUMERIC(5,2),
  trust_score         NUMERIC(5,2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### project_source_mappings
```sql
CREATE TABLE project_source_mappings (
  id                    BIGSERIAL PRIMARY KEY,
  canonical_project_id  TEXT NOT NULL REFERENCES canonical_projects(id),
  source_name           TEXT NOT NULL,
  source_project_id     TEXT NOT NULL,
  source_slug           TEXT,
  source_url            TEXT,
  confidence            NUMERIC(5,4) NOT NULL,
  resolution_method     TEXT NOT NULL,
  is_verified           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_name, source_project_id)
);
```

### canonical_versions
```sql
CREATE TABLE canonical_versions (
  id                    TEXT PRIMARY KEY,
  canonical_project_id  TEXT NOT NULL REFERENCES canonical_projects(id),
  version_label         TEXT NOT NULL,
  release_channel       TEXT,
  minecraft_versions    JSONB NOT NULL,
  loaders               JSONB NOT NULL,
  java_versions         JSONB,
  published_at          TIMESTAMPTZ,
  is_listed             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### pack_snapshots
```sql
CREATE TABLE pack_snapshots (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  source_type           TEXT NOT NULL,
  source_ref            TEXT,
  normalized_hash       TEXT NOT NULL,
  environment_profile_id TEXT,
  created_by            TEXT REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, normalized_hash)
);
```

### analyses
```sql
CREATE TABLE analyses (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  pack_snapshot_id      TEXT NOT NULL REFERENCES pack_snapshots(id),
  trigger_type          TEXT NOT NULL,
  analysis_mode         TEXT NOT NULL,
  status                TEXT NOT NULL,
  overall_score         NUMERIC(5,2),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  created_by            TEXT REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### findings
```sql
CREATE TABLE findings (
  id                    TEXT PRIMARY KEY,
  analysis_id           TEXT NOT NULL REFERENCES analyses(id),
  finding_type          TEXT NOT NULL,
  severity              TEXT NOT NULL,
  confidence            NUMERIC(6,5) NOT NULL,
  reproducibility       TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  explanation           TEXT,
  score_details         JSONB,
  status                TEXT NOT NULL DEFAULT 'open',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Indexing guidance
- GIN indexes on JSONB arrays used for loader/version filtering
- B-tree on timestamps and foreign keys
- partial indexes on active/open findings
- unique indexes on normalized project and version mappings

## Partitioning guidance
Partition high-volume tables by time or tenant if needed:
- `evidence_documents`
- `evidence_snippets`
- `source_sync_runs`
- `analyses`
- `findings`

## Migration strategy
- use additive migrations
- avoid destructive changes in hot tables
- use backfills for derived columns
- keep event and DB schema evolution decoupled but tracked
