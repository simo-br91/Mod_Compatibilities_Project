/**
 * Production configuration management.
 *
 * Goals:
 *  - Fail fast at startup when required environment variables are absent
 *  - Never allow secrets to be hardcoded — all sensitive values come from env
 *  - Provide a single validated config object that every service can import
 *  - Support sensible defaults for development so the platform runs locally
 *    without a full secret management stack
 *
 * Usage:
 *   import { loadPlatformConfig } from "@modcompat/platform-core";
 *   const config = loadPlatformConfig();
 *   // config.jwtSecret is guaranteed to be a non-empty string
 */

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  // ── Identity and Auth ────────────────────────────────────────────────────
  /** Secret used to sign and verify HS256 JWTs.  Must be ≥32 chars. */
  jwtSecret: string;
  /** JWT expiry in seconds (default 28800 = 8 hours). */
  jwtExpirySeconds: number;

  // ── Service URLs ─────────────────────────────────────────────────────────
  gatewayPort: number;
  evidenceServiceUrl: string;
  adminServiceUrl: string;
  recommendationServiceUrl: string;
  graphServiceUrl: string;
  simulationServiceUrl: string;
  orchestratorServiceUrl: string;
  artifactAnalysisServiceUrl: string;

  // ── Persistence ──────────────────────────────────────────────────────────
  postgresUrl: string;
  redisUrl: string;
  opensearchUrl: string;
  neo4jUrl: string;
  neo4jUsername: string;
  neo4jPassword: string;
  s3BucketName: string;
  s3Region: string;
  s3EndpointUrl: string | undefined;  // optional override for MinIO

  // ── Webhook ──────────────────────────────────────────────────────────────
  /** Default HMAC secret for outgoing webhooks (per-webhook secrets override). */
  webhookSigningSecret: string;
  webhookMaxRetries: number;

  // ── Rate limits ──────────────────────────────────────────────────────────
  publicRateLimitPerMinute: number;
  authenticatedRateLimitPerMinute: number;
  writeRateLimitPerMinute: number;

  // ── Upload hardening ─────────────────────────────────────────────────────
  /** Max upload size in bytes (default 50 MB). */
  maxUploadBytes: number;
  /** Allowed MIME types for pack manifest uploads. */
  allowedUploadMimeTypes: string[];

  // ── Observability ────────────────────────────────────────────────────────
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  serviceName: string;
  otlpEndpoint: string | undefined;
}

const DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-change-before-production";
const DEV_WEBHOOK_SECRET = "dev-only-insecure-webhook-secret";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ConfigurationError extends Error {
  readonly code = "configuration_error" as const;
  readonly missingKeys: string[];
  constructor(missingKeys: string[]) {
    super(
      `Missing required environment variable(s): ${missingKeys.join(", ")}. ` +
      "Set them in your .env file or deployment environment."
    );
    this.name = "ConfigurationError";
    this.missingKeys = missingKeys;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Require a non-empty environment variable.
 * Throws `ConfigurationError` if absent or empty.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new ConfigurationError([key]);
  }
  return value.trim();
}

/**
 * Read an optional environment variable with a default fallback.
 */
export function optionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value?.trim() || defaultValue;
}

/**
 * Read a numeric environment variable.
 * Falls back to `defaultValue` if the variable is absent or non-numeric.
 */
export function numericEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizedStage(): string {
  return optionalEnv("APP_ENV", optionalEnv("NODE_ENV", "development")).toLowerCase();
}

function isProductionLikeStage(stage: string): boolean {
  return stage === "production" || stage === "prod" || stage === "staging";
}

