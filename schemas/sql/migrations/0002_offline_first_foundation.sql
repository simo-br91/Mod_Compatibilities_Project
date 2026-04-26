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

CREATE TABLE IF NOT EXISTS coverage_scopes (
  id TEXT PRIMARY KEY,
  snapshot_version TEXT NOT NULL,
  status TEXT NOT NULL,
  supported_minecraft_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
  supported_loaders JSONB NOT NULL DEFAULT '[]'::jsonb,
  supported_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  version_freshness_window_days INTEGER NOT NULL,
  notes TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_snapshots (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  coverage_scope_id TEXT REFERENCES coverage_scopes(id),
  validation_report_id TEXT,
  activated_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id),
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_snapshot_components (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  component_type TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, component_type)
);

CREATE TABLE IF NOT EXISTS snapshot_validation_reports (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  status TEXT NOT NULL,
  summary TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snapshot_validation_checks (
  id TEXT PRIMARY KEY,
  validation_report_id TEXT NOT NULL REFERENCES snapshot_validation_reports(id),
  check_code TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snapshot_promotion_events (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promoted_compatibility_claims (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  claim_key TEXT NOT NULL,
  finding_type TEXT NOT NULL,
  finding_verdict TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence_summary JSONB NOT NULL,
  source_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  environment JSONB,
  explanation TEXT NOT NULL,
  freshness_summary TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, claim_key)
);

CREATE TABLE IF NOT EXISTS promoted_claim_evidence_refs (
  id TEXT PRIMARY KEY,
  promoted_claim_id TEXT NOT NULL REFERENCES promoted_compatibility_claims(id),
  evidence_type TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  snippet_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technical_conflict_signatures (
  id TEXT PRIMARY KEY,
  signature_key TEXT NOT NULL UNIQUE,
  snapshot_id TEXT REFERENCES knowledge_snapshots(id),
  signature_type TEXT NOT NULL,
  project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_ref TEXT,
  package_hint TEXT,
  confidence_summary JSONB NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technical_conflict_signature_evidence_refs (
  id TEXT PRIMARY KEY,
  technical_conflict_signature_id TEXT NOT NULL REFERENCES technical_conflict_signatures(id),
  evidence_type TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  snippet_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pairwise_compatibility_records (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  left_project_id TEXT NOT NULL REFERENCES canonical_projects(id),
  left_version_id TEXT REFERENCES canonical_versions(id),
  right_project_id TEXT NOT NULL REFERENCES canonical_projects(id),
  right_version_id TEXT REFERENCES canonical_versions(id),
  environment JSONB,
  verdict TEXT NOT NULL,
  confidence_summary JSONB NOT NULL,
  claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fragment_compatibility_records (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  fragment_hash TEXT NOT NULL,
  project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  environment JSONB,
  verdict TEXT NOT NULL,
  confidence_summary JSONB NOT NULL,
  claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, fragment_hash)
);

CREATE TABLE IF NOT EXISTS pack_benchmark_results (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  benchmark_key TEXT NOT NULL,
  pack_fingerprint TEXT NOT NULL,
  environment JSONB NOT NULL,
  verdict TEXT NOT NULL,
  confidence_summary JSONB NOT NULL,
  finding_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, benchmark_key)
);

CREATE TABLE IF NOT EXISTS exact_pack_analysis_cache (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  pack_fingerprint TEXT NOT NULL,
  environment JSONB NOT NULL,
  verdict TEXT NOT NULL,
  confidence_summary JSONB NOT NULL,
  coverage_status TEXT NOT NULL,
  finding_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation TEXT NOT NULL,
  freshness_summary TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, pack_fingerprint)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_analysis_reports_knowledge_snapshot'
  ) THEN
    ALTER TABLE analysis_reports
      ADD CONSTRAINT fk_analysis_reports_knowledge_snapshot
      FOREIGN KEY (knowledge_snapshot_id) REFERENCES knowledge_snapshots(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_knowledge_snapshots_validation_report'
  ) THEN
    ALTER TABLE knowledge_snapshots
      ADD CONSTRAINT fk_knowledge_snapshots_validation_report
      FOREIGN KEY (validation_report_id) REFERENCES snapshot_validation_reports(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_coverage_scopes_snapshot_version
  ON coverage_scopes (snapshot_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_snapshots_status
  ON knowledge_snapshots (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshot_components_snapshot_id
  ON knowledge_snapshot_components (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_validation_reports_snapshot_id
  ON snapshot_validation_reports (snapshot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshot_promotion_events_snapshot_id
  ON snapshot_promotion_events (snapshot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_promoted_compatibility_claims_snapshot_id
  ON promoted_compatibility_claims (snapshot_id, finding_type);
CREATE INDEX IF NOT EXISTS idx_pairwise_compatibility_lookup
  ON pairwise_compatibility_records (snapshot_id, left_project_id, right_project_id);
CREATE INDEX IF NOT EXISTS idx_fragment_compatibility_lookup
  ON fragment_compatibility_records (snapshot_id, fragment_hash);
CREATE INDEX IF NOT EXISTS idx_pack_benchmark_results_snapshot_id
  ON pack_benchmark_results (snapshot_id, benchmark_key);
CREATE INDEX IF NOT EXISTS idx_exact_pack_analysis_cache_lookup
  ON exact_pack_analysis_cache (snapshot_id, pack_fingerprint);
