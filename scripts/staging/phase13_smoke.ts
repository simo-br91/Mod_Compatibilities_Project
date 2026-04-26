import { spawn } from "node:child_process";
import { existsSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const LOG_DIR = resolve(ROOT, ".staging-smoke-logs");
const CACHE_DIR = resolve(ROOT, ".staging-smoke-cache");
const ARTIFACT_CLASSES_DIR = resolve(ROOT, ".staging-smoke-artifact-analysis-classes");
const DEFAULT_HOST = "127.0.0.1";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const probeOnly = args.has("--probe-only");

if (args.has("--help")) {
  console.log(`Phase 13 staging smoke runner

Usage:
  node --import tsx ./scripts/staging/phase13_smoke.ts
  node --import tsx ./scripts/staging/phase13_smoke.ts --dry-run
  node --import tsx ./scripts/staging/phase13_smoke.ts --probe-only

Environment:
  POSTGRES_URL                        Required reachable Postgres connection string
  LOG_LEVEL                          Optional, defaults to info
  APP_ENV                            Optional, defaults to staging
  EVIDENCE_HTTP_PORT                 Optional, defaults to 8081
  ADMIN_HTTP_PORT                    Optional, defaults to 8082
  RECOMMENDATION_HTTP_PORT           Optional, defaults to 8083
  GRAPH_HTTP_PORT                    Optional, defaults to 8084
  SIMULATION_HTTP_PORT               Optional, defaults to 8085
  ORCHESTRATOR_HTTP_PORT             Optional, defaults to 8086
  ARTIFACT_ANALYSIS_HTTP_PORT        Optional, defaults to 9090

The runner starts the live Phase 8/13 service topology, waits for health checks,
executes the gateway demo flow through the active service boundaries, and asserts
that the returned summary reflects successful cross-service execution.

With --probe-only, the runner skips process startup and only probes already-running
services before executing the gateway validation flow.`);
  process.exit(0);
}

interface ServiceDefinition {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  healthUrl: string;
}

interface ManagedProcess extends ServiceDefinition {
  child: ReturnType<typeof spawn>;
  stdoutLogPath: string;
  stderrLogPath: string;
  startupError?: string;
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function ensureCleanDirectory(path: string) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true });
}

function parseGatewayJson(rawStdout: string) {
  const lines = rawStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if ("serviceBoundaries" in parsed && "demo" in parsed) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON log lines and continue scanning upward.
    }
  }

  throw new Error("Could not find the gateway smoke summary JSON in stdout.");
}

function tailFile(path: string, lineCount = 40) {
  if (!existsSync(path)) {
    return "";
  }

  const content = readFileSync(path, "utf8").trim();
  if (!content) {
    return "";
  }

  return content
    .split(/\r?\n/)
    .slice(-lineCount)
    .join("\n");
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function buildBaseEnv() {
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
    ...process.env,
    APP_ENV: process.env.APP_ENV ?? "staging",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    POSTGRES_URL: postgresUrl,
    EVIDENCE_HTTP_PORT: evidencePort,
    ADMIN_HTTP_PORT: adminPort,
    RECOMMENDATION_HTTP_PORT: recommendationPort,
    GRAPH_HTTP_PORT: graphPort,
    SIMULATION_HTTP_PORT: simulationPort,
    ORCHESTRATOR_HTTP_PORT: orchestratorPort,
    ARTIFACT_ANALYSIS_HTTP_PORT: artifactAnalysisPort,
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

async function runCommand(
  name: string,
  command: string,
  argsList: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
) {
  return await new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, argsList, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      rejectPromise(
        new Error(`Failed to start ${name}: ${error instanceof Error ? error.message : String(error)}`)
      );
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(
        new Error(
          `${name} exited with code ${code ?? "unknown"}.\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`
        )
      );
    });
  });
}