function readConfiguredSecret(key: string): string | undefined {
  const value = process.env[key]?.trim();
  if (!value) {
    return undefined;
  }

  if (
    value === DEV_JWT_SECRET ||
    value === DEV_WEBHOOK_SECRET ||
    value === "change-this-to-a-random-256-bit-secret-in-production"
  ) {
    return undefined;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Collect all missing required keys and throw a single error listing all of
 * them, rather than failing at the first missing value.
 */
function collectRequired(
  checks: Array<[string, string | undefined]>
): string[] {
  return checks
    .filter(([, v]) => !v || v.trim() === "")
    .map(([k]) => k);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the platform configuration from environment variables.
 *
 * In development, many values fall back to sensible localhost defaults so the
 * platform can boot without a full secrets manager.  In production,
 * `NODE_ENV=production` will be set and the fallbacks should NOT be relied
 * upon — the deploy pipeline must inject all required variables.
 */
export function loadPlatformConfig(): PlatformConfig {
  const stage = normalizedStage();
  const isProductionLike = isProductionLikeStage(stage);

  // In staging/production, these are strictly required.
  // In development, we fall back to insecure demo values.
  const jwtSecret = readConfiguredSecret("JWT_SECRET") ?? (isProductionLike ? "" : DEV_JWT_SECRET);
  const webhookSigningSecret =
    readConfiguredSecret("WEBHOOK_SIGNING_SECRET") ??
    (isProductionLike ? "" : DEV_WEBHOOK_SECRET);

  if (isProductionLike) {
    const missing = collectRequired([
      ["JWT_SECRET", jwtSecret],
      ["WEBHOOK_SIGNING_SECRET", webhookSigningSecret],
      ["POSTGRES_URL", process.env["POSTGRES_URL"]],
      ["REDIS_URL", process.env["REDIS_URL"]],
    ]);
    if (missing.length > 0) {
      throw new ConfigurationError(missing);
    }
  }

  return {
    // Auth
    jwtSecret,
    jwtExpirySeconds: numericEnv("JWT_EXPIRY_SECONDS", 28_800),

    // Service ports / URLs
    gatewayPort: numericEnv("GATEWAY_PORT", 8080),
    evidenceServiceUrl: optionalEnv("EVIDENCE_SERVICE_URL", "http://localhost:8082"),
    adminServiceUrl: optionalEnv("ADMIN_SERVICE_URL", "http://localhost:8083"),
    recommendationServiceUrl: optionalEnv("RECOMMENDATION_SERVICE_URL", "http://localhost:8084"),
    graphServiceUrl: optionalEnv("GRAPH_SERVICE_URL", "http://localhost:8085"),
    simulationServiceUrl: optionalEnv("SIMULATION_SERVICE_URL", "http://localhost:8086"),
    orchestratorServiceUrl: optionalEnv("ORCHESTRATOR_SERVICE_URL", "http://localhost:8087"),
    artifactAnalysisServiceUrl: optionalEnv("ARTIFACT_ANALYSIS_SERVICE_URL", "http://localhost:9090"),

    // Persistence
    postgresUrl: optionalEnv("POSTGRES_URL", "postgres://postgres:postgres@localhost:5432/modcompat"),
    redisUrl: optionalEnv("REDIS_URL", "redis://localhost:6379"),
    opensearchUrl: optionalEnv("OPENSEARCH_URL", "http://localhost:9200"),
    neo4jUrl: optionalEnv("NEO4J_URL", process.env["NEO4J_URI"] ?? "bolt://localhost:7687"),
    neo4jUsername: optionalEnv("NEO4J_USERNAME", "neo4j"),
    neo4jPassword: optionalEnv("NEO4J_PASSWORD", "neo4j"),
    s3BucketName: optionalEnv("S3_BUCKET_NAME", "modcompat-artifacts"),
    s3Region: optionalEnv("S3_REGION", "us-east-1"),
    s3EndpointUrl: process.env["S3_ENDPOINT_URL"] ?? undefined,

    // Webhooks
    webhookSigningSecret,
    webhookMaxRetries: numericEnv("WEBHOOK_MAX_RETRIES", 5),

    // Rate limits
    publicRateLimitPerMinute: numericEnv("RATE_LIMIT_PUBLIC_PER_MINUTE", 60),
    authenticatedRateLimitPerMinute: numericEnv("RATE_LIMIT_AUTH_PER_MINUTE", 600),
    writeRateLimitPerMinute: numericEnv("RATE_LIMIT_WRITE_PER_MINUTE", 30),

    // Upload hardening
    maxUploadBytes: numericEnv("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
    allowedUploadMimeTypes: (
      optionalEnv(
        "ALLOWED_UPLOAD_MIME_TYPES",
        "application/json,text/plain,application/zip,application/x-zip-compressed"
      )
    ).split(",").map((t) => t.trim()),

    // Observability
    logLevel: (optionalEnv("LOG_LEVEL", "info") as PlatformConfig["logLevel"]),
    serviceName: optionalEnv("SERVICE_NAME", "modcompat-gateway"),
    otlpEndpoint: process.env["OTLP_ENDPOINT"] ?? undefined,
  };
}
