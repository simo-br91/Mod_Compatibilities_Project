CREATE TABLE organizations (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  display_name        TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  role                TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE plans (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  limits              JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  plan_id             TEXT NOT NULL REFERENCES plans(id),
  status              TEXT NOT NULL,
  period_start_at     TIMESTAMPTZ,
  period_end_at       TIMESTAMPTZ,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  created_by          TEXT REFERENCES users(id),
  name                TEXT NOT NULL,
  key_prefix          TEXT NOT NULL,
  key_hash            TEXT NOT NULL,
  scopes              JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  visibility          TEXT NOT NULL DEFAULT 'private',
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE project_integrations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  integration_type    TEXT NOT NULL,
  external_ref        TEXT NOT NULL,
  status              TEXT NOT NULL,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_watches (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  watch_type          TEXT NOT NULL,
  target_ref          TEXT NOT NULL,
  status              TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_aliases (
  id                  BIGSERIAL PRIMARY KEY,
  canonical_project_id TEXT NOT NULL REFERENCES canonical_projects(id),
  alias               TEXT NOT NULL,
  alias_type          TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_project_id, alias, alias_type)
);

CREATE TABLE project_source_mappings (
  id                  BIGSERIAL PRIMARY KEY,
  canonical_project_id TEXT NOT NULL REFERENCES canonical_projects(id),
  source_name         TEXT NOT NULL,
  source_project_id   TEXT NOT NULL,
  source_slug         TEXT,
  source_url          TEXT,
  confidence          NUMERIC(5,4) NOT NULL,
  resolution_method   TEXT NOT NULL,
  is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_name, source_project_id)
);

CREATE TABLE canonical_versions (
  id                  TEXT PRIMARY KEY,
  canonical_project_id TEXT NOT NULL REFERENCES canonical_projects(id),
  version_label       TEXT NOT NULL,
  release_channel     TEXT,
  minecraft_versions  JSONB NOT NULL,
  loaders             JSONB NOT NULL,
  java_versions       JSONB,
  published_at        TIMESTAMPTZ,
  is_listed           BOOLEAN NOT NULL DEFAULT TRUE,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE version_files (
  id                  TEXT PRIMARY KEY,
  canonical_version_id TEXT NOT NULL REFERENCES canonical_versions(id),
  artifact_url        TEXT,
  artifact_hash       TEXT,
  file_size_bytes     BIGINT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE declared_dependencies (
  id                  BIGSERIAL PRIMARY KEY,
  canonical_version_id TEXT NOT NULL REFERENCES canonical_versions(id),
  dependency_project_id TEXT,
  dependency_slug     TEXT,
  relation_type       TEXT NOT NULL,
  version_range       TEXT,
  side                TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE declared_incompatibilities (
  id                  BIGSERIAL PRIMARY KEY,
  canonical_version_id TEXT NOT NULL REFERENCES canonical_versions(id),
  incompatible_project_id TEXT,
  incompatible_slug   TEXT,
  reason              TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pack_environment_profiles (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  minecraft_version   TEXT NOT NULL,
  loader              TEXT NOT NULL,
  loader_version      TEXT,
  java_version        TEXT NOT NULL,
  side                TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pack_snapshots (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  source_type         TEXT NOT NULL,
  source_ref          TEXT,
  normalized_hash     TEXT NOT NULL,
  environment_profile_id TEXT REFERENCES pack_environment_profiles(id),
  source_payload_uri  TEXT,
  provenance          JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, normalized_hash)
);

CREATE TABLE pack_imports (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  source_type         TEXT NOT NULL,
  source_ref          TEXT,
  status              TEXT NOT NULL,
  environment         JSONB,
  pack_snapshot_id    TEXT REFERENCES pack_snapshots(id),
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_by          TEXT REFERENCES users(id),
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pack_snapshot_mods (
  id                  TEXT PRIMARY KEY,
  pack_snapshot_id    TEXT NOT NULL REFERENCES pack_snapshots(id),
  canonical_project_id TEXT,
  canonical_version_id TEXT,
  declared_name       TEXT NOT NULL,
  declared_version    TEXT,
  source_name         TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pack_snapshot_configs (
  id                  TEXT PRIMARY KEY,
  pack_snapshot_id    TEXT NOT NULL REFERENCES pack_snapshots(id),
  config_path         TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE analyses (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  pack_snapshot_id    TEXT NOT NULL REFERENCES pack_snapshots(id),
  trigger_type        TEXT NOT NULL,
  analysis_mode       TEXT NOT NULL,
  status              TEXT NOT NULL,
  overall_score       NUMERIC(5,2),
  counts              JSONB,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  provenance          JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_by          TEXT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE analysis_phases (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  phase_name          TEXT NOT NULL,
  status              TEXT NOT NULL,
  duration_ms         INTEGER,
  artifacts           JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, phase_name)
);

CREATE TABLE analysis_events (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  event_type          TEXT NOT NULL,
  message             TEXT NOT NULL,
  phase_name          TEXT,
  payload             JSONB,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE findings (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  finding_type        TEXT NOT NULL,
  severity            TEXT NOT NULL,
  confidence          NUMERIC(6,5) NOT NULL,
  reproducibility     TEXT NOT NULL DEFAULT 'not_tested',
  title               TEXT NOT NULL,
  summary             TEXT,
  explanation         TEXT,
  scope               JSONB,
  score_details       JSONB,
  status              TEXT NOT NULL DEFAULT 'open',
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  provenance          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE finding_subjects (
  id                  TEXT PRIMARY KEY,
  finding_id          TEXT NOT NULL REFERENCES findings(id),
  canonical_project_id TEXT,
  canonical_version_id TEXT,
  relation            TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE finding_evidence (
  id                  TEXT PRIMARY KEY,
  finding_id          TEXT NOT NULL REFERENCES findings(id),
  evidence_type       TEXT NOT NULL,
  evidence_id         TEXT NOT NULL,
  snippet_id          TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE finding_actions (
  id                  TEXT PRIMARY KEY,
  finding_id          TEXT NOT NULL REFERENCES findings(id),
  action_type         TEXT NOT NULL,
  action_text         TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendation_sets (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  generation_strategy TEXT NOT NULL,
  summary_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendations (
  id                  TEXT PRIMARY KEY,
  recommendation_set_id TEXT NOT NULL REFERENCES recommendation_sets(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  recommendation_kind TEXT NOT NULL,
  rank                INTEGER NOT NULL,
  confidence          NUMERIC(6,5) NOT NULL,
  summary             TEXT NOT NULL,
  rationale           TEXT,
  status              TEXT NOT NULL DEFAULT 'proposed',
  finding_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  replaces_subjects   JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate_projects  JSONB NOT NULL DEFAULT '[]'::jsonb,
  migration_cost      TEXT,
  expected_compatibility_gain NUMERIC(6,5),
  remediation_steps   JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendation_impacts (
  id                  TEXT PRIMARY KEY,
  recommendation_id   TEXT NOT NULL REFERENCES recommendations(id),
  impact_type         TEXT NOT NULL,
  impact_value        JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendation_bundles (
  id                  TEXT PRIMARY KEY,
  recommendation_set_id TEXT NOT NULL REFERENCES recommendation_sets(id),
  strategy            TEXT NOT NULL,
  recommendation_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary             TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  migration_cost      TEXT NOT NULL,
  expected_compatibility_gain NUMERIC(6,5) NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendation_feedback (
  id                  TEXT PRIMARY KEY,
  recommendation_set_id TEXT NOT NULL REFERENCES recommendation_sets(id),
  recommendation_id   TEXT NOT NULL REFERENCES recommendations(id),
  feedback_type       TEXT NOT NULL,
  note                TEXT,
  created_by          TEXT NOT NULL REFERENCES users(id),
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendation_outcomes (
  id                  TEXT PRIMARY KEY,
  recommendation_set_id TEXT NOT NULL REFERENCES recommendation_sets(id),
  status              TEXT NOT NULL,
  applied_recommendation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_summary  TEXT NOT NULL,
  created_by          TEXT NOT NULL REFERENCES users(id),
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE analysis_reports (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL UNIQUE REFERENCES analyses(id),
  recommendation_set_id TEXT REFERENCES recommendation_sets(id),
  report_json         JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_registry_entries (
  id                  TEXT PRIMARY KEY,
  model_key           TEXT NOT NULL,
  version             TEXT NOT NULL,
  task                TEXT NOT NULL,
  status              TEXT NOT NULL,
  metrics             JSONB NOT NULL DEFAULT '{}'::jsonb,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_evaluations (
  id                  TEXT PRIMARY KEY,
  model_id            TEXT NOT NULL REFERENCES model_registry_entries(id),
  dataset_id          TEXT NOT NULL,
  metrics             JSONB NOT NULL,
  sample_count        INTEGER NOT NULL,
  tenant_id           TEXT,
  trace_id            TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  evaluated_at        TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feedback_signal_reports (
  id                  TEXT PRIMARY KEY,
  generated_at        TIMESTAMPTZ NOT NULL,
  analysis_count      INTEGER NOT NULL,
  total_feedback_items INTEGER NOT NULL,
  total_outcomes      INTEGER NOT NULL,
  overall_acceptance_rate NUMERIC(6,5) NOT NULL,
  overall_validation_rate NUMERIC(6,5) NOT NULL,
  acceptance_by_kind  JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_accuracy NUMERIC(6,5),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE finding_feature_vectors (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  finding_id          TEXT NOT NULL REFERENCES findings(id),
  feature_namespace   TEXT NOT NULL,
  feature_values      JSONB NOT NULL,
  label               TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE offline_datasets (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  dataset_kind        TEXT NOT NULL,
  feature_vector_ids  JSONB NOT NULL,
  summary             JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE calibrated_finding_scores (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  finding_id          TEXT NOT NULL REFERENCES findings(id),
  model_id            TEXT NOT NULL REFERENCES model_registry_entries(id),
  original_confidence NUMERIC(6,5) NOT NULL,
  calibrated_confidence NUMERIC(6,5) NOT NULL,
  predicted_risk_score NUMERIC(6,5) NOT NULL,
  rationale           JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pack_review_summaries (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL UNIQUE REFERENCES analyses(id),
  model_id            TEXT NOT NULL REFERENCES model_registry_entries(id),
  review_json         JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE smoke_test_recipes (
  id                  TEXT PRIMARY KEY,
  recipe_key          TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  steps               JSONB NOT NULL,
  success_criteria    JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crash_signatures (
  id                  TEXT PRIMARY KEY,
  signature_key       TEXT NOT NULL UNIQUE,
  headline            TEXT NOT NULL,
  pattern             TEXT NOT NULL,
  related_finding_types JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE simulation_runs (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL UNIQUE REFERENCES analyses(id),
  pack_snapshot_id    TEXT NOT NULL REFERENCES pack_snapshots(id),
  recipe_id           TEXT NOT NULL REFERENCES smoke_test_recipes(id),
  status              TEXT NOT NULL,
  summary             TEXT NOT NULL,
  observations        JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE release_gate_decisions (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL UNIQUE REFERENCES analyses(id),
  policy_key          TEXT NOT NULL,
  status              TEXT NOT NULL,
  summary             TEXT NOT NULL,
  reasons             JSONB NOT NULL,
  blocking_finding_ids JSONB NOT NULL,
  simulation_run_id   TEXT REFERENCES simulation_runs(id),
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE github_installation_links (
  id                  TEXT PRIMARY KEY,
  installation_id     TEXT NOT NULL UNIQUE,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  repository_full_name TEXT NOT NULL,
  status              TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_registrations (
  id                  TEXT PRIMARY KEY,
  target_url          TEXT NOT NULL,
  event_types         JSONB NOT NULL,
  status              TEXT NOT NULL,
  secret_hint         TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_delivery_attempts (
  id                  TEXT PRIMARY KEY,
  webhook_id          TEXT NOT NULL REFERENCES webhook_registrations(id),
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  event_type          TEXT NOT NULL,
  status              TEXT NOT NULL,
  payload             JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE status_check_results (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL UNIQUE REFERENCES analyses(id),
  installation_id     TEXT,
  conclusion          TEXT NOT NULL,
  summary             TEXT NOT NULL,
  details_url         TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE source_connectors (
  id                  TEXT PRIMARY KEY,
  connector_name      TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verified_rules (
  id                  TEXT PRIMARY KEY,
  rule_key            TEXT NOT NULL UNIQUE,
  version             INTEGER NOT NULL,
  status              TEXT NOT NULL,
  severity            TEXT NOT NULL,
  confidence          NUMERIC(6,5) NOT NULL,
  reproducibility     TEXT NOT NULL,
  definition          JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rule_drafts (
  id                  TEXT PRIMARY KEY,
  rule_id             TEXT NOT NULL,
  version             INTEGER NOT NULL,
  title               TEXT NOT NULL,
  finding_type        TEXT NOT NULL,
  severity            TEXT NOT NULL,
  confidence          NUMERIC(6,5) NOT NULL,
  reproducibility     TEXT NOT NULL,
  summary             TEXT NOT NULL,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditions          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT NOT NULL,
  validation_errors   JSONB,
  created_by          TEXT NOT NULL REFERENCES users(id),
  tenant_id           TEXT,
  trace_id            TEXT,
  promoted_at         TIMESTAMPTZ,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version)
);

CREATE TABLE rule_version_history (
  draft_id            TEXT PRIMARY KEY REFERENCES rule_drafts(id),
  rule_id             TEXT NOT NULL,
  version             INTEGER NOT NULL,
  promoted_by         TEXT NOT NULL REFERENCES users(id),
  promoted_at         TIMESTAMPTZ NOT NULL,
  change_note         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version)
);

CREATE TABLE source_sync_runs (
  id                  TEXT PRIMARY KEY,
  connector_id        TEXT NOT NULL REFERENCES source_connectors(id),
  status              TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL,
  finished_at         TIMESTAMPTZ,
  checkpoint          JSONB,
  stats               JSONB,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE source_raw_payloads (
  id                  TEXT PRIMARY KEY,
  connector_id        TEXT NOT NULL REFERENCES source_connectors(id),
  sync_run_id         TEXT NOT NULL REFERENCES source_sync_runs(id),
  external_document_ref TEXT NOT NULL,
  content_type        TEXT NOT NULL,
  checksum            TEXT NOT NULL,
  payload             JSONB NOT NULL,
  fetched_at          TIMESTAMPTZ NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE evidence_documents (
  id                  TEXT PRIMARY KEY,
  source_connector_id TEXT REFERENCES source_connectors(id),
  sync_run_id         TEXT REFERENCES source_sync_runs(id),
  raw_payload_id      TEXT REFERENCES source_raw_payloads(id),
  source_document_ref TEXT NOT NULL,
  title               TEXT,
  source_url          TEXT,
  trust_tier          TEXT,
  trust_score         NUMERIC(6,5),
  relevance           TEXT,
  stance              TEXT,
  recency_score       NUMERIC(6,5),
  published_at        TIMESTAMPTZ,
  raw_payload_uri     TEXT,
  normalized_payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
  related_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  finding_types       JSONB NOT NULL DEFAULT '[]'::jsonb,
  extracted_entities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  extracted_relations JSONB NOT NULL DEFAULT '[]'::jsonb,
  cluster_id          TEXT,
  duplicate_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradicted_by_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  superseded_by_document_id TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_connector_id, source_document_ref)
);

CREATE TABLE evidence_snippets (
  id                  TEXT PRIMARY KEY,
  document_id         TEXT NOT NULL REFERENCES evidence_documents(id),
  snippet_text        TEXT NOT NULL,
  snippet_hash        TEXT NOT NULL,
  relevance           TEXT,
  stance              TEXT,
  trust_score         NUMERIC(6,5),
  related_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradiction_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  superseded_by_document_id TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, snippet_hash)
);

CREATE TABLE evidence_search_documents (
  id                  TEXT PRIMARY KEY,
  index_name          TEXT NOT NULL,
  document_id         TEXT NOT NULL REFERENCES evidence_documents(id),
  snippet_id          TEXT REFERENCES evidence_snippets(id),
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  trust_tier          TEXT NOT NULL,
  trust_score         NUMERIC(6,5) NOT NULL,
  recency_score       NUMERIC(6,5) NOT NULL,
  relevance           TEXT NOT NULL,
  stance              TEXT NOT NULL,
  finding_types       JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  cluster_id          TEXT NOT NULL,
  contradicted_by_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  superseded_by_document_id TEXT,
  source_url          TEXT NOT NULL,
  published_at        TIMESTAMPTZ NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE evidence_curations (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  finding_type        TEXT NOT NULL,
  severity            TEXT NOT NULL,
  summary             TEXT NOT NULL,
  subject_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_snippet_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  rule_draft          JSONB NOT NULL,
  status              TEXT NOT NULL,
  created_by          TEXT REFERENCES users(id),
  promoted_rule_id    TEXT REFERENCES verified_rules(id),
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  promoted_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_workspace_id ON projects (workspace_id);
CREATE INDEX idx_pack_imports_project_id ON pack_imports (project_id, created_at DESC);
CREATE INDEX idx_pack_snapshots_project_id ON pack_snapshots (project_id);
CREATE INDEX idx_pack_snapshot_mods_snapshot_id ON pack_snapshot_mods (pack_snapshot_id);
CREATE INDEX idx_analyses_project_status ON analyses (project_id, status, created_at DESC);
CREATE INDEX idx_analysis_phases_analysis_id ON analysis_phases (analysis_id);
CREATE INDEX idx_analysis_events_analysis_id ON analysis_events (analysis_id, occurred_at ASC);
CREATE INDEX idx_findings_analysis_id ON findings (analysis_id);
CREATE INDEX idx_recommendation_sets_analysis_id ON recommendation_sets (analysis_id);
CREATE INDEX idx_recommendations_set_rank ON recommendations (recommendation_set_id, rank);
CREATE INDEX idx_recommendation_bundles_set_id ON recommendation_bundles (recommendation_set_id);
CREATE INDEX idx_recommendation_feedback_recommendation_id ON recommendation_feedback (recommendation_id, created_at DESC);
CREATE INDEX idx_recommendation_outcomes_set_id ON recommendation_outcomes (recommendation_set_id, created_at DESC);
CREATE INDEX idx_model_registry_task_status ON model_registry_entries (task, status, created_at DESC);
CREATE INDEX idx_model_evaluations_model_id ON model_evaluations (model_id, evaluated_at DESC);
CREATE INDEX idx_feedback_signal_reports_generated_at ON feedback_signal_reports (generated_at DESC);
CREATE INDEX idx_finding_feature_vectors_analysis_id ON finding_feature_vectors (analysis_id, finding_id);
CREATE INDEX idx_offline_datasets_analysis_id ON offline_datasets (analysis_id, created_at DESC);
CREATE INDEX idx_calibrated_finding_scores_analysis_id ON calibrated_finding_scores (analysis_id, finding_id);
CREATE INDEX idx_smoke_test_recipes_key ON smoke_test_recipes (recipe_key);
CREATE INDEX idx_crash_signatures_key ON crash_signatures (signature_key);
CREATE INDEX idx_release_gate_decisions_analysis_id ON release_gate_decisions (analysis_id, status);
CREATE INDEX idx_github_installation_links_project_id ON github_installation_links (project_id, installation_id);
CREATE INDEX idx_webhook_delivery_attempts_analysis_id ON webhook_delivery_attempts (analysis_id, created_at DESC);
CREATE INDEX idx_verified_rules_status ON verified_rules (status, updated_at DESC);
CREATE INDEX idx_rule_drafts_rule_status ON rule_drafts (rule_id, status, created_at DESC);
CREATE INDEX idx_rule_version_history_rule_id ON rule_version_history (rule_id, version DESC);
CREATE INDEX idx_evidence_documents_connector_id ON evidence_documents (source_connector_id, created_at DESC);
CREATE INDEX idx_source_sync_runs_connector_id ON source_sync_runs (connector_id, started_at DESC);
CREATE INDEX idx_source_raw_payloads_sync_run_id ON source_raw_payloads (sync_run_id, created_at DESC);
CREATE INDEX idx_evidence_search_documents_lookup ON evidence_search_documents (index_name, published_at DESC);
CREATE INDEX idx_evidence_curations_status ON evidence_curations (status, created_at DESC);

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS confidence_inputs JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE artifact_analysis_runs (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  pack_snapshot_id    TEXT NOT NULL REFERENCES pack_snapshots(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  status              TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE artifact_analysis_outputs (
  id                  TEXT PRIMARY KEY,
  artifact_analysis_run_id TEXT NOT NULL REFERENCES artifact_analysis_runs(id),
  canonical_project_id TEXT NOT NULL REFERENCES canonical_projects(id),
  canonical_version_id TEXT REFERENCES canonical_versions(id),
  metadata            JSONB NOT NULL,
  mixin_targets       JSONB NOT NULL DEFAULT '[]'::jsonb,
  class_targets       JSONB NOT NULL DEFAULT '[]'::jsonb,
  resource_targets    JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedded_libraries  JSONB NOT NULL DEFAULT '[]'::jsonb,
  fingerprint         TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE graph_snapshots (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  node_count          INTEGER NOT NULL,
  edge_count          INTEGER NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE graph_nodes (
  id                  TEXT PRIMARY KEY,
  graph_snapshot_id   TEXT NOT NULL REFERENCES graph_snapshots(id),
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  node_type           TEXT NOT NULL,
  label               TEXT NOT NULL,
  properties          JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE graph_edges (
  id                  TEXT PRIMARY KEY,
  graph_snapshot_id   TEXT NOT NULL REFERENCES graph_snapshots(id),
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  edge_type           TEXT NOT NULL,
  source_node_id      TEXT NOT NULL,
  target_node_id      TEXT NOT NULL,
  weight              NUMERIC(6,5),
  properties          JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE explanation_paths (
  id                  TEXT PRIMARY KEY,
  analysis_id         TEXT NOT NULL REFERENCES analyses(id),
  finding_id          TEXT NOT NULL REFERENCES findings(id),
  summary             TEXT NOT NULL,
  node_ids            JSONB NOT NULL DEFAULT '[]'::jsonb,
  edge_ids            JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pack_diffs (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  tenant_id           TEXT NOT NULL REFERENCES organizations(id),
  base_snapshot_id    TEXT NOT NULL REFERENCES pack_snapshots(id),
  target_snapshot_id  TEXT NOT NULL REFERENCES pack_snapshots(id),
  baseline_analysis_id TEXT REFERENCES analyses(id),
  target_analysis_id  TEXT REFERENCES analyses(id),
  summary             JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  trace_id            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pack_diff_changes (
  id                  TEXT PRIMARY KEY,
  pack_diff_id        TEXT NOT NULL REFERENCES pack_diffs(id),
  change_type         TEXT NOT NULL,
  canonical_project_id TEXT REFERENCES canonical_projects(id),
  before_value        TEXT,
  after_value         TEXT,
  summary             TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifact_analysis_runs_analysis_id ON artifact_analysis_runs (analysis_id);
CREATE INDEX idx_graph_snapshots_analysis_id ON graph_snapshots (analysis_id);
CREATE INDEX idx_graph_nodes_snapshot_id ON graph_nodes (graph_snapshot_id);
CREATE INDEX idx_graph_edges_snapshot_id ON graph_edges (graph_snapshot_id);
CREATE INDEX idx_explanation_paths_finding_id ON explanation_paths (finding_id);
CREATE INDEX idx_pack_diffs_project_id ON pack_diffs (project_id, created_at DESC);

ALTER TABLE analyses
  ADD COLUMN IF NOT EXISTS verdict TEXT,
  ADD COLUMN IF NOT EXISTS confidence_summary JSONB,
  ADD COLUMN IF NOT EXISTS coverage_status TEXT,
  ADD COLUMN IF NOT EXISTS serving_mode TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_snapshot_version TEXT,
  ADD COLUMN IF NOT EXISTS explanation TEXT;

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS verdict TEXT,
  ADD COLUMN IF NOT EXISTS confidence_band TEXT,
  ADD COLUMN IF NOT EXISTS freshness_summary TEXT,
  ADD COLUMN IF NOT EXISTS coverage_status TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_snapshot_version TEXT;

ALTER TABLE analysis_reports
  ADD COLUMN IF NOT EXISTS knowledge_snapshot_id TEXT;

CREATE TABLE coverage_scopes (
  id                  TEXT PRIMARY KEY,
  snapshot_version    TEXT NOT NULL,
  status              TEXT NOT NULL,
  supported_minecraft_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
  supported_loaders   JSONB NOT NULL DEFAULT '[]'::jsonb,
  supported_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  version_freshness_window_days INTEGER NOT NULL,
  notes               TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_snapshots (
  id                  TEXT PRIMARY KEY,
  version             TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL,
  coverage_scope_id   TEXT REFERENCES coverage_scopes(id),
  validation_report_id TEXT,
  activated_at        TIMESTAMPTZ,
  created_by          TEXT REFERENCES users(id),
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_snapshot_components (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  component_type      TEXT NOT NULL,
  record_count        INTEGER NOT NULL DEFAULT 0,
  checksum            TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, component_type)
);

CREATE TABLE snapshot_validation_reports (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  status              TEXT NOT NULL,
  summary             TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE snapshot_validation_checks (
  id                  TEXT PRIMARY KEY,
  validation_report_id TEXT NOT NULL REFERENCES snapshot_validation_reports(id),
  check_code          TEXT NOT NULL,
  status              TEXT NOT NULL,
  summary             TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE snapshot_promotion_events (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  action              TEXT NOT NULL,
  actor_id            TEXT NOT NULL REFERENCES users(id),
  note                TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE promoted_compatibility_claims (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  claim_key           TEXT NOT NULL,
  finding_type        TEXT NOT NULL,
  finding_verdict     TEXT NOT NULL,
  severity            TEXT NOT NULL,
  confidence_summary  JSONB NOT NULL,
  source_kinds        JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  environment         JSONB,
  explanation         TEXT NOT NULL,
  freshness_summary   TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, claim_key)
);

CREATE TABLE promoted_claim_evidence_refs (
  id                  TEXT PRIMARY KEY,
  promoted_claim_id   TEXT NOT NULL REFERENCES promoted_compatibility_claims(id),
  evidence_type       TEXT NOT NULL,
  evidence_id         TEXT NOT NULL,
  snippet_id          TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE technical_conflict_signatures (
  id                  TEXT PRIMARY KEY,
  signature_key       TEXT NOT NULL UNIQUE,
  snapshot_id         TEXT REFERENCES knowledge_snapshots(id),
  signature_type      TEXT NOT NULL,
  project_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  version_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_ref          TEXT,
  package_hint        TEXT,
  confidence_summary  JSONB NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE technical_conflict_signature_evidence_refs (
  id                  TEXT PRIMARY KEY,
  technical_conflict_signature_id TEXT NOT NULL REFERENCES technical_conflict_signatures(id),
  evidence_type       TEXT NOT NULL,
  evidence_id         TEXT NOT NULL,
  snippet_id          TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mod_inspection_records (
  version_id          TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  last_inspected_at   TIMESTAMPTZ NOT NULL,
  inspection_count    INTEGER NOT NULL DEFAULT 1,
  inspection_status   TEXT NOT NULL,
  last_error_message  TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jar_artifact_profiles (
  version_id                 TEXT PRIMARY KEY,
  project_id                 TEXT NOT NULL,
  artifact_id                TEXT NOT NULL,
  mixin_config_files         JSONB NOT NULL DEFAULT '[]'::jsonb,
  mixin_targets              JSONB NOT NULL DEFAULT '[]'::jsonb,
  class_targets              JSONB NOT NULL DEFAULT '[]'::jsonb,
  resource_targets           JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedded_libraries         JSONB NOT NULL DEFAULT '[]'::jsonb,
  package_namespaces         JSONB NOT NULL DEFAULT '[]'::jsonb,
  access_widener_targets     JSONB NOT NULL DEFAULT '[]'::jsonb,
  access_transformer_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  refmap_targets             JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version             INTEGER NOT NULL DEFAULT 1,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pairwise_compatibility_records (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  left_project_id     TEXT NOT NULL REFERENCES canonical_projects(id),
  left_version_id     TEXT REFERENCES canonical_versions(id),
  right_project_id    TEXT NOT NULL REFERENCES canonical_projects(id),
  right_version_id    TEXT REFERENCES canonical_versions(id),
  environment         JSONB,
  verdict             TEXT NOT NULL,
  confidence_summary  JSONB NOT NULL,
  claim_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fragment_compatibility_records (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  fragment_hash       TEXT NOT NULL,
  project_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  version_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  environment         JSONB,
  verdict             TEXT NOT NULL,
  confidence_summary  JSONB NOT NULL,
  claim_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, fragment_hash)
);

CREATE TABLE pack_benchmark_results (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  benchmark_key       TEXT NOT NULL,
  pack_fingerprint    TEXT NOT NULL,
  environment         JSONB NOT NULL,
  verdict             TEXT NOT NULL,
  confidence_summary  JSONB NOT NULL,
  finding_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, benchmark_key)
);

CREATE TABLE exact_pack_analysis_cache (
  id                  TEXT PRIMARY KEY,
  snapshot_id         TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  pack_fingerprint    TEXT NOT NULL,
  environment         JSONB NOT NULL,
  verdict             TEXT NOT NULL,
  confidence_summary  JSONB NOT NULL,
  coverage_status     TEXT NOT NULL,
  finding_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation         TEXT NOT NULL,
  freshness_summary   TEXT,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, pack_fingerprint)
);

ALTER TABLE analysis_reports
  ADD CONSTRAINT fk_analysis_reports_knowledge_snapshot
  FOREIGN KEY (knowledge_snapshot_id) REFERENCES knowledge_snapshots(id);

ALTER TABLE knowledge_snapshots
  ADD CONSTRAINT fk_knowledge_snapshots_validation_report
  FOREIGN KEY (validation_report_id) REFERENCES snapshot_validation_reports(id);

CREATE INDEX idx_coverage_scopes_snapshot_version ON coverage_scopes (snapshot_version, created_at DESC);
CREATE INDEX idx_knowledge_snapshots_status ON knowledge_snapshots (status, created_at DESC);
CREATE INDEX idx_snapshot_components_snapshot_id ON knowledge_snapshot_components (snapshot_id);
CREATE INDEX idx_snapshot_validation_reports_snapshot_id ON snapshot_validation_reports (snapshot_id, created_at DESC);
CREATE INDEX idx_snapshot_promotion_events_snapshot_id ON snapshot_promotion_events (snapshot_id, created_at DESC);
CREATE INDEX idx_promoted_compatibility_claims_snapshot_id ON promoted_compatibility_claims (snapshot_id, finding_type);
CREATE INDEX idx_pairwise_compatibility_lookup ON pairwise_compatibility_records (snapshot_id, left_project_id, right_project_id);
CREATE INDEX idx_fragment_compatibility_lookup ON fragment_compatibility_records (snapshot_id, fragment_hash);
CREATE INDEX idx_pack_benchmark_results_snapshot_id ON pack_benchmark_results (snapshot_id, benchmark_key);
CREATE INDEX idx_exact_pack_analysis_cache_lookup ON exact_pack_analysis_cache (snapshot_id, pack_fingerprint);
