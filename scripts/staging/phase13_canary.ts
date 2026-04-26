import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_REPORT_PATH = resolve(ROOT, ".phase13-canary-report.json");
const DEFAULT_METRICS_PATH = resolve(ROOT, ".phase13-canary.prom");

interface ProbeResult {
  probeId: string;
  status: "ok" | "failed";
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

function usage() {
  console.log(`Phase 13 staging canary

Usage:
  node --import tsx ./scripts/staging/phase13_canary.ts
  node --import tsx ./scripts/staging/phase13_canary.ts --dry-run
  node --import tsx ./scripts/staging/phase13_canary.ts --report-path <path> --metrics-path <path>

Environment:
  POSTGRES_URL                 Optional, defaults to postgres://postgres:postgres@127.0.0.1:5432/modcompat
  LOG_LEVEL                    Optional, defaults to info
  APP_ENV                      Optional, defaults to staging
  EVIDENCE_HTTP_PORT           Optional, defaults to 8081
  ADMIN_HTTP_PORT              Optional, defaults to 8082
  RECOMMENDATION_HTTP_PORT     Optional, defaults to 8083
  GRAPH_HTTP_PORT              Optional, defaults to 8084
  SIMULATION_HTTP_PORT         Optional, defaults to 8085
  ORCHESTRATOR_HTTP_PORT       Optional, defaults to 8086
  ARTIFACT_ANALYSIS_HTTP_PORT  Optional, defaults to 9090

This canary verifies that the compose-backed staging runtime is reachable and that
the artifact-analysis, evidence, and admin service boundaries can complete
critical read/write operations before the heavier staging smoke gate runs.`);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return flags;
}

function getStringFlag(flags: Map<string, string | boolean>, key: string) {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function getBooleanFlag(flags: Map<string, string | boolean>, key: string) {
  return flags.get(key) === true;
}

function buildEnv() {
  const postgresUrl =
    process.env.POSTGRES_URL ?? `postgres://postgres:postgres@${DEFAULT_HOST}:5432/modcompat`;
  const evidencePort = process.env.EVIDENCE_HTTP_PORT ?? "8081";
  const adminPort = process.env.ADMIN_HTTP_PORT ?? "8082";
  const recommendationPort = process.env.RECOMMENDATION_HTTP_PORT ?? "8083";
  const graphPort = process.env.GRAPH_HTTP_PORT ?? "8084";
  const simulationPort = process.env.SIMULATION_HTTP_PORT ?? "8085";
  const orchestratorPort = process.env.ORCHESTRATOR_HTTP_PORT ?? "8086";
  const artifactAnalysisPort = process.env.ARTIFACT_ANALYSIS_HTTP_PORT ?? "9090";

  return {
    POSTGRES_URL: postgresUrl,
    APP_ENV: process.env.APP_ENV ?? "staging",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    EVIDENCE_SERVICE_URL: process.env.EVIDENCE_SERVICE_URL ?? `http://${DEFAULT_HOST}:${evidencePort}`,
    ADMIN_SERVICE_URL: process.env.ADMIN_SERVICE_URL ?? `http://${DEFAULT_HOST}:${adminPort}`,
    RECOMMENDATION_SERVICE_URL:
      process.env.RECOMMENDATION_SERVICE_URL ?? `http://${DEFAULT_HOST}:${recommendationPort}`,
    GRAPH_SERVICE_URL: process.env.GRAPH_SERVICE_URL ?? `http://${DEFAULT_HOST}:${graphPort}`,
    SIMULATION_SERVICE_URL:
      process.env.SIMULATION_SERVICE_URL ?? `http://${DEFAULT_HOST}:${simulationPort}`,
    ORCHESTRATOR_SERVICE_URL:
      process.env.ORCHESTRATOR_SERVICE_URL ?? `http://${DEFAULT_HOST}:${orchestratorPort}`,
    ARTIFACT_ANALYSIS_SERVICE_URL:
      process.env.ARTIFACT_ANALYSIS_SERVICE_URL ??
      `http://${DEFAULT_HOST}:${artifactAnalysisPort}`
  };
}

function ensureParentDirectory(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForTcpConnection(name: string, connectionString: string, timeoutMs = 60_000) {
  const target = new URL(connectionString);
  const host = target.hostname;
  const port = Number(target.port || "5432");
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const reachable = await new Promise<boolean>((resolvePromise) => {
      const socket = net.createConnection({ host, port });

      const finish = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolvePromise(result);
      };

      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });

    if (reachable) {
      return;
    }

    await delay(1_000);
  }

  throw new Error(`${name} was not reachable at ${host}:${port} within ${timeoutMs}ms.`);
}

async function seedDemoIdentity(connectionString: string) {
  const pool = new Pool({
    connectionString
  });

  try {
    await pool.query(
      `INSERT INTO organizations (id, name, slug, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug`,
      ["org_demo", "Demo Pack Studio", "demo-pack-studio", 1, new Date().toISOString()]
    );

    await pool.query(
      `INSERT INTO users (id, email, display_name, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name`,
      ["usr_demo", "analyst@example.com", "Demo Analyst", 1, new Date().toISOString()]
    );

    await pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         role = EXCLUDED.role`,
      ["org_demo", "usr_demo", "owner", 1, new Date().toISOString()]
    );

    await pool.query(
      `INSERT INTO workspaces (id, organization_id, tenant_id, name, slug, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         tenant_id = EXCLUDED.tenant_id,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug`,
      [
        "wrk_demo",
        "org_demo",
        "org_demo",
        "Compatibility Ops",
        "compatibility-ops",
        1,
        new Date().toISOString()
      ]
    );

    await pool.query(
      `INSERT INTO projects (
         id, workspace_id, organization_id, tenant_id, name, slug, visibility, schema_version, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         organization_id = EXCLUDED.organization_id,
         tenant_id = EXCLUDED.tenant_id,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         visibility = EXCLUDED.visibility`,
      [
        "prj_demo",
        "wrk_demo",
        "org_demo",
        "org_demo",
        "Kitchen Sink Pack",
        "kitchen-sink-pack",
        "private",
        1,
        new Date().toISOString()
      ]
    );
  } finally {
    await pool.end();
  }
}

async function readJson(response: Response) {
  const raw = await response.text();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function timedProbe(
  probeId: string,
  callback: () => Promise<Record<string, unknown> | undefined>
): Promise<ProbeResult> {
  const startedAt = Date.now();

  try {
    const details = await callback();
    return {
      probeId,
      status: "ok",
      durationMs: Date.now() - startedAt,
      details
    };
  } catch (error) {
    return {
      probeId,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function formatPrometheusLabels(labels: Record<string, string>) {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
}

function buildMetrics(
  environment: string,
  startedAtIso: string,
  completedAtIso: string,
  probes: ProbeResult[]
) {
  const startedAtSeconds = Math.floor(new Date(startedAtIso).getTime() / 1000);
  const completedAtSeconds = Math.floor(new Date(completedAtIso).getTime() / 1000);
  const overallSuccess = probes.every((probe) => probe.status === "ok") ? 1 : 0;
  const lines = [
    "# HELP modcompat_canary_overall_success Whether the latest staging canary succeeded.",
    "# TYPE modcompat_canary_overall_success gauge",
    `modcompat_canary_overall_success{${formatPrometheusLabels({ environment })}} ${overallSuccess}`,
    "# HELP modcompat_canary_run_timestamp_seconds Unix timestamp of the latest staging canary run completion.",
    "# TYPE modcompat_canary_run_timestamp_seconds gauge",
    `modcompat_canary_run_timestamp_seconds{${formatPrometheusLabels({ environment })}} ${completedAtSeconds}`,
    "# HELP modcompat_canary_started_timestamp_seconds Unix timestamp of the latest staging canary run start.",
    "# TYPE modcompat_canary_started_timestamp_seconds gauge",
    `modcompat_canary_started_timestamp_seconds{${formatPrometheusLabels({ environment })}} ${startedAtSeconds}`,
    "# HELP modcompat_canary_success Whether an individual canary probe succeeded.",
    "# TYPE modcompat_canary_success gauge",
    "# HELP modcompat_canary_duration_milliseconds Duration of an individual canary probe in milliseconds.",
    "# TYPE modcompat_canary_duration_milliseconds gauge"
  ];

  for (const probe of probes) {
    const labels = formatPrometheusLabels({
      environment,
      probe: probe.probeId
    });
    lines.push(`modcompat_canary_success{${labels}} ${probe.status === "ok" ? 1 : 0}`);
    lines.push(`modcompat_canary_duration_milliseconds{${labels}} ${probe.durationMs}`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (getBooleanFlag(flags, "help")) {
    usage();
    return;
  }

  const dryRun = getBooleanFlag(flags, "dry-run");
  const reportPath = resolve(ROOT, getStringFlag(flags, "report-path") ?? DEFAULT_REPORT_PATH);
  const metricsPath = resolve(ROOT, getStringFlag(flags, "metrics-path") ?? DEFAULT_METRICS_PATH);
  const env = buildEnv();

  const serviceHealthChecks = [
    { probeId: "artifact-analysis-health", url: `${env.ARTIFACT_ANALYSIS_SERVICE_URL}/healthz` },
    { probeId: "evidence-health", url: `${env.EVIDENCE_SERVICE_URL}/healthz` },
    { probeId: "admin-health", url: `${env.ADMIN_SERVICE_URL}/healthz` },
    { probeId: "analysis-orchestrator-health", url: `${env.ORCHESTRATOR_SERVICE_URL}/healthz` },
    { probeId: "recommendation-health", url: `${env.RECOMMENDATION_SERVICE_URL}/healthz` },
    { probeId: "graph-health", url: `${env.GRAPH_SERVICE_URL}/healthz` },
    { probeId: "simulation-health", url: `${env.SIMULATION_SERVICE_URL}/healthz` }
  ];

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          status: "dry-run",
          reportPath,
          metricsPath,
          postgresUrl: env.POSTGRES_URL,
          healthChecks: serviceHealthChecks,
          probes: [
          "postgres-connectivity",
            "demo-identity-seeded",
            ...serviceHealthChecks.map((item) => item.probeId),
            "artifact-analysis-sample",
            "evidence-sync",
            "evidence-search",
            "admin-curation",
            "admin-promotion"
          ]
        },
        null,
        2
      )
    );
    return;
  }

  const startedAt = new Date().toISOString();
  const runKey = startedAt.replace(/[^0-9A-Za-z]/g, "");
  const probes: ProbeResult[] = [];

  try {
    await waitForTcpConnection("Postgres", env.POSTGRES_URL);
    probes.push({
      probeId: "postgres-connectivity",
      status: "ok",
      durationMs: 0,
      details: {
        postgresUrl: env.POSTGRES_URL
      }
    });

    probes.push(
      await timedProbe("demo-identity-seeded", async () => {
        await seedDemoIdentity(env.POSTGRES_URL);
        return {
          userId: "usr_demo",
          organizationId: "org_demo",
          projectId: "prj_demo"
        };
      })
    );

    for (const healthCheck of serviceHealthChecks) {
      probes.push(
        await timedProbe(healthCheck.probeId, async () => {
          const response = await fetch(healthCheck.url);
          assertCondition(
            response.ok,
            `${healthCheck.probeId} returned ${response.status} at ${healthCheck.url}.`
          );
          const payload = await readJson(response);
          return {
            url: healthCheck.url,
            status: payload?.status ?? "ok"
          };
        })
      );
    }

    probes.push(
      await timedProbe("artifact-analysis-sample", async () => {
        const requestBody = [
          "artifact\tart_alpha\t\t\tOptiFine",
          "mixin\tart_alpha\tnet.fabricmc.example.RenderMixin",
          "library\tart_alpha\tcom.example:lib-a:1.0\tcom.example.lib",
          "artifact\tart_beta\t\t\tSodium",
          "mixin\tart_beta\tnet.fabricmc.example.RenderMixin",
          "library\tart_beta\tcom.example:lib-b:2.0\tcom.example.lib"
        ].join("\n");
        const response = await fetch(`${env.ARTIFACT_ANALYSIS_SERVICE_URL}/v1/artifact-analysis/analyze`, {
          method: "POST",
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-request-id": "phase13-canary-artifact-analysis",
            "x-trace-id": "phase13-canary-artifact-analysis"
          },
          body: requestBody
        });
        const raw = await response.text();
        assertCondition(
          response.ok,
          `Artifact analysis canary returned ${response.status}: ${raw || "<empty body>"}`
        );
        assertCondition(
          raw.includes("mixin_overlap") || raw.includes("divergence"),
          "Artifact analysis canary did not produce the expected overlap/divergence output."
        );
        return {
          overlapDetected: raw.includes("mixin_overlap"),
          divergenceDetected: raw.includes("divergence")
        };
      })
    );

    let evidenceDocumentIds: string[] = [];
    probes.push(
      await timedProbe("evidence-sync", async () => {
        const response = await fetch(`${env.EVIDENCE_SERVICE_URL}/v1/evidence/sync`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-idempotency-key": `phase13-canary-evidence-sync-${runKey}`
          },
          body: JSON.stringify({
            connectorNames: ["github", "curated-community"]
          })
        });
        const payload = await readJson(response);
        assertCondition(
          response.ok,
          `Evidence sync canary returned ${response.status}: ${JSON.stringify(payload)}`
        );
        const documents = Array.isArray(payload?.documents) ? payload.documents : [];
        evidenceDocumentIds = documents
          .map((item) =>
            item && typeof item === "object" && "documentId" in item
              ? String(item.documentId)
              : undefined
          )
          .filter((item): item is string => Boolean(item));
        assertCondition(evidenceDocumentIds.length > 0, "Evidence sync canary returned no documents.");
        return {
          documentCount: evidenceDocumentIds.length
        };
      })
    );

    probes.push(
      await timedProbe("evidence-search", async () => {
        const response = await fetch(`${env.EVIDENCE_SERVICE_URL}/v1/evidence/search`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8"
          },
          body: JSON.stringify({
            query: "optifine fabric crash",
            limit: 3
          })
        });
        const payload = await readJson(response);
        assertCondition(
          response.ok,
          `Evidence search canary returned ${response.status}: ${JSON.stringify(payload)}`
        );
        const hits = Array.isArray(payload?.hits) ? payload.hits : [];
        assertCondition(hits.length > 0, "Evidence search canary returned no hits.");
        return {
          hitCount: hits.length
        };
      })
    );

    let curationId: string | undefined;
    probes.push(
      await timedProbe("admin-curation", async () => {
        assertCondition(
          evidenceDocumentIds.length > 0,
          "Admin canary requires evidence document IDs from evidence sync."
        );
        const response = await fetch(`${env.ADMIN_SERVICE_URL}/v1/admin/evidence-curations`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-idempotency-key": `phase13-canary-admin-curation-${runKey}`
          },
          body: JSON.stringify({
            title: "Phase 13 staging canary evidence promotion",
            findingType: "community_verified_incompatibility",
            severity: "high",
            summary:
              "Canary validation confirms that evidence curation and promotion are reachable in staging.",
            subjectProjectIds: ["cp_optifine", "cp_sodium"],
            evidenceDocumentIds: evidenceDocumentIds.slice(0, 2),
            evidenceSnippetIds: [],
            createdBy: "usr_demo"
          })
        });
        const payload = await readJson(response);
        assertCondition(
          response.ok,
          `Admin curation canary returned ${response.status}: ${JSON.stringify(payload)}`
        );
        curationId =
          payload && typeof payload === "object" && "curationId" in payload
            ? String(payload.curationId)
            : undefined;
        assertCondition(curationId, "Admin curation canary did not return a curationId.");
        return {
          curationId
        };
      })
    );

    probes.push(
      await timedProbe("admin-promotion", async () => {
        assertCondition(curationId, "Admin promotion canary requires a curationId.");
        const response = await fetch(
          `${env.ADMIN_SERVICE_URL}/v1/admin/evidence-curations/${encodeURIComponent(curationId)}/promote`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-idempotency-key": `phase13-canary-admin-promotion-${runKey}`
            },
            body: JSON.stringify({
              promotedBy: "usr_demo"
            })
          }
        );
        const payload = await readJson(response);
        assertCondition(
          response.ok,
          `Admin promotion canary returned ${response.status}: ${JSON.stringify(payload)}`
        );
        const promotedRuleId =
          payload &&
          typeof payload === "object" &&
          "rule" in payload &&
          payload.rule &&
          typeof payload.rule === "object" &&
          "ruleId" in payload.rule
            ? String(payload.rule.ruleId)
            : undefined;
        const curationStatus =
          payload &&
          typeof payload === "object" &&
          "curation" in payload &&
          payload.curation &&
          typeof payload.curation === "object" &&
          "status" in payload.curation
            ? String(payload.curation.status)
            : undefined;
        assertCondition(promotedRuleId, "Admin promotion canary did not return a promoted rule ID.");
        assertCondition(
          curationStatus === "promoted",
          `Expected promoted curation status, received ${curationStatus ?? "unknown"}.`
        );
        return {
          promotedRuleId,
          curationStatus
        };
      })
    );
  } finally {
    const completedAt = new Date().toISOString();
    const overallStatus = probes.every((probe) => probe.status === "ok") ? "ok" : "failed";
    const report = {
      status: overallStatus,
      environment: env.APP_ENV,
      startedAt,
      completedAt,
      reportPath,
      metricsPath,
      probes
    };

    ensureParentDirectory(reportPath);
    ensureParentDirectory(metricsPath);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(metricsPath, buildMetrics(env.APP_ENV, startedAt, completedAt, probes), "utf8");

    if (overallStatus !== "ok") {
      console.error(JSON.stringify(report, null, 2));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 13 staging canary failed: ${message}`);
  process.exitCode = 1;
});
