import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlatformId } from "@modcompat/id-generation";
import type {
  AnalysisEvent,
  AnalysisPhase,
  ArtifactAnalysisResult,
  ApiKeyRecord,
  CalibratedFindingScore,
  ExactPackAnalysisCacheRecord,
  EvidenceDocument,
  EvidenceSearchDocument,
  EvidenceSnippet,
  EvidenceCurationRecord,
  FeedbackSignalReport,
  FindingFeatureVector,
  FragmentCompatibilityRecord,
  GroundTruthCandidate,
  GroundTruthExactPackRecord,
  GroundTruthKnowledgeSnapshot,
  GroundTruthRun,
  KnowledgeSnapshot,
  ModelEvaluationRecord,
  ModelRegistryEntry,
  OfflineDataset,
  PackDiff,
  PackImport,
  PackSnapshot,
  PairwiseCompatibilityRecord,
  PromotedCompatibilityClaim,
  Recommendation,
  RecommendationFeedback,
  RecommendationOutcome,
  RecommendationSet,
  RuleDraftRecord,
  RuleDraftStatus,
  RuleVersionHistoryEntry,
  SupportedCoverageScope,
  SourceConnector,
  SourceSyncRun,
  TechnicalConflictSignature,
  UserIdentity,
  OrganizationMembership,
  RawPayloadRecord,
  Workspace,
  Project
} from "@modcompat/domain-models";
import type { AnalysisReport, AnalysisSummary, Finding } from "@modcompat/api-contracts";
import { Pool, type PoolClient } from "pg";
import { InMemoryPlatformRepository } from "./repository.js";
import type {
  AnalysisRecordInternal,
  AnalysisResult,
  ArtifactProfileRecord,
  VerifiedRuleDefinition
} from "./types.js";
import type { ModInspectionRecord } from "./mod-inspection-tracker.js";
import { stableHash } from "./helpers.js";

interface JsonRow {
  [key: string]: unknown;
}

type ServiceRequestStatus = "started" | "completed" | "failed" | "cancelled";

interface ServiceRequestRecord {
  serviceName: string;
  operationName: string;
  idempotencyKey: string;
  status: ServiceRequestStatus;
  analysisId?: string;
  response?: unknown;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

function sqlRootPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../schemas/sql/postgres_core.sql"
  );
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

function toNumeric(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return Number(value);
}

function toTimestampString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

