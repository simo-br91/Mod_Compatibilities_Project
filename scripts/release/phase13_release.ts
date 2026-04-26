import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const RELEASE_ROOT = resolve(ROOT, "infra/releases");
const MANIFEST_DIR = resolve(RELEASE_ROOT, "manifests");
const ENVIRONMENT_DIR = resolve(RELEASE_ROOT, "environments");
const DEFAULT_ENVIRONMENT = "staging";
const DEFAULT_REGISTRY_HOST =
  process.env.MODCOMPAT_IMAGE_REGISTRY?.trim() || "ghcr.io/modcompat";
const DEFAULT_IMAGE_NAMESPACE =
  process.env.MODCOMPAT_IMAGE_NAMESPACE?.trim() || "platform";

type CommandName =
  | "bundle"
  | "publish-images"
  | "status"
  | "deploy"
  | "rollback"
  | "verify";
type HistoryAction = "deploy" | "rollback";
type DeploymentKind = "docker-compose" | "kubernetes";

interface HistoryEntry {
  action: HistoryAction;
  changedAt: string;
  actor: string;
  reason?: string;
  fromReleaseVersion: string | null;
  toReleaseVersion: string;
  manifestPath: string;
  gitSha: string;
}

interface ReleaseServiceDefinition {
  serviceId: string;
  deployable: boolean;
  language: "typescript" | "go" | "java" | "nextjs";
  role: string;
  startCommand: string;
  healthUrl?: string;
  envKeys: string[];
  imageRepository?: string;
  dockerfilePath?: string;
  buildContext?: string;
}

interface PublishedImageArtifact {
  serviceId: string;
  localImageRef: string;
  remoteImageRef: string;
  registryHost: string;
  repository: string;
  tag: string;
  publishStatus: "planned" | "published";
  publishedAt: string | null;
  digest?: string;
  dockerfilePath: string;
  buildContext: string;
}

interface ReleaseImageSet {
  registryHost: string;
  namespace: string;
  publishedAt: string | null;
  artifacts: PublishedImageArtifact[];
}

interface DeploymentTarget {
  targetId: string;
  kind: DeploymentKind;
  environment: string;
  registryHost: string;
  manifestsPath: string;
  namespace: string;
  composeFiles: string[];
  releaseStatePath: string;
}

interface ReleaseManifest {
  schemaVersion: 2;
  releaseVersion: string;
  environment: string;
  createdAt: string;
  source: {
    gitSha: string;
    gitRef: string;
    generatedBy: string;
  };
  validation: {
    requiredChecks: string[];
    smokeWorkflow: string;
    regressionSuite: string;
  };
  runtime: {
    envTemplatePath: string;
    composeFilePath: string;
    appComposeFilePath: string;
    infrastructureDependencies: Array<{
      serviceId: string;
      source: "docker-compose";
      ports?: string[];
    }>;
  };
  services: ReleaseServiceDefinition[];
  images: ReleaseImageSet;
  deploymentTarget: DeploymentTarget;
  probes: Array<{
    probeId: string;
    command: string;
    purpose: string;
  }>;
}

interface CurrentImageSet {
  releaseVersion: string;
  publishedAt: string | null;
  registryHost: string;
  images: Array<{
    serviceId: string;
    imageRef: string;
    digest?: string;
  }>;
}

interface ReleaseHistoryRecord {
  releaseVersion: string;
  manifestPath: string;
  targetId: string;
  firstPromotedAt: string;
  lastChangedAt: string;
  gitSha: string;
  status: "active" | "superseded" | "rolled_back";
  imageSet?: CurrentImageSet;
}

interface EnvironmentState {
  schemaVersion: 2;
  environment: string;
  currentReleaseVersion: string | null;
  previousReleaseVersion: string | null;
  updatedAt: string | null;
  history: HistoryEntry[];
  deploymentTarget: DeploymentTarget;
  currentImageSet: CurrentImageSet | null;
  releaseHistory: ReleaseHistoryRecord[];
  rollbackCandidates: string[];
}

interface VerificationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

function usage() {
  console.log(`Phase 13 release control utility

Usage:
  node --import tsx ./scripts/release/phase13_release.ts <command> [options]

Commands:
  bundle          Create a versioned release manifest
  publish-images  Mark a manifest's image set as published to the configured registry
  status          Print environment release state
  deploy          Promote a release version into an environment
  rollback        Roll back an environment to a previous or explicitly targeted release
  verify          Validate release manifests and environment state references

Options:
  --environment <name>             Defaults to staging
  --release-version <version>      Required for publish-images and deploy, optional for bundle
  --target-release-version <ver>   Optional explicit rollback target
  --actor <name>                   Defaults to local-operator
  --reason <text>                  Optional change summary
  --registry-host <host>           Defaults to MODCOMPAT_IMAGE_REGISTRY or ghcr.io/modcompat
  --image-namespace <namespace>    Defaults to MODCOMPAT_IMAGE_NAMESPACE or platform
  --published-at <iso>             Optional explicit publish timestamp
  --dry-run                        Print the planned result without writing files
  --help                           Show this help
`);
}