function spawnService(definition: ServiceDefinition): ManagedProcess {
  const stdoutLogPath = resolve(LOG_DIR, `${definition.name}.out.log`);
  const stderrLogPath = resolve(LOG_DIR, `${definition.name}.err.log`);
  const stdoutStream = createWriteStream(stdoutLogPath, { flags: "w" });
  const stderrStream = createWriteStream(stderrLogPath, { flags: "w" });
  const child = spawn(definition.command, definition.args, {
    cwd: definition.cwd,
    env: definition.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  const managedProcess: ManagedProcess = {
    ...definition,
    child,
    stdoutLogPath,
    stderrLogPath
  };

  child.once("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    managedProcess.startupError = message;
    stderrStream.write(`[spawn-error] ${message}\n`);
  });

  return managedProcess;
}

async function waitForHealth(managedProcess: ManagedProcess, timeoutMs = 120_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (managedProcess.startupError) {
      const stdoutTail = tailFile(managedProcess.stdoutLogPath);
      const stderrTail = tailFile(managedProcess.stderrLogPath);
      throw new Error(
        `${managedProcess.name} failed to start.\n\nstdout:\n${stdoutTail}\n\nstderr:\n${stderrTail}`
      );
    }

    if (managedProcess.child.exitCode !== null) {
      const stdoutTail = tailFile(managedProcess.stdoutLogPath);
      const stderrTail = tailFile(managedProcess.stderrLogPath);
      throw new Error(
        `${managedProcess.name} exited before becoming healthy.\n\nstdout:\n${stdoutTail}\n\nstderr:\n${stderrTail}`
      );
    }

    try {
      const response = await fetch(managedProcess.healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Service is still starting.
    }

    await delay(1_000);
  }

  throw new Error(
    `${managedProcess.name} did not become healthy at ${managedProcess.healthUrl} within ${timeoutMs}ms.`
  );
}

async function stopProcess(managedProcess: ManagedProcess) {
  if (managedProcess.child.exitCode !== null || managedProcess.child.killed) {
    return;
  }

  managedProcess.child.kill("SIGTERM");

  const stopped = await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      resolvePromise(false);
    }, 5_000);

    managedProcess.child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });

  if (!stopped) {
    managedProcess.child.kill("SIGKILL");
  }
}

function validateGatewaySummary(summary: Record<string, unknown>) {
  const persistence = summary.persistence as Record<string, unknown>;
  const serviceBoundaries = summary.serviceBoundaries as Record<string, Record<string, unknown>>;
  const demo = summary.demo as Record<string, unknown>;
  const artifactAnalysis = serviceBoundaries.artifactAnalysis;
  const evidence = serviceBoundaries.evidence;
  const admin = serviceBoundaries.admin;
  const recommendation = serviceBoundaries.recommendation;
  const graph = serviceBoundaries.graph;
  const simulation = serviceBoundaries.simulation;
  const orchestrator = serviceBoundaries.orchestrator;

  assertCondition(persistence.enabled === true, "Expected persistence to be enabled.");
  assertCondition(persistence.persisted === true, "Expected the gateway smoke run to persist analysis state.");
  assertCondition(persistence.hydrated === true, "Expected the gateway smoke run to hydrate persisted analysis state.");

  assertCondition(artifactAnalysis.mode === "jvm-http", "Expected artifact analysis to use the JVM HTTP boundary.");
  assertCondition(evidence.mode === "http", "Expected the evidence boundary to run over HTTP.");
  assertCondition(admin.mode === "http", "Expected the admin boundary to run over HTTP.");
  assertCondition(recommendation.mode === "http", "Expected the recommendation boundary to run over HTTP.");
  assertCondition(graph.mode === "http", "Expected the graph boundary to run over HTTP.");
  assertCondition(simulation.mode === "http", "Expected the simulation boundary to run over HTTP.");
  assertCondition(orchestrator.mode === "http", "Expected the orchestrator boundary to run over HTTP.");

  assertCondition((evidence.searchHits as number) > 0, "Expected remote evidence search hits.");
  assertCondition((evidence.linkedHits as number) > 0, "Expected remote linked evidence hits.");
  assertCondition(evidence.replaySameDocumentIds === true, "Expected evidence replay-safe behavior.");
  assertCondition(admin.curationReplaySameId === true, "Expected admin curation replay-safe behavior.");
  assertCondition(admin.promotionReplaySameRule === true, "Expected admin promotion replay-safe behavior.");
  assertCondition(recommendation.replaySameSetId === true, "Expected recommendation replay-safe behavior.");
  assertCondition(graph.replaySameShape === true, "Expected graph replay-safe behavior.");
  assertCondition(simulation.replaySameRunId === true, "Expected simulation replay-safe behavior.");

  assertCondition(orchestrator.status === "completed", "Expected remote orchestrator analysis to complete.");
  assertCondition(
    orchestrator.idempotentReplaySameAnalysis === true,
    "Expected orchestrator idempotent replay to return the same analysis."
  );
  assertCondition(
    orchestrator.cancelledBeforeExecution === true,
    "Expected the staging smoke cancel probe to cancel before execution."
  );
  assertCondition(
    orchestrator.cancelledRequestStatus === "cancelled",
    "Expected the cancelled request to end in cancelled status."
  );

  assertCondition((demo.findingCount as number) > 0, "Expected demo findings to be present.");
  assertCondition((recommendation.itemCount as number) > 0, "Expected remote recommendations to be present.");
  assertCondition((graph.nodeCount as number) > 0, "Expected remote graph nodes to be present.");
  assertCondition(
    (simulation.observationCount as number) > 0,
    "Expected remote simulation observations to be present."
  );
}