async function ensurePhase8Tables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_request_dedupes (
      service_name TEXT NOT NULL,
      operation_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      analysis_id TEXT,
      response_json JSONB,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (service_name, operation_name, idempotency_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rule_drafts (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      finding_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence NUMERIC(6,5) NOT NULL,
      reproducibility TEXT NOT NULL,
      summary TEXT NOT NULL,
      recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL,
      validation_errors JSONB,
      created_by TEXT NOT NULL REFERENCES users(id),
      tenant_id TEXT,
      trace_id TEXT,
      promoted_at TIMESTAMPTZ,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (rule_id, version)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rule_version_history (
      draft_id TEXT PRIMARY KEY REFERENCES rule_drafts(id),
      rule_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      promoted_by TEXT NOT NULL REFERENCES users(id),
      promoted_at TIMESTAMPTZ NOT NULL,
      change_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (rule_id, version)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_evaluations (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES model_registry_entries(id),
      dataset_id TEXT NOT NULL,
      metrics JSONB NOT NULL,
      sample_count INTEGER NOT NULL,
      tenant_id TEXT,
      trace_id TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      evaluated_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_signal_reports (
      id TEXT PRIMARY KEY,
      generated_at TIMESTAMPTZ NOT NULL,
      analysis_count INTEGER NOT NULL,
      total_feedback_items INTEGER NOT NULL,
      total_outcomes INTEGER NOT NULL,
      overall_acceptance_rate NUMERIC(6,5) NOT NULL,
      overall_validation_rate NUMERIC(6,5) NOT NULL,
      acceptance_by_kind JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence_accuracy NUMERIC(6,5),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rule_drafts_rule_status
      ON rule_drafts (rule_id, status, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rule_version_history_rule_id
      ON rule_version_history (rule_id, version DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_model_evaluations_model_id
      ON model_evaluations (model_id, evaluated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_signal_reports_generated_at
      ON feedback_signal_reports (generated_at DESC)
  `);
}

async function ensureGroundTruthTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ground_truth_candidates (
      id TEXT PRIMARY KEY,
      candidate_kind TEXT NOT NULL,
      pack_snapshot_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL,
      environment JSONB NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      execution_profile_key TEXT NOT NULL,
      discovered_from TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50,
      attempts INTEGER NOT NULL DEFAULT 0,
      latest_run_id TEXT,
      latest_verdict TEXT,
      tenant_id TEXT,
      trace_id TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ground_truth_runs (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES ground_truth_candidates(id),
      pack_snapshot_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL,
      environment JSONB NOT NULL,
      execution_profile_key TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reached_main_menu BOOLEAN NOT NULL DEFAULT FALSE,
      reached_world BOOLEAN NOT NULL DEFAULT FALSE,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      summary TEXT NOT NULL,
      observations JSONB NOT NULL DEFAULT '[]'::jsonb,
      stdout_text TEXT,
      stderr_text TEXT,
      artifact_directory TEXT,
      raw_result JSONB,
      tenant_id TEXT,
      trace_id TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ground_truth_exact_pack_records (
      id TEXT PRIMARY KEY,
      ground_truth_snapshot_id TEXT,
      pack_fingerprint TEXT NOT NULL,
      pack_snapshot_id TEXT NOT NULL,
      environment JSONB NOT NULL,
      execution_profile_key TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence JSONB NOT NULL,
      run_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      latest_run_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      reproducibility_score NUMERIC(6,5) NOT NULL,
      tenant_id TEXT,
      trace_id TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    ALTER TABLE ground_truth_exact_pack_records
      DROP CONSTRAINT IF EXISTS ground_truth_exact_pack_records_pack_fingerprint_execution_profile_key_environment_key
  `);
  await pool.query(`
    ALTER TABLE ground_truth_exact_pack_records
      DROP CONSTRAINT IF EXISTS ground_truth_exact_pack_recor_pack_fingerprint_execution_pr_key
  `);
  await pool.query(`
    ALTER TABLE ground_truth_exact_pack_records
      DROP CONSTRAINT IF EXISTS ground_truth_exact_pack_records_pack_fingerprint_execution_profile_key_key
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ground_truth_exact_pack_records_fingerprint_profile_env_key'
      ) THEN
        ALTER TABLE ground_truth_exact_pack_records
          ADD CONSTRAINT ground_truth_exact_pack_records_fingerprint_profile_env_key
          UNIQUE (pack_fingerprint, execution_profile_key, environment);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ground_truth_knowledge_snapshots (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      included_record_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      checksums JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      activated_at TIMESTAMPTZ,
      tenant_id TEXT,
      trace_id TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ground_truth_candidates_status
      ON ground_truth_candidates (status, priority DESC, created_at ASC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ground_truth_runs_candidate_id
      ON ground_truth_runs (candidate_id, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ground_truth_exact_pack_records_snapshot
      ON ground_truth_exact_pack_records (ground_truth_snapshot_id, updated_at DESC)
  `);
  await pool.query(`
    ALTER TABLE pack_environment_profiles
      ADD COLUMN IF NOT EXISTS loader_version TEXT
  `);
  await pool.query(`
    CREATE OR REPLACE VIEW ground_truth_pair_knowledge AS
    SELECT
      exact_record.id AS record_id,
      exact_record.ground_truth_snapshot_id,
      exact_record.pack_fingerprint,
      exact_record.verdict,
      exact_record.confidence,
      exact_record.summary,
      exact_record.reproducibility_score,
      exact_record.latest_run_id,
      exact_record.updated_at,
      environment.minecraft_version,
      environment.loader,
      COALESCE(environment.loader_version, exact_record.environment->>'loaderVersion') AS loader_version,
      environment.java_version,
      environment.side,
      left_mod.canonical_project_id AS left_project_id,
      left_mod.canonical_version_id AS left_version_id,
      left_mod.declared_name AS left_name,
      left_mod.declared_version AS left_version,
      right_mod.canonical_project_id AS right_project_id,
      right_mod.canonical_version_id AS right_version_id,
      right_mod.declared_name AS right_name,
      right_mod.declared_version AS right_version
    FROM ground_truth_exact_pack_records exact_record
    JOIN pack_snapshots snapshot
      ON snapshot.id = exact_record.pack_snapshot_id
    LEFT JOIN pack_environment_profiles environment
      ON environment.id = snapshot.environment_profile_id
    JOIN pack_snapshot_mods left_mod
      ON left_mod.pack_snapshot_id = exact_record.pack_snapshot_id
    JOIN pack_snapshot_mods right_mod
      ON right_mod.pack_snapshot_id = exact_record.pack_snapshot_id
      AND left_mod.id < right_mod.id
    WHERE exact_record.verdict IN (
      'passed_startup_and_world',
      'failed_startup',
      'failed_world_load'
    )
  `);
}

async function ensureOfflinePipelineTables(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mod_inspection_records (
      version_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      last_inspected_at TIMESTAMPTZ NOT NULL,
      inspection_count INTEGER NOT NULL DEFAULT 1,
      inspection_status TEXT NOT NULL,
      last_error_message TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jar_artifact_profiles (
      version_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      mixin_config_files JSONB NOT NULL DEFAULT '[]'::jsonb,
      mixin_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      class_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      resource_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      embedded_libraries JSONB NOT NULL DEFAULT '[]'::jsonb,
      package_namespaces JSONB NOT NULL DEFAULT '[]'::jsonb,
      access_widener_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      access_transformer_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      refmap_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_mod_inspection_records_project
      ON mod_inspection_records (project_id, last_inspected_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_jar_artifact_profiles_project
      ON jar_artifact_profiles (project_id)
  `);
}

async function ensureKnowledgeSnapshotTables(pool: Pool) {
  await pool.query(`
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
    )
  `);

  await pool.query(`
    ALTER TABLE knowledge_snapshots
      ADD COLUMN IF NOT EXISTS coverage_scope_id TEXT
  `);
  await pool.query(`
    ALTER TABLE knowledge_snapshots
      ADD COLUMN IF NOT EXISTS validation_report_id TEXT
  `);
  await pool.query(`
    ALTER TABLE knowledge_snapshots
      ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE knowledge_snapshots
      ADD COLUMN IF NOT EXISTS created_by TEXT
  `);
  await pool.query(`
    ALTER TABLE knowledge_snapshots
      ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1
  `);
  await pool.query(`
    ALTER TABLE knowledge_snapshots
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_snapshot_components (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
      component_type TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (snapshot_id, component_type)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshot_validation_reports (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
      status TEXT NOT NULL,
      summary TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshot_validation_checks (
      id TEXT PRIMARY KEY,
      validation_report_id TEXT NOT NULL REFERENCES snapshot_validation_reports(id),
      check_code TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshot_promotion_events (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
      action TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES users(id),
      note TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_components_snapshot_id
      ON knowledge_snapshot_components (snapshot_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_validation_reports_snapshot_id
      ON snapshot_validation_reports (snapshot_id, created_at DESC)
  `);
}

function toFindingRecord(
  row: JsonRow,
  lookup: {
    subjects: Map<string, Finding["subjects"]>;
    evidence: Map<string, Finding["evidence"]>;
    actions: Map<string, string[]>;
  }
): Finding {
  const findingId = String(row.id);

  return {
    findingId,
    type: String(row.finding_type),
    severity: row.severity as Finding["severity"],
    confidence: Number(row.confidence),
    reproducibility: row.reproducibility as Finding["reproducibility"],
    title: String(row.title),
    summary: row.summary ? String(row.summary) : undefined,
    explanation: row.explanation ? String(row.explanation) : undefined,
    scope: parseJsonValue(row.scope, undefined),
    evidence: lookup.evidence.get(findingId) ?? [],
    subjects: lookup.subjects.get(findingId) ?? [],
    recommendedActions: lookup.actions.get(findingId) ?? [],
    provenance: parseJsonValue(row.provenance, []),
    confidenceInputs: parseJsonValue(row.confidence_inputs, []),
    dedupeKey: row.dedupe_key ? String(row.dedupe_key) : undefined
  };
}

function toRecord(result: AnalysisResult): AnalysisRecordInternal {
  return {
    summary: result.analysis,
    phases: result.phases,
    events: result.events,
    findings: result.findings,
    recommendations: result.recommendations,
    recommendationSet: result.recommendationSet,
    featureDataset: result.featureDataset,
    featureVectors: result.featureVectors ?? [],
    calibratedScores: result.calibratedScores ?? [],
    reviewSummary: result.reviewSummary,
    simulationRun: result.simulationRun,
    releaseGateDecision: result.releaseGateDecision,
    statusCheck: result.statusCheck,
    artifacts: result.artifacts ?? [],
    graph: result.graph,
    explanationPaths: new Map(),
    packDiff: result.packDiff,
    report: result.report
  };
}

function toArtifactAnalysisRecord(row: JsonRow): ArtifactAnalysisResult {
  return {
    artifactAnalysisId: String(row.id),
    analysisId: String(row.analysis_id),
    packSnapshotId: String(row.pack_snapshot_id),
    projectId: String(row.canonical_project_id),
    versionId: row.canonical_version_id ? String(row.canonical_version_id) : undefined,
    metadata: parseJsonValue<ArtifactAnalysisResult["metadata"]>(row.metadata, {
      artifactId: String(row.id),
      name: String(row.canonical_project_id),
      loaderHints: [],
      mixinConfigFiles: []
    }),
    mixinTargets: parseJsonValue<ArtifactAnalysisResult["mixinTargets"]>(row.mixin_targets, []),
    classTargets: parseJsonValue<ArtifactAnalysisResult["classTargets"]>(row.class_targets, []),
    resourceTargets: parseJsonValue<ArtifactAnalysisResult["resourceTargets"]>(
      row.resource_targets,
      []
    ),
    embeddedLibraries: parseJsonValue<ArtifactAnalysisResult["embeddedLibraries"]>(
      row.embedded_libraries,
      []
    ),
    fingerprint: String(row.fingerprint),
    tenantId: row.tenant_id ? String(row.tenant_id) : String(row.organization_id),
    schemaVersion: Number(row.schema_version),
    createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
  };
}

function toRuleDraftRecord(row: JsonRow): RuleDraftRecord {
  const validationErrors = parseJsonValue(row.validation_errors, undefined as string[] | undefined);
  return {
    draftId: String(row.id),
    ruleId: String(row.rule_id),
    version: Number(row.version),
    title: String(row.title),
    findingType: String(row.finding_type),
    severity: row.severity as RuleDraftRecord["severity"],
    confidence: Number(row.confidence),
    reproducibility: row.reproducibility as RuleDraftRecord["reproducibility"],
    summary: String(row.summary),
    recommendedActions: parseJsonValue(row.recommended_actions, []),
    conditions: parseJsonValue(row.conditions, []),
    status: row.status as RuleDraftRecord["status"],
    validationErrors: validationErrors && validationErrors.length > 0 ? validationErrors : undefined,
    createdBy: String(row.created_by),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    traceId: row.trace_id ? String(row.trace_id) : undefined,
    schemaVersion: Number(row.schema_version),
    promotedAt: toTimestampString(row.promoted_at),
    createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
  };
}

function toRuleVersionHistoryRecord(row: JsonRow): RuleVersionHistoryEntry {
  return {
    ruleId: String(row.rule_id),
    version: Number(row.version),
    draftId: String(row.draft_id),
    promotedBy: String(row.promoted_by),
    promotedAt: toTimestampString(row.promoted_at) ?? new Date(0).toISOString(),
    changeNote: row.change_note ? String(row.change_note) : undefined
  };
}

function toModelRegistryEntryRecord(row: JsonRow): ModelRegistryEntry {
  return {
    modelId: String(row.id),
    modelKey: String(row.model_key),
    version: String(row.version),
    task: row.task as ModelRegistryEntry["task"],
    status: row.status as ModelRegistryEntry["status"],
    metrics: parseJsonValue(row.metrics, {}),
    config: parseJsonValue(row.config, {}),
    schemaVersion: Number(row.schema_version),
    createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
  };
}

function toModelEvaluationRecord(row: JsonRow): ModelEvaluationRecord {
  return {
    evaluationId: String(row.id),
    modelId: String(row.model_id),
    datasetId: String(row.dataset_id),
    metrics: parseJsonValue(row.metrics, {
      precision: 0,
      recall: 0,
      f1: 0
    }),
    sampleCount: Number(row.sample_count),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    traceId: row.trace_id ? String(row.trace_id) : undefined,
    schemaVersion: Number(row.schema_version),
    evaluatedAt: toTimestampString(row.evaluated_at) ?? new Date(0).toISOString()
  };
}

function toFeedbackSignalReportRecord(row: JsonRow): FeedbackSignalReport {
  return {
    reportId: String(row.id),
    generatedAt: toTimestampString(row.generated_at) ?? new Date(0).toISOString(),
    analysisCount: Number(row.analysis_count),
    totalFeedbackItems: Number(row.total_feedback_items),
    totalOutcomes: Number(row.total_outcomes),
    overallAcceptanceRate: Number(row.overall_acceptance_rate),
    overallValidationRate: Number(row.overall_validation_rate),
    acceptanceByKind: parseJsonValue(row.acceptance_by_kind, {}),
    confidenceAccuracy: toNumeric(row.confidence_accuracy)
  };
}

async function persistUsers(client: PoolClient, repository: InMemoryPlatformRepository) {
  for (const user of repository.users.values()) {
    await client.query(
      `INSERT INTO users (id, email, display_name, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name`,
      [user.userId, user.email, user.displayName, user.schemaVersion, user.createdAt]
    );
  }
}

async function upsertModelRegistryEntry(client: PoolClient, model: ModelRegistryEntry) {
  await client.query(
    `INSERT INTO model_registry_entries (
      id, model_key, version, task, status, metrics, config, schema_version, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
    ON CONFLICT (id) DO UPDATE SET
      model_key = EXCLUDED.model_key,
      version = EXCLUDED.version,
      task = EXCLUDED.task,
      status = EXCLUDED.status,
      metrics = EXCLUDED.metrics,
      config = EXCLUDED.config`,
    [
      model.modelId,
      model.modelKey,
      model.version,
      model.task,
      model.status,
      JSON.stringify(model.metrics),
      JSON.stringify(model.config),
      model.schemaVersion,
      model.createdAt
    ]
  );
}

async function upsertVerifiedRuleDefinition(
  client: PoolClient,
  rule: VerifiedRuleDefinition
) {
  const timestamp = new Date().toISOString();
  await client.query(
    `INSERT INTO verified_rules (
      id, rule_key, version, status, severity, confidence, reproducibility,
      definition, schema_version, updated_at, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8::jsonb, $9, $10, $11
    )
    ON CONFLICT (id) DO UPDATE SET
      rule_key = EXCLUDED.rule_key,
      version = EXCLUDED.version,
      status = EXCLUDED.status,
      severity = EXCLUDED.severity,
      confidence = EXCLUDED.confidence,
      reproducibility = EXCLUDED.reproducibility,
      definition = EXCLUDED.definition,
      updated_at = EXCLUDED.updated_at`,
    [
      rule.rule_id,
      rule.rule_id,
      rule.version,
      "active",
      rule.severity,
      rule.confidence,
      rule.reproducibility,
      JSON.stringify(rule),
      1,
      timestamp,
      timestamp
    ]
  );
}

async function upsertRuleDraftRecord(client: PoolClient, draft: RuleDraftRecord) {
  await client.query(
    `INSERT INTO rule_drafts (
      id, rule_id, version, title, finding_type, severity, confidence, reproducibility,
      summary, recommended_actions, conditions, status, validation_errors, created_by,
      tenant_id, trace_id, promoted_at, schema_version, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14,
      $15, $16, $17, $18, $19
    )
    ON CONFLICT (id) DO UPDATE SET
      rule_id = EXCLUDED.rule_id,
      version = EXCLUDED.version,
      title = EXCLUDED.title,
      finding_type = EXCLUDED.finding_type,
      severity = EXCLUDED.severity,
      confidence = EXCLUDED.confidence,
      reproducibility = EXCLUDED.reproducibility,
      summary = EXCLUDED.summary,
      recommended_actions = EXCLUDED.recommended_actions,
      conditions = EXCLUDED.conditions,
      status = EXCLUDED.status,
      validation_errors = EXCLUDED.validation_errors,
      created_by = EXCLUDED.created_by,
      tenant_id = EXCLUDED.tenant_id,
      trace_id = EXCLUDED.trace_id,
      promoted_at = EXCLUDED.promoted_at,
      schema_version = EXCLUDED.schema_version`,
    [
      draft.draftId,
      draft.ruleId,
      draft.version,
      draft.title,
      draft.findingType,
      draft.severity,
      draft.confidence,
      draft.reproducibility,
      draft.summary,
      JSON.stringify(draft.recommendedActions),
      JSON.stringify(draft.conditions),
      draft.status,
      draft.validationErrors ? JSON.stringify(draft.validationErrors) : null,
      draft.createdBy,
      draft.tenantId ?? null,
      draft.traceId ?? null,
      draft.promotedAt ?? null,
      draft.schemaVersion,
      draft.createdAt
    ]
  );
}

async function upsertModelEvaluationRecord(client: PoolClient, evaluation: ModelEvaluationRecord) {
  await client.query(
    `INSERT INTO model_evaluations (
      id, model_id, dataset_id, metrics, sample_count, tenant_id, trace_id,
      schema_version, evaluated_at, created_at
    ) VALUES (
      $1, $2, $3, $4::jsonb, $5, $6, $7,
      $8, $9, $10
    )
    ON CONFLICT (id) DO UPDATE SET
      model_id = EXCLUDED.model_id,
      dataset_id = EXCLUDED.dataset_id,
      metrics = EXCLUDED.metrics,
      sample_count = EXCLUDED.sample_count,
      tenant_id = EXCLUDED.tenant_id,
      trace_id = EXCLUDED.trace_id,
      schema_version = EXCLUDED.schema_version,
      evaluated_at = EXCLUDED.evaluated_at`,
    [
      evaluation.evaluationId,
      evaluation.modelId,
      evaluation.datasetId,
      JSON.stringify(evaluation.metrics),
      evaluation.sampleCount,
      evaluation.tenantId ?? null,
      evaluation.traceId ?? null,
      evaluation.schemaVersion,
      evaluation.evaluatedAt,
      evaluation.evaluatedAt
    ]
  );
}

async function upsertFeedbackSignalReportRecord(
  client: PoolClient,
  report: FeedbackSignalReport
) {
  await client.query(
    `INSERT INTO feedback_signal_reports (
      id, generated_at, analysis_count, total_feedback_items, total_outcomes,
      overall_acceptance_rate, overall_validation_rate, acceptance_by_kind,
      confidence_accuracy, created_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8::jsonb,
      $9, $10
    )
    ON CONFLICT (id) DO UPDATE SET
      generated_at = EXCLUDED.generated_at,
      analysis_count = EXCLUDED.analysis_count,
      total_feedback_items = EXCLUDED.total_feedback_items,
      total_outcomes = EXCLUDED.total_outcomes,
      overall_acceptance_rate = EXCLUDED.overall_acceptance_rate,
      overall_validation_rate = EXCLUDED.overall_validation_rate,
      acceptance_by_kind = EXCLUDED.acceptance_by_kind,
      confidence_accuracy = EXCLUDED.confidence_accuracy`,
    [
      report.reportId,
      report.generatedAt,
      report.analysisCount,
      report.totalFeedbackItems,
      report.totalOutcomes,
      report.overallAcceptanceRate,
      report.overallValidationRate,
      JSON.stringify(report.acceptanceByKind),
      report.confidenceAccuracy ?? null,
      report.generatedAt
    ]
  );
}

async function persistIdentityAndSnapshotPrerequisites(
  client: PoolClient,
  repository: InMemoryPlatformRepository,
  analysisSummary: AnalysisSummary
) {
  const organizationId = analysisSummary.organizationId;
  const projectId = analysisSummary.projectId;
  const workspaceId = analysisSummary.workspaceId;
  const packSnapshotId = analysisSummary.packSnapshotId;

  if (!organizationId || !packSnapshotId) {
    throw new Error(
      `Analysis ${analysisSummary.analysisId} is missing organization or snapshot references.`
    );
  }

  const organization = repository.organizations.get(organizationId);
  const workspace = repository.workspaces.get(workspaceId);
  const project = repository.projects.get(projectId);
  const snapshot = repository.snapshots.get(packSnapshotId);

  if (!organization || !workspace || !project || !snapshot) {
    throw new Error(
      `Cannot persist analysis ${analysisSummary.analysisId} because one or more prerequisite records are missing.`
    );
  }

  await persistProjectContext(client, repository, projectId);
  const persistedSnapshotId = await persistSnapshot(client, snapshot);
  await persistCatalog(client, repository);
  await persistModelRegistryEntries(client, repository);
  await persistSimulationAssets(client, repository);
  await persistNotificationAndIntegrationAssets(client, repository);
  return { persistedSnapshotId };
}

async function persistProjectContext(
  client: PoolClient,
  repository: InMemoryPlatformRepository,
  projectId: string
) {
  const project = repository.projects.get(projectId);
  if (!project) {
    throw new Error(`Project not found in memory: ${projectId}`);
  }

  const workspace = repository.workspaces.get(project.workspaceId);
  const organization = repository.organizations.get(project.organizationId);
  if (!workspace || !organization) {
    throw new Error(
      `Cannot persist project context for ${projectId} because organization or workspace is missing.`
    );
  }

  for (const user of repository.users.values()) {
    await client.query(
      `INSERT INTO users (id, email, display_name, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name`,
      [user.userId, user.email, user.displayName, user.schemaVersion, user.createdAt]
    );
  }

  await client.query(
    `INSERT INTO organizations (id, name, slug, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       slug = EXCLUDED.slug`,
    [
      organization.organizationId,
      organization.name,
      organization.slug,
      organization.schemaVersion,
      organization.createdAt
    ]
  );

  for (const membership of repository.memberships.values()) {
    await client.query(
      `INSERT INTO organization_memberships (
        organization_id, user_id, role, schema_version, created_at
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET
        role = EXCLUDED.role`,
      [
        membership.organizationId,
        membership.userId,
        membership.role,
        membership.schemaVersion,
        membership.createdAt
      ]
    );
  }

  await client.query(
    `INSERT INTO workspaces (
      id, organization_id, tenant_id, name, slug, schema_version, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      slug = EXCLUDED.slug`,
    [
      workspace.workspaceId,
      workspace.organizationId,
      workspace.tenantId,
      workspace.name,
      workspace.slug,
      workspace.schemaVersion,
      workspace.createdAt
    ]
  );

  await client.query(
    `INSERT INTO projects (
      id, workspace_id, organization_id, tenant_id, name, slug, visibility, schema_version, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      visibility = EXCLUDED.visibility`,
    [
      project.projectId,
      project.workspaceId,
      project.organizationId,
      project.tenantId,
      project.name,
      project.slug,
      project.visibility,
      project.schemaVersion,
      project.createdAt
    ]
  );
}

async function persistSnapshot(client: PoolClient, snapshot: PackSnapshot) {
  const existingSnapshotResult = await client.query<{ id: string }>(
    `SELECT id
     FROM pack_snapshots
     WHERE project_id = $1 AND normalized_hash = $2
     LIMIT 1`,
    [snapshot.projectId, snapshot.normalizedHash]
  );

  const persistedSnapshotId =
    existingSnapshotResult.rows[0]?.id ?? snapshot.packSnapshotId;
  const environmentProfileId = `env_${persistedSnapshotId}`;

  await client.query(
    `INSERT INTO pack_environment_profiles (
      id, project_id, organization_id, tenant_id, minecraft_version, loader,
      loader_version, java_version, side, schema_version, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO UPDATE SET
      minecraft_version = EXCLUDED.minecraft_version,
      loader = EXCLUDED.loader,
      loader_version = EXCLUDED.loader_version,
      java_version = EXCLUDED.java_version,
      side = EXCLUDED.side`,
    [
      environmentProfileId,
      snapshot.projectId,
      snapshot.organizationId,
      snapshot.tenantId,
      snapshot.environment.minecraftVersion,
      snapshot.environment.loader,
      snapshot.environment.loaderVersion ?? null,
      snapshot.environment.javaVersion,
      snapshot.environment.side,
      snapshot.schemaVersion,
      snapshot.createdAt
    ]
  );

  const snapshotInsert = await client.query<{ id: string }>(
    `INSERT INTO pack_snapshots (
      id, project_id, organization_id, tenant_id, source_type, source_ref, normalized_hash,
      environment_profile_id, source_payload_uri, provenance, schema_version, created_by, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10::jsonb, $11, $12, $13
    )
    ON CONFLICT (project_id, normalized_hash) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      tenant_id = EXCLUDED.tenant_id,
      source_type = EXCLUDED.source_type,
      source_ref = EXCLUDED.source_ref,
      environment_profile_id = EXCLUDED.environment_profile_id,
      source_payload_uri = EXCLUDED.source_payload_uri,
      created_by = EXCLUDED.created_by
    RETURNING id`,
    [
      persistedSnapshotId,
      snapshot.projectId,
      snapshot.organizationId,
      snapshot.tenantId,
      snapshot.sourceType,
      snapshot.sourceRef ?? null,
      snapshot.normalizedHash,
      environmentProfileId,
      snapshot.sourcePayloadUri ?? null,
      JSON.stringify({ persistedBy: "phase7-postgres-adapter" }),
      snapshot.schemaVersion,
      snapshot.createdBy ?? null,
      snapshot.createdAt
    ]
  );

  const effectiveSnapshotId =
    snapshotInsert.rows[0]?.id ?? persistedSnapshotId;

  await client.query("DELETE FROM pack_snapshot_mods WHERE pack_snapshot_id = $1", [
    effectiveSnapshotId
  ]);

  for (const [index, mod] of snapshot.mods.entries()) {
    await client.query(
      `INSERT INTO pack_snapshot_mods (
        id, pack_snapshot_id, canonical_project_id, canonical_version_id, declared_name,
        declared_version, source_name, schema_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        `${effectiveSnapshotId}:mod:${index}`,
        effectiveSnapshotId,
        mod.canonicalProjectId ?? null,
        mod.canonicalVersionId ?? null,
        mod.name,
        mod.version ?? null,
        mod.source ?? null,
        snapshot.schemaVersion,
        snapshot.createdAt
      ]
    );
  }

  return effectiveSnapshotId;
}

async function resolvePersistedSnapshotId(
  client: PoolClient,
  repository: InMemoryPlatformRepository,
  packSnapshotId?: string
) {
  if (!packSnapshotId) {
    return undefined;
  }

  const snapshot = repository.snapshots.get(packSnapshotId);
  if (!snapshot) {
    return packSnapshotId;
  }

  return persistSnapshot(client, snapshot);
}

async function persistProjectImports(
  client: PoolClient,
  repository: InMemoryPlatformRepository,
  projectId: string,
  workspaceId: string
) {
  const imports = [...repository.imports.values()].filter(
    (record) => record.projectId === projectId
  );

  for (const importRecord of imports) {
    const persistedSnapshotId = await resolvePersistedSnapshotId(
      client,
      repository,
      importRecord.packSnapshotId
    );

    await client.query(
      `INSERT INTO pack_imports (
        id, project_id, workspace_id, organization_id, tenant_id, source_type, source_ref,
        status, environment, pack_snapshot_id, schema_version, created_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9::jsonb, $10, $11, $12, $13
      )
      ON CONFLICT (id) DO UPDATE SET
        source_type = EXCLUDED.source_type,
        source_ref = EXCLUDED.source_ref,
        status = EXCLUDED.status,
        environment = EXCLUDED.environment,
        pack_snapshot_id = EXCLUDED.pack_snapshot_id,
        completed_at = EXCLUDED.completed_at`,
      [
        importRecord.importId,
        importRecord.projectId,
        workspaceId,
        importRecord.organizationId,
        importRecord.tenantId,
        importRecord.sourceType,
        importRecord.sourceRef ?? null,
        importRecord.status,
        JSON.stringify(importRecord.environment ?? null),
        persistedSnapshotId ?? null,
        importRecord.schemaVersion,
        importRecord.createdAt,
        importRecord.completedAt ?? null
      ]
    );
  }
}

async function persistPackDiff(
  client: PoolClient,
  repository: InMemoryPlatformRepository,
  packDiff: PackDiff
) {
  const project = repository.projects.get(packDiff.projectId);
  if (!project) {
    throw new Error(`Project not found for pack diff persistence: ${packDiff.projectId}`);
  }

  await client.query(
    `INSERT INTO pack_diffs (
      id, project_id, organization_id, tenant_id, base_snapshot_id, target_snapshot_id,
      baseline_analysis_id, target_analysis_id, summary, schema_version, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9::jsonb, $10, $11
    )
    ON CONFLICT (id) DO UPDATE SET
      base_snapshot_id = EXCLUDED.base_snapshot_id,
      target_snapshot_id = EXCLUDED.target_snapshot_id,
      baseline_analysis_id = EXCLUDED.baseline_analysis_id,
      target_analysis_id = EXCLUDED.target_analysis_id,
      summary = EXCLUDED.summary`,
    [
      packDiff.packDiffId,
      packDiff.projectId,
      project.organizationId,
      packDiff.tenantId ?? project.organizationId,
      packDiff.baseSnapshotId,
      packDiff.targetSnapshotId,
      packDiff.baselineAnalysisId ?? null,
      packDiff.targetAnalysisId ?? null,
      JSON.stringify(packDiff.summary),
      packDiff.schemaVersion,
      packDiff.createdAt
    ]
  );

  await client.query("DELETE FROM pack_diff_changes WHERE pack_diff_id = $1", [
    packDiff.packDiffId
  ]);

  for (const [index, change] of packDiff.changes.entries()) {
    await client.query(
      `INSERT INTO pack_diff_changes (
        id, pack_diff_id, change_type, canonical_project_id, before_value, after_value,
        summary, schema_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        `${packDiff.packDiffId}:chg:${index}`,
        packDiff.packDiffId,
        change.changeType,
        change.projectId ?? null,
        change.before ?? null,
        change.after ?? null,
        change.summary,
        packDiff.schemaVersion,
        packDiff.createdAt
      ]
    );
  }
}

async function persistModelRegistryEntries(
  client: PoolClient,
  repository: InMemoryPlatformRepository
) {
  for (const model of repository.modelRegistry.values()) {
    await upsertModelRegistryEntry(client, model);
  }
}

async function persistCatalog(
  client: PoolClient,
  repository: InMemoryPlatformRepository
) {
  for (const project of repository.canonicalProjects.values()) {
    await client.query(
      `INSERT INTO canonical_projects (
        id, slug, display_name, project_type, schema_version, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        slug = EXCLUDED.slug,
        display_name = EXCLUDED.display_name,
        updated_at = EXCLUDED.updated_at`,
      [
        project.projectId,
        project.slug,
        project.displayName,
        "mod",
        1,
        new Date(0).toISOString(),
        new Date().toISOString()
      ]
    );

    for (const [index, alias] of project.aliases.entries()) {
      await client.query(
        `INSERT INTO project_aliases (
          canonical_project_id, alias, alias_type, schema_version, created_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (canonical_project_id, alias, alias_type) DO NOTHING`,
        [project.projectId, alias, index === 0 ? "slug" : "alias", 1, new Date(0).toISOString()]
      );
    }
  }

    for (const version of repository.canonicalVersions.values()) {
      await client.query(
        `INSERT INTO canonical_versions (
          id, canonical_project_id, version_label, minecraft_versions, loaders,
        java_versions, schema_version, created_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        version_label = EXCLUDED.version_label,
        minecraft_versions = EXCLUDED.minecraft_versions,
        loaders = EXCLUDED.loaders,
        java_versions = EXCLUDED.java_versions`,
      [
        version.versionId,
        version.projectId,
        version.versionLabel,
        JSON.stringify(version.minecraftVersions),
        JSON.stringify(version.loaders),
        JSON.stringify(version.javaVersions),
        1,
        new Date(0).toISOString()
      ]
    );

    if (version.primaryFileDownloadUrl) {
      await client.query(
        `INSERT INTO version_files (
          id, canonical_version_id, artifact_url, schema_version, created_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          artifact_url = EXCLUDED.artifact_url`,
        [
          `${version.versionId}:primary`,
          version.versionId,
          version.primaryFileDownloadUrl,
          1,
          new Date(0).toISOString()
        ]
      );
    }
  }

  for (const mapping of repository.sourceMappings.values()) {
    await client.query(
      `INSERT INTO project_source_mappings (
        canonical_project_id, source_name, source_project_id, confidence,
        resolution_method, is_verified, schema_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (source_name, source_project_id) DO UPDATE SET
        canonical_project_id = EXCLUDED.canonical_project_id,
        confidence = EXCLUDED.confidence,
        resolution_method = EXCLUDED.resolution_method,
        is_verified = EXCLUDED.is_verified`,
      [
        mapping.canonicalProjectId,
        mapping.sourceName,
        mapping.sourceProjectId,
        1,
        "seeded_mapping",
        true,
        1,
        new Date(0).toISOString()
      ]
    );
  }

  for (const dependency of repository.dependencies) {
    await client.query(
      `INSERT INTO declared_dependencies (
        canonical_version_id, dependency_project_id, relation_type, schema_version, created_at
      ) SELECT $1, $2, $3, $4, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM declared_dependencies
        WHERE canonical_version_id = $1
          AND dependency_project_id = $2
          AND relation_type = $3
      )`,
      [
        dependency.versionId,
        dependency.dependencyProjectId,
        dependency.relationType,
        1,
        new Date(0).toISOString()
      ]
    );
  }

  for (const incompatibility of repository.incompatibilities) {
    await client.query(
      `INSERT INTO declared_incompatibilities (
        canonical_version_id, incompatible_project_id, reason, schema_version, created_at
      ) SELECT $1, $2, $3, $4, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM declared_incompatibilities
        WHERE canonical_version_id = $1
          AND incompatible_project_id = $2
      )`,
      [
        incompatibility.versionId,
        incompatibility.incompatibleProjectId,
        incompatibility.reason,
        1,
        new Date(0).toISOString()
      ]
    );
  }
}

async function persistSimulationAssets(
  client: PoolClient,
  repository: InMemoryPlatformRepository
) {
  for (const recipe of repository.smokeTestRecipes.values()) {
    await client.query(
      `INSERT INTO smoke_test_recipes (
        id, recipe_key, title, steps, success_criteria, schema_version, created_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        steps = EXCLUDED.steps,
        success_criteria = EXCLUDED.success_criteria`,
      [
        recipe.recipeId,
        recipe.recipeKey,
        recipe.title,
        JSON.stringify(recipe.steps),
        JSON.stringify(recipe.successCriteria),
        recipe.schemaVersion,
        recipe.createdAt
      ]
    );
  }

  for (const signature of repository.crashSignatures.values()) {
    await client.query(
      `INSERT INTO crash_signatures (
        id, signature_key, headline, pattern, related_finding_types, schema_version, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        headline = EXCLUDED.headline,
        pattern = EXCLUDED.pattern,
        related_finding_types = EXCLUDED.related_finding_types`,
      [
        signature.crashSignatureId,
        signature.signatureKey,
        signature.headline,
        signature.pattern,
        JSON.stringify(signature.relatedFindingTypes),
        signature.schemaVersion,
        signature.createdAt
      ]
    );
  }
}

async function persistNotificationAndIntegrationAssets(
  client: PoolClient,
  repository: InMemoryPlatformRepository
) {
  for (const webhook of repository.webhookRegistrations.values()) {
    await client.query(
      `INSERT INTO webhook_registrations (
        id, target_url, event_types, status, secret_hint, schema_version, created_at
      ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        target_url = EXCLUDED.target_url,
        event_types = EXCLUDED.event_types,
        status = EXCLUDED.status,
        secret_hint = EXCLUDED.secret_hint`,
      [
        webhook.webhookId,
        webhook.targetUrl,
        JSON.stringify(webhook.eventTypes),
        webhook.status,
        webhook.secretHint ?? null,
        webhook.schemaVersion,
        webhook.createdAt
      ]
    );
  }

  for (const link of repository.githubInstallationLinks.values()) {
    await client.query(
      `INSERT INTO github_installation_links (
        id, installation_id, project_id, repository_full_name, status, schema_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (installation_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        repository_full_name = EXCLUDED.repository_full_name,
        status = EXCLUDED.status`,
      [
        link.installationLinkId,
        link.installationId,
        link.projectId,
        link.repositoryFullName,
        link.status,
        link.schemaVersion,
        link.createdAt
      ]
    );
  }
}

export class PostgresPlatformPersistence {
  private readonly connectionString?: string;
  private pool?: Pool;
  private schemaReady = false;

  constructor(private readonly repository: InMemoryPlatformRepository) {
    this.connectionString = process.env.POSTGRES_URL;
  }

  isEnabled(): boolean {
    return Boolean(this.connectionString);
  }

  getStatus() {
    return {
      enabled: this.isEnabled(),
      connectionStringConfigured: Boolean(this.connectionString)
    };
  }

  async ensureSchema() {
    if (!this.isEnabled()) {
      return false;
    }

    if (this.schemaReady) {
      return true;
    }

    const pool = this.getPool();
    const existingSchema = await pool.query(
      "SELECT to_regclass('public.organizations') AS organizations_table"
    );
    if (existingSchema.rows[0]?.organizations_table) {
      await ensureKnowledgeSnapshotTables(pool);
      await ensurePhase8Tables(pool);
      await ensureGroundTruthTables(pool);
      await ensureOfflinePipelineTables(pool);
      this.schemaReady = true;
      return true;
    }

    const schemaPath = sqlRootPath();
    if (!existsSync(schemaPath)) {
      throw new Error(`Postgres schema not found at ${schemaPath}`);
    }

    const sql = readFileSync(schemaPath, "utf8");
    await pool.query(sql);
    await ensureKnowledgeSnapshotTables(pool);
    await ensurePhase8Tables(pool);
    await ensureGroundTruthTables(pool);
    await ensureOfflinePipelineTables(pool);
    this.schemaReady = true;
    return true;
  }

  async readModInspectionRecords(): Promise<ModInspectionRecord[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM mod_inspection_records
       ORDER BY last_inspected_at ASC`
    );

    return result.rows.map((row) => ({
      versionId: String(row.version_id),
      projectId: String(row.project_id),
      lastInspectedAt: toTimestampString(row.last_inspected_at) ?? new Date(0).toISOString(),
      inspectionCount: Number(row.inspection_count),
      inspectionStatus: row.inspection_status as ModInspectionRecord["inspectionStatus"],
      lastErrorMessage: row.last_error_message ? String(row.last_error_message) : undefined
    }));
  }

  async persistModInspectionRecord(record: ModInspectionRecord) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO mod_inspection_records (
        version_id, project_id, last_inspected_at, inspection_count, inspection_status,
        last_error_message, schema_version, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 1, now())
      ON CONFLICT (version_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        last_inspected_at = EXCLUDED.last_inspected_at,
        inspection_count = EXCLUDED.inspection_count,
        inspection_status = EXCLUDED.inspection_status,
        last_error_message = EXCLUDED.last_error_message,
        updated_at = now()`,
      [
        record.versionId,
        record.projectId,
        record.lastInspectedAt,
        record.inspectionCount,
        record.inspectionStatus,
        record.lastErrorMessage ?? null
      ]
    );

    return { persisted: true };
  }

  async hydrateJarArtifactProfiles(versionIds?: string[]) {
    if (!this.isEnabled()) {
      return { hydrated: 0 };
    }

    await this.ensureSchema();
    const params: unknown[] = [];
    const filter = versionIds?.length ? "WHERE version_id = ANY($1::text[])" : "";
    if (versionIds?.length) params.push(versionIds);

    const result = await this.getPool().query(
      `SELECT *
       FROM jar_artifact_profiles
       ${filter}
       ORDER BY updated_at ASC`,
      params
    );

    let hydrated = 0;
    for (const row of result.rows) {
      const profile: ArtifactProfileRecord = {
        artifactId: String(row.artifact_id),
        versionId: String(row.version_id),
        mixinConfigFiles: parseJsonValue<string[]>(row.mixin_config_files, []),
        mixinTargets: parseJsonValue<string[]>(row.mixin_targets, []),
        classTargets: parseJsonValue<string[]>(row.class_targets, []),
        resourceTargets: parseJsonValue<string[]>(row.resource_targets, []),
        embeddedLibraries: parseJsonValue<ArtifactProfileRecord["embeddedLibraries"]>(
          row.embedded_libraries,
          []
        ),
        packageNamespaces: parseJsonValue<string[]>(row.package_namespaces, []),
        accessWidenerTargets: parseJsonValue<string[]>(row.access_widener_targets, []),
        accessTransformerTargets: parseJsonValue<string[]>(row.access_transformer_targets, []),
        refmapTargets: parseJsonValue<string[]>(row.refmap_targets, [])
      };
      this.repository.artifactProfiles.set(profile.versionId, profile);
      hydrated++;
    }

    return { hydrated };
  }

  async persistJarArtifactProfile(versionId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const profile = this.repository.artifactProfiles.get(versionId);
    const version = this.repository.canonicalVersions.get(versionId);
    if (!profile || !version) {
      return { persisted: false, reason: `Artifact profile or version missing for ${versionId}.` };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO jar_artifact_profiles (
        version_id, project_id, artifact_id, mixin_config_files, mixin_targets, class_targets,
        resource_targets, embedded_libraries, package_namespaces, access_widener_targets,
        access_transformer_targets, refmap_targets, schema_version, updated_at
      ) VALUES (
        $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
        $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
        $11::jsonb, $12::jsonb, 1, now()
      )
      ON CONFLICT (version_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        artifact_id = EXCLUDED.artifact_id,
        mixin_config_files = EXCLUDED.mixin_config_files,
        mixin_targets = EXCLUDED.mixin_targets,
        class_targets = EXCLUDED.class_targets,
        resource_targets = EXCLUDED.resource_targets,
        embedded_libraries = EXCLUDED.embedded_libraries,
        package_namespaces = EXCLUDED.package_namespaces,
        access_widener_targets = EXCLUDED.access_widener_targets,
        access_transformer_targets = EXCLUDED.access_transformer_targets,
        refmap_targets = EXCLUDED.refmap_targets,
        updated_at = now()`,
      [
        profile.versionId,
        version.projectId,
        profile.artifactId,
        JSON.stringify(profile.mixinConfigFiles),
        JSON.stringify(profile.mixinTargets),
        JSON.stringify(profile.classTargets),
        JSON.stringify(profile.resourceTargets),
        JSON.stringify(profile.embeddedLibraries),
        JSON.stringify(profile.packageNamespaces ?? []),
        JSON.stringify(profile.accessWidenerTargets ?? []),
        JSON.stringify(profile.accessTransformerTargets ?? []),
        JSON.stringify(profile.refmapTargets ?? [])
      ]
    );

    return { persisted: true };
  }

  async persistImportsForProject(projectId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const project = this.repository.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found in memory: ${projectId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await persistProjectContext(client, this.repository, projectId);
      await persistProjectImports(client, this.repository, projectId, project.workspaceId);
      await persistCatalog(client, this.repository);
      await persistModelRegistryEntries(client, this.repository);
      await persistSimulationAssets(client, this.repository);
      await persistNotificationAndIntegrationAssets(client, this.repository);
      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolvePersistedSnapshotId(packSnapshotId?: string) {
    if (!this.isEnabled()) {
      return packSnapshotId;
    }

    if (!packSnapshotId) {
      return undefined;
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      return await resolvePersistedSnapshotId(client, this.repository, packSnapshotId);
    } finally {
      client.release();
    }
  }

  async persistPackSnapshot(packSnapshotId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const snapshot = this.repository.snapshots.get(packSnapshotId);
    if (!snapshot) {
      throw new Error(`Pack snapshot not found in memory: ${packSnapshotId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await persistProjectContext(client, this.repository, snapshot.projectId);
      await persistCatalog(client, this.repository);
      const persistedSnapshotId = await persistSnapshot(client, snapshot);
      await client.query("COMMIT");
      return { persisted: true, packSnapshotId: persistedSnapshotId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistCoverageScope(coverageScopeId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const coverageScope = this.repository.coverageScopes.get(coverageScopeId);
    if (!coverageScope) {
      throw new Error(`Coverage scope not found in memory: ${coverageScopeId}`);
    }

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO coverage_scopes (
        id, snapshot_version, status, supported_minecraft_versions, supported_loaders,
        supported_project_ids, version_freshness_window_days, notes, schema_version, created_at
      ) VALUES (
        $1, $2, $3, $4::jsonb, $5::jsonb,
        $6::jsonb, $7, $8, $9, $10
      )
      ON CONFLICT (id) DO UPDATE SET
        snapshot_version = EXCLUDED.snapshot_version,
        status = EXCLUDED.status,
        supported_minecraft_versions = EXCLUDED.supported_minecraft_versions,
        supported_loaders = EXCLUDED.supported_loaders,
        supported_project_ids = EXCLUDED.supported_project_ids,
        version_freshness_window_days = EXCLUDED.version_freshness_window_days,
        notes = EXCLUDED.notes,
        schema_version = EXCLUDED.schema_version`,
      [
        coverageScope.coverageScopeId,
        coverageScope.snapshotVersion,
        coverageScope.status,
        JSON.stringify(coverageScope.supportedMinecraftVersions),
        JSON.stringify(coverageScope.supportedLoaders),
        JSON.stringify(coverageScope.supportedProjectIds),
        coverageScope.versionFreshnessWindowDays,
        coverageScope.notes ?? null,
        coverageScope.schemaVersion,
        coverageScope.createdAt
      ]
    );

    return { persisted: true };
  }

  async persistSnapshotValidationReport(snapshotId: string, validationReportId: string) {
    if (!this.isEnabled()) {
      return;
    }

    const snapshot = this.repository.knowledgeSnapshots.get(snapshotId);
    if (!snapshot) return;

    const validationReport = this.repository.snapshotValidationReports.get(validationReportId);
    if (!validationReport) return;

    const reportSummary =
      validationReport.checks.map((check) => `${check.code}:${check.status}`).join("; ") || null;

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO snapshot_validation_reports (id, snapshot_id, status, summary, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        validationReportId,
        snapshotId,
        validationReport.status,
        reportSummary,
        validationReport.schemaVersion,
        validationReport.createdAt
      ]
    );
  }

  async persistKnowledgeSnapshot(snapshotId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const snapshot = this.repository.knowledgeSnapshots.get(snapshotId);
    if (!snapshot) {
      throw new Error(`Knowledge snapshot not found in memory: ${snapshotId}`);
    }

    if (snapshot.coverageScopeId) {
      await this.persistCoverageScope(snapshot.coverageScopeId);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await persistUsers(client, this.repository);
      await client.query(
        `INSERT INTO knowledge_snapshots (
          id, version, status, coverage_scope_id, validation_report_id, activated_at,
          created_by, schema_version, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9
        )
        ON CONFLICT (id) DO UPDATE SET
          version = EXCLUDED.version,
          status = EXCLUDED.status,
          coverage_scope_id = EXCLUDED.coverage_scope_id,
          validation_report_id = EXCLUDED.validation_report_id,
          activated_at = EXCLUDED.activated_at,
          created_by = EXCLUDED.created_by,
          schema_version = EXCLUDED.schema_version`,
        [
          snapshot.snapshotId,
          snapshot.version,
          snapshot.status,
          snapshot.coverageScopeId ?? null,
          snapshot.validationReportId ?? null,
          snapshot.activatedAt ?? null,
          snapshot.createdBy ?? null,
          snapshot.schemaVersion,
          snapshot.createdAt
        ]
      );

      await client.query(
        `DELETE FROM knowledge_snapshot_components
         WHERE snapshot_id = $1`,
        [snapshot.snapshotId]
      );

      if (snapshot.components.length > 0) {
        const componentRows = snapshot.components.map((component) => ({
          id: createPlatformId("ksc"),
          component_type: component.componentType,
          record_count: component.recordCount,
          checksum: component.checksum,
          schema_version: 1,
          created_at: snapshot.createdAt
        }));

        await client.query(
          `INSERT INTO knowledge_snapshot_components (
            id, snapshot_id, component_type, record_count, checksum, schema_version, created_at
          )
          SELECT
            component.id,
            $1,
            component.component_type,
            component.record_count,
            component.checksum,
            component.schema_version,
            component.created_at
          FROM jsonb_to_recordset($2::jsonb) AS component(
            id text,
            component_type text,
            record_count integer,
            checksum text,
            schema_version integer,
            created_at timestamptz
          )`,
          [snapshot.snapshotId, JSON.stringify(componentRows)]
        );
      }

      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistCatalogState() {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await persistCatalog(client, this.repository);
      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resetOfflinePipelineState(options?: {
    deleteOfflineSnapshots?: boolean;
    deleteCatalogProjectPrefixes?: string[];
  }) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const deleteOfflineSnapshots = options?.deleteOfflineSnapshots !== false;
    const deleteCatalogProjectPrefixes = options?.deleteCatalogProjectPrefixes ?? [];

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");

      let deletedSnapshots = 0;
      if (deleteOfflineSnapshots) {
        const snapshotRows = await client.query(
          `SELECT id
           FROM knowledge_snapshots
           WHERE version LIKE 'offline-pipeline-%'`
        );
        const snapshotIds = snapshotRows.rows.map((row) => String((row as JsonRow).id));

        if (snapshotIds.length > 0) {
          await client.query(
            `DELETE FROM promoted_claim_evidence_refs
             WHERE promoted_claim_id IN (
               SELECT id
               FROM promoted_compatibility_claims
               WHERE snapshot_id = ANY($1::text[])
             )`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM technical_conflict_signature_evidence_refs
             WHERE technical_conflict_signature_id IN (
               SELECT id
               FROM technical_conflict_signatures
               WHERE snapshot_id = ANY($1::text[])
             )`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM exact_pack_analysis_cache
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM pack_benchmark_results
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM pairwise_compatibility_records
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM fragment_compatibility_records
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM technical_conflict_signatures
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM promoted_compatibility_claims
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM snapshot_promotion_events
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `UPDATE knowledge_snapshots
             SET validation_report_id = NULL
             WHERE id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM snapshot_validation_checks
             WHERE validation_report_id IN (
               SELECT id
               FROM snapshot_validation_reports
               WHERE snapshot_id = ANY($1::text[])
             )`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM snapshot_validation_reports
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM knowledge_snapshot_components
             WHERE snapshot_id = ANY($1::text[])`,
            [snapshotIds]
          );
          await client.query(
            `DELETE FROM knowledge_snapshots
             WHERE id = ANY($1::text[])`,
            [snapshotIds]
          );
          deletedSnapshots = snapshotIds.length;
        }
      }

      let deletedProjects = 0;
      let deletedVersions = 0;
      if (deleteCatalogProjectPrefixes.length > 0) {
        const projectIds: string[] = [];
        for (const prefix of deleteCatalogProjectPrefixes) {
          const projectRows = await client.query(
            `SELECT id
             FROM canonical_projects
             WHERE id LIKE $1`,
            [`${prefix}%`]
          );
          for (const row of projectRows.rows as JsonRow[]) {
            projectIds.push(String(row.id));
          }
        }

        const uniqueProjectIds = [...new Set(projectIds)];
        if (uniqueProjectIds.length > 0) {
          const versionRows = await client.query(
            `SELECT id
             FROM canonical_versions
             WHERE canonical_project_id = ANY($1::text[])`,
            [uniqueProjectIds]
          );
          const versionIds = versionRows.rows.map((row) => String((row as JsonRow).id));

          if (versionIds.length > 0) {
            await client.query(
              `DELETE FROM version_files
               WHERE canonical_version_id = ANY($1::text[])`,
              [versionIds]
            );
            await client.query(
              `DELETE FROM declared_dependencies
               WHERE canonical_version_id = ANY($1::text[])
                  OR dependency_project_id = ANY($2::text[])`,
              [versionIds, uniqueProjectIds]
            );
            await client.query(
              `DELETE FROM declared_incompatibilities
               WHERE canonical_version_id = ANY($1::text[])
                  OR incompatible_project_id = ANY($2::text[])`,
              [versionIds, uniqueProjectIds]
            );
            await client.query(
              `DELETE FROM canonical_versions
               WHERE id = ANY($1::text[])`,
              [versionIds]
            );
            deletedVersions = versionIds.length;
          }

          await client.query(
            `DELETE FROM project_source_mappings
             WHERE canonical_project_id = ANY($1::text[])`,
            [uniqueProjectIds]
          );
          await client.query(
            `DELETE FROM project_aliases
             WHERE canonical_project_id = ANY($1::text[])`,
            [uniqueProjectIds]
          );
          await client.query(
            `DELETE FROM canonical_projects
             WHERE id = ANY($1::text[])`,
            [uniqueProjectIds]
          );
          deletedProjects = uniqueProjectIds.length;
        }
      }

      await client.query("COMMIT");
      return {
        persisted: true,
        deletedSnapshots,
        deletedProjects,
        deletedVersions
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async hydrateCatalogState() {
    if (!this.isEnabled()) {
      return {
        projects: [],
        versions: [],
        sourceMappings: [],
        dependencies: [],
        incompatibilities: []
      };
    }

    await this.ensureSchema();
    const [
      projectsResult,
      aliasesResult,
      versionsResult,
      versionFilesResult,
      mappingsResult,
      depsResult,
      incompatResult
    ] =
      await Promise.all([
        this.getPool().query(`SELECT * FROM canonical_projects ORDER BY created_at ASC`),
        this.getPool().query(`SELECT * FROM project_aliases ORDER BY created_at ASC`),
        this.getPool().query(`SELECT * FROM canonical_versions ORDER BY created_at ASC`),
        this.getPool().query(`SELECT * FROM version_files ORDER BY created_at ASC`),
        this.getPool().query(`SELECT * FROM project_source_mappings ORDER BY created_at ASC`),
        this.getPool().query(`SELECT * FROM declared_dependencies ORDER BY created_at ASC`),
        this.getPool().query(`SELECT * FROM declared_incompatibilities ORDER BY created_at ASC`)
      ]);

    const aliasesByProjectId = new Map<string, string[]>();
    for (const row of aliasesResult.rows as JsonRow[]) {
      const projectId = String(row.canonical_project_id);
      const aliases = aliasesByProjectId.get(projectId) ?? [];
      aliases.push(String(row.alias));
      aliasesByProjectId.set(projectId, aliases);
    }

    const primaryFileUrlByVersionId = new Map<string, string>();
    for (const row of versionFilesResult.rows as JsonRow[]) {
      if (row.artifact_url) {
        primaryFileUrlByVersionId.set(String(row.canonical_version_id), String(row.artifact_url));
      }
    }

    const projects = (projectsResult.rows as JsonRow[]).map((row) => ({
      projectId: String(row.id),
      slug: String(row.slug),
      displayName: String(row.display_name),
      aliases: aliasesByProjectId.get(String(row.id)) ?? [String(row.slug)]
    }));
    this.repository.canonicalProjects.clear();
    for (const project of projects) {
      this.repository.canonicalProjects.set(project.projectId, project);
    }

    const versions = (versionsResult.rows as JsonRow[]).map((row) => ({
      versionId: String(row.id),
      projectId: String(row.canonical_project_id),
      versionLabel: String(row.version_label),
      loaders: parseJsonValue(row.loaders, [] as string[]),
      minecraftVersions: parseJsonValue(row.minecraft_versions, [] as string[]),
      javaVersions: parseJsonValue(row.java_versions, [] as string[]),
      primaryFileDownloadUrl: primaryFileUrlByVersionId.get(String(row.id)),
      releaseDate: toTimestampString(row.published_at)
    }));
    this.repository.canonicalVersions.clear();
    for (const version of versions) {
      this.repository.canonicalVersions.set(version.versionId, version);
    }

    const sourceMappings = (mappingsResult.rows as JsonRow[]).map((row) => ({
      sourceName: String(row.source_name),
      sourceProjectId: String(row.source_project_id),
      canonicalProjectId: String(row.canonical_project_id),
      canonicalVersionId: undefined as string | undefined
    }));
    this.repository.sourceMappings.clear();
    for (const mapping of sourceMappings) {
      this.repository.sourceMappings.set(
        `${mapping.sourceName}:${mapping.sourceProjectId}`,
        mapping
      );
    }

    const dependencies = (depsResult.rows as JsonRow[]).map((row) => ({
      versionId: String(row.canonical_version_id),
      dependencyProjectId: String(row.dependency_project_id),
      relationType: String(row.relation_type) as import("./types.js").DependencyRelation
    }));
    this.repository.dependencies.splice(0, this.repository.dependencies.length, ...dependencies);

    const incompatibilities = (incompatResult.rows as JsonRow[]).map((row) => ({
      versionId: String(row.canonical_version_id),
      incompatibleProjectId: String(row.incompatible_project_id),
      reason: String(row.reason)
    }));
    this.repository.incompatibilities.splice(
      0,
      this.repository.incompatibilities.length,
      ...incompatibilities
    );

    return { projects, versions, sourceMappings, dependencies, incompatibilities };
  }

  async persistEvidenceState(syncRunId?: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");

      const connectors = [...this.repository.sourceConnectors.values()];
      for (const connector of connectors) {
        await client.query(
          `INSERT INTO source_connectors (
            id, connector_name, status, config, schema_version, updated_at, created_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            connector_name = EXCLUDED.connector_name,
            status = EXCLUDED.status,
            config = EXCLUDED.config,
            schema_version = EXCLUDED.schema_version,
            updated_at = EXCLUDED.updated_at`,
          [
            connector.connectorId,
            connector.connectorName,
            connector.status,
            JSON.stringify({
              sourceType: connector.sourceType,
              trustTier: connector.trustTier,
              lastSyncAt: connector.lastSyncAt
            }),
            connector.schemaVersion,
            connector.updatedAt,
            connector.createdAt
          ]
        );
      }

      const runs = [...this.repository.sourceSyncRuns.values()].filter(
        (run) => !syncRunId || run.syncRunId === syncRunId
      );
      for (const run of runs) {
        await client.query(
          `INSERT INTO source_sync_runs (
            id, connector_id, status, started_at, finished_at, checkpoint, stats, schema_version, trace_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            checkpoint = EXCLUDED.checkpoint,
            stats = EXCLUDED.stats,
            schema_version = EXCLUDED.schema_version,
            trace_id = EXCLUDED.trace_id`,
          [
            run.syncRunId,
            run.connectorId,
            run.status,
            run.startedAt,
            run.finishedAt ?? null,
            JSON.stringify(run.checkpoint ?? null),
            JSON.stringify(run.stats),
            run.schemaVersion,
            run.traceId ?? null,
            run.createdAt
          ]
        );
      }

      const rawPayloads = [...this.repository.rawPayloads.values()].filter(
        (payload) => !syncRunId || payload.syncRunId === syncRunId
      );
      for (const payload of rawPayloads) {
        await client.query(
          `INSERT INTO source_raw_payloads (
            id, connector_id, sync_run_id, external_document_ref, content_type, checksum, payload,
            fetched_at, schema_version, trace_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
          ON CONFLICT (id) DO UPDATE SET
            content_type = EXCLUDED.content_type,
            checksum = EXCLUDED.checksum,
            payload = EXCLUDED.payload,
            fetched_at = EXCLUDED.fetched_at,
            schema_version = EXCLUDED.schema_version,
            trace_id = EXCLUDED.trace_id`,
          [
            payload.rawPayloadId,
            payload.connectorId,
            payload.syncRunId,
            payload.externalDocumentId,
            payload.contentType,
            payload.checksum,
            JSON.stringify(payload.body),
            payload.fetchedAt,
            payload.schemaVersion,
            payload.traceId ?? null,
            payload.createdAt
          ]
        );
      }

      const documents = [...this.repository.evidenceDocuments.values()].filter(
        (document) => !syncRunId || document.syncRunId === syncRunId
      );
      for (const document of documents) {
        await client.query(
          `INSERT INTO evidence_documents (
            id, source_connector_id, sync_run_id, raw_payload_id, source_document_ref, title, source_url,
            trust_tier, trust_score, relevance, stance, recency_score, published_at, raw_payload_uri,
            normalized_payload, related_project_ids, related_version_ids, finding_types, extracted_entities,
            extracted_relations, cluster_id, duplicate_document_ids, contradicted_by_document_ids,
            superseded_by_document_id, schema_version, trace_id, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13, $14,
            $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb,
            $20::jsonb, $21, $22::jsonb, $23::jsonb,
            $24, $25, $26, $27
          )
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            source_url = EXCLUDED.source_url,
            trust_tier = EXCLUDED.trust_tier,
            trust_score = EXCLUDED.trust_score,
            relevance = EXCLUDED.relevance,
            stance = EXCLUDED.stance,
            recency_score = EXCLUDED.recency_score,
            published_at = EXCLUDED.published_at,
            normalized_payload = EXCLUDED.normalized_payload,
            related_project_ids = EXCLUDED.related_project_ids,
            related_version_ids = EXCLUDED.related_version_ids,
            finding_types = EXCLUDED.finding_types,
            extracted_entities = EXCLUDED.extracted_entities,
            extracted_relations = EXCLUDED.extracted_relations,
            cluster_id = EXCLUDED.cluster_id,
            duplicate_document_ids = EXCLUDED.duplicate_document_ids,
            contradicted_by_document_ids = EXCLUDED.contradicted_by_document_ids,
            superseded_by_document_id = EXCLUDED.superseded_by_document_id,
            schema_version = EXCLUDED.schema_version,
            trace_id = EXCLUDED.trace_id`,
          [
            document.documentId,
            document.connectorId,
            document.syncRunId,
            document.rawPayloadId,
            document.externalDocumentId,
            document.title,
            document.sourceUrl,
            document.trust.tier,
            document.trust.score,
            document.relevance,
            document.stance,
            document.recencyScore,
            document.publishedAt,
            null,
            JSON.stringify({
              kind: document.kind,
              author: document.author,
              harvestedAt: document.harvestedAt,
              summary: document.summary,
              content: document.content,
              tags: document.tags,
              provenance: document.provenance,
              trustSignals: document.trust.signals
            }),
            JSON.stringify(document.relatedProjectIds),
            JSON.stringify(document.relatedVersionIds),
            JSON.stringify(document.findingTypes),
            JSON.stringify(document.extractedEntities),
            JSON.stringify(document.extractedRelations),
            document.clusterId,
            JSON.stringify(document.duplicateDocumentIds),
            JSON.stringify(document.contradictedByDocumentIds),
            document.supersededByDocumentId ?? null,
            document.schemaVersion,
            document.traceId ?? null,
            document.createdAt
          ]
        );
      }

      const snippets = [...this.repository.evidenceSnippets.values()].filter((snippet) => {
        if (!syncRunId) return true;
        const document = this.repository.evidenceDocuments.get(snippet.documentId);
        return document?.syncRunId === syncRunId;
      });
      for (const snippet of snippets) {
        await client.query(
          `INSERT INTO evidence_snippets (
            id, document_id, snippet_text, snippet_hash, relevance, stance, trust_score,
            related_project_ids, related_version_ids, contradiction_document_ids,
            superseded_by_document_id, metadata, schema_version, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8::jsonb, $9::jsonb, $10::jsonb,
            $11, $12::jsonb, $13, $14
          )
          ON CONFLICT (id) DO UPDATE SET
            relevance = EXCLUDED.relevance,
            stance = EXCLUDED.stance,
            trust_score = EXCLUDED.trust_score,
            related_project_ids = EXCLUDED.related_project_ids,
            related_version_ids = EXCLUDED.related_version_ids,
            contradiction_document_ids = EXCLUDED.contradiction_document_ids,
            superseded_by_document_id = EXCLUDED.superseded_by_document_id,
            metadata = EXCLUDED.metadata,
            schema_version = EXCLUDED.schema_version`,
          [
            snippet.snippetId,
            snippet.documentId,
            snippet.text,
            snippet.textHash,
            snippet.relevance,
            snippet.stance,
            snippet.trustScore,
            JSON.stringify(snippet.relatedProjectIds),
            JSON.stringify(snippet.relatedVersionIds),
            JSON.stringify(snippet.contradictionDocumentIds),
            snippet.supersededByDocumentId ?? null,
            JSON.stringify({
              kind: snippet.kind,
              extractedEntities: snippet.extractedEntities,
              extractedRelations: snippet.extractedRelations
            }),
            snippet.schemaVersion,
            snippet.createdAt
          ]
        );
      }

      const searchDocuments = [...this.repository.evidenceSearchDocuments.values()].filter(
        (searchDocument) => {
          const document = this.repository.evidenceDocuments.get(searchDocument.documentId);
          return !syncRunId || document?.syncRunId === syncRunId;
        }
      );
      for (const searchDocument of searchDocuments) {
        await client.query(
          `INSERT INTO evidence_search_documents (
            id, index_name, document_id, snippet_id, title, body, trust_tier, trust_score, recency_score,
            relevance, stance, finding_types, related_project_ids, related_version_ids, cluster_id,
            contradicted_by_document_ids, superseded_by_document_id, source_url, published_at, schema_version, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15,
            $16::jsonb, $17, $18, $19, $20, $21
          )
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            body = EXCLUDED.body,
            trust_tier = EXCLUDED.trust_tier,
            trust_score = EXCLUDED.trust_score,
            recency_score = EXCLUDED.recency_score,
            relevance = EXCLUDED.relevance,
            stance = EXCLUDED.stance,
            finding_types = EXCLUDED.finding_types,
            related_project_ids = EXCLUDED.related_project_ids,
            related_version_ids = EXCLUDED.related_version_ids,
            cluster_id = EXCLUDED.cluster_id,
            contradicted_by_document_ids = EXCLUDED.contradicted_by_document_ids,
            superseded_by_document_id = EXCLUDED.superseded_by_document_id,
            source_url = EXCLUDED.source_url,
            published_at = EXCLUDED.published_at,
            schema_version = EXCLUDED.schema_version`,
          [
            searchDocument.id,
            searchDocument.index,
            searchDocument.documentId,
            searchDocument.snippetId ?? null,
            searchDocument.title,
            searchDocument.text,
            searchDocument.trustTier,
            searchDocument.trustScore,
            searchDocument.recencyScore,
            searchDocument.relevance,
            searchDocument.stance,
            JSON.stringify(searchDocument.findingTypes),
            JSON.stringify(searchDocument.relatedProjectIds),
            JSON.stringify(searchDocument.relatedVersionIds),
            searchDocument.clusterId,
            JSON.stringify(searchDocument.contradictedByDocumentIds),
            searchDocument.supersededByDocumentId ?? null,
            searchDocument.sourceUrl,
            searchDocument.publishedAt,
            1,
            new Date().toISOString()
          ]
        );
      }

      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async hydrateEvidenceState() {
    if (!this.isEnabled()) {
      return {
        connectors: [],
        runs: [],
        rawPayloads: [],
        documents: [],
        snippets: [],
        searchDocuments: []
      };
    }

    await this.ensureSchema();
    const [
      connectorRows,
      runRows,
      rawPayloadRows,
      documentRows,
      snippetRows,
      searchRows
    ] = await Promise.all([
      this.getPool().query(`SELECT * FROM source_connectors ORDER BY created_at ASC`),
      this.getPool().query(`SELECT * FROM source_sync_runs ORDER BY created_at ASC`),
      this.getPool().query(`SELECT * FROM source_raw_payloads ORDER BY created_at ASC`),
      this.getPool().query(`SELECT * FROM evidence_documents ORDER BY created_at ASC`),
      this.getPool().query(`SELECT * FROM evidence_snippets ORDER BY created_at ASC`),
      this.getPool().query(`SELECT * FROM evidence_search_documents ORDER BY created_at ASC`)
    ]);

    const connectors = (connectorRows.rows as JsonRow[]).map((row) => {
      const config = parseJsonValue<Record<string, unknown>>(row.config, {});
      const connector: SourceConnector = {
        connectorId: String(row.id),
        connectorName: String(row.connector_name),
        sourceType: (config.sourceType as SourceConnector["sourceType"]) ?? "github",
        status: row.status as SourceConnector["status"],
        trustTier: (config.trustTier as SourceConnector["trustTier"]) ?? "community",
        lastSyncAt: config.lastSyncAt ? String(config.lastSyncAt) : undefined,
        schemaVersion: Number(row.schema_version),
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString(),
        updatedAt: toTimestampString(row.updated_at) ?? new Date(0).toISOString()
      };
      return connector;
    });
    this.repository.sourceConnectors.clear();
    this.repository.sourceConnectorsByName.clear();
    for (const connector of connectors) {
      this.repository.sourceConnectors.set(connector.connectorId, connector);
      this.repository.sourceConnectorsByName.set(connector.connectorName, connector);
    }

    const runs = (runRows.rows as JsonRow[]).map((row) => {
      const run: SourceSyncRun = {
        syncRunId: String(row.id),
        connectorId: String(row.connector_id),
        status: row.status as SourceSyncRun["status"],
        startedAt: toTimestampString(row.started_at) ?? new Date(0).toISOString(),
        finishedAt: toTimestampString(row.finished_at),
        checkpoint: parseJsonValue(row.checkpoint, undefined),
        stats: parseJsonValue(row.stats, {
          rawPayloadCount: 0,
          documentCount: 0,
          snippetCount: 0,
          contradictionCount: 0,
          supersessionCount: 0
        }),
        schemaVersion: Number(row.schema_version),
        traceId: row.trace_id ? String(row.trace_id) : undefined,
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
      };
      return run;
    });
    this.repository.sourceSyncRuns.clear();
    for (const run of runs) {
      this.repository.sourceSyncRuns.set(run.syncRunId, run);
    }

    const rawPayloads = (rawPayloadRows.rows as JsonRow[]).map((row) => {
      const payload: RawPayloadRecord = {
        rawPayloadId: String(row.id),
        connectorId: String(row.connector_id),
        syncRunId: String(row.sync_run_id),
        externalDocumentId: String(row.external_document_ref),
        contentType: String(row.content_type),
        checksum: String(row.checksum),
        body: parseJsonValue(row.payload, {}),
        fetchedAt: toTimestampString(row.fetched_at) ?? new Date(0).toISOString(),
        schemaVersion: Number(row.schema_version),
        traceId: row.trace_id ? String(row.trace_id) : undefined,
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
      };
      return payload;
    });
    this.repository.rawPayloads.clear();
    for (const payload of rawPayloads) {
      this.repository.rawPayloads.set(payload.rawPayloadId, payload);
    }

    const documents = (documentRows.rows as JsonRow[]).map((row) => {
      const normalized = parseJsonValue<Record<string, unknown>>(row.normalized_payload, {});
      const document: EvidenceDocument = {
        documentId: String(row.id),
        connectorId: String(row.source_connector_id),
        syncRunId: String(row.sync_run_id),
        rawPayloadId: String(row.raw_payload_id),
        externalDocumentId: String(row.source_document_ref),
        kind: (normalized.kind as EvidenceDocument["kind"]) ?? "curated_post",
        title: row.title ? String(row.title) : "",
        sourceUrl: row.source_url ? String(row.source_url) : "",
        author: normalized.author ? String(normalized.author) : undefined,
        publishedAt: toTimestampString(row.published_at) ?? new Date(0).toISOString(),
        harvestedAt: normalized.harvestedAt ? String(normalized.harvestedAt) : toTimestampString(row.created_at) ?? new Date(0).toISOString(),
        trust: {
          tier: (row.trust_tier as EvidenceDocument["trust"]["tier"]) ?? "community",
          score: toNumeric(row.trust_score) ?? 0,
          signals: parseJsonValue(normalized.trustSignals, [])
        },
        recencyScore: toNumeric(row.recency_score) ?? 0,
        relevance: (row.relevance as EvidenceDocument["relevance"]) ?? "background",
        stance: (row.stance as EvidenceDocument["stance"]) ?? "neutral",
        summary: normalized.summary ? String(normalized.summary) : "",
        content: normalized.content ? String(normalized.content) : "",
        tags: parseJsonValue(normalized.tags, []),
        relatedProjectIds: parseJsonValue(row.related_project_ids, []),
        relatedVersionIds: parseJsonValue(row.related_version_ids, []),
        findingTypes: parseJsonValue(row.finding_types, []),
        extractedEntities: parseJsonValue(row.extracted_entities, []),
        extractedRelations: parseJsonValue(row.extracted_relations, []),
        provenance: parseJsonValue(normalized.provenance, {
          connectorName: "",
          syncRunId: String(row.sync_run_id),
          externalDocumentId: String(row.source_document_ref),
          rawPayloadId: String(row.raw_payload_id)
        }),
        clusterId: row.cluster_id ? String(row.cluster_id) : "",
        duplicateDocumentIds: parseJsonValue(row.duplicate_document_ids, []),
        contradictedByDocumentIds: parseJsonValue(row.contradicted_by_document_ids, []),
        supersededByDocumentId: row.superseded_by_document_id
          ? String(row.superseded_by_document_id)
          : undefined,
        schemaVersion: Number(row.schema_version),
        traceId: row.trace_id ? String(row.trace_id) : undefined,
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
      };
      return document;
    });
    this.repository.evidenceDocuments.clear();
    this.repository.evidenceDocumentsByExternalRef.clear();
    for (const document of documents) {
      this.repository.evidenceDocuments.set(document.documentId, document);
      this.repository.evidenceDocumentsByExternalRef.set(
        `${document.connectorId}:${document.externalDocumentId}`,
        document.documentId
      );
    }

    const snippets = (snippetRows.rows as JsonRow[]).map((row) => {
      const metadata = parseJsonValue<Record<string, unknown>>(row.metadata, {});
      const snippet: EvidenceSnippet = {
        snippetId: String(row.id),
        documentId: String(row.document_id),
        kind: (metadata.kind as EvidenceSnippet["kind"]) ?? "summary",
        text: String(row.snippet_text),
        textHash: String(row.snippet_hash),
        relevance: (row.relevance as EvidenceSnippet["relevance"]) ?? "background",
        stance: (row.stance as EvidenceSnippet["stance"]) ?? "neutral",
        trustScore: toNumeric(row.trust_score) ?? 0,
        relatedProjectIds: parseJsonValue(row.related_project_ids, []),
        relatedVersionIds: parseJsonValue(row.related_version_ids, []),
        extractedEntities: parseJsonValue(metadata.extractedEntities, []),
        extractedRelations: parseJsonValue(metadata.extractedRelations, []),
        contradictionDocumentIds: parseJsonValue(row.contradiction_document_ids, []),
        supersededByDocumentId: row.superseded_by_document_id
          ? String(row.superseded_by_document_id)
          : undefined,
        schemaVersion: Number(row.schema_version),
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
      };
      return snippet;
    });
    this.repository.evidenceSnippets.clear();
    for (const snippet of snippets) {
      this.repository.evidenceSnippets.set(snippet.snippetId, snippet);
    }

    const searchDocuments = (searchRows.rows as JsonRow[]).map((row) => {
      const searchDocument: EvidenceSearchDocument = {
        index: row.index_name as EvidenceSearchDocument["index"],
        id: String(row.id),
        documentId: String(row.document_id),
        snippetId: row.snippet_id ? String(row.snippet_id) : undefined,
        title: String(row.title),
        text: String(row.body),
        connectorId:
          documents.find((document) => document.documentId === String(row.document_id))?.connectorId ??
          "",
        trustTier: row.trust_tier as EvidenceSearchDocument["trustTier"],
        trustScore: toNumeric(row.trust_score) ?? 0,
        recencyScore: toNumeric(row.recency_score) ?? 0,
        relevance: row.relevance as EvidenceSearchDocument["relevance"],
        stance: row.stance as EvidenceSearchDocument["stance"],
        findingTypes: parseJsonValue(row.finding_types, []),
        relatedProjectIds: parseJsonValue(row.related_project_ids, []),
        relatedVersionIds: parseJsonValue(row.related_version_ids, []),
        clusterId: String(row.cluster_id),
        contradictedByDocumentIds: parseJsonValue(row.contradicted_by_document_ids, []),
        supersededByDocumentId: row.superseded_by_document_id
          ? String(row.superseded_by_document_id)
          : undefined,
        sourceUrl: String(row.source_url),
        publishedAt: toTimestampString(row.published_at) ?? new Date(0).toISOString()
      };
      return searchDocument;
    });
    this.repository.evidenceSearchDocuments.clear();
    for (const searchDocument of searchDocuments) {
      this.repository.evidenceSearchDocuments.set(searchDocument.id, searchDocument);
    }

    return { connectors, runs, rawPayloads, documents, snippets, searchDocuments };
  }

  async persistExactPackAnalysisCache(cacheId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const cache = this.repository.exactPackAnalysisCache.get(cacheId);
    if (!cache) {
      throw new Error(`Exact pack analysis cache not found in memory: ${cacheId}`);
    }

    await this.persistKnowledgeSnapshot(cache.snapshotId);
    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO exact_pack_analysis_cache (
        id, snapshot_id, pack_fingerprint, environment, verdict, confidence_summary,
        coverage_status, finding_ids, recommendation_ids, explanation, freshness_summary,
        schema_version, created_at
      ) VALUES (
        $1, $2, $3, $4::jsonb, $5, $6::jsonb,
        $7, $8::jsonb, $9::jsonb, $10, $11,
        $12, $13
      )
      ON CONFLICT (id) DO UPDATE SET
        snapshot_id = EXCLUDED.snapshot_id,
        pack_fingerprint = EXCLUDED.pack_fingerprint,
        environment = EXCLUDED.environment,
        verdict = EXCLUDED.verdict,
        confidence_summary = EXCLUDED.confidence_summary,
        coverage_status = EXCLUDED.coverage_status,
        finding_ids = EXCLUDED.finding_ids,
        recommendation_ids = EXCLUDED.recommendation_ids,
        explanation = EXCLUDED.explanation,
        freshness_summary = EXCLUDED.freshness_summary,
        schema_version = EXCLUDED.schema_version`,
      [
        cache.exactPackCacheId,
        cache.snapshotId,
        cache.packFingerprint,
        JSON.stringify(cache.environment),
        cache.verdict,
        JSON.stringify(cache.confidence),
        cache.coverageStatus,
        JSON.stringify(cache.findingIds),
        JSON.stringify(cache.recommendationIds),
        cache.explanation,
        cache.freshnessSummary ?? null,
        cache.schemaVersion,
        cache.createdAt
      ]
    );

    return { persisted: true };
  }

  async persistPromotedCompatibilityClaim(claimId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const claim = this.repository.promotedCompatibilityClaims.get(claimId);
    if (!claim) {
      throw new Error(`Promoted compatibility claim not found in memory: ${claimId}`);
    }

    await this.persistKnowledgeSnapshot(claim.snapshotId);
    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO promoted_compatibility_claims (
          id, snapshot_id, claim_key, finding_type, finding_verdict, severity,
          confidence_summary, source_kinds, subject_project_ids, subject_version_ids,
          environment, explanation, freshness_summary, schema_version, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
          $11::jsonb, $12, $13, $14, $15
        )
        ON CONFLICT (id) DO UPDATE SET
          snapshot_id = EXCLUDED.snapshot_id,
          claim_key = EXCLUDED.claim_key,
          finding_type = EXCLUDED.finding_type,
          finding_verdict = EXCLUDED.finding_verdict,
          severity = EXCLUDED.severity,
          confidence_summary = EXCLUDED.confidence_summary,
          source_kinds = EXCLUDED.source_kinds,
          subject_project_ids = EXCLUDED.subject_project_ids,
          subject_version_ids = EXCLUDED.subject_version_ids,
          environment = EXCLUDED.environment,
          explanation = EXCLUDED.explanation,
          freshness_summary = EXCLUDED.freshness_summary,
          schema_version = EXCLUDED.schema_version`,
        [
          claim.promotedClaimId,
          claim.snapshotId,
          claim.claimKey,
          claim.findingType,
          claim.findingVerdict,
          claim.severity,
          JSON.stringify(claim.confidence),
          JSON.stringify(claim.sourceKinds),
          JSON.stringify(claim.subjectProjectIds),
          JSON.stringify(claim.subjectVersionIds),
          JSON.stringify(claim.environment ?? null),
          claim.explanation,
          claim.freshnessSummary ?? null,
          claim.schemaVersion,
          claim.createdAt
        ]
      );

      await client.query(
        `DELETE FROM promoted_claim_evidence_refs
         WHERE promoted_claim_id = $1`,
        [claim.promotedClaimId]
      );

      for (const evidenceRef of claim.evidenceRefs) {
        await client.query(
          `INSERT INTO promoted_claim_evidence_refs (
            id, promoted_claim_id, evidence_type, evidence_id, snippet_id, schema_version, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7
          )`,
          [
            createPlatformId("cer"),
            claim.promotedClaimId,
            evidenceRef.type,
            evidenceRef.id,
            evidenceRef.snippetId ?? null,
            1,
            claim.createdAt
          ]
        );
      }

      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readKnowledgeSnapshotByVersion(version: string): Promise<KnowledgeSnapshot | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const [snapshotResult, componentResult] = await Promise.all([
      this.getPool().query(
        `SELECT *
         FROM knowledge_snapshots
         WHERE version = $1
         LIMIT 1`,
        [version]
      ),
      this.getPool().query(
        `SELECT component.*
         FROM knowledge_snapshot_components component
         INNER JOIN knowledge_snapshots snapshot
           ON snapshot.id = component.snapshot_id
         WHERE snapshot.version = $1
         ORDER BY component.created_at ASC`,
        [version]
      )
    ]);

    if (snapshotResult.rowCount === 0) {
      return undefined;
    }

    const row = snapshotResult.rows[0] as JsonRow;
    return {
      snapshotId: String(row.id),
      version: String(row.version),
      status: row.status as KnowledgeSnapshot["status"],
      coverageScopeId: row.coverage_scope_id ? String(row.coverage_scope_id) : undefined,
      validationReportId: row.validation_report_id
        ? String(row.validation_report_id)
        : undefined,
      activatedAt: toTimestampString(row.activated_at),
      createdBy: row.created_by ? String(row.created_by) : undefined,
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString(),
      components: componentResult.rows.map((componentRow) => ({
        componentType: componentRow.component_type as KnowledgeSnapshot["components"][number]["componentType"],
        recordCount: Number(componentRow.record_count),
        checksum: String(componentRow.checksum)
      }))
    };
  }

  async readLatestPromotedKnowledgeSnapshotVersion(): Promise<string | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT version
       FROM knowledge_snapshots
       WHERE status = 'promoted'
       ORDER BY COALESCE(activated_at, created_at) DESC, created_at DESC
       LIMIT 1`
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    return String(result.rows[0].version);
  }

  async readCoverageScopeBySnapshotVersion(
    snapshotVersion: string
  ): Promise<SupportedCoverageScope | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM coverage_scopes
       WHERE snapshot_version = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [snapshotVersion]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0] as JsonRow;
    return {
      coverageScopeId: String(row.id),
      snapshotVersion: String(row.snapshot_version),
      status: row.status as SupportedCoverageScope["status"],
      supportedMinecraftVersions: parseJsonValue(row.supported_minecraft_versions, []),
      supportedLoaders: parseJsonValue(row.supported_loaders, []),
      supportedProjectIds: parseJsonValue(row.supported_project_ids, []),
      versionFreshnessWindowDays: Number(row.version_freshness_window_days),
      notes: row.notes ? String(row.notes) : undefined,
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    };
  }

  async readExactPackAnalysisCache(
    snapshotId: string,
    packFingerprint: string
  ): Promise<ExactPackAnalysisCacheRecord | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM exact_pack_analysis_cache
       WHERE snapshot_id = $1
         AND pack_fingerprint = $2
       LIMIT 1`,
      [snapshotId, packFingerprint]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0] as JsonRow;
    return {
      exactPackCacheId: String(row.id),
      snapshotId: String(row.snapshot_id),
      packFingerprint: String(row.pack_fingerprint),
      environment: parseJsonValue(row.environment, {
        minecraftVersion: "",
        loader: "unknown",
        javaVersion: "",
        side: "both"
      }),
      verdict: row.verdict as ExactPackAnalysisCacheRecord["verdict"],
      confidence: parseJsonValue(row.confidence_summary, {
        score: 0,
        band: "very_low",
        explanation: "",
        primaryDrivers: []
      }),
      coverageStatus: row.coverage_status as ExactPackAnalysisCacheRecord["coverageStatus"],
      findingIds: parseJsonValue(row.finding_ids, []),
      recommendationIds: parseJsonValue(row.recommendation_ids, []),
      explanation: String(row.explanation),
      freshnessSummary: row.freshness_summary ? String(row.freshness_summary) : undefined,
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    };
  }

  async readAllExactPackCacheForSnapshot(
    snapshotId: string
  ): Promise<ExactPackAnalysisCacheRecord[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM exact_pack_analysis_cache
       WHERE snapshot_id = $1
       ORDER BY created_at ASC`,
      [snapshotId]
    );

    return result.rows.map((row) => {
      const r = row as JsonRow;
      return {
        exactPackCacheId: String(r.id),
        snapshotId: String(r.snapshot_id),
        packFingerprint: String(r.pack_fingerprint),
        environment: parseJsonValue(r.environment, {
          minecraftVersion: "",
          loader: "unknown",
          javaVersion: "",
          side: "both"
        }),
        verdict: r.verdict as ExactPackAnalysisCacheRecord["verdict"],
        confidence: parseJsonValue(r.confidence_summary, {
          score: 0,
          band: "very_low",
          explanation: "",
          primaryDrivers: []
        }),
        coverageStatus: r.coverage_status as ExactPackAnalysisCacheRecord["coverageStatus"],
        findingIds: parseJsonValue(r.finding_ids, []),
        recommendationIds: parseJsonValue(r.recommendation_ids, []),
        explanation: String(r.explanation),
        freshnessSummary: r.freshness_summary ? String(r.freshness_summary) : undefined,
        schemaVersion: Number(r.schema_version),
        createdAt: toTimestampString(r.created_at) ?? new Date(0).toISOString()
      } as ExactPackAnalysisCacheRecord;
    });
  }

  async readPromotedCompatibilityClaims(
    snapshotId: string
  ): Promise<PromotedCompatibilityClaim[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const [claimResult, evidenceResult] = await Promise.all([
      this.getPool().query(
        `SELECT *
         FROM promoted_compatibility_claims
         WHERE snapshot_id = $1
         ORDER BY created_at ASC`,
        [snapshotId]
      ),
      this.getPool().query(
        `SELECT ref.*
         FROM promoted_claim_evidence_refs ref
         INNER JOIN promoted_compatibility_claims claim
           ON claim.id = ref.promoted_claim_id
         WHERE claim.snapshot_id = $1
         ORDER BY ref.created_at ASC`,
        [snapshotId]
      )
    ]);

    const evidenceByClaimId = new Map<
      string,
      PromotedCompatibilityClaim["evidenceRefs"]
    >();
    for (const row of evidenceResult.rows as JsonRow[]) {
      const claimId = String(row.promoted_claim_id);
      const refs = evidenceByClaimId.get(claimId) ?? [];
      refs.push({
        type: row.evidence_type as PromotedCompatibilityClaim["evidenceRefs"][number]["type"],
        id: String(row.evidence_id),
        snippetId: row.snippet_id ? String(row.snippet_id) : undefined
      });
      evidenceByClaimId.set(claimId, refs);
    }

    return claimResult.rows.map((row) => ({
      promotedClaimId: String(row.id),
      snapshotId: String(row.snapshot_id),
      claimKey: String(row.claim_key),
      findingType: String(row.finding_type),
      findingVerdict: row.finding_verdict as PromotedCompatibilityClaim["findingVerdict"],
      severity: row.severity as PromotedCompatibilityClaim["severity"],
      confidence: parseJsonValue(row.confidence_summary, {
        score: 0,
        band: "very_low",
        explanation: "",
        primaryDrivers: []
      }),
      sourceKinds: parseJsonValue(row.source_kinds, []),
      subjectProjectIds: parseJsonValue(row.subject_project_ids, []),
      subjectVersionIds: parseJsonValue(row.subject_version_ids, []),
      environment: parseJsonValue(row.environment, undefined),
      explanation: String(row.explanation),
      evidenceRefs: evidenceByClaimId.get(String(row.id)) ?? [],
      freshnessSummary: row.freshness_summary ? String(row.freshness_summary) : undefined,
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    }));
  }

  async hydrateKnowledgeSnapshotById(snapshotId: string) {
    if (!this.isEnabled()) return undefined;
    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT version FROM knowledge_snapshots WHERE id = $1 LIMIT 1`,
      [snapshotId]
    );
    if (result.rowCount === 0) return undefined;
    const version = String((result.rows[0] as { version: string }).version);
    return this.hydrateKnowledgeSnapshotByVersion(version);
  }

  async hydrateKnowledgeSnapshotByVersion(version: string) {
    const snapshot = await this.readKnowledgeSnapshotByVersion(version);
    if (!snapshot) {
      return undefined;
    }

    this.repository.knowledgeSnapshots.set(snapshot.snapshotId, snapshot);
    this.repository.knowledgeSnapshotsByVersion.set(snapshot.version, snapshot.snapshotId);

    const coverageScope = await this.readCoverageScopeBySnapshotVersion(version);
    if (coverageScope) {
      this.repository.coverageScopes.set(coverageScope.coverageScopeId, coverageScope);
      this.repository.coverageScopesBySnapshotVersion.set(
        coverageScope.snapshotVersion,
        coverageScope.coverageScopeId
      );
    }

    const promotedClaims = await this.readPromotedCompatibilityClaims(snapshot.snapshotId);
    if (promotedClaims.length > 0) {
      this.repository.promotedCompatibilityClaimsBySnapshot.set(
        snapshot.snapshotId,
        promotedClaims.map((claim) => claim.promotedClaimId)
      );
      for (const claim of promotedClaims) {
        this.repository.promotedCompatibilityClaims.set(claim.promotedClaimId, claim);
      }
    }

    const pairwiseRecords = await this.readPairwiseCompatibilityRecords(snapshot.snapshotId);
    if (pairwiseRecords.length > 0) {
      this.repository.pairwiseCompatibilityBySnapshot.set(
        snapshot.snapshotId,
        pairwiseRecords.map((r) => r.pairwiseCompatibilityId)
      );
      for (const record of pairwiseRecords) {
        this.repository.pairwiseCompatibilityRecords.set(record.pairwiseCompatibilityId, record);
      }
    }

    const fragmentRecords = await this.readFragmentCompatibilityRecords(snapshot.snapshotId);
    if (fragmentRecords.length > 0) {
      this.repository.fragmentCompatibilityBySnapshot.set(
        snapshot.snapshotId,
        fragmentRecords.map((r) => r.fragmentCompatibilityId)
      );
      for (const record of fragmentRecords) {
        this.repository.fragmentCompatibilityRecords.set(record.fragmentCompatibilityId, record);
      }
    }

    const techSignatures = await this.readTechnicalConflictSignatures(snapshot.snapshotId);
    if (techSignatures.length > 0) {
      this.repository.technicalConflictSignaturesBySnapshot.set(
        snapshot.snapshotId,
        techSignatures.map((s) => s.technicalConflictSignatureId)
      );
      for (const sig of techSignatures) {
        this.repository.technicalConflictSignatures.set(sig.technicalConflictSignatureId, sig);
      }
    }

    const exactPackCacheEntries = await this.readAllExactPackCacheForSnapshot(snapshot.snapshotId);
    if (exactPackCacheEntries.length > 0) {
      this.repository.exactPackAnalysisCacheBySnapshot.set(
        snapshot.snapshotId,
        exactPackCacheEntries.map((e) => e.exactPackCacheId)
      );
      for (const entry of exactPackCacheEntries) {
        this.repository.exactPackAnalysisCache.set(entry.exactPackCacheId, entry);
      }
    }

    return snapshot;
  }

  async hydrateLatestPromotedKnowledgeSnapshot() {
    const version = await this.readLatestPromotedKnowledgeSnapshotVersion();
    if (!version) {
      return undefined;
    }
    return this.hydrateKnowledgeSnapshotByVersion(version);
  }

  async readPairwiseCompatibilityRecords(snapshotId: string): Promise<PairwiseCompatibilityRecord[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM pairwise_compatibility_records
       WHERE snapshot_id = $1
       ORDER BY created_at ASC`,
      [snapshotId]
    );

    return result.rows.map((row) => ({
      pairwiseCompatibilityId: String(row.id),
      snapshotId: String(row.snapshot_id),
      leftProjectId: String(row.left_project_id),
      leftVersionId: row.left_version_id ? String(row.left_version_id) : undefined,
      rightProjectId: String(row.right_project_id),
      rightVersionId: row.right_version_id ? String(row.right_version_id) : undefined,
      environment: parseJsonValue<PairwiseCompatibilityRecord["environment"]>(
        row.environment,
        undefined
      ),
      verdict: row.verdict as PairwiseCompatibilityRecord["verdict"],
      confidence: parseJsonValue(row.confidence_summary, {
        score: 0.5,
        band: "medium" as const,
        explanation: "",
        primaryDrivers: []
      }),
      claimIds: parseJsonValue<string[]>(row.claim_ids, []),
      recommendationIds: parseJsonValue<string[]>(row.recommendation_ids, []),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    }));
  }

  async persistPairwiseCompatibilityRecord(recordId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const record = this.repository.pairwiseCompatibilityRecords.get(recordId);
    if (!record) {
      throw new Error(`Pairwise compatibility record not found in memory: ${recordId}`);
    }

    await this.persistKnowledgeSnapshot(record.snapshotId);
    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO pairwise_compatibility_records (
        id, snapshot_id, left_project_id, left_version_id, right_project_id, right_version_id,
        environment, verdict, confidence_summary, claim_ids, recommendation_ids, schema_version, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13
      )
      ON CONFLICT (id) DO UPDATE SET
        verdict = EXCLUDED.verdict,
        confidence_summary = EXCLUDED.confidence_summary,
        claim_ids = EXCLUDED.claim_ids,
        recommendation_ids = EXCLUDED.recommendation_ids,
        schema_version = EXCLUDED.schema_version`,
      [
        record.pairwiseCompatibilityId,
        record.snapshotId,
        record.leftProjectId,
        record.leftVersionId ?? null,
        record.rightProjectId,
        record.rightVersionId ?? null,
        record.environment ? JSON.stringify(record.environment) : null,
        record.verdict,
        JSON.stringify(record.confidence),
        JSON.stringify(record.claimIds),
        JSON.stringify(record.recommendationIds ?? []),
        record.schemaVersion,
        record.createdAt
      ]
    );

    return { persisted: true };
  }

  async readFragmentCompatibilityRecords(snapshotId: string): Promise<FragmentCompatibilityRecord[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM fragment_compatibility_records
       WHERE snapshot_id = $1
       ORDER BY created_at ASC`,
      [snapshotId]
    );

    return result.rows.map((row) => ({
      fragmentCompatibilityId: String(row.id),
      snapshotId: String(row.snapshot_id),
      fragmentHash: String(row.fragment_hash),
      projectIds: parseJsonValue<string[]>(row.project_ids, []),
      versionIds: parseJsonValue<string[]>(row.version_ids, []),
      environment: parseJsonValue<FragmentCompatibilityRecord["environment"]>(
        row.environment,
        undefined
      ),
      verdict: row.verdict as FragmentCompatibilityRecord["verdict"],
      confidence: parseJsonValue(row.confidence_summary, {
        score: 0.5,
        band: "medium" as const,
        explanation: "",
        primaryDrivers: []
      }),
      claimIds: parseJsonValue<string[]>(row.claim_ids, []),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    }));
  }

  async persistFragmentCompatibilityRecord(recordId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const record = this.repository.fragmentCompatibilityRecords.get(recordId);
    if (!record) {
      throw new Error(`Fragment compatibility record not found in memory: ${recordId}`);
    }

    await this.persistKnowledgeSnapshot(record.snapshotId);
    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO fragment_compatibility_records (
        id, snapshot_id, fragment_hash, project_ids, version_ids, environment,
        verdict, confidence_summary, claim_ids, schema_version, created_at
      ) VALUES (
        $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
        $7, $8::jsonb, $9::jsonb, $10, $11
      )
      ON CONFLICT (id) DO UPDATE SET
        verdict = EXCLUDED.verdict,
        confidence_summary = EXCLUDED.confidence_summary,
        claim_ids = EXCLUDED.claim_ids,
        schema_version = EXCLUDED.schema_version`,
      [
        record.fragmentCompatibilityId,
        record.snapshotId,
        record.fragmentHash,
        JSON.stringify(record.projectIds),
        JSON.stringify(record.versionIds),
        record.environment ? JSON.stringify(record.environment) : null,
        record.verdict,
        JSON.stringify(record.confidence),
        JSON.stringify(record.claimIds),
        record.schemaVersion,
        record.createdAt
      ]
    );

    return { persisted: true };
  }

  async readTechnicalConflictSignatures(snapshotId: string): Promise<TechnicalConflictSignature[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const sigResult = await this.getPool().query(
      `SELECT *
       FROM technical_conflict_signatures
       WHERE snapshot_id = $1
       ORDER BY created_at ASC`,
      [snapshotId]
    );

    if (sigResult.rowCount === 0) {
      return [];
    }

    const sigIds = sigResult.rows.map((r) => String(r.id));
    const evidenceResult = await this.getPool().query(
      `SELECT *
       FROM technical_conflict_signature_evidence_refs
       WHERE technical_conflict_signature_id = ANY($1::text[])
       ORDER BY created_at ASC`,
      [sigIds]
    );

    const evidenceBySigId = new Map<string, TechnicalConflictSignature["evidenceRefs"]>();
    for (const row of evidenceResult.rows) {
      const sigId = String(row.technical_conflict_signature_id);
      const refs = evidenceBySigId.get(sigId) ?? [];
      refs.push({
        type: row.evidence_type as TechnicalConflictSignature["evidenceRefs"][number]["type"],
        id: String(row.evidence_id),
        snippetId: row.snippet_id ? String(row.snippet_id) : undefined
      });
      evidenceBySigId.set(sigId, refs);
    }

    return sigResult.rows.map((row) => ({
      technicalConflictSignatureId: String(row.id),
      signatureKey: String(row.signature_key),
      snapshotId: row.snapshot_id ? String(row.snapshot_id) : undefined,
      signatureType: row.signature_type as TechnicalConflictSignature["signatureType"],
      projectIds: parseJsonValue<string[]>(row.project_ids, []),
      versionIds: parseJsonValue<string[]>(row.version_ids, []),
      targetRef: row.target_ref ? String(row.target_ref) : undefined,
      packageHint: row.package_hint ? String(row.package_hint) : undefined,
      confidence: parseJsonValue(row.confidence_summary, {
        score: 0.5,
        band: "medium" as const,
        explanation: "",
        primaryDrivers: []
      }),
      evidenceRefs: evidenceBySigId.get(String(row.id)) ?? [],
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    }));
  }

  async persistTechnicalConflictSignature(signatureId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const sig = this.repository.technicalConflictSignatures.get(signatureId);
    if (!sig) {
      throw new Error(`Technical conflict signature not found in memory: ${signatureId}`);
    }

    if (sig.snapshotId) {
      await this.persistKnowledgeSnapshot(sig.snapshotId);
    }
    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO technical_conflict_signatures (
          id, signature_key, snapshot_id, signature_type, project_ids, version_ids,
          target_ref, package_hint, confidence_summary, schema_version, created_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6::jsonb,
          $7, $8, $9::jsonb, $10, $11
        )
        ON CONFLICT (id) DO UPDATE SET
          confidence_summary = EXCLUDED.confidence_summary,
          schema_version = EXCLUDED.schema_version`,
        [
          sig.technicalConflictSignatureId,
          sig.signatureKey,
          sig.snapshotId ?? null,
          sig.signatureType,
          JSON.stringify(sig.projectIds),
          JSON.stringify(sig.versionIds),
          sig.targetRef ?? null,
          sig.packageHint ?? null,
          JSON.stringify(sig.confidence),
          sig.schemaVersion,
          sig.createdAt
        ]
      );

      for (const ref of sig.evidenceRefs) {
        const refId = createPlatformId("evr");
        await client.query(
          `INSERT INTO technical_conflict_signature_evidence_refs (
            id, technical_conflict_signature_id, evidence_type, evidence_id, snippet_id, schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5, 1, now())
          ON CONFLICT (id) DO NOTHING`,
          [
            refId,
            sig.technicalConflictSignatureId,
            ref.type,
            ref.id,
            ref.snippetId ?? null
          ]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return { persisted: true };
  }

  async readServiceRequest(
    serviceName: string,
    operationName: string,
    idempotencyKey: string
  ): Promise<ServiceRequestRecord | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM service_request_dedupes
       WHERE service_name = $1
         AND operation_name = $2
         AND idempotency_key = $3
       LIMIT 1`,
      [serviceName, operationName, idempotencyKey]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0];
    return {
      serviceName: String(row.service_name),
      operationName: String(row.operation_name),
      idempotencyKey: String(row.idempotency_key),
      status: row.status,
      analysisId: row.analysis_id ? String(row.analysis_id) : undefined,
      response: parseJsonValue(row.response_json, undefined),
      errorCode: row.error_code ? String(row.error_code) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: toTimestampString(row.updated_at) ?? new Date(0).toISOString()
    };
  }

  async beginServiceRequest(
    serviceName: string,
    operationName: string,
    idempotencyKey: string
  ) {
    if (!this.isEnabled()) {
      return {
        persisted: false,
        existing: undefined as ServiceRequestRecord | undefined
      };
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT *
         FROM service_request_dedupes
         WHERE service_name = $1
           AND operation_name = $2
           AND idempotency_key = $3
         LIMIT 1`,
        [serviceName, operationName, idempotencyKey]
      );

      if ((existing.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        const row = existing.rows[0];
        return {
          persisted: true,
          existing: {
            serviceName: String(row.service_name),
            operationName: String(row.operation_name),
            idempotencyKey: String(row.idempotency_key),
            status: row.status,
            analysisId: row.analysis_id ? String(row.analysis_id) : undefined,
            response: parseJsonValue(row.response_json, undefined),
            errorCode: row.error_code ? String(row.error_code) : undefined,
            errorMessage: row.error_message ? String(row.error_message) : undefined,
            createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString(),
            updatedAt: toTimestampString(row.updated_at) ?? new Date(0).toISOString()
          } as ServiceRequestRecord
        };
      }

      await client.query(
        `INSERT INTO service_request_dedupes (
          service_name, operation_name, idempotency_key, status
        ) VALUES ($1, $2, $3, $4)`,
        [serviceName, operationName, idempotencyKey, "started"]
      );

      await client.query("COMMIT");
      return {
        persisted: true,
        existing: undefined as ServiceRequestRecord | undefined
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeServiceRequest(
    serviceName: string,
    operationName: string,
    idempotencyKey: string,
    input: {
      analysisId?: string;
      response: unknown;
    }
  ) {
    if (!this.isEnabled()) {
      return { persisted: false };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `UPDATE service_request_dedupes
       SET status = $4,
           analysis_id = $5,
           response_json = $6::jsonb,
           error_code = NULL,
           error_message = NULL,
           updated_at = now()
       WHERE service_name = $1
         AND operation_name = $2
         AND idempotency_key = $3`,
      [
        serviceName,
        operationName,
        idempotencyKey,
        "completed",
        input.analysisId ?? null,
        JSON.stringify(input.response)
      ]
    );

    return { persisted: true };
  }

  async failServiceRequest(
    serviceName: string,
    operationName: string,
    idempotencyKey: string,
    input: {
      code: string;
      message: string;
    }
  ) {
    if (!this.isEnabled()) {
      return { persisted: false };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `UPDATE service_request_dedupes
       SET status = $4,
           error_code = $5,
           error_message = $6,
           updated_at = now()
       WHERE service_name = $1
         AND operation_name = $2
         AND idempotency_key = $3`,
      [serviceName, operationName, idempotencyKey, "failed", input.code, input.message]
    );

    return { persisted: true };
  }

  async cancelServiceRequest(
    serviceName: string,
    operationName: string,
    idempotencyKey: string,
    input: {
      code: string;
      message: string;
    }
  ) {
    if (!this.isEnabled()) {
      return { persisted: false };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `UPDATE service_request_dedupes
       SET status = $4,
           error_code = $5,
           error_message = $6,
           updated_at = now()
       WHERE service_name = $1
         AND operation_name = $2
         AND idempotency_key = $3`,
      [serviceName, operationName, idempotencyKey, "cancelled", input.code, input.message]
    );

    return { persisted: true };
  }

  async persistAnalysis(analysisId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const record = this.repository.analyses.get(analysisId);
    if (!record) {
      throw new Error(`Analysis not found in memory: ${analysisId}`);
    }

    await this.ensureSchema();

    const tenantId = record.summary.organizationId;
    if (!tenantId) {
      throw new Error(`Analysis ${analysisId} is missing organizationId/tenant context.`);
    }

    const report = record.report;
    const recommendationSet = record.recommendationSet;
    const feedback = report?.feedback ?? [];
    const latestOutcome = report?.latestOutcome;

    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      const prerequisites = await persistIdentityAndSnapshotPrerequisites(
        client,
        this.repository,
        record.summary
      );
      await persistProjectImports(
        client,
        this.repository,
        record.summary.projectId,
        record.summary.workspaceId
      );

      await client.query(
        `INSERT INTO analyses (
          id, project_id, workspace_id, organization_id, tenant_id, pack_snapshot_id,
          trigger_type, analysis_mode, status, overall_score, counts, schema_version,
          provenance, started_at, finished_at, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11::jsonb, $12,
          $13::jsonb, $14, $15, $16
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          overall_score = EXCLUDED.overall_score,
          counts = EXCLUDED.counts,
          started_at = EXCLUDED.started_at,
          finished_at = EXCLUDED.finished_at`,
        [
          record.summary.analysisId,
          record.summary.projectId,
          record.summary.workspaceId,
          tenantId,
          tenantId,
          prerequisites.persistedSnapshotId,
          record.summary.trigger,
          record.summary.analysisMode,
          record.summary.status,
          record.summary.score ?? null,
          JSON.stringify(record.summary.counts ?? null),
          1,
          JSON.stringify({ persistedBy: "phase7-postgres-adapter" }),
          record.summary.startedAt ?? null,
          record.summary.finishedAt ?? null,
          record.summary.createdAt
        ]
      );

      await client.query("DELETE FROM analysis_phases WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM analysis_events WHERE analysis_id = $1", [analysisId]);
      await client.query(
        "DELETE FROM finding_subjects WHERE finding_id IN (SELECT id FROM findings WHERE analysis_id = $1)",
        [analysisId]
      );
      await client.query(
        "DELETE FROM finding_evidence WHERE finding_id IN (SELECT id FROM findings WHERE analysis_id = $1)",
        [analysisId]
      );
      await client.query(
        "DELETE FROM finding_actions WHERE finding_id IN (SELECT id FROM findings WHERE analysis_id = $1)",
        [analysisId]
      );
      await client.query("DELETE FROM findings WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM recommendation_impacts WHERE recommendation_id IN (SELECT id FROM recommendations WHERE recommendation_set_id IN (SELECT id FROM recommendation_sets WHERE analysis_id = $1))", [analysisId]);
      await client.query("DELETE FROM recommendation_feedback WHERE recommendation_set_id IN (SELECT id FROM recommendation_sets WHERE analysis_id = $1)", [analysisId]);
      await client.query("DELETE FROM recommendation_outcomes WHERE recommendation_set_id IN (SELECT id FROM recommendation_sets WHERE analysis_id = $1)", [analysisId]);
      await client.query("DELETE FROM recommendation_bundles WHERE recommendation_set_id IN (SELECT id FROM recommendation_sets WHERE analysis_id = $1)", [analysisId]);
      await client.query("DELETE FROM recommendations WHERE recommendation_set_id IN (SELECT id FROM recommendation_sets WHERE analysis_id = $1)", [analysisId]);
      await client.query("DELETE FROM recommendation_sets WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM finding_feature_vectors WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM offline_datasets WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM calibrated_finding_scores WHERE analysis_id = $1", [analysisId]);
      await client.query(
        "DELETE FROM artifact_analysis_outputs WHERE artifact_analysis_run_id IN (SELECT id FROM artifact_analysis_runs WHERE analysis_id = $1)",
        [analysisId]
      );
      await client.query("DELETE FROM artifact_analysis_runs WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM pack_review_summaries WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM simulation_runs WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM release_gate_decisions WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM status_check_results WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM webhook_delivery_attempts WHERE analysis_id = $1", [analysisId]);
      await client.query("DELETE FROM analysis_reports WHERE analysis_id = $1", [analysisId]);

      for (const phase of record.phases) {
        await client.query(
          `INSERT INTO analysis_phases (
            id, analysis_id, phase_name, status, duration_ms, artifacts,
            schema_version, started_at, finished_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
          [
            phase.phaseId,
            analysisId,
            phase.phaseName,
            phase.status,
            phase.durationMs,
            JSON.stringify(phase.artifacts ?? []),
            phase.schemaVersion,
            phase.startedAt,
            phase.finishedAt,
            phase.startedAt
          ]
        );
      }

      for (const event of record.events) {
        await client.query(
          `INSERT INTO analysis_events (
            id, analysis_id, organization_id, tenant_id, event_type, message,
            phase_name, payload, schema_version, occurred_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
          [
            event.eventId,
            analysisId,
            tenantId,
            tenantId,
            event.eventType,
            event.message,
            event.phaseName ?? null,
            JSON.stringify(event.payload ?? null),
            event.schemaVersion,
            event.occurredAt,
            event.occurredAt
          ]
        );
      }

      for (const finding of record.findings) {
        await client.query(
          `INSERT INTO findings (
            id, analysis_id, organization_id, tenant_id, finding_type, severity,
            confidence, reproducibility, title, summary, explanation, scope,
            score_details, status, schema_version, provenance, dedupe_key,
            confidence_inputs, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12::jsonb,
            $13::jsonb, $14, $15, $16::jsonb, $17,
            $18::jsonb, $19
          )`,
          [
            finding.findingId,
            analysisId,
            tenantId,
            tenantId,
            finding.type,
            finding.severity,
            finding.confidence,
            finding.reproducibility,
            finding.title,
            finding.summary ?? null,
            finding.explanation ?? null,
            JSON.stringify(finding.scope ?? null),
            JSON.stringify({ persistedBy: "phase7-postgres-adapter" }),
            "open",
            1,
            JSON.stringify(finding.provenance ?? []),
            finding.dedupeKey ?? null,
            JSON.stringify(finding.confidenceInputs ?? []),
            record.summary.finishedAt ?? record.summary.createdAt
          ]
        );

        for (const subject of finding.subjects) {
          await client.query(
            `INSERT INTO finding_subjects (
              id, finding_id, canonical_project_id, canonical_version_id,
              relation, schema_version, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              `${finding.findingId}:${subject.projectId}:${subject.relation ?? "primary"}`,
              finding.findingId,
              subject.projectId,
              subject.versionId ?? null,
              subject.relation ?? null,
              1,
              record.summary.finishedAt ?? record.summary.createdAt
            ]
          );
        }

        for (const evidence of finding.evidence) {
          await client.query(
            `INSERT INTO finding_evidence (
              id, finding_id, evidence_type, evidence_id, snippet_id, schema_version, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              `${finding.findingId}:${evidence.type}:${evidence.id}:${evidence.snippetId ?? "none"}`,
              finding.findingId,
              evidence.type,
              evidence.id,
              evidence.snippetId ?? null,
              1,
              record.summary.finishedAt ?? record.summary.createdAt
            ]
          );
        }

        for (const action of finding.recommendedActions ?? []) {
          await client.query(
            `INSERT INTO finding_actions (
              id, finding_id, action_type, action_text, schema_version, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              `${finding.findingId}:${action}`,
              finding.findingId,
              "recommended_action",
              action,
              1,
              record.summary.finishedAt ?? record.summary.createdAt
            ]
          );
        }
      }

      if (recommendationSet) {
        await client.query(
          `INSERT INTO recommendation_sets (
            id, analysis_id, organization_id, tenant_id, generation_strategy,
            summary_json, schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [
            recommendationSet.recommendationSetId,
            analysisId,
            tenantId,
            tenantId,
            recommendationSet.generationStrategy,
            JSON.stringify(recommendationSet.summary),
            recommendationSet.schemaVersion,
            recommendationSet.createdAt
          ]
        );

        for (const recommendation of recommendationSet.items) {
          await client.query(
            `INSERT INTO recommendations (
              id, recommendation_set_id, organization_id, tenant_id, recommendation_kind, rank,
              confidence, summary, rationale, status, finding_ids, evidence_refs, replaces_subjects,
              candidate_projects, migration_cost, expected_compatibility_gain, remediation_steps,
              schema_version, created_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
              $14::jsonb, $15, $16, $17::jsonb,
              $18, $19
            )`,
            [
              recommendation.recommendationId,
              recommendationSet.recommendationSetId,
              tenantId,
              tenantId,
              recommendation.kind,
              recommendation.rank,
              recommendation.confidence,
              recommendation.summary,
              recommendation.rationale ?? null,
              recommendation.status ?? "proposed",
              JSON.stringify(recommendation.findingIds ?? []),
              JSON.stringify(recommendation.evidence ?? []),
              JSON.stringify(recommendation.replacesSubjects ?? []),
              JSON.stringify(recommendation.candidateProjects ?? []),
              recommendation.migrationCost ?? null,
              recommendation.expectedCompatibilityGain ?? null,
              JSON.stringify(recommendation.steps ?? []),
              1,
              recommendationSet.createdAt
            ]
          );

          for (const impact of recommendation.impacts ?? []) {
            await client.query(
              `INSERT INTO recommendation_impacts (
                id, recommendation_id, impact_type, impact_value, schema_version, created_at
              ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
              [
                `${recommendation.recommendationId}:${impact.impactType}`,
                recommendation.recommendationId,
                impact.impactType,
                JSON.stringify(impact),
                1,
                recommendationSet.createdAt
              ]
            );
          }
        }

        for (const bundle of recommendationSet.bundles) {
          await client.query(
            `INSERT INTO recommendation_bundles (
              id, recommendation_set_id, strategy, recommendation_ids, summary, rationale,
              migration_cost, expected_compatibility_gain, schema_version, created_at
            ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
            [
              bundle.bundleId,
              recommendationSet.recommendationSetId,
              bundle.strategy,
              JSON.stringify(bundle.recommendationIds),
              bundle.summary,
              bundle.rationale,
              bundle.migrationCost,
              bundle.expectedCompatibilityGain,
              bundle.schemaVersion,
              bundle.createdAt
            ]
          );
        }

        for (const item of feedback) {
          await client.query(
            `INSERT INTO recommendation_feedback (
              id, recommendation_set_id, recommendation_id, feedback_type, note, created_by,
              schema_version, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              item.feedbackId,
              item.recommendationSetId,
              item.recommendationId,
              item.feedbackType,
              item.note ?? null,
              item.createdBy,
              item.schemaVersion,
              item.createdAt
            ]
          );
        }

        if (latestOutcome) {
          await client.query(
            `INSERT INTO recommendation_outcomes (
              id, recommendation_set_id, status, applied_recommendation_ids,
              validation_summary, created_by, schema_version, created_at
            ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
            [
              latestOutcome.outcomeId,
              latestOutcome.recommendationSetId,
              latestOutcome.status,
              JSON.stringify(latestOutcome.appliedRecommendationIds),
              latestOutcome.validationSummary,
              latestOutcome.createdBy,
              latestOutcome.schemaVersion,
              latestOutcome.createdAt
            ]
          );
        }
      }

      if (record.artifacts.length > 0) {
        const artifactRunId = `aar_run_${analysisId}`;
        await client.query(
          `INSERT INTO artifact_analysis_runs (
            id, analysis_id, pack_snapshot_id, organization_id, tenant_id, status,
            schema_version, trace_id, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            artifactRunId,
            analysisId,
            prerequisites.persistedSnapshotId,
            tenantId,
            tenantId,
            "completed",
            1,
            null,
            record.summary.finishedAt ?? record.summary.createdAt
          ]
        );

        for (const artifact of record.artifacts) {
          await client.query(
            `INSERT INTO artifact_analysis_outputs (
              id, artifact_analysis_run_id, canonical_project_id, canonical_version_id, metadata,
              mixin_targets, class_targets, resource_targets, embedded_libraries,
              fingerprint, schema_version, created_at
            ) VALUES (
              $1, $2, $3, $4, $5::jsonb,
              $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
              $10, $11, $12
            )`,
            [
              artifact.artifactAnalysisId,
              artifactRunId,
              artifact.projectId,
              artifact.versionId ?? null,
              JSON.stringify(artifact.metadata),
              JSON.stringify(artifact.mixinTargets),
              JSON.stringify(artifact.classTargets),
              JSON.stringify(artifact.resourceTargets),
              JSON.stringify(artifact.embeddedLibraries),
              artifact.fingerprint,
              artifact.schemaVersion,
              artifact.createdAt
            ]
          );
        }
      }

      for (const featureVector of record.featureVectors) {
        await client.query(
          `INSERT INTO finding_feature_vectors (
            id, analysis_id, finding_id, feature_namespace, feature_values, label,
            schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [
            featureVector.featureVectorId,
            analysisId,
            featureVector.findingId,
            featureVector.featureNamespace,
            JSON.stringify(featureVector.featureValues),
            featureVector.label ?? null,
            featureVector.schemaVersion,
            featureVector.createdAt
          ]
        );
      }

      if (record.featureDataset) {
        await client.query(
          `INSERT INTO offline_datasets (
            id, analysis_id, dataset_kind, feature_vector_ids, summary, schema_version, created_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
          [
            record.featureDataset.datasetId,
            analysisId,
            record.featureDataset.datasetKind,
            JSON.stringify(record.featureDataset.featureVectorIds),
            JSON.stringify(record.featureDataset.summary),
            record.featureDataset.schemaVersion,
            record.featureDataset.createdAt
          ]
        );
      }

      for (const score of record.calibratedScores) {
        await client.query(
          `INSERT INTO calibrated_finding_scores (
            id, analysis_id, finding_id, model_id, original_confidence, calibrated_confidence,
            predicted_risk_score, rationale, schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
          [
            score.calibratedFindingScoreId,
            analysisId,
            score.findingId,
            score.modelId,
            score.originalConfidence,
            score.calibratedConfidence,
            score.predictedRiskScore,
            JSON.stringify(score.rationale),
            score.schemaVersion,
            score.createdAt
          ]
        );
      }

      if (record.reviewSummary) {
        await client.query(
          `INSERT INTO pack_review_summaries (
            id, analysis_id, model_id, review_json, schema_version, created_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            record.reviewSummary.reviewSummaryId,
            analysisId,
            record.reviewSummary.modelId,
            JSON.stringify(record.reviewSummary),
            record.reviewSummary.schemaVersion,
            record.reviewSummary.createdAt
          ]
        );
      }

      if (record.simulationRun) {
        await client.query(
          `INSERT INTO simulation_runs (
            id, analysis_id, pack_snapshot_id, recipe_id, status, summary,
            observations, schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
          [
            record.simulationRun.simulationRunId,
            analysisId,
            prerequisites.persistedSnapshotId,
            record.simulationRun.recipeId,
            record.simulationRun.status,
            record.simulationRun.summary,
            JSON.stringify(record.simulationRun.observations),
            record.simulationRun.schemaVersion,
            record.simulationRun.createdAt
          ]
        );
      }

      if (record.releaseGateDecision) {
        await client.query(
          `INSERT INTO release_gate_decisions (
            id, analysis_id, policy_key, status, summary, reasons, blocking_finding_ids,
            simulation_run_id, schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
          [
            record.releaseGateDecision.releaseGateDecisionId,
            analysisId,
            record.releaseGateDecision.policyKey,
            record.releaseGateDecision.status,
            record.releaseGateDecision.summary,
            JSON.stringify(record.releaseGateDecision.reasons),
            JSON.stringify(record.releaseGateDecision.blockingFindingIds),
            record.releaseGateDecision.simulationRunId ?? null,
            record.releaseGateDecision.schemaVersion,
            record.releaseGateDecision.createdAt
          ]
        );
      }

      if (record.statusCheck) {
        await client.query(
          `INSERT INTO status_check_results (
            id, analysis_id, installation_id, conclusion, summary, details_url,
            schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            record.statusCheck.statusCheckId,
            analysisId,
            record.statusCheck.installationId ?? null,
            record.statusCheck.conclusion,
            record.statusCheck.summary,
            record.statusCheck.detailsUrl,
            record.statusCheck.schemaVersion,
            record.statusCheck.createdAt
          ]
        );
      }

      const deliveries = this.repository.webhookDeliveries.get(analysisId) ?? [];
      for (const delivery of deliveries) {
        await client.query(
          `INSERT INTO webhook_delivery_attempts (
            id, webhook_id, analysis_id, event_type, status, payload, schema_version, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [
            delivery.deliveryId,
            delivery.webhookId,
            analysisId,
            delivery.eventType,
            delivery.status,
            JSON.stringify(delivery.payload),
            delivery.schemaVersion,
            delivery.createdAt
          ]
        );
      }

      if (report) {
        await client.query(
          `INSERT INTO analysis_reports (
            id, analysis_id, recommendation_set_id, report_json, schema_version, created_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            report.reportId,
            analysisId,
            report.recommendationSet?.recommendationSetId ?? null,
            JSON.stringify(report),
            1,
            record.summary.finishedAt ?? record.summary.createdAt
          ]
        );
      }

      if (record.packDiff) {
        await persistPackDiff(client, this.repository, {
          ...record.packDiff,
          baseSnapshotId:
            (await resolvePersistedSnapshotId(
              client,
              this.repository,
              record.packDiff.baseSnapshotId
            )) ?? record.packDiff.baseSnapshotId,
          targetSnapshotId:
            (await resolvePersistedSnapshotId(
              client,
              this.repository,
              record.packDiff.targetSnapshotId
            )) ?? record.packDiff.targetSnapshotId
        });
      }

      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readImportsForProject(projectId: string): Promise<PackImport[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM pack_imports
       WHERE project_id = $1
       ORDER BY created_at ASC`,
      [projectId]
    );

    return result.rows.map((row) => ({
      importId: String(row.id),
      projectId: String(row.project_id),
      organizationId: String(row.organization_id),
      tenantId: String(row.tenant_id),
      sourceType: row.source_type,
      status: row.status,
      sourceRef: row.source_ref ? String(row.source_ref) : undefined,
      packSnapshotId: row.pack_snapshot_id ? String(row.pack_snapshot_id) : undefined,
      environment: parseJsonValue(row.environment, undefined),
      schemaVersion: Number(row.schema_version),
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined
    })) as PackImport[];
  }

  async hydrateImportsForProject(projectId: string) {
    const imports = await this.readImportsForProject(projectId);
    for (const importRecord of imports) {
      this.repository.imports.set(importRecord.importId, importRecord);
    }
    return imports;
  }

  async readOrganization(organizationId: string) {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM organizations
       WHERE id = $1
       LIMIT 1`,
      [organizationId]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0];
    return {
      organizationId: String(row.id),
      tenantId: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    };
  }

  async hydrateOrganization(organizationId: string) {
    const organization = await this.readOrganization(organizationId);
    if (organization) {
      this.repository.organizations.set(organization.organizationId, organization);
    }
    return organization;
  }

  async readUser(userId: string) {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0];
    return {
      userId: String(row.id),
      tenantId: "global",
      email: String(row.email),
      displayName: row.display_name ? String(row.display_name) : String(row.email),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    } satisfies UserIdentity;
  }

  async hydrateUser(userId: string) {
    const user = await this.readUser(userId);
    if (user) {
      this.repository.users.set(user.userId, user);
    }
    return user;
  }

  async readMembershipsForUser(userId: string, organizationId?: string) {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const query = organizationId
      ? {
          text: `SELECT *
                 FROM organization_memberships
                 WHERE user_id = $1 AND organization_id = $2
                 ORDER BY created_at ASC`,
          values: [userId, organizationId]
        }
      : {
          text: `SELECT *
                 FROM organization_memberships
                 WHERE user_id = $1
                 ORDER BY created_at ASC`,
          values: [userId]
        };
    const result = await this.getPool().query(query.text, query.values);

    return result.rows.map((row) => ({
      organizationId: String(row.organization_id),
      userId: String(row.user_id),
      role: row.role as OrganizationMembership["role"],
      tenantId: String(row.organization_id),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    }));
  }

  async hydrateMembershipsForUser(userId: string, organizationId?: string) {
    const memberships = await this.readMembershipsForUser(userId, organizationId);
    for (const membership of memberships) {
      this.repository.memberships.set(
        `${membership.organizationId}:${membership.userId}`,
        membership
      );
      await this.hydrateOrganization(membership.organizationId);
    }
    return memberships;
  }

  async readWorkspace(workspaceId: string) {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM workspaces
       WHERE id = $1
       LIMIT 1`,
      [workspaceId]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0];
    return {
      workspaceId: String(row.id),
      organizationId: String(row.organization_id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      slug: String(row.slug),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    };
  }

  async hydrateWorkspace(workspaceId: string) {
    const workspace = await this.readWorkspace(workspaceId);
    if (workspace) {
      this.repository.workspaces.set(workspace.workspaceId, workspace);
      await this.hydrateOrganization(workspace.organizationId);
    }
    return workspace;
  }

  async readProject(projectId: string) {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM projects
       WHERE id = $1
       LIMIT 1`,
      [projectId]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0];
    return {
      projectId: String(row.id),
      workspaceId: String(row.workspace_id),
      organizationId: String(row.organization_id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      slug: String(row.slug),
      visibility: row.visibility,
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    };
  }

  async hydrateProject(projectId: string) {
    const project = await this.readProject(projectId);
    if (project) {
      this.repository.projects.set(project.projectId, project);
      await this.hydrateWorkspace(project.workspaceId);
      await this.hydrateOrganization(project.organizationId);
    }
    return project;
  }

  async readWorkspacesForOrganization(organizationId: string) {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM workspaces
       WHERE organization_id = $1
       ORDER BY created_at ASC`,
      [organizationId]
    );

    return result.rows.map((row) => ({
      workspaceId: String(row.id),
      organizationId: String(row.organization_id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      slug: String(row.slug),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    } satisfies Workspace));
  }

  async hydrateWorkspacesForOrganization(organizationId: string) {
    const workspaces = await this.readWorkspacesForOrganization(organizationId);
    for (const workspace of workspaces) {
      this.repository.workspaces.set(workspace.workspaceId, workspace);
    }
    return workspaces;
  }

  async readProjectsForOrganization(organizationId: string) {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM projects
       WHERE organization_id = $1
       ORDER BY created_at ASC`,
      [organizationId]
    );

    return result.rows.map((row) => ({
      projectId: String(row.id),
      workspaceId: String(row.workspace_id),
      organizationId: String(row.organization_id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      slug: String(row.slug),
      visibility: row.visibility as Project["visibility"],
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    } satisfies Project));
  }

  async hydrateProjectsForOrganization(organizationId: string) {
    const projects = await this.readProjectsForOrganization(organizationId);
    for (const project of projects) {
      this.repository.projects.set(project.projectId, project);
    }
    return projects;
  }

  async readApiKeysForOrganization(organizationId: string) {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM api_keys
       WHERE organization_id = $1
       ORDER BY created_at ASC`,
      [organizationId]
    );

    return result.rows.map((row) => ({
      apiKeyId: String(row.id),
      organizationId: String(row.organization_id),
      tenantId: String(row.organization_id),
      createdBy: row.created_by ? String(row.created_by) : "system",
      name: String(row.name),
      keyPrefix: String(row.key_prefix),
      scopes: parseJsonValue<ApiKeyRecord["scopes"]>(row.scopes, []),
      lastUsedAt: toTimestampString(row.last_used_at),
      revokedAt: toTimestampString(row.revoked_at),
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    }));
  }

  async hydrateApiKeysForOrganization(organizationId: string) {
    const apiKeys = await this.readApiKeysForOrganization(organizationId);
    for (const apiKey of apiKeys) {
      this.repository.apiKeys.set(apiKey.apiKeyId, {
        ...apiKey,
        secret: ""
      });
    }
    return apiKeys;
  }

  async hydrateSessionIdentity(input: { organizationId: string; userId: string }) {
    const [user, organization, memberships, workspaces, projects, apiKeys] = await Promise.all([
      this.hydrateUser(input.userId),
      this.hydrateOrganization(input.organizationId),
      this.hydrateMembershipsForUser(input.userId, input.organizationId),
      this.hydrateWorkspacesForOrganization(input.organizationId),
      this.hydrateProjectsForOrganization(input.organizationId),
      this.hydrateApiKeysForOrganization(input.organizationId)
    ]);

    return {
      user,
      organization,
      memberships,
      workspaces,
      projects,
      apiKeys
    };
  }

  async readRecentSnapshotIds(limit = 100): Promise<string[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT id
       FROM pack_snapshots
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => String(row.id));
  }

  async persistGroundTruthCandidate(candidate: GroundTruthCandidate) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO ground_truth_candidates (
        id, candidate_kind, pack_snapshot_id, pack_fingerprint, environment, dedupe_key,
        execution_profile_key, discovered_from, status, priority, attempts, latest_run_id,
        latest_verdict, tenant_id, trace_id, schema_version, created_at, updated_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        attempts = EXCLUDED.attempts,
        latest_run_id = EXCLUDED.latest_run_id,
        latest_verdict = EXCLUDED.latest_verdict,
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at`,
      [
        candidate.candidateId,
        candidate.candidateKind,
        candidate.packSnapshotId,
        candidate.packFingerprint,
        JSON.stringify(candidate.environment),
        candidate.dedupeKey,
        candidate.executionProfileKey,
        candidate.discoveredFrom ?? null,
        candidate.status,
        candidate.priority,
        candidate.attempts,
        candidate.latestRunId ?? null,
        candidate.latestVerdict ?? null,
        candidate.tenantId ?? null,
        candidate.traceId ?? null,
        candidate.schemaVersion,
        candidate.createdAt,
        candidate.updatedAt,
        candidate.completedAt ?? null
      ]
    );

    return { persisted: true };
  }

  async persistGroundTruthRun(run: GroundTruthRun) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO ground_truth_runs (
        id, candidate_id, pack_snapshot_id, pack_fingerprint, environment, execution_profile_key,
        status, verdict, reached_main_menu, reached_world, exit_code, duration_ms, summary,
        observations, stdout_text, stderr_text, artifact_directory, raw_result, tenant_id,
        trace_id, schema_version, created_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14::jsonb, $15, $16, $17, $18::jsonb, $19,
        $20, $21, $22
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        verdict = EXCLUDED.verdict,
        reached_main_menu = EXCLUDED.reached_main_menu,
        reached_world = EXCLUDED.reached_world,
        exit_code = EXCLUDED.exit_code,
        duration_ms = EXCLUDED.duration_ms,
        summary = EXCLUDED.summary,
        observations = EXCLUDED.observations,
        stdout_text = EXCLUDED.stdout_text,
        stderr_text = EXCLUDED.stderr_text,
        artifact_directory = EXCLUDED.artifact_directory,
        raw_result = EXCLUDED.raw_result`,
      [
        run.groundTruthRunId,
        run.candidateId,
        run.packSnapshotId,
        run.packFingerprint,
        JSON.stringify(run.environment),
        run.executionProfileKey,
        run.status,
        run.verdict,
        run.reachedMainMenu,
        run.reachedWorld,
        run.exitCode ?? null,
        run.durationMs,
        run.summary,
        JSON.stringify(run.observations),
        run.stdoutText ?? null,
        run.stderrText ?? null,
        run.artifactDirectory ?? null,
        run.rawResult ? JSON.stringify(run.rawResult) : null,
        run.tenantId ?? null,
        run.traceId ?? null,
        run.schemaVersion,
        run.createdAt
      ]
    );

    return { persisted: true };
  }

  async persistGroundTruthExactPackRecord(record: GroundTruthExactPackRecord) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO ground_truth_exact_pack_records (
        id, ground_truth_snapshot_id, pack_fingerprint, pack_snapshot_id, environment,
        execution_profile_key, verdict, confidence, run_ids, latest_run_id, summary,
        reproducibility_score, tenant_id, trace_id, schema_version, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb,
        $6, $7, $8::jsonb, $9::jsonb, $10, $11,
        $12, $13, $14, $15, $16, $17
      )
      ON CONFLICT (pack_fingerprint, execution_profile_key, environment) DO UPDATE SET
        ground_truth_snapshot_id = EXCLUDED.ground_truth_snapshot_id,
        verdict = EXCLUDED.verdict,
        confidence = EXCLUDED.confidence,
        run_ids = EXCLUDED.run_ids,
        latest_run_id = EXCLUDED.latest_run_id,
        summary = EXCLUDED.summary,
        reproducibility_score = EXCLUDED.reproducibility_score,
        updated_at = EXCLUDED.updated_at`,
      [
        record.groundTruthExactPackRecordId,
        record.groundTruthSnapshotId ?? null,
        record.packFingerprint,
        record.packSnapshotId,
        JSON.stringify(record.environment),
        record.executionProfileKey,
        record.verdict,
        JSON.stringify(record.confidence),
        JSON.stringify(record.runIds),
        record.latestRunId,
        record.summary,
        record.reproducibilityScore,
        record.tenantId ?? null,
        record.traceId ?? null,
        record.schemaVersion,
        record.createdAt,
        record.updatedAt
      ]
    );

    return { persisted: true };
  }

  async persistGroundTruthKnowledgeSnapshot(snapshot: GroundTruthKnowledgeSnapshot) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    await this.getPool().query(
      `INSERT INTO ground_truth_knowledge_snapshots (
        id, version, status, record_count, included_record_ids, checksums, created_by,
        activated_at, tenant_id, trace_id, schema_version, created_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
        $8, $9, $10, $11, $12
      )
      ON CONFLICT (id) DO UPDATE SET
        version = EXCLUDED.version,
        status = EXCLUDED.status,
        record_count = EXCLUDED.record_count,
        included_record_ids = EXCLUDED.included_record_ids,
        checksums = EXCLUDED.checksums,
        created_by = EXCLUDED.created_by,
        activated_at = EXCLUDED.activated_at`,
      [
        snapshot.groundTruthSnapshotId,
        snapshot.version,
        snapshot.status,
        snapshot.recordCount,
        JSON.stringify(snapshot.includedRecordIds),
        JSON.stringify(snapshot.checksums),
        snapshot.createdBy ?? null,
        snapshot.activatedAt ?? null,
        snapshot.tenantId ?? null,
        snapshot.traceId ?? null,
        snapshot.schemaVersion,
        snapshot.createdAt
      ]
    );

    return { persisted: true };
  }

  async compactGroundTruthKnowledgeState() {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");

      await client.query(`
        CREATE TEMP TABLE compact_ground_truth_snapshot_ids
        ON COMMIT DROP AS
        SELECT DISTINCT pack_snapshot_id
        FROM (
          SELECT pack_snapshot_id FROM ground_truth_exact_pack_records
          UNION ALL
          SELECT pack_snapshot_id FROM ground_truth_runs
          UNION ALL
          SELECT pack_snapshot_id FROM ground_truth_candidates
        ) referenced_snapshots
      `);

      const repairedFacts = await client.query(`
        WITH repair AS (
          SELECT exact_record.id AS record_id, replacement.id AS replacement_snapshot_id
          FROM ground_truth_exact_pack_records exact_record
          LEFT JOIN pack_snapshots current_snapshot
            ON current_snapshot.id = exact_record.pack_snapshot_id
          JOIN LATERAL (
            SELECT snapshot.id
            FROM pack_snapshots snapshot
            WHERE snapshot.normalized_hash = exact_record.pack_fingerprint
            ORDER BY snapshot.created_at DESC, snapshot.id DESC
            LIMIT 1
          ) replacement ON true
          WHERE current_snapshot.id IS NULL
        )
        UPDATE ground_truth_exact_pack_records exact_record
        SET pack_snapshot_id = repair.replacement_snapshot_id,
            updated_at = now()
        FROM repair
        WHERE exact_record.id = repair.record_id
        RETURNING exact_record.id
      `);

      const repairedRuns = await client.query(`
        WITH repair AS (
          SELECT run.id AS run_id, replacement.id AS replacement_snapshot_id
          FROM ground_truth_runs run
          LEFT JOIN pack_snapshots current_snapshot
            ON current_snapshot.id = run.pack_snapshot_id
          JOIN LATERAL (
            SELECT snapshot.id
            FROM pack_snapshots snapshot
            WHERE snapshot.normalized_hash = run.pack_fingerprint
            ORDER BY snapshot.created_at DESC, snapshot.id DESC
            LIMIT 1
          ) replacement ON true
          WHERE current_snapshot.id IS NULL
        )
        UPDATE ground_truth_runs run
        SET pack_snapshot_id = repair.replacement_snapshot_id
        FROM repair
        WHERE run.id = repair.run_id
        RETURNING run.id
      `);

      const repairedCandidates = await client.query(`
        WITH repair AS (
          SELECT candidate.id AS candidate_id, replacement.id AS replacement_snapshot_id
          FROM ground_truth_candidates candidate
          LEFT JOIN pack_snapshots current_snapshot
            ON current_snapshot.id = candidate.pack_snapshot_id
          JOIN LATERAL (
            SELECT snapshot.id
            FROM pack_snapshots snapshot
            WHERE snapshot.normalized_hash = candidate.pack_fingerprint
            ORDER BY snapshot.created_at DESC, snapshot.id DESC
            LIMIT 1
          ) replacement ON true
          WHERE current_snapshot.id IS NULL
        )
        UPDATE ground_truth_candidates candidate
        SET pack_snapshot_id = repair.replacement_snapshot_id,
            updated_at = now()
        FROM repair
        WHERE candidate.id = repair.candidate_id
        RETURNING candidate.id
      `);

      const removedUnsettledFacts = await client.query(`
        DELETE FROM ground_truth_exact_pack_records
        WHERE verdict NOT IN ('passed_startup_and_world', 'failed_startup', 'failed_world_load')
        RETURNING id
      `);

      const removedFactsWithoutSnapshots = await client.query(`
        DELETE FROM ground_truth_exact_pack_records exact_record
        WHERE NOT EXISTS (
          SELECT 1
          FROM pack_snapshots snapshot
          WHERE snapshot.id = exact_record.pack_snapshot_id
        )
        RETURNING exact_record.id
      `);

      const canonicalizedFacts = await client.query(`
        WITH selected_runs AS (
          SELECT exact_record.id AS record_id, run.id AS run_id
          FROM ground_truth_exact_pack_records exact_record
          JOIN LATERAL (
            SELECT run.id
            FROM ground_truth_runs run
            WHERE run.pack_fingerprint = exact_record.pack_fingerprint
              AND run.execution_profile_key = exact_record.execution_profile_key
              AND run.environment = exact_record.environment
              AND run.verdict = exact_record.verdict
            ORDER BY (run.id = exact_record.latest_run_id) DESC, run.created_at DESC, run.id DESC
            LIMIT 1
          ) run ON true
        )
        UPDATE ground_truth_exact_pack_records exact_record
        SET latest_run_id = selected_runs.run_id,
            run_ids = jsonb_build_array(selected_runs.run_id),
            updated_at = now()
        FROM selected_runs
        WHERE exact_record.id = selected_runs.record_id
        RETURNING exact_record.id
      `);

      const removedFactsWithoutRuns = await client.query(`
        DELETE FROM ground_truth_exact_pack_records exact_record
        WHERE NOT EXISTS (
          SELECT 1
          FROM ground_truth_runs run
          WHERE run.id = exact_record.latest_run_id
        )
        RETURNING exact_record.id
      `);

      const deletedRuns = await client.query(`
        DELETE FROM ground_truth_runs run
        WHERE NOT EXISTS (
          SELECT 1
          FROM ground_truth_exact_pack_records exact_record
          WHERE exact_record.latest_run_id = run.id
        )
        RETURNING run.id
      `);

      const deletedCompletedCandidates = await client.query(`
        DELETE FROM ground_truth_candidates candidate
        WHERE candidate.status <> 'queued'
          AND NOT EXISTS (
            SELECT 1
            FROM ground_truth_runs run
            WHERE run.candidate_id = candidate.id
          )
        RETURNING candidate.id
      `);

      const deletedQueuedAlreadySettled = await client.query(`
        DELETE FROM ground_truth_candidates candidate
        WHERE candidate.status = 'queued'
          AND EXISTS (
            SELECT 1
            FROM ground_truth_exact_pack_records exact_record
            WHERE exact_record.pack_fingerprint = candidate.pack_fingerprint
              AND exact_record.execution_profile_key = candidate.execution_profile_key
              AND exact_record.environment = candidate.environment
          )
        RETURNING candidate.id
      `);

      const deletedDuplicateQueued = await client.query(`
        WITH ranked AS (
          SELECT id,
                 row_number() OVER (
                   PARTITION BY pack_fingerprint, execution_profile_key, environment::text
                   ORDER BY created_at DESC, id DESC
                 ) AS rank
          FROM ground_truth_candidates
          WHERE status = 'queued'
        )
        DELETE FROM ground_truth_candidates candidate
        USING ranked
        WHERE candidate.id = ranked.id
          AND ranked.rank > 1
        RETURNING candidate.id
      `);

      const latestSnapshotResult = await client.query(`
        SELECT id
        FROM ground_truth_knowledge_snapshots
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `);
      const latestSnapshotId = latestSnapshotResult.rows[0]
        ? String((latestSnapshotResult.rows[0] as JsonRow).id)
        : undefined;
      let deletedKnowledgeSnapshots = 0;
      if (latestSnapshotId) {
        const includedRecords = await client.query(`
          SELECT COALESCE(jsonb_agg(id ORDER BY updated_at DESC, id DESC), '[]'::jsonb) AS ids,
                 COUNT(*)::int AS count
          FROM ground_truth_exact_pack_records
        `);
        const includedRecordIds = includedRecords.rows[0]?.ids ?? [];
        const recordCount = Number(includedRecords.rows[0]?.count ?? 0);
        await client.query(
          `UPDATE ground_truth_exact_pack_records
           SET ground_truth_snapshot_id = $1`,
          [latestSnapshotId]
        );
        await client.query(
          `UPDATE ground_truth_knowledge_snapshots
           SET status = 'promoted',
               record_count = $2,
               included_record_ids = $3::jsonb,
               checksums = jsonb_build_object(
                 'compactedAt', now()::text,
                 'recordCount', $2::int
               ),
               activated_at = COALESCE(activated_at, now())
           WHERE id = $1`,
          [latestSnapshotId, recordCount, JSON.stringify(includedRecordIds)]
        );
        const deleteSnapshotsResult = await client.query(
          `DELETE FROM ground_truth_knowledge_snapshots
           WHERE id <> $1
           RETURNING id`,
          [latestSnapshotId]
        );
        deletedKnowledgeSnapshots = deleteSnapshotsResult.rowCount ?? 0;
      }

      const deletedSnapshotMods = await client.query(`
        DELETE FROM pack_snapshot_mods mod
        WHERE mod.pack_snapshot_id IN (
          SELECT pack_snapshot_id FROM compact_ground_truth_snapshot_ids
        )
          AND NOT EXISTS (
            SELECT 1
            FROM ground_truth_exact_pack_records exact_record
            WHERE exact_record.pack_snapshot_id = mod.pack_snapshot_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ground_truth_candidates candidate
            WHERE candidate.pack_snapshot_id = mod.pack_snapshot_id
          )
        RETURNING mod.id
      `);

      const deletedPackSnapshots = await client.query(`
        DELETE FROM pack_snapshots snapshot
        WHERE snapshot.id IN (
          SELECT pack_snapshot_id FROM compact_ground_truth_snapshot_ids
        )
          AND NOT EXISTS (
            SELECT 1
            FROM ground_truth_exact_pack_records exact_record
            WHERE exact_record.pack_snapshot_id = snapshot.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ground_truth_candidates candidate
            WHERE candidate.pack_snapshot_id = snapshot.id
          )
        RETURNING snapshot.id
      `);

      await client.query(`
        DELETE FROM pack_environment_profiles environment
        WHERE NOT EXISTS (
          SELECT 1
          FROM pack_snapshots snapshot
          WHERE snapshot.environment_profile_id = environment.id
        )
      `);

      await client.query("COMMIT");
      return {
        persisted: true,
        repairedFacts: repairedFacts.rowCount ?? 0,
        repairedRuns: repairedRuns.rowCount ?? 0,
        repairedCandidates: repairedCandidates.rowCount ?? 0,
        removedUnsettledFacts: removedUnsettledFacts.rowCount ?? 0,
        removedFactsWithoutSnapshots: removedFactsWithoutSnapshots.rowCount ?? 0,
        removedFactsWithoutRuns: removedFactsWithoutRuns.rowCount ?? 0,
        canonicalizedFacts: canonicalizedFacts.rowCount ?? 0,
        deletedRuns: deletedRuns.rowCount ?? 0,
        deletedCompletedCandidates: deletedCompletedCandidates.rowCount ?? 0,
        deletedQueuedAlreadySettled: deletedQueuedAlreadySettled.rowCount ?? 0,
        deletedDuplicateQueued: deletedDuplicateQueued.rowCount ?? 0,
        deletedKnowledgeSnapshots,
        deletedSnapshotMods: deletedSnapshotMods.rowCount ?? 0,
        deletedPackSnapshots: deletedPackSnapshots.rowCount ?? 0
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async hydrateGroundTruthState() {
    if (!this.isEnabled()) {
      return {
        candidateCount: this.repository.groundTruthCandidates.size,
        runCount: this.repository.groundTruthRuns.size,
        recordCount: this.repository.groundTruthExactPackRecords.size,
        snapshotCount: this.repository.groundTruthKnowledgeSnapshots.size
      };
    }

    await this.ensureSchema();
    const pool = this.getPool();
    const [candidateResult, runResult, recordResult, snapshotResult] = await Promise.all([
      pool.query("SELECT * FROM ground_truth_candidates ORDER BY created_at ASC"),
      pool.query("SELECT * FROM ground_truth_runs ORDER BY created_at ASC"),
      pool.query("SELECT * FROM ground_truth_exact_pack_records ORDER BY updated_at ASC"),
      pool.query("SELECT * FROM ground_truth_knowledge_snapshots ORDER BY created_at ASC")
    ]);

    this.repository.groundTruthCandidates.clear();
    for (const row of candidateResult.rows as JsonRow[]) {
      const candidate: GroundTruthCandidate = {
        candidateId: String(row.id),
        candidateKind: "pack_snapshot",
        packSnapshotId: String(row.pack_snapshot_id),
        packFingerprint: String(row.pack_fingerprint),
        environment: parseJsonValue(row.environment, {
          minecraftVersion: "",
          loader: "unknown",
          javaVersion: "",
          side: "both"
        }),
        dedupeKey: String(row.dedupe_key),
        executionProfileKey: String(row.execution_profile_key),
        discoveredFrom: row.discovered_from ? String(row.discovered_from) : undefined,
        status: row.status as GroundTruthCandidate["status"],
        priority: Number(row.priority),
        attempts: Number(row.attempts),
        latestRunId: row.latest_run_id ? String(row.latest_run_id) : undefined,
        latestVerdict: row.latest_verdict as GroundTruthCandidate["latestVerdict"],
        tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
        traceId: row.trace_id ? String(row.trace_id) : undefined,
        schemaVersion: Number(row.schema_version),
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString(),
        updatedAt: toTimestampString(row.updated_at) ?? new Date(0).toISOString(),
        completedAt: toTimestampString(row.completed_at)
      };
      this.repository.groundTruthCandidates.set(candidate.candidateId, candidate);
    }

    this.repository.groundTruthRuns.clear();
    for (const row of runResult.rows as JsonRow[]) {
      const run: GroundTruthRun = {
        groundTruthRunId: String(row.id),
        candidateId: String(row.candidate_id),
        packSnapshotId: String(row.pack_snapshot_id),
        packFingerprint: String(row.pack_fingerprint),
        environment: parseJsonValue(row.environment, {
          minecraftVersion: "",
          loader: "unknown",
          javaVersion: "",
          side: "both"
        }),
        executionProfileKey: String(row.execution_profile_key),
        status: row.status as GroundTruthRun["status"],
        verdict: row.verdict as GroundTruthRun["verdict"],
        reachedMainMenu: Boolean(row.reached_main_menu),
        reachedWorld: Boolean(row.reached_world),
        exitCode: row.exit_code === null || row.exit_code === undefined ? undefined : Number(row.exit_code),
        durationMs: Number(row.duration_ms),
        summary: String(row.summary),
        observations: parseJsonValue(row.observations, []),
        stdoutText: row.stdout_text ? String(row.stdout_text) : undefined,
        stderrText: row.stderr_text ? String(row.stderr_text) : undefined,
        artifactDirectory: row.artifact_directory ? String(row.artifact_directory) : undefined,
        rawResult: parseJsonValue(row.raw_result, undefined),
        tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
        traceId: row.trace_id ? String(row.trace_id) : undefined,
        schemaVersion: Number(row.schema_version),
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
      };
      this.repository.groundTruthRuns.set(run.groundTruthRunId, run);
    }

    this.repository.groundTruthExactPackRecords.clear();
    this.repository.groundTruthExactPackRecordByKey.clear();
    for (const row of recordResult.rows as JsonRow[]) {
      const record: GroundTruthExactPackRecord = {
        groundTruthExactPackRecordId: String(row.id),
        groundTruthSnapshotId: row.ground_truth_snapshot_id
          ? String(row.ground_truth_snapshot_id)
          : undefined,
        packFingerprint: String(row.pack_fingerprint),
        packSnapshotId: String(row.pack_snapshot_id),
        environment: parseJsonValue(row.environment, {
          minecraftVersion: "",
          loader: "unknown",
          javaVersion: "",
          side: "both"
        }),
        executionProfileKey: String(row.execution_profile_key),
        verdict: row.verdict as GroundTruthExactPackRecord["verdict"],
        confidence: parseJsonValue(row.confidence, {
          score: 0,
          band: "very_low",
          explanation: "",
          primaryDrivers: []
        }),
        runIds: parseJsonValue(row.run_ids, []),
        latestRunId: String(row.latest_run_id),
        summary: String(row.summary),
        reproducibilityScore: Number(row.reproducibility_score),
        tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
        traceId: row.trace_id ? String(row.trace_id) : undefined,
        schemaVersion: Number(row.schema_version),
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString(),
        updatedAt: toTimestampString(row.updated_at) ?? new Date(0).toISOString()
      };
      this.repository.groundTruthExactPackRecords.set(record.groundTruthExactPackRecordId, record);
      this.repository.groundTruthExactPackRecordByKey.set(
        stableHash({
          packFingerprint: record.packFingerprint,
          executionProfileKey: record.executionProfileKey,
          environment: record.environment
        }),
        record.groundTruthExactPackRecordId
      );
    }

    this.repository.groundTruthKnowledgeSnapshots.clear();
    this.repository.groundTruthKnowledgeSnapshotsByVersion.clear();
    for (const row of snapshotResult.rows as JsonRow[]) {
      const snapshot: GroundTruthKnowledgeSnapshot = {
        groundTruthSnapshotId: String(row.id),
        version: String(row.version),
        status: row.status as GroundTruthKnowledgeSnapshot["status"],
        recordCount: Number(row.record_count),
        includedRecordIds: parseJsonValue(row.included_record_ids, []),
        checksums: parseJsonValue(row.checksums, {}),
        createdBy: row.created_by ? String(row.created_by) : undefined,
        activatedAt: toTimestampString(row.activated_at),
        tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
        traceId: row.trace_id ? String(row.trace_id) : undefined,
        schemaVersion: Number(row.schema_version),
        createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
      };
      this.repository.groundTruthKnowledgeSnapshots.set(
        snapshot.groundTruthSnapshotId,
        snapshot
      );
      this.repository.groundTruthKnowledgeSnapshotsByVersion.set(
        snapshot.version,
        snapshot.groundTruthSnapshotId
      );
    }

    const referencedPackSnapshotIds = new Set<string>();
    for (const candidate of this.repository.groundTruthCandidates.values()) {
      referencedPackSnapshotIds.add(candidate.packSnapshotId);
    }
    for (const record of this.repository.groundTruthExactPackRecords.values()) {
      referencedPackSnapshotIds.add(record.packSnapshotId);
    }
    await Promise.all(
      [...referencedPackSnapshotIds].map((packSnapshotId) => this.hydrateSnapshot(packSnapshotId))
    );

    return {
      candidateCount: this.repository.groundTruthCandidates.size,
      runCount: this.repository.groundTruthRuns.size,
      recordCount: this.repository.groundTruthExactPackRecords.size,
      snapshotCount: this.repository.groundTruthKnowledgeSnapshots.size
    };
  }

  async readSnapshot(packSnapshotId: string): Promise<PackSnapshot | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const pool = this.getPool();
    const [snapshotRows, modRows] = await Promise.all([
      pool.query(
        `SELECT snapshot.*, env.minecraft_version, env.loader, env.loader_version, env.java_version, env.side
         FROM pack_snapshots snapshot
         LEFT JOIN pack_environment_profiles env
           ON env.id = snapshot.environment_profile_id
         WHERE snapshot.id = $1
         LIMIT 1`,
        [packSnapshotId]
      ),
      pool.query(
        `SELECT *
         FROM pack_snapshot_mods
         WHERE pack_snapshot_id = $1
         ORDER BY created_at ASC, id ASC`,
        [packSnapshotId]
      )
    ]);

    if (snapshotRows.rowCount === 0) {
      return undefined;
    }

    const row = snapshotRows.rows[0] as JsonRow;
    return {
      packSnapshotId: String(row.id),
      projectId: String(row.project_id),
      organizationId: String(row.organization_id),
      tenantId: String(row.tenant_id),
      sourceType: row.source_type as PackSnapshot["sourceType"],
      normalizedHash: String(row.normalized_hash),
      environment: {
        minecraftVersion: String(row.minecraft_version),
        loader: row.loader as PackSnapshot["environment"]["loader"],
        loaderVersion: row.loader_version ? String(row.loader_version) : undefined,
        javaVersion: String(row.java_version),
        side: row.side as PackSnapshot["environment"]["side"]
      },
      mods: modRows.rows.map((modRow) => ({
        name: String(modRow.declared_name),
        version: modRow.declared_version ? String(modRow.declared_version) : undefined,
        source: modRow.source_name ? String(modRow.source_name) : undefined,
        canonicalProjectId: modRow.canonical_project_id
          ? String(modRow.canonical_project_id)
          : undefined,
        canonicalVersionId: modRow.canonical_version_id
          ? String(modRow.canonical_version_id)
          : undefined,
        resolutionMethod:
          modRow.canonical_project_id || modRow.canonical_version_id
            ? "source_mapping"
            : "unresolved",
        confidence: modRow.canonical_project_id || modRow.canonical_version_id ? 1 : 0
      })),
      sourceRef: row.source_ref ? String(row.source_ref) : undefined,
      sourcePayloadUri: row.source_payload_uri ? String(row.source_payload_uri) : undefined,
      createdBy: row.created_by ? String(row.created_by) : undefined,
      schemaVersion: Number(row.schema_version),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    };
  }

  async hydrateSnapshot(packSnapshotId: string) {
    const snapshot = await this.readSnapshot(packSnapshotId);
    if (snapshot) {
      this.repository.snapshots.set(snapshot.packSnapshotId, snapshot);
      await this.hydrateProject(snapshot.projectId);
    }
    return snapshot;
  }

  async readPackDiffByAnalysis(analysisId: string): Promise<PackDiff | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const diffResult = await this.getPool().query(
      `SELECT *
       FROM pack_diffs
       WHERE target_analysis_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [analysisId]
    );

    if (diffResult.rowCount === 0) {
      return undefined;
    }

    const row = diffResult.rows[0];
    const changesResult = await this.getPool().query(
      `SELECT *
       FROM pack_diff_changes
       WHERE pack_diff_id = $1
       ORDER BY created_at ASC, id ASC`,
      [row.id]
    );

    return {
      packDiffId: String(row.id),
      projectId: String(row.project_id),
      tenantId: String(row.tenant_id),
      baseSnapshotId: String(row.base_snapshot_id),
      targetSnapshotId: String(row.target_snapshot_id),
      baselineAnalysisId: row.baseline_analysis_id
        ? String(row.baseline_analysis_id)
        : undefined,
      targetAnalysisId: row.target_analysis_id
        ? String(row.target_analysis_id)
        : undefined,
      summary: parseJsonValue(row.summary, {
        addedMods: 0,
        removedMods: 0,
        changedVersions: 0,
        findingAdds: 0,
        findingResolutions: 0
      }),
      changes: changesResult.rows.map((changeRow) => ({
        changeType: changeRow.change_type,
        projectId: changeRow.canonical_project_id
          ? String(changeRow.canonical_project_id)
          : undefined,
        before: changeRow.before_value ? String(changeRow.before_value) : undefined,
        after: changeRow.after_value ? String(changeRow.after_value) : undefined,
        summary: String(changeRow.summary)
      })),
      schemaVersion: Number(row.schema_version),
      createdAt: String(row.created_at)
    } as PackDiff;
  }

  async hydratePackDiffByAnalysis(analysisId: string) {
    const packDiff = await this.readPackDiffByAnalysis(analysisId);
    if (packDiff) {
      this.repository.packDiffs.set(packDiff.packDiffId, packDiff);
    }
    return packDiff;
  }

  async persistModelRegistryEntry(modelId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const model = this.repository.modelRegistry.get(modelId);
    if (!model) {
      throw new Error(`Model registry entry not found in memory: ${modelId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await upsertModelRegistryEntry(client, model);
      return { persisted: true };
    } finally {
      client.release();
    }
  }

  async readModelRegistryEntries(
    task?: ModelRegistryEntry["task"]
  ): Promise<ModelRegistryEntry[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = task
      ? await this.getPool().query(
          `SELECT *
           FROM model_registry_entries
           WHERE task = $1
           ORDER BY created_at ASC`,
          [task]
        )
      : await this.getPool().query(
          `SELECT *
           FROM model_registry_entries
           ORDER BY created_at ASC`
        );

    return result.rows.map((row) => toModelRegistryEntryRecord(row as JsonRow));
  }

  async hydrateModelRegistryEntries(task?: ModelRegistryEntry["task"]) {
    const entries = await this.readModelRegistryEntries(task);
    for (const entry of entries) {
      this.repository.modelRegistry.set(entry.modelId, entry);
    }
    return entries;
  }

  async persistRuleDraft(draftId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const draft = this.repository.ruleDrafts.get(draftId);
    if (!draft) {
      throw new Error(`Rule draft not found in memory: ${draftId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await persistUsers(client, this.repository);
      await upsertRuleDraftRecord(client, draft);
      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readRuleDraft(draftId: string): Promise<RuleDraftRecord | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM rule_drafts
       WHERE id = $1
       LIMIT 1`,
      [draftId]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    return toRuleDraftRecord(result.rows[0] as JsonRow);
  }

  async readRuleDrafts(status?: RuleDraftStatus): Promise<RuleDraftRecord[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = status
      ? await this.getPool().query(
          `SELECT *
           FROM rule_drafts
           WHERE status = $1
           ORDER BY created_at ASC`,
          [status]
        )
      : await this.getPool().query(
          `SELECT *
           FROM rule_drafts
           ORDER BY created_at ASC`
        );

    return result.rows.map((row) => toRuleDraftRecord(row as JsonRow));
  }

  async hydrateRuleDraft(draftId: string) {
    const draft = await this.readRuleDraft(draftId);
    if (draft) {
      this.repository.ruleDrafts.set(draft.draftId, draft);
    }
    return draft;
  }

  async hydrateRuleDrafts(status?: RuleDraftStatus) {
    const drafts = await this.readRuleDrafts(status);
    for (const draft of drafts) {
      this.repository.ruleDrafts.set(draft.draftId, draft);
    }
    return drafts;
  }

  async persistRuleVersionHistory(ruleId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const history = this.repository.ruleVersionHistory.get(ruleId) ?? [];
    if (history.length === 0) {
      throw new Error(`Rule version history not found in memory: ${ruleId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await persistUsers(client, this.repository);

      const orderedHistory = history.slice().sort((left, right) => left.version - right.version);
      for (const entry of orderedHistory) {
        const draft = this.repository.ruleDrafts.get(entry.draftId);
        if (!draft) {
          throw new Error(`Rule draft ${entry.draftId} missing for history entry on ${ruleId}`);
        }
        await upsertRuleDraftRecord(client, draft);
      }

      await client.query("DELETE FROM rule_version_history WHERE rule_id = $1", [ruleId]);

      for (const entry of orderedHistory) {
        await client.query(
          `INSERT INTO rule_version_history (
            draft_id, rule_id, version, promoted_by, promoted_at, change_note, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (draft_id) DO UPDATE SET
            rule_id = EXCLUDED.rule_id,
            version = EXCLUDED.version,
            promoted_by = EXCLUDED.promoted_by,
            promoted_at = EXCLUDED.promoted_at,
            change_note = EXCLUDED.change_note`,
          [
            entry.draftId,
            entry.ruleId,
            entry.version,
            entry.promotedBy,
            entry.promotedAt,
            entry.changeNote ?? null,
            entry.promotedAt
          ]
        );
      }

      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readRuleVersionHistory(ruleId: string): Promise<RuleVersionHistoryEntry[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM rule_version_history
       WHERE rule_id = $1
       ORDER BY version ASC`,
      [ruleId]
    );

    return result.rows.map((row) => toRuleVersionHistoryRecord(row as JsonRow));
  }

  async hydrateRuleVersionHistory(ruleId: string) {
    const history = await this.readRuleVersionHistory(ruleId);
    if (history.length > 0) {
      this.repository.ruleVersionHistory.set(ruleId, history);
    } else {
      this.repository.ruleVersionHistory.delete(ruleId);
    }
    return history;
  }

  async persistModelEvaluations(modelId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const model = this.repository.modelRegistry.get(modelId);
    if (!model) {
      throw new Error(`Model registry entry not found in memory: ${modelId}`);
    }

    const evaluations = this.repository.modelEvaluations.get(modelId) ?? [];
    if (evaluations.length === 0) {
      throw new Error(`Model evaluations not found in memory: ${modelId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await upsertModelRegistryEntry(client, model);
      await client.query("DELETE FROM model_evaluations WHERE model_id = $1", [modelId]);
      for (const evaluation of evaluations) {
        await upsertModelEvaluationRecord(client, evaluation);
      }
      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readModelEvaluations(modelId: string): Promise<ModelEvaluationRecord[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM model_evaluations
       WHERE model_id = $1
       ORDER BY evaluated_at ASC, created_at ASC`,
      [modelId]
    );

    return result.rows.map((row) => toModelEvaluationRecord(row as JsonRow));
  }

  async hydrateModelEvaluations(modelId: string) {
    const evaluations = await this.readModelEvaluations(modelId);
    if (evaluations.length > 0) {
      this.repository.modelEvaluations.set(modelId, evaluations);
    } else {
      this.repository.modelEvaluations.delete(modelId);
    }
    return evaluations;
  }

  async persistFeedbackSignalReport(reportId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const report = this.repository.feedbackSignalReports.get(reportId);
    if (!report) {
      throw new Error(`Feedback signal report not found in memory: ${reportId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await upsertFeedbackSignalReportRecord(client, report);
      return { persisted: true };
    } finally {
      client.release();
    }
  }

  async readFeedbackSignalReport(reportId: string): Promise<FeedbackSignalReport | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM feedback_signal_reports
       WHERE id = $1
       LIMIT 1`,
      [reportId]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    return toFeedbackSignalReportRecord(result.rows[0] as JsonRow);
  }

  async hydrateFeedbackSignalReport(reportId: string) {
    const report = await this.readFeedbackSignalReport(reportId);
    if (report) {
      this.repository.feedbackSignalReports.set(report.reportId, report);
    }
    return report;
  }

  async persistEvidenceCuration(curationId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const curation = this.repository.evidenceCurations.get(curationId);
    if (!curation) {
      throw new Error(`Evidence curation not found in memory: ${curationId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await persistUsers(client, this.repository);

      await client.query(
        `INSERT INTO evidence_curations (
          id, title, finding_type, severity, summary, subject_project_ids,
          evidence_document_ids, evidence_snippet_ids, rule_draft, status, created_by,
          promoted_rule_id, schema_version, promoted_at, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6::jsonb,
          $7::jsonb, $8::jsonb, $9::jsonb, $10, $11,
          $12, $13, $14, $15
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          finding_type = EXCLUDED.finding_type,
          severity = EXCLUDED.severity,
          summary = EXCLUDED.summary,
          subject_project_ids = EXCLUDED.subject_project_ids,
          evidence_document_ids = EXCLUDED.evidence_document_ids,
          evidence_snippet_ids = EXCLUDED.evidence_snippet_ids,
          rule_draft = EXCLUDED.rule_draft,
          status = EXCLUDED.status,
          created_by = EXCLUDED.created_by,
          promoted_rule_id = EXCLUDED.promoted_rule_id,
          promoted_at = EXCLUDED.promoted_at`,
        [
          curation.curationId,
          curation.title,
          curation.findingType,
          curation.severity,
          curation.summary,
          JSON.stringify(curation.subjectProjectIds),
          JSON.stringify(curation.evidenceDocumentIds),
          JSON.stringify(curation.evidenceSnippetIds),
          JSON.stringify(curation.ruleDraft),
          curation.status,
          curation.createdBy,
          curation.promotedRuleId ?? null,
          curation.schemaVersion,
          curation.promotedAt ?? null,
          curation.createdAt
        ]
      );

      await client.query("COMMIT");
      return { persisted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistVerifiedRule(ruleId: string) {
    if (!this.isEnabled()) {
      return { persisted: false, reason: "POSTGRES_URL is not configured." };
    }

    const rule = this.repository.verifiedRules.find((item) => item.rule_id === ruleId);
    if (!rule) {
      throw new Error(`Verified rule not found in memory: ${ruleId}`);
    }

    await this.ensureSchema();
    const client = await this.getPool().connect();
    try {
      await upsertVerifiedRuleDefinition(client, rule);
    } finally {
      client.release();
    }

    return { persisted: true };
  }

  async readEvidenceCuration(curationId: string): Promise<EvidenceCurationRecord | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT *
       FROM evidence_curations
       WHERE id = $1
       LIMIT 1`,
      [curationId]
    );

    if (result.rowCount === 0) {
      return undefined;
    }

    const row = result.rows[0];
    return {
      curationId: String(row.id),
      title: String(row.title),
      findingType: String(row.finding_type),
      severity: row.severity,
      summary: String(row.summary),
      subjectProjectIds: parseJsonValue(row.subject_project_ids, []),
      evidenceDocumentIds: parseJsonValue(row.evidence_document_ids, []),
      evidenceSnippetIds: parseJsonValue(row.evidence_snippet_ids, []),
      ruleDraft: parseJsonValue(row.rule_draft, {}),
      status: row.status,
      createdBy: row.created_by ? String(row.created_by) : undefined,
      promotedRuleId: row.promoted_rule_id ? String(row.promoted_rule_id) : undefined,
      schemaVersion: Number(row.schema_version),
      promotedAt: toTimestampString(row.promoted_at),
      createdAt: toTimestampString(row.created_at) ?? new Date(0).toISOString()
    } as EvidenceCurationRecord;
  }

  async hydrateEvidenceCuration(curationId: string) {
    const curation = await this.readEvidenceCuration(curationId);
    if (curation) {
      this.repository.evidenceCurations.set(curation.curationId, curation);
    }
    return curation;
  }

  async readVerifiedRules(): Promise<VerifiedRuleDefinition[]> {
    if (!this.isEnabled()) {
      return [];
    }

    await this.ensureSchema();
    const result = await this.getPool().query(
      `SELECT definition
       FROM verified_rules
       WHERE status = 'active'
       ORDER BY updated_at ASC, created_at ASC`
    );

    return result.rows.map((row) =>
      parseJsonValue(row.definition, {} as VerifiedRuleDefinition)
    );
  }

  async hydrateVerifiedRules() {
    const persistedRules = await this.readVerifiedRules();
    for (const rule of persistedRules) {
      const existingIndex = this.repository.verifiedRules.findIndex(
        (item) => item.rule_id === rule.rule_id
      );
      if (existingIndex >= 0) {
        this.repository.verifiedRules.splice(existingIndex, 1, rule);
      } else {
        this.repository.verifiedRules.push(rule);
      }
    }
    return persistedRules;
  }

  async hydrateAdminState(curationId?: string) {
    const [curation, drafts] = await Promise.all([
      curationId ? this.hydrateEvidenceCuration(curationId) : Promise.resolve(undefined),
      this.hydrateVerifiedRules(),
      this.hydrateRuleDrafts()
    ]);

    return {
      curation,
      ruleCount: this.repository.verifiedRules.length,
      draftCount: drafts.length
    };
  }

  async readAnalysis(analysisId: string): Promise<AnalysisResult | undefined> {
    if (!this.isEnabled()) {
      return undefined;
    }

    await this.ensureSchema();
    const pool = this.getPool();

    const [
      analysisRows,
      phaseRows,
      eventRows,
      findingRows,
      subjectRows,
      evidenceRows,
      actionRows,
      artifactRows,
      reportRows,
      datasetRows,
      featureVectorRows,
      scoreRows,
      reviewRows,
      simulationRows,
      gateRows,
      statusCheckRows
    ] = await Promise.all([
      pool.query("SELECT * FROM analyses WHERE id = $1", [analysisId]),
      pool.query(
        "SELECT * FROM analysis_phases WHERE analysis_id = $1 ORDER BY started_at ASC, created_at ASC",
        [analysisId]
      ),
      pool.query(
        "SELECT * FROM analysis_events WHERE analysis_id = $1 ORDER BY occurred_at ASC, created_at ASC",
        [analysisId]
      ),
      pool.query("SELECT * FROM findings WHERE analysis_id = $1 ORDER BY created_at ASC", [analysisId]),
      pool.query(
        "SELECT * FROM finding_subjects WHERE finding_id IN (SELECT id FROM findings WHERE analysis_id = $1)",
        [analysisId]
      ),
      pool.query(
        "SELECT * FROM finding_evidence WHERE finding_id IN (SELECT id FROM findings WHERE analysis_id = $1)",
        [analysisId]
      ),
      pool.query(
        "SELECT * FROM finding_actions WHERE finding_id IN (SELECT id FROM findings WHERE analysis_id = $1)",
        [analysisId]
      ),
      pool.query(
        `SELECT output.*, run.analysis_id, run.pack_snapshot_id, run.organization_id, run.tenant_id
         FROM artifact_analysis_outputs output
         INNER JOIN artifact_analysis_runs run
           ON run.id = output.artifact_analysis_run_id
         WHERE run.analysis_id = $1
         ORDER BY output.created_at ASC, output.id ASC`,
        [analysisId]
      ),
      pool.query("SELECT * FROM analysis_reports WHERE analysis_id = $1", [analysisId]),
      pool.query(
        "SELECT * FROM offline_datasets WHERE analysis_id = $1 ORDER BY created_at DESC LIMIT 1",
        [analysisId]
      ),
      pool.query(
        "SELECT * FROM finding_feature_vectors WHERE analysis_id = $1 ORDER BY created_at ASC",
        [analysisId]
      ),
      pool.query(
        "SELECT * FROM calibrated_finding_scores WHERE analysis_id = $1 ORDER BY created_at ASC",
        [analysisId]
      ),
      pool.query("SELECT * FROM pack_review_summaries WHERE analysis_id = $1 LIMIT 1", [analysisId]),
      pool.query("SELECT * FROM simulation_runs WHERE analysis_id = $1 LIMIT 1", [analysisId]),
      pool.query("SELECT * FROM release_gate_decisions WHERE analysis_id = $1 LIMIT 1", [analysisId]),
      pool.query("SELECT * FROM status_check_results WHERE analysis_id = $1 LIMIT 1", [analysisId])
    ]);

    if (analysisRows.rowCount === 0) {
      return undefined;
    }

    const summaryRow = analysisRows.rows[0] as JsonRow;
    const phases = phaseRows.rows.map((row) => ({
      phaseId: String(row.id),
      analysisId: String(row.analysis_id),
      phaseName: row.phase_name as AnalysisPhase["phaseName"],
      status: row.status as AnalysisPhase["status"],
      durationMs: Number(row.duration_ms ?? 0),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      artifacts: parseJsonValue(row.artifacts, []),
      schemaVersion: Number(row.schema_version)
    }));
    const events = eventRows.rows.map((row) => ({
      eventId: String(row.id),
      analysisId: String(row.analysis_id),
      eventType: row.event_type as AnalysisEvent["eventType"],
      message: String(row.message),
      occurredAt: String(row.occurred_at),
      phaseName: row.phase_name as AnalysisEvent["phaseName"],
      payload: parseJsonValue(row.payload, undefined),
      schemaVersion: Number(row.schema_version)
    }));

    const subjects = new Map<string, Finding["subjects"]>();
    for (const row of subjectRows.rows as JsonRow[]) {
      const findingId = String(row.finding_id);
      const existing = subjects.get(findingId) ?? [];
      existing.push({
        projectId: String(row.canonical_project_id),
        versionId: row.canonical_version_id ? String(row.canonical_version_id) : undefined,
        relation: row.relation as Finding["subjects"][number]["relation"]
      });
      subjects.set(findingId, existing);
    }

    const evidence = new Map<string, Finding["evidence"]>();
    for (const row of evidenceRows.rows as JsonRow[]) {
      const findingId = String(row.finding_id);
      const existing = evidence.get(findingId) ?? [];
      existing.push({
        type: row.evidence_type as Finding["evidence"][number]["type"],
        id: String(row.evidence_id),
        snippetId: row.snippet_id ? String(row.snippet_id) : undefined
      });
      evidence.set(findingId, existing);
    }

    const actions = new Map<string, string[]>();
    for (const row of actionRows.rows as JsonRow[]) {
      const findingId = String(row.finding_id);
      const existing = actions.get(findingId) ?? [];
      existing.push(String(row.action_text));
      actions.set(findingId, existing);
    }

    const findings = findingRows.rows.map((row) =>
      toFindingRecord(row as JsonRow, { subjects, evidence, actions })
    );
    const artifacts = artifactRows.rows.map((row) =>
      toArtifactAnalysisRecord(row as JsonRow)
    );

    const report = reportRows.rowCount
      ? (parseJsonValue(reportRows.rows[0].report_json, undefined) as AnalysisReport | undefined)
      : undefined;
    const summary: AnalysisSummary = {
      analysisId: String(summaryRow.id),
      projectId: String(summaryRow.project_id),
      workspaceId: String(summaryRow.workspace_id),
      organizationId: String(summaryRow.organization_id),
      packSnapshotId: summaryRow.pack_snapshot_id
        ? String(summaryRow.pack_snapshot_id)
        : undefined,
      status: summaryRow.status as AnalysisSummary["status"],
      trigger: summaryRow.trigger_type as AnalysisSummary["trigger"],
      analysisMode: summaryRow.analysis_mode as AnalysisSummary["analysisMode"],
      score: toNumeric(summaryRow.overall_score),
      counts: parseJsonValue(summaryRow.counts, undefined),
      createdAt: String(summaryRow.created_at),
      startedAt: summaryRow.started_at ? String(summaryRow.started_at) : undefined,
      finishedAt: summaryRow.finished_at ? String(summaryRow.finished_at) : undefined
    };

    const featureDataset: OfflineDataset | undefined = datasetRows.rowCount
      ? {
          datasetId: String(datasetRows.rows[0].id),
          analysisId: String(datasetRows.rows[0].analysis_id),
          datasetKind: datasetRows.rows[0].dataset_kind as OfflineDataset["datasetKind"],
          featureVectorIds: parseJsonValue<OfflineDataset["featureVectorIds"]>(
            datasetRows.rows[0].feature_vector_ids,
            []
          ),
          summary: parseJsonValue<OfflineDataset["summary"]>(datasetRows.rows[0].summary, {
            rowCount: 0,
            labeledRowCount: 0,
            featureNamespaces: []
          }),
          tenantId: String(datasetRows.rows[0].tenant_id),
          schemaVersion: Number(datasetRows.rows[0].schema_version),
          createdAt: String(datasetRows.rows[0].created_at)
        }
      : undefined;

    const featureVectors = featureVectorRows.rows.map((row) => ({
      featureVectorId: String(row.id),
      analysisId: String(row.analysis_id),
      findingId: String(row.finding_id),
      featureNamespace: row.feature_namespace as FindingFeatureVector["featureNamespace"],
      featureValues: parseJsonValue(row.feature_values, []),
      label: row.label as FindingFeatureVector["label"],
      schemaVersion: Number(row.schema_version),
      createdAt: String(row.created_at)
    }));

    const calibratedScores = scoreRows.rows.map((row) => ({
      calibratedFindingScoreId: String(row.id),
      analysisId: String(row.analysis_id),
      findingId: String(row.finding_id),
      modelId: String(row.model_id),
      originalConfidence: Number(row.original_confidence),
      calibratedConfidence: Number(row.calibrated_confidence),
      predictedRiskScore: Number(row.predicted_risk_score),
      rationale: parseJsonValue(row.rationale, []),
      schemaVersion: Number(row.schema_version),
      createdAt: String(row.created_at)
    })) as CalibratedFindingScore[];

    const reviewSummary = reviewRows.rowCount
      ? parseJsonValue(reviewRows.rows[0].review_json, undefined)
      : undefined;
    const simulationRun = simulationRows.rowCount
      ? {
          simulationRunId: String(simulationRows.rows[0].id),
          analysisId: String(simulationRows.rows[0].analysis_id),
          packSnapshotId: String(simulationRows.rows[0].pack_snapshot_id),
          recipeId: String(simulationRows.rows[0].recipe_id),
          status: simulationRows.rows[0].status,
          summary: String(simulationRows.rows[0].summary),
          observations: parseJsonValue(simulationRows.rows[0].observations, []),
          schemaVersion: Number(simulationRows.rows[0].schema_version),
          createdAt: String(simulationRows.rows[0].created_at)
        }
      : undefined;
    const releaseGateDecision = gateRows.rowCount
      ? {
          releaseGateDecisionId: String(gateRows.rows[0].id),
          analysisId: String(gateRows.rows[0].analysis_id),
          policyKey: String(gateRows.rows[0].policy_key),
          status: gateRows.rows[0].status,
          summary: String(gateRows.rows[0].summary),
          reasons: parseJsonValue(gateRows.rows[0].reasons, []),
          blockingFindingIds: parseJsonValue(gateRows.rows[0].blocking_finding_ids, []),
          simulationRunId: gateRows.rows[0].simulation_run_id
            ? String(gateRows.rows[0].simulation_run_id)
            : undefined,
          schemaVersion: Number(gateRows.rows[0].schema_version),
          createdAt: String(gateRows.rows[0].created_at)
        }
      : undefined;
    const statusCheck = statusCheckRows.rowCount
      ? {
          statusCheckId: String(statusCheckRows.rows[0].id),
          analysisId: String(statusCheckRows.rows[0].analysis_id),
          installationId: statusCheckRows.rows[0].installation_id
            ? String(statusCheckRows.rows[0].installation_id)
            : undefined,
          conclusion: statusCheckRows.rows[0].conclusion,
          summary: String(statusCheckRows.rows[0].summary),
          detailsUrl: String(statusCheckRows.rows[0].details_url),
          schemaVersion: Number(statusCheckRows.rows[0].schema_version),
          createdAt: String(statusCheckRows.rows[0].created_at)
        }
      : undefined;

    const recommendationSet = report?.recommendationSet as RecommendationSet | undefined;
    const recommendations = (report?.recommendations ??
      recommendationSet?.items ??
      []) as Recommendation[];
    const feedback = (report?.feedback ?? []) as RecommendationFeedback[];
    const latestOutcome = report?.latestOutcome as RecommendationOutcome | undefined;
    const packDiff = await this.readPackDiffByAnalysis(analysisId);

    return {
      analysis: summary,
      phases,
      events,
      findings,
      recommendations,
      recommendationSet,
      featureDataset,
      featureVectors: featureVectors as FindingFeatureVector[],
      calibratedScores,
      reviewSummary,
      simulationRun,
      releaseGateDecision,
      statusCheck,
      artifacts,
      graph: undefined,
      packDiff,
      report: report
        ? {
            ...report,
            analysis: summary,
            findings,
            recommendations,
            recommendationSet,
            feedback,
            latestOutcome,
            reviewSummary,
            simulationRun,
            releaseGateDecision,
            statusCheck
          }
        : undefined
    };
  }

  async hydrateAnalysis(analysisId: string) {
    const result = await this.readAnalysis(analysisId);
    if (!result) {
      return undefined;
    }

    const record = toRecord(result);
    this.repository.analyses.set(analysisId, record);

    if (result.artifacts?.length) {
      this.repository.artifactAnalyses.set(analysisId, result.artifacts);
    }

    if (result.recommendationSet) {
      this.repository.recommendationSets.set(
        result.recommendationSet.recommendationSetId,
        result.recommendationSet
      );
      this.repository.recommendationSetsByAnalysis.set(
        analysisId,
        result.recommendationSet.recommendationSetId
      );
    }

    if (result.featureDataset) {
      this.repository.featureDatasets.set(result.featureDataset.datasetId, result.featureDataset);
      this.repository.featureDatasetsByAnalysis.set(analysisId, result.featureDataset.datasetId);
    }

    if (result.featureVectors?.length) {
      this.repository.findingFeatureVectors.set(analysisId, result.featureVectors);
    }

    if (result.calibratedScores?.length) {
      this.repository.calibratedFindingScores.set(analysisId, result.calibratedScores);
    }

    if (result.reviewSummary) {
      this.repository.reviewSummaries.set(analysisId, result.reviewSummary);
    }

    if (result.simulationRun) {
      this.repository.simulationRuns.set(analysisId, result.simulationRun);
    }

    if (result.releaseGateDecision) {
      this.repository.releaseGateDecisions.set(analysisId, result.releaseGateDecision);
    }

    if (result.statusCheck) {
      this.repository.statusChecks.set(analysisId, result.statusCheck);
    }

    if (result.packDiff) {
      this.repository.packDiffs.set(result.packDiff.packDiffId, result.packDiff);
    }

    if (result.report) {
      this.repository.reports.set(analysisId, result.report);
      for (const item of result.report.feedback) {
        this.repository.recommendationFeedback.set(item.feedbackId, item);
        const feedbackIds =
          this.repository.recommendationFeedbackByRecommendation.get(item.recommendationId) ?? [];
        feedbackIds.push(item.feedbackId);
        this.repository.recommendationFeedbackByRecommendation.set(
          item.recommendationId,
          feedbackIds
        );
      }

      if (result.report.latestOutcome) {
        this.repository.recommendationOutcomes.set(
          result.report.latestOutcome.outcomeId,
          result.report.latestOutcome
        );
        if (result.recommendationSet) {
          this.repository.recommendationOutcomesBySet.set(
            result.recommendationSet.recommendationSetId,
            [result.report.latestOutcome.outcomeId]
          );
        }
      }
    }

    return result;
  }

  private getPool() {
    if (!this.connectionString) {
      throw new Error("POSTGRES_URL is not configured.");
    }

    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.connectionString
      });
    }

    return this.pool;
  }
}