function ensureDirectories() {
  mkdirSync(RELEASE_ROOT, { recursive: true });
  mkdirSync(MANIFEST_DIR, { recursive: true });
  mkdirSync(ENVIRONMENT_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeReleaseVersion(value: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `Invalid release version "${value}". Use only letters, numbers, ".", "_" and "-".`
    );
  }

  return value;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
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

  return { positional, flags };
}

function getStringFlag(flags: Map<string, string | boolean>, key: string) {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function getBooleanFlag(flags: Map<string, string | boolean>, key: string) {
  return flags.get(key) === true;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJsonFile(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function environmentStatePath(environment: string) {
  return resolve(ENVIRONMENT_DIR, `${environment}.json`);
}

function manifestPathForVersion(releaseVersion: string) {
  return resolve(MANIFEST_DIR, `${releaseVersion}.json`);
}

function gitSha() {
  return process.env.GITHUB_SHA?.trim() || "local-worktree";
}

function gitRef() {
  return process.env.GITHUB_REF_NAME?.trim() || process.env.GITHUB_REF?.trim() || "local";
}

function generatedBy(defaultActor?: string) {
  return (
    defaultActor ||
    process.env.GITHUB_ACTOR?.trim() ||
    process.env.USERNAME ||
    process.env.USER ||
    "local-operator"
  );
}

function buildDefaultReleaseVersion(environment: string) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const shortSha = gitSha().slice(0, 7) || "local";
  return `${environment}-${timestamp}-${shortSha}`;
}

function parseEnvTemplate(path: string) {
  const content = readFileSync(path, "utf8");
  const entries = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    entries.set(
      line.slice(0, separatorIndex).trim(),
      line.slice(separatorIndex + 1).trim()
    );
  }

  return entries;
}

function buildInfrastructureDependencies() {
  return [
    { serviceId: "postgres", source: "docker-compose" as const, ports: ["5432:5432"] },
    { serviceId: "redis", source: "docker-compose" as const, ports: ["6379:6379"] },
    { serviceId: "temporal", source: "docker-compose" as const, ports: ["7233:7233"] },
    { serviceId: "neo4j", source: "docker-compose" as const, ports: ["7474:7474", "7687:7687"] },
    { serviceId: "opensearch", source: "docker-compose" as const, ports: ["9200:9200"] },
    { serviceId: "minio", source: "docker-compose" as const, ports: ["9000:9000", "9001:9001"] }
  ];
}

function imageBuildMetadata(
  serviceId: string
): { localRepository: string; dockerfilePath: string; buildContext: string } | undefined {
  switch (serviceId) {
    case "artifact-analysis":
      return {
        localRepository: "modcompat/artifact-analysis",
        dockerfilePath: "docker/artifact-analysis.Dockerfile",
        buildContext: "."
      };
    case "evidence":
    case "admin":
    case "analysis-orchestrator":
      return {
        localRepository: `modcompat/${serviceId}`,
        dockerfilePath: "docker/node-service.Dockerfile",
        buildContext: "."
      };
    case "recommendation":
    case "graph":
    case "simulation":
      return {
        localRepository: `modcompat/${serviceId}`,
        dockerfilePath: "docker/go-service.Dockerfile",
        buildContext: "."
      };
    default:
      return undefined;
  }
}

function buildServiceInventory(envTemplate: Map<string, string>): ReleaseServiceDefinition[] {
  const evidenceUrl = envTemplate.get("EVIDENCE_SERVICE_URL") ?? "http://localhost:8081";
  const adminUrl = envTemplate.get("ADMIN_SERVICE_URL") ?? "http://localhost:8082";
  const recommendationUrl =
    envTemplate.get("RECOMMENDATION_SERVICE_URL") ?? "http://localhost:8083";
  const graphUrl = envTemplate.get("GRAPH_SERVICE_URL") ?? "http://localhost:8084";
  const simulationUrl = envTemplate.get("SIMULATION_SERVICE_URL") ?? "http://localhost:8085";
  const orchestratorUrl =
    envTemplate.get("ORCHESTRATOR_SERVICE_URL") ?? "http://localhost:8086";
  const artifactAnalysisUrl =
    envTemplate.get("ARTIFACT_ANALYSIS_SERVICE_URL") ?? "http://localhost:9090";
  const webUrl = envTemplate.get("WEB_BASE_URL") ?? "http://localhost:3000";

  const inventory: ReleaseServiceDefinition[] = [
    {
      serviceId: "evidence",
      deployable: true,
      language: "typescript",
      role: "evidence service",
      startCommand: "pnpm --filter @modcompat/evidence exec tsx src/index.ts",
      healthUrl: `${evidenceUrl}/healthz`,
      envKeys: ["APP_ENV", "LOG_LEVEL", "POSTGRES_URL", "EVIDENCE_HTTP_PORT"]
    },
    {
      serviceId: "admin",
      deployable: true,
      language: "typescript",
      role: "admin curation service",
      startCommand: "pnpm --filter @modcompat/admin exec tsx src/index.ts",
      healthUrl: `${adminUrl}/healthz`,
      envKeys: ["APP_ENV", "LOG_LEVEL", "POSTGRES_URL", "ADMIN_HTTP_PORT"]
    },
    {
      serviceId: "analysis-orchestrator",
      deployable: true,
      language: "typescript",
      role: "analysis orchestration service",
      startCommand: "pnpm --filter @modcompat/analysis-orchestrator exec tsx src/index.ts",
      healthUrl: `${orchestratorUrl}/healthz`,
      envKeys: [
        "APP_ENV",
        "LOG_LEVEL",
        "POSTGRES_URL",
        "ORCHESTRATOR_HTTP_PORT",
        "ARTIFACT_ANALYSIS_SERVICE_URL"
      ]
    },
    {
      serviceId: "recommendation",
      deployable: true,
      language: "go",
      role: "recommendation service",
      startCommand: "go run ./apps/recommendation/cmd/service",
      healthUrl: `${recommendationUrl}/healthz`,
      envKeys: ["RECOMMENDATION_HTTP_PORT", "ORCHESTRATOR_SERVICE_URL"]
    },
    {
      serviceId: "graph",
      deployable: true,
      language: "go",
      role: "graph service",
      startCommand: "go run ./apps/graph/cmd/service",
      healthUrl: `${graphUrl}/healthz`,
      envKeys: ["GRAPH_HTTP_PORT", "ORCHESTRATOR_SERVICE_URL"]
    },
    {
      serviceId: "simulation",
      deployable: true,
      language: "go",
      role: "simulation service",
      startCommand: "go run ./apps/simulation/cmd/service",
      healthUrl: `${simulationUrl}/healthz`,
      envKeys: ["SIMULATION_HTTP_PORT", "ORCHESTRATOR_SERVICE_URL"]
    },
    {
      serviceId: "artifact-analysis",
      deployable: true,
      language: "java",
      role: "artifact analysis service",
      startCommand:
        "java -cp .staging-smoke-artifact-analysis-classes com.modcompat.artifactanalysis.ArtifactAnalysisServer",
      healthUrl: `${artifactAnalysisUrl}/healthz`,
      envKeys: ["ARTIFACT_ANALYSIS_HTTP_PORT", "JAVA_BIN"]
    },
    {
      serviceId: "web",
      deployable: false,
      language: "nextjs",
      role: "web application shell",
      startCommand: "pnpm --filter @modcompat/web start",
      healthUrl: webUrl,
      envKeys: ["WEB_BASE_URL", "API_BASE_URL"]
    }
  ];

  return inventory.map((service) => {
    const image = imageBuildMetadata(service.serviceId);
    return {
      ...service,
      imageRepository: image?.localRepository,
      dockerfilePath: image?.dockerfilePath,
      buildContext: image?.buildContext
    };
  });
}

function buildDeploymentTarget(
  environment: string,
  registryHost: string,
  kind: DeploymentKind = "kubernetes"
): DeploymentTarget {
  return {
    targetId: `${environment}-${kind}`,
    kind,
    environment,
    registryHost,
    manifestsPath: kind === "kubernetes" ? "infra/kubernetes" : ".",
    namespace: `modcompat-${environment}`,
    composeFiles: ["docker-compose.yml", "docker-compose.staging.yml"],
    releaseStatePath: `infra/releases/environments/${environment}.json`
  };
}

function buildImageSet(options: {
  services: ReleaseServiceDefinition[];
  releaseVersion: string;
  registryHost: string;
  namespace: string;
}): ReleaseImageSet {
  return {
    registryHost: options.registryHost,
    namespace: options.namespace,
    publishedAt: null,
    artifacts: options.services
      .filter((service) => service.deployable && service.imageRepository && service.dockerfilePath)
      .map((service) => {
        const repository = `${options.namespace}/${service.serviceId}`;
        return {
          serviceId: service.serviceId,
          localImageRef: `${service.imageRepository}:${options.releaseVersion}`,
          remoteImageRef: `${options.registryHost}/${repository}:${options.releaseVersion}`,
          registryHost: options.registryHost,
          repository,
          tag: options.releaseVersion,
          publishStatus: "planned" as const,
          publishedAt: null,
          dockerfilePath: service.dockerfilePath!,
          buildContext: service.buildContext ?? "."
        };
      })
  };
}

function createManifest(options: {
  environment: string;
  releaseVersion: string;
  actor: string;
  registryHost: string;
  imageNamespace: string;
}): ReleaseManifest {
  const envTemplate = parseEnvTemplate(resolve(ROOT, ".env.example"));
  const services = buildServiceInventory(envTemplate);

  return {
    schemaVersion: 2,
    releaseVersion: options.releaseVersion,
    environment: options.environment,
    createdAt: nowIso(),
    source: {
      gitSha: gitSha(),
      gitRef: gitRef(),
      generatedBy: generatedBy(options.actor)
    },
    validation: {
      requiredChecks: [
        "pnpm contracts:check",
        "pnpm typecheck",
        "pnpm test:regression",
        "pnpm --filter @modcompat/web build",
        "pnpm canary:staging",
        "pnpm smoke:staging"
      ],
      smokeWorkflow: "Staging Smoke",
      regressionSuite: "pnpm test:regression"
    },
    runtime: {
      envTemplatePath: ".env.example",
      composeFilePath: "docker-compose.yml",
      appComposeFilePath: "docker-compose.staging.yml",
      infrastructureDependencies: buildInfrastructureDependencies()
    },
    services,
    images: buildImageSet({
      services,
      releaseVersion: options.releaseVersion,
      registryHost: options.registryHost,
      namespace: options.imageNamespace
    }),
    deploymentTarget: buildDeploymentTarget(options.environment, options.registryHost),
    probes: [
      {
        probeId: "staging-canary",
        command: "pnpm canary:staging",
        purpose:
          "Quickly verify service health plus critical artifact-analysis, evidence, and admin write/read paths before the heavier staging smoke gate."
      },
      {
        probeId: "gateway-staging-smoke",
        command: "pnpm smoke:staging",
        purpose: "Boot live service topology and validate replay, persistence, and boundary modes."
      },
      {
        probeId: "curated-regression-suite",
        command: "pnpm test:regression",
        purpose: "Detect drift in findings, recommendation quality, simulation results, and release gating."
      }
    ]
  };
}

function writeManifest(manifest: ReleaseManifest, dryRun: boolean) {
  const path = manifestPathForVersion(manifest.releaseVersion);
  if (!dryRun) {
    writeJsonFile(path, manifest);
  }
  return path;
}

function ensureManifestExists(releaseVersion: string) {
  const path = manifestPathForVersion(releaseVersion);
  if (!existsSync(path)) {
    throw new Error(`Release manifest not found for ${releaseVersion} at ${path}.`);
  }
  return path;
}

function relativeToRoot(path: string) {
  return path.replace(`${ROOT}\\`, "").replace(`${ROOT}/`, "");
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function readManifest(releaseVersion: string) {
  return readJsonFile<ReleaseManifest>(ensureManifestExists(releaseVersion));
}

function currentImageSetFromManifest(manifest: ReleaseManifest): CurrentImageSet | null {
  if (manifest.images.artifacts.length === 0) {
    return null;
  }

  return {
    releaseVersion: manifest.releaseVersion,
    publishedAt: manifest.images.publishedAt,
    registryHost: manifest.images.registryHost,
    images: manifest.images.artifacts.map((artifact) => ({
      serviceId: artifact.serviceId,
      imageRef: artifact.remoteImageRef,
      digest: artifact.digest
    }))
  };
}

function buildRollbackCandidates(history: ReleaseHistoryRecord[], currentReleaseVersion: string | null) {
  return history
    .filter((entry) => entry.releaseVersion !== currentReleaseVersion)
    .sort((left, right) => right.lastChangedAt.localeCompare(left.lastChangedAt))
    .map((entry) => entry.releaseVersion);
}

function migrateEnvironmentState(raw: unknown, environment: string): EnvironmentState {
  const defaultDeploymentTarget = buildDeploymentTarget(environment, DEFAULT_REGISTRY_HOST);

  if (
    raw &&
    typeof raw === "object" &&
    "schemaVersion" in raw &&
    (raw as { schemaVersion?: number }).schemaVersion === 2
  ) {
    const state = raw as EnvironmentState;
    return {
      ...state,
      deploymentTarget: state.deploymentTarget ?? defaultDeploymentTarget,
      currentImageSet: state.currentImageSet ?? null,
      releaseHistory: state.releaseHistory ?? [],
      rollbackCandidates:
        state.rollbackCandidates ??
        buildRollbackCandidates(state.releaseHistory ?? [], state.currentReleaseVersion ?? null)
    };
  }

  const state = raw as
    | {
        environment?: string;
        currentReleaseVersion?: string | null;
        previousReleaseVersion?: string | null;
        updatedAt?: string | null;
        history?: HistoryEntry[];
      }
    | undefined;

  return {
    schemaVersion: 2,
    environment: state?.environment ?? environment,
    currentReleaseVersion: state?.currentReleaseVersion ?? null,
    previousReleaseVersion: state?.previousReleaseVersion ?? null,
    updatedAt: state?.updatedAt ?? null,
    history: state?.history ?? [],
    deploymentTarget: defaultDeploymentTarget,
    currentImageSet: null,
    releaseHistory: [],
    rollbackCandidates: []
  };
}

function loadEnvironmentState(environment: string): EnvironmentState {
  const path = environmentStatePath(environment);
  if (!existsSync(path)) {
    return migrateEnvironmentState(undefined, environment);
  }

  return migrateEnvironmentState(readJsonFile(path), environment);
}

function saveEnvironmentState(state: EnvironmentState, dryRun: boolean) {
  const path = environmentStatePath(state.environment);
  if (!dryRun) {
    writeJsonFile(path, state);
  }
  return path;
}

function addIssue(
  issues: VerificationIssue[],
  severity: VerificationIssue["severity"],
  code: string,
  message: string
) {
  issues.push({ severity, code, message });
}

function tryParseUrl(issues: VerificationIssue[], value: string, context: string) {
  try {
    new URL(value);
  } catch {
    addIssue(issues, "error", "invalid_url", `${context} is not a valid URL: ${value}`);
  }
}

function verifyManifest(
  environment: string,
  releaseVersion: string,
  issues: VerificationIssue[]
) {
  const manifestFilePath = manifestPathForVersion(releaseVersion);

  if (!existsSync(manifestFilePath)) {
    addIssue(
      issues,
      "error",
      "manifest_missing",
      `Release manifest for ${releaseVersion} is missing at ${relativeToRoot(manifestFilePath)}.`
    );
    return;
  }

  const manifest = readJsonFile<ReleaseManifest>(manifestFilePath);

  if (manifest.environment !== environment) {
    addIssue(
      issues,
      "warning",
      "manifest_environment_mismatch",
      `Release manifest ${releaseVersion} targets ${manifest.environment} instead of ${environment}.`
    );
  }

  if (manifest.validation.requiredChecks.length === 0) {
    addIssue(
      issues,
      "error",
      "required_checks_missing",
      `Release manifest ${releaseVersion} does not declare any required validation checks.`
    );
  }

  if (manifest.probes.length === 0) {
    addIssue(
      issues,
      "warning",
      "probe_commands_missing",
      `Release manifest ${releaseVersion} does not declare any operator probe commands.`
    );
  }

  const composePath = resolve(ROOT, manifest.runtime.composeFilePath);
  if (!existsSync(composePath)) {
    addIssue(
      issues,
      "error",
      "compose_file_missing",
      `Release manifest ${releaseVersion} references a missing compose file: ${manifest.runtime.composeFilePath}`
    );
  }

  const appComposePath = resolve(ROOT, manifest.runtime.appComposeFilePath);
  if (!existsSync(appComposePath)) {
    addIssue(
      issues,
      "error",
      "app_compose_file_missing",
      `Release manifest ${releaseVersion} references a missing application compose file: ${manifest.runtime.appComposeFilePath}`
    );
  }

  const manifestsPath = resolve(ROOT, manifest.deploymentTarget.manifestsPath);
  if (!existsSync(manifestsPath)) {
    addIssue(
      issues,
      "error",
      "deployment_target_missing",
      `Release manifest ${releaseVersion} references missing deployment target assets at ${manifest.deploymentTarget.manifestsPath}.`
    );
  }

  if (manifest.images.artifacts.length === 0) {
    addIssue(
      issues,
      "error",
      "image_inventory_missing",
      `Release manifest ${releaseVersion} does not include any deployable image artifacts.`
    );
  }

  for (const service of manifest.services) {
    if (!service.startCommand.trim()) {
      addIssue(
        issues,
        "error",
        "service_start_command_missing",
        `Release manifest ${releaseVersion} service ${service.serviceId} has no startCommand.`
      );
    }

    if (service.healthUrl) {
      tryParseUrl(
        issues,
        service.healthUrl,
        `Release manifest ${releaseVersion} service ${service.serviceId} healthUrl`
      );
    }
  }

  for (const image of manifest.images.artifacts) {
    if (!image.remoteImageRef.trim()) {
      addIssue(
        issues,
        "error",
        "remote_image_missing",
        `Release manifest ${releaseVersion} image ${image.serviceId} has no remote image reference.`
      );
    }
    if (!existsSync(resolve(ROOT, image.dockerfilePath))) {
      addIssue(
        issues,
        "error",
        "dockerfile_missing",
        `Release manifest ${releaseVersion} image ${image.serviceId} references missing Dockerfile ${image.dockerfilePath}.`
      );
    }
  }
}

function verifyEnvironmentState(environment: string, specificReleaseVersion?: string) {
  const issues: VerificationIssue[] = [];
  const statePath = environmentStatePath(environment);
  const state = loadEnvironmentState(environment);

  if (!existsSync(statePath)) {
    addIssue(
      issues,
      "warning",
      "environment_state_missing",
      `Environment state for ${environment} does not exist yet at ${relativeToRoot(statePath)}.`
    );
  }

  const releaseVersionsToVerify = new Set<string>();
  if (specificReleaseVersion) {
    releaseVersionsToVerify.add(specificReleaseVersion);
  }
  if (state.currentReleaseVersion) {
    releaseVersionsToVerify.add(state.currentReleaseVersion);
  }
  if (state.previousReleaseVersion) {
    releaseVersionsToVerify.add(state.previousReleaseVersion);
  }

  for (const candidate of state.rollbackCandidates) {
    releaseVersionsToVerify.add(candidate);
  }

  for (const historyEntry of state.history) {
    releaseVersionsToVerify.add(historyEntry.toReleaseVersion);

    if (!existsSync(resolve(ROOT, historyEntry.manifestPath))) {
      addIssue(
        issues,
        "error",
        "history_manifest_missing",
        `History entry for ${historyEntry.toReleaseVersion} references missing manifest path ${historyEntry.manifestPath}.`
      );
    }
  }

  for (const releaseRecord of state.releaseHistory) {
    releaseVersionsToVerify.add(releaseRecord.releaseVersion);

    if (!existsSync(resolve(ROOT, releaseRecord.manifestPath))) {
      addIssue(
        issues,
        "error",
        "release_history_manifest_missing",
        `Release history entry for ${releaseRecord.releaseVersion} references missing manifest path ${releaseRecord.manifestPath}.`
      );
    }
  }

  for (const releaseVersion of releaseVersionsToVerify) {
    verifyManifest(environment, releaseVersion, issues);
  }

  if (state.currentImageSet && state.currentReleaseVersion !== state.currentImageSet.releaseVersion) {
    addIssue(
      issues,
      "warning",
      "image_set_release_mismatch",
      `Environment ${environment} current image set points to ${state.currentImageSet.releaseVersion} while currentReleaseVersion is ${state.currentReleaseVersion}.`
    );
  }

  return {
    environment,
    specificReleaseVersion: specificReleaseVersion ?? null,
    currentReleaseVersion: state.currentReleaseVersion,
    previousReleaseVersion: state.previousReleaseVersion,
    rollbackCandidates: state.rollbackCandidates,
    manifestCount: releaseVersionsToVerify.size,
    ok: issues.every((issue) => issue.severity !== "error"),
    issues
  };
}

function upsertReleaseHistory(
  history: ReleaseHistoryRecord[],
  entry: ReleaseHistoryRecord
): ReleaseHistoryRecord[] {
  const filtered = history.filter((item) => item.releaseVersion !== entry.releaseVersion);
  return [...filtered, entry].sort((left, right) =>
    left.firstPromotedAt.localeCompare(right.firstPromotedAt)
  );
}

function publishImages(options: {
  environment: string;
  releaseVersion: string;
  publishedAt?: string;
  dryRun: boolean;
}) {
  const manifestPath = ensureManifestExists(options.releaseVersion);
  const manifest = readJsonFile<ReleaseManifest>(manifestPath);
  const publishedAt = options.publishedAt ?? nowIso();

  const nextManifest: ReleaseManifest = {
    ...manifest,
    images: {
      ...manifest.images,
      publishedAt,
      artifacts: manifest.images.artifacts.map((artifact) => ({
        ...artifact,
        publishStatus: "published",
        publishedAt
      }))
    }
  };

  if (!options.dryRun) {
    writeJsonFile(manifestPath, nextManifest);
  }

  return {
    action: "publish-images",
    environment: options.environment,
    releaseVersion: options.releaseVersion,
    manifestPath: relativeToRoot(manifestPath),
    publishedAt,
    imageCount: nextManifest.images.artifacts.length,
    registryHost: nextManifest.images.registryHost
  };
}

function promoteRelease(options: {
  environment: string;
  releaseVersion: string;
  actor: string;
  reason?: string;
  dryRun: boolean;
  action: HistoryAction;
}) {
  const manifestFilePath = ensureManifestExists(options.releaseVersion);
  const manifest = readJsonFile<ReleaseManifest>(manifestFilePath);
  const currentState = loadEnvironmentState(options.environment);
  const currentReleaseVersion = currentState.currentReleaseVersion;
  const changedAt = nowIso();
  const imageSet = currentImageSetFromManifest(manifest);

  const releaseHistory = currentState.releaseHistory.map((entry) => ({
    ...entry,
    status:
      entry.releaseVersion === currentReleaseVersion && entry.releaseVersion !== options.releaseVersion
        ? "superseded"
        : entry.status
  }));

  const nextReleaseHistory = upsertReleaseHistory(releaseHistory, {
    releaseVersion: options.releaseVersion,
    manifestPath: relativeToRoot(manifestFilePath),
    targetId: manifest.deploymentTarget.targetId,
    firstPromotedAt:
      currentState.releaseHistory.find((entry) => entry.releaseVersion === options.releaseVersion)
        ?.firstPromotedAt ?? changedAt,
    lastChangedAt: changedAt,
    gitSha: manifest.source.gitSha,
    status: "active",
    imageSet: imageSet ?? undefined
  });

  const nextState: EnvironmentState = {
    ...currentState,
    currentReleaseVersion: options.releaseVersion,
    previousReleaseVersion:
      currentReleaseVersion && currentReleaseVersion !== options.releaseVersion
        ? currentReleaseVersion
        : currentState.previousReleaseVersion,
    updatedAt: changedAt,
    deploymentTarget: manifest.deploymentTarget,
    currentImageSet: imageSet,
    releaseHistory: nextReleaseHistory,
    rollbackCandidates: buildRollbackCandidates(nextReleaseHistory, options.releaseVersion),
    history: [
      ...currentState.history,
      {
        action: options.action,
        changedAt,
        actor: options.actor,
        reason: options.reason,
        fromReleaseVersion: currentReleaseVersion,
        toReleaseVersion: options.releaseVersion,
        manifestPath: relativeToRoot(manifestFilePath),
        gitSha: manifest.source.gitSha
      }
    ]
  };

  const statePath = saveEnvironmentState(nextState, options.dryRun);
  return {
    environment: options.environment,
    action: options.action,
    releaseVersion: options.releaseVersion,
    manifestPath: relativeToRoot(manifestFilePath),
    statePath: relativeToRoot(statePath),
    currentReleaseVersion: nextState.currentReleaseVersion,
    previousReleaseVersion: nextState.previousReleaseVersion,
    rollbackCandidates: nextState.rollbackCandidates,
    currentImageSet: nextState.currentImageSet
  };
}

function rollbackRelease(options: {
  environment: string;
  targetReleaseVersion?: string;
  actor: string;
  reason?: string;
  dryRun: boolean;
}) {
  const state = loadEnvironmentState(options.environment);
  const targetReleaseVersion =
    options.targetReleaseVersion ?? state.rollbackCandidates[0] ?? state.previousReleaseVersion;

  if (!targetReleaseVersion) {
    throw new Error(
      `No rollback target is available for ${options.environment}. rollbackCandidates is empty.`
    );
  }

  const manifestFilePath = ensureManifestExists(targetReleaseVersion);
  const manifest = readJsonFile<ReleaseManifest>(manifestFilePath);
  const changedAt = nowIso();
  const imageSet = currentImageSetFromManifest(manifest);

  const nextReleaseHistory = upsertReleaseHistory(
    state.releaseHistory.map((entry) => ({
      ...entry,
      status:
        entry.releaseVersion === state.currentReleaseVersion && entry.releaseVersion !== targetReleaseVersion
          ? "rolled_back"
          : entry.releaseVersion === targetReleaseVersion
            ? "active"
            : entry.status
    })),
    {
      releaseVersion: targetReleaseVersion,
      manifestPath: relativeToRoot(manifestFilePath),
      targetId: manifest.deploymentTarget.targetId,
      firstPromotedAt:
        state.releaseHistory.find((entry) => entry.releaseVersion === targetReleaseVersion)
          ?.firstPromotedAt ?? changedAt,
      lastChangedAt: changedAt,
      gitSha: manifest.source.gitSha,
      status: "active",
      imageSet: imageSet ?? undefined
    }
  );

  const nextState: EnvironmentState = {
    ...state,
    currentReleaseVersion: targetReleaseVersion,
    previousReleaseVersion: state.currentReleaseVersion,
    updatedAt: changedAt,
    deploymentTarget: manifest.deploymentTarget,
    currentImageSet: imageSet,
    releaseHistory: nextReleaseHistory,
    rollbackCandidates: buildRollbackCandidates(nextReleaseHistory, targetReleaseVersion),
    history: [
      ...state.history,
      {
        action: "rollback",
        changedAt,
        actor: options.actor,
        reason: options.reason,
        fromReleaseVersion: state.currentReleaseVersion,
        toReleaseVersion: targetReleaseVersion,
        manifestPath: relativeToRoot(manifestFilePath),
        gitSha: manifest.source.gitSha
      }
    ]
  };

  const statePath = saveEnvironmentState(nextState, options.dryRun);
  return {
    environment: options.environment,
    action: "rollback",
    releaseVersion: targetReleaseVersion,
    manifestPath: relativeToRoot(manifestFilePath),
    statePath: relativeToRoot(statePath),
    currentReleaseVersion: nextState.currentReleaseVersion,
    previousReleaseVersion: nextState.previousReleaseVersion,
    rollbackCandidates: nextState.rollbackCandidates,
    currentImageSet: nextState.currentImageSet
  };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] as CommandName | undefined;

  if (!command || getBooleanFlag(flags, "help")) {
    usage();
    return;
  }

  ensureDirectories();

  const environment = getStringFlag(flags, "environment") ?? DEFAULT_ENVIRONMENT;
  const actor = getStringFlag(flags, "actor") ?? "local-operator";
  const reason = getStringFlag(flags, "reason");
  const dryRun = getBooleanFlag(flags, "dry-run");
  const registryHost = getStringFlag(flags, "registry-host") ?? DEFAULT_REGISTRY_HOST;
  const imageNamespace =
    getStringFlag(flags, "image-namespace") ?? DEFAULT_IMAGE_NAMESPACE;

  switch (command) {
    case "status":
      printJson(loadEnvironmentState(environment));
      return;
    case "verify":
      printJson(
        verifyEnvironmentState(
          environment,
          getStringFlag(flags, "release-version")
            ? sanitizeReleaseVersion(getStringFlag(flags, "release-version")!)
            : undefined
        )
      );
      return;
    case "bundle": {
      const releaseVersion = sanitizeReleaseVersion(
        getStringFlag(flags, "release-version") ?? buildDefaultReleaseVersion(environment)
      );
      const manifest = createManifest({
        environment,
        releaseVersion,
        actor,
        registryHost,
        imageNamespace
      });
      const manifestPath = writeManifest(manifest, dryRun);
      printJson({
        action: "bundle",
        dryRun,
        environment,
        releaseVersion,
        manifestPath: relativeToRoot(manifestPath),
        gitSha: manifest.source.gitSha,
        registryHost,
        imageCount: manifest.images.artifacts.length
      });
      return;
    }
    case "publish-images": {
      const releaseVersion = getStringFlag(flags, "release-version");
      if (!releaseVersion) {
        throw new Error("--release-version is required for publish-images.");
      }

      printJson(
        publishImages({
          environment,
          releaseVersion: sanitizeReleaseVersion(releaseVersion),
          publishedAt: getStringFlag(flags, "published-at"),
          dryRun
        })
      );
      return;
    }
    case "deploy": {
      const releaseVersion = getStringFlag(flags, "release-version");
      if (!releaseVersion) {
        throw new Error("--release-version is required for deploy.");
      }

      printJson(
        promoteRelease({
          environment,
          releaseVersion: sanitizeReleaseVersion(releaseVersion),
          actor,
          reason,
          dryRun,
          action: "deploy"
        })
      );
      return;
    }
    case "rollback":
      printJson(
        rollbackRelease({
          environment,
          targetReleaseVersion: getStringFlag(flags, "target-release-version")
            ? sanitizeReleaseVersion(getStringFlag(flags, "target-release-version")!)
            : undefined,
          actor,
          reason,
          dryRun
        })
      );
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 13 release control failed: ${message}`);
  process.exitCode = 1;
}