function printDiagnostics(managedProcesses: ManagedProcess[]) {
  console.error(`Staging smoke logs are available in ${LOG_DIR}`);

  for (const managedProcess of managedProcesses) {
    const stdoutTail = tailFile(managedProcess.stdoutLogPath, 20);
    const stderrTail = tailFile(managedProcess.stderrLogPath, 20);

    if (stdoutTail) {
      console.error(`\n[${managedProcess.name} stdout]\n${stdoutTail}`);
    }

    if (stderrTail) {
      console.error(`\n[${managedProcess.name} stderr]\n${stderrTail}`);
    }
  }
}

async function compileArtifactAnalysisServer(env: NodeJS.ProcessEnv) {
  ensureCleanDirectory(ARTIFACT_CLASSES_DIR);

  const sourceDir = resolve(
    ROOT,
    "apps/artifact-analysis/src/main/java/com/modcompat/artifactanalysis"
  );
  const boundarySource = resolve(sourceDir, "ArtifactAnalysisBoundary.java");
  const serverSource = resolve(sourceDir, "ArtifactAnalysisServer.java");

  await runCommand("javac", "javac", ["--release", "21", "-d", ARTIFACT_CLASSES_DIR, boundarySource, serverSource], {
    cwd: ROOT,
    env
  });
}

async function runGatewaySmoke(env: NodeJS.ProcessEnv) {
  const gatewayDirectory = resolve(ROOT, "apps/gateway");
  const result = await runCommand(
    "gateway staging smoke",
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: gatewayDirectory,
      env
    }
  );

  writeFileSync(resolve(LOG_DIR, "gateway-smoke.out.log"), result.stdout);
  writeFileSync(resolve(LOG_DIR, "gateway-smoke.err.log"), result.stderr);

  const summary = parseGatewayJson(result.stdout);
  validateGatewaySummary(summary);
  return summary;
}

async function main() {
  ensureCleanDirectory(LOG_DIR);
  ensureDirectory(CACHE_DIR);

  const env = buildBaseEnv();

  const goRecommendationCache = resolve(CACHE_DIR, "recommendation");
  const goGraphCache = resolve(CACHE_DIR, "graph");
  const goSimulationCache = resolve(CACHE_DIR, "simulation");

  ensureDirectory(resolve(goRecommendationCache, "go-build"));
  ensureDirectory(resolve(goRecommendationCache, "go-mod"));
  ensureDirectory(resolve(goGraphCache, "go-build"));
  ensureDirectory(resolve(goGraphCache, "go-mod"));
  ensureDirectory(resolve(goSimulationCache, "go-build"));
  ensureDirectory(resolve(goSimulationCache, "go-mod"));

  const serviceDefinitions: ServiceDefinition[] = [
    {
      name: "artifact-analysis",
      command: "java",
      args: ["-cp", ARTIFACT_CLASSES_DIR, "com.modcompat.artifactanalysis.ArtifactAnalysisServer"],
      cwd: ROOT,
      env,
      healthUrl: `http://${DEFAULT_HOST}:${env.ARTIFACT_ANALYSIS_HTTP_PORT}/healthz`
    },
    {
      name: "evidence",
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: resolve(ROOT, "apps/evidence"),
      env,
      healthUrl: `${env.EVIDENCE_SERVICE_URL}/healthz`
    },
    {
      name: "admin",
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: resolve(ROOT, "apps/admin"),
      env,
      healthUrl: `${env.ADMIN_SERVICE_URL}/healthz`
    },
    {
      name: "orchestrator",
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: resolve(ROOT, "apps/analysis-orchestrator"),
      env,
      healthUrl: `${env.ORCHESTRATOR_SERVICE_URL}/healthz`
    },
    {
      name: "recommendation",
      command: "go",
      args: ["run", "./cmd/service"],
      cwd: resolve(ROOT, "apps/recommendation"),
      env: {
        ...env,
        GOCACHE: resolve(goRecommendationCache, "go-build"),
        GOMODCACHE: resolve(goRecommendationCache, "go-mod"),
        GOTELEMETRY: "off"
      },
      healthUrl: `${env.RECOMMENDATION_SERVICE_URL}/healthz`
    },
    {
      name: "graph",
      command: "go",
      args: ["run", "./cmd/service"],
      cwd: resolve(ROOT, "apps/graph"),
      env: {
        ...env,
        GOCACHE: resolve(goGraphCache, "go-build"),
        GOMODCACHE: resolve(goGraphCache, "go-mod"),
        GOTELEMETRY: "off"
      },
      healthUrl: `${env.GRAPH_SERVICE_URL}/healthz`
    },
    {
      name: "simulation",
      command: "go",
      args: ["run", "./cmd/service"],
      cwd: resolve(ROOT, "apps/simulation"),
      env: {
        ...env,
        GOCACHE: resolve(goSimulationCache, "go-build"),
        GOMODCACHE: resolve(goSimulationCache, "go-mod"),
        GOTELEMETRY: "off"
      },
      healthUrl: `${env.SIMULATION_SERVICE_URL}/healthz`
    }
  ];

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          status: "dry-run",
          probeOnly,
          postgresUrl: env.POSTGRES_URL,
          logsDir: LOG_DIR,
          services: serviceDefinitions.map((service) => ({
            name: service.name,
            cwd: service.cwd,
            command: [service.command, ...service.args].join(" "),
            healthUrl: service.healthUrl
          }))
        },
        null,
        2
      )
    );
    return;
  }

  await waitForTcpConnection("Postgres", env.POSTGRES_URL!);
  const managedProcesses: ManagedProcess[] = [];

  try {
    if (probeOnly) {
      for (const definition of serviceDefinitions) {
        const response = await fetch(definition.healthUrl);
        if (!response.ok) {
          throw new Error(
            `${definition.name} probe returned non-OK status at ${definition.healthUrl}: ${response.status}`
          );
        }
      }
    } else {
      await compileArtifactAnalysisServer(env);

      for (const definition of serviceDefinitions) {
        managedProcesses.push(spawnService(definition));
      }

      for (const managedProcess of managedProcesses) {
        await waitForHealth(managedProcess);
      }
    }

    const summary = await runGatewaySmoke(env);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          probeOnly,
          logsDir: LOG_DIR,
          demoAnalysisId: (summary.demo as Record<string, unknown>).analysisId,
          orchestratedAnalysisId:
            (summary.serviceBoundaries as Record<string, Record<string, unknown>>).orchestrator
              .analysisId,
          boundaryModes: {
            artifactAnalysis: (
              summary.serviceBoundaries as Record<string, Record<string, unknown>>
            ).artifactAnalysis.mode,
            evidence: (
              summary.serviceBoundaries as Record<string, Record<string, unknown>>
            ).evidence.mode,
            admin: (
              summary.serviceBoundaries as Record<string, Record<string, unknown>>
            ).admin.mode,
            recommendation: (
              summary.serviceBoundaries as Record<string, Record<string, unknown>>
            ).recommendation.mode,
            graph: (
              summary.serviceBoundaries as Record<string, Record<string, unknown>>
            ).graph.mode,
            simulation: (
              summary.serviceBoundaries as Record<string, Record<string, unknown>>
            ).simulation.mode,
            orchestrator: (
              summary.serviceBoundaries as Record<string, Record<string, unknown>>
            ).orchestrator.mode
          }
        },
        null,
        2
      )
    );
  } catch (error) {
    printDiagnostics(managedProcesses);
    throw error;
  } finally {
    for (const managedProcess of [...managedProcesses].reverse()) {
      await stopProcess(managedProcess);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 13 staging smoke failed: ${message}`);
  process.exitCode = 1;
});
