import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadLocalEnvFile } from "../load_local_env.ts";

loadLocalEnvFile();

const CURSEFORGE_API_BASE = "https://api.curseforge.com/v1";
const MODRINTH_API_BASE = "https://api.modrinth.com/v2";

interface CurseForgeFile {
  id: number;
  displayName: string;
  fileName: string;
  downloadUrl?: string;
  gameVersions: string[];
  modLoaders?: string[];
}

interface CurseForgeMod {
  id: number;
  name: string;
  slug: string;
  gameLatestFiles?: CurseForgeFile[];
}

interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  name?: string;
  loaders: string[];
  game_versions: string[];
  files: Array<{ url: string; primary?: boolean; filename?: string }>;
}

interface ModrinthSearchResponse {
  hits: Array<{
    project_id: string;
    slug: string;
    title: string;
  }>;
}

const KNOWN_CURSEFORGE_PROJECT_IDS: Record<string, number> = {
  balm: 531761,
  bookshelf: 228525,
  collective: 342584,
  curios: 309927,
  "architectury-api": 419699,
  placebo: 283644,
  ferritecore: 429235,
  modernfix: 790626
};

const DEFAULT_FORGE_VERSION_BY_MINECRAFT: Record<string, string> = {
  "1.20.1": "47.4.20"
};

interface CandidatePayload {
  candidate: {
    candidateId: string;
    packSnapshotId: string;
    environment: {
      minecraftVersion: string;
      loader: string;
      loaderVersion?: string;
      javaVersion: string;
      side: string;
    };
  };
  snapshot: {
    packSnapshotId: string;
    environment: {
      minecraftVersion: string;
      loader: string;
      loaderVersion?: string;
      javaVersion: string;
      side: string;
    };
    mods: Array<{
      name: string;
      version?: string;
      source?: string;
      sourceProjectId?: string;
      sourceVersionId?: string;
    }>;
  };
}

function requiredEnv(key: string) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required for the Forge ground-truth runner.`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string) {
  return process.env[key]?.trim() || fallback;
}

function parseNumberEnv(key: string, fallback: number) {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLoaderVersionMap(raw?: string) {
  const entries = new Map<string, string>();
  for (const token of (raw ?? "").split(/[;,]/)) {
    const [minecraftVersion, loaderVersion] = token.split(/[=:]/).map((part) => part.trim());
    if (minecraftVersion && loaderVersion) {
      entries.set(minecraftVersion, loaderVersion);
    }
  }
  return entries;
}

function defaultLoaderVersion(loader: string, minecraftVersion: string) {
  if (loader === "forge") {
    return (
      parseLoaderVersionMap(process.env.GROUND_TRUTH_FORGE_VERSION_BY_MINECRAFT).get(
        minecraftVersion
      ) ||
      (minecraftVersion === "1.20.1"
        ? process.env.GROUND_TRUTH_FORGE_VERSION?.trim() ||
          DEFAULT_FORGE_VERSION_BY_MINECRAFT[minecraftVersion]
        : undefined)
    );
  }
  return process.env.GROUND_TRUTH_LOADER_VERSION?.trim() || undefined;
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function defaultLaunchCommand() {
  return process.platform === "win32" ? "cmd /c run.bat nogui" : "sh ./run.sh nogui";
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

async function copyTemplate(source: string, destination: string) {
  if (existsSync(destination)) {
    await rm(destination, { recursive: true, force: true });
  }
  await cp(source, destination, { recursive: true, force: true });
}

async function patchForgeRunScript(instanceDir: string) {
  const runBatPath = join(instanceDir, "run.bat");
  if (await fileExists(runBatPath)) {
    const original = await readFile(runBatPath, "utf8");
    const patched = original.replace(/^\s*pause\s*$/gim, "REM pause removed for automated runner");
    if (patched !== original) {
      await writeFile(runBatPath, patched, "utf8");
    }
  }

  const runShPath = join(instanceDir, "run.sh");
  if (await fileExists(runShPath)) {
    await chmod(runShPath, 0o755);
  }
}

async function writeServerProperties(instanceDir: string) {
  const serverPropertiesPath = join(instanceDir, "server.properties");
  const serverProperties = [
    "motd=ModCompat Ground Truth",
    "enable-query=false",
    "allow-flight=true",
    "online-mode=false",
    "spawn-monsters=false",
    "difficulty=easy",
    "gamemode=survival",
    "level-type=minecraft\\:normal"
  ].join("\n");

  await writeFile(serverPropertiesPath, `${serverProperties}\n`, "utf8");
}

async function downloadToFile(url: string, destination: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  }

  await ensureDir(dirname(destination));
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function curseForgeApiKey() {
  return process.env.CURSEFORGE_API_KEY?.trim();
}

async function curseForgeRequest<T>(endpoint: string) {
  const apiKey = curseForgeApiKey();
  if (!apiKey) {
    return undefined;
  }

  const response = await fetch(`${CURSEFORGE_API_BASE}${endpoint}`, {
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`CurseForge API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function modrinthRequest<T>(endpoint: string) {
  const response = await fetch(`${MODRINTH_API_BASE}${endpoint}`, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Modrinth API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function normalizeLookupValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildSearchTerms(modName: string) {
  const base = modName.trim();
  const terms = new Set<string>([
    base,
    base.replace(/-/g, " "),
    base.replace(/[_-]/g, " ")
  ]);

  if (normalizeLookupValue(base) === "curios") {
    terms.add("Curios API");
    terms.add("Curios API Forge");
  }

  return [...terms].filter(Boolean);
}

function scoreCandidate(candidate: CurseForgeMod, modName: string) {
  const target = normalizeLookupValue(modName);
  const slug = normalizeLookupValue(candidate.slug);
  const name = normalizeLookupValue(candidate.name);

  if (slug === target) return 100;
  if (name === target) return 95;
  if (slug.includes(target)) return 80;
  if (name.includes(target)) return 70;
  return 10;
}

async function getCurseForgeModById(modId: number) {
  const response = await curseForgeRequest<{ data: CurseForgeMod }>(`/mods/${modId}`);
  return response?.data;
}

async function getCurseForgeFiles(modId: number, minecraftVersion: string) {
  const params = new URLSearchParams({
    gameVersion: minecraftVersion,
    pageSize: "50"
  });
  const response = await curseForgeRequest<{ data: CurseForgeFile[] }>(
    `/mods/${modId}/files?${params}`
  );
  return response?.data ?? [];
}

function selectBestFile(files: CurseForgeFile[], minecraftVersion: string, loader: string) {
  const matchingFiles = files.filter((file) => {
    const supportsMinecraft = file.gameVersions.includes(minecraftVersion);
    const supportsLoader =
      !file.modLoaders?.length ||
      file.modLoaders.some((candidate) => candidate.toLowerCase() === loader.toLowerCase());
    return supportsMinecraft && supportsLoader && Boolean(file.downloadUrl);
  });

  if (matchingFiles.length > 0) {
    return matchingFiles[0];
  }

  return files.find((file) => Boolean(file.downloadUrl));
}

async function findCurseForgeMod(modName: string, minecraftVersion: string, loader: string) {
  if (!curseForgeApiKey()) {
    return undefined;
  }

  const knownId = KNOWN_CURSEFORGE_PROJECT_IDS[modName.toLowerCase()];
  if (knownId) {
    return getCurseForgeModById(knownId);
  }

  const modLoaderType =
    loader === "forge"
      ? "1"
      : loader === "fabric"
        ? "4"
        : loader === "quilt"
          ? "5"
          : loader === "neoforge"
            ? "6"
            : undefined;
  let bestCandidate: CurseForgeMod | undefined;
  let bestScore = -1;

  for (const term of buildSearchTerms(modName)) {
    const params = new URLSearchParams({
      gameId: "432",
      searchFilter: term,
      pageSize: "20",
      gameVersion: minecraftVersion
    });
    if (modLoaderType) {
      params.set("modLoaderType", modLoaderType);
    }

    const response = await curseForgeRequest<{ data: CurseForgeMod[] }>(`/mods/search?${params}`);
    for (const candidate of response?.data ?? []) {
      const score = scoreCandidate(candidate, modName);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }
    if (bestScore >= 95) {
      break;
    }
  }

  if (!bestCandidate) {
    return undefined;
  }

  return bestCandidate;
}

function selectBestModrinthFile(version: ModrinthVersion) {
  return version.files.find((file) => file.primary && file.url) ?? version.files.find((file) => file.url);
}

async function getModrinthProjectById(projectId: string) {
  try {
    return await modrinthRequest<ModrinthProject>(`/project/${projectId}`);
  } catch {
    return undefined;
  }
}

async function findModrinthProject(modName: string) {
  try {
    const params = new URLSearchParams({
      query: modName,
      facets: JSON.stringify([["project_type:mod"], ["categories:forge"]]),
      limit: "10"
    });
    const response = await modrinthRequest<ModrinthSearchResponse>(`/search?${params}`);
    const target = normalizeLookupValue(modName);
    return response.hits.find((hit) =>
      normalizeLookupValue(hit.slug) === target ||
      normalizeLookupValue(hit.title) === target
    ) ?? response.hits[0];
  } catch {
    return undefined;
  }
}

async function findModrinthDownloadUrl(
  mod: CandidatePayload["snapshot"]["mods"][number],
  minecraftVersion: string,
  loader: string
) {
  const projectId =
    mod.source === "modrinth" && mod.sourceProjectId
      ? mod.sourceProjectId
      : (await findModrinthProject(mod.name))?.project_id;
  if (!projectId) {
    return undefined;
  }

  const project = await getModrinthProjectById(projectId);
  try {
    if (mod.source === "modrinth" && mod.sourceVersionId) {
      const exactVersion = await modrinthRequest<ModrinthVersion>(
        `/version/${mod.sourceVersionId}`
      );
      const exactFile = selectBestModrinthFile(exactVersion);
      if (
        exactVersion.loaders.some((candidate) => candidate.toLowerCase() === loader.toLowerCase()) &&
        exactVersion.game_versions.includes(minecraftVersion) &&
        exactFile?.url
      ) {
        return {
          source: "modrinth",
          sourceProjectId: projectId,
          version: exactVersion.name || exactVersion.version_number || "unknown",
          displayName: project?.title ?? mod.name,
          downloadUrl: exactFile.url
        };
      }
    }

    const params = new URLSearchParams({
      loaders: JSON.stringify([loader]),
      game_versions: JSON.stringify([minecraftVersion])
    });
    const versions = await modrinthRequest<ModrinthVersion[]>(
      `/project/${projectId}/version?${params}`
    );
    const selectedVersion = versions.find((version) =>
      version.loaders.some((candidate) => candidate.toLowerCase() === loader.toLowerCase()) &&
      version.game_versions.includes(minecraftVersion) &&
      selectBestModrinthFile(version)
    );
    const selectedFile = selectedVersion ? selectBestModrinthFile(selectedVersion) : undefined;
    if (!selectedVersion || !selectedFile?.url) {
      return undefined;
    }

    return {
      source: "modrinth",
      sourceProjectId: projectId,
      version: selectedVersion.name || selectedVersion.version_number || "unknown",
      displayName: project?.title ?? mod.name,
      downloadUrl: selectedFile.url
    };
  } catch {
    return undefined;
  }
}

async function findCurseForgeDownloadUrl(modName: string, minecraftVersion: string, loader: string) {
  const mod = await findCurseForgeMod(modName, minecraftVersion, loader);
  if (!mod) {
    return undefined;
  }

  const files = await getCurseForgeFiles(mod.id, minecraftVersion);
  const selectedFile = selectBestFile(files, minecraftVersion, loader);

  if (!selectedFile?.downloadUrl) {
    return undefined;
  }

  return {
    source: "curseforge",
    sourceProjectId: String(mod.id),
    version: selectedFile.displayName || selectedFile.fileName || "unknown",
    displayName: mod.name || modName,
    downloadUrl: selectedFile.downloadUrl
  };
}

export async function findDownloadUrl(
  mod: CandidatePayload["snapshot"]["mods"][number],
  minecraftVersion: string,
  loader: string
) {
  const modrinth = await findModrinthDownloadUrl(mod, minecraftVersion, loader);
  if (modrinth) return modrinth;
  return findCurseForgeDownloadUrl(mod.name, minecraftVersion, loader);
}

export async function resolveAndDownloadMods(
  payload: CandidatePayload,
  modsDir: string,
  cacheDir: string
) {
  const downloaded: Array<{ name: string; file: string; source: string; version: string }> = [];
  const unresolved: string[] = [];

  for (const mod of payload.snapshot.mods) {
    const resolved = await findDownloadUrl(
      mod,
      payload.snapshot.environment.minecraftVersion,
      "forge"
    );

    if (!resolved?.downloadUrl) {
      unresolved.push(mod.name);
      continue;
    }

    const hashed = createHash("sha1").update(resolved.downloadUrl).digest("hex").slice(0, 12);
    const extension = extname(new URL(resolved.downloadUrl).pathname) || ".jar";
    const cachedFile = join(
      cacheDir,
      `${sanitizeFilePart(mod.name)}-${sanitizeFilePart(resolved.version || "unknown")}-${hashed}${extension}`
    );
    if (!(await fileExists(cachedFile))) {
      await downloadToFile(resolved.downloadUrl, cachedFile);
    }

    const targetFile = join(modsDir, basename(cachedFile));
    await cp(cachedFile, targetFile, { force: true });
    downloaded.push({
      name: mod.name,
      file: targetFile,
      source: resolved.source,
      version: resolved.version
    });
  }

  return { downloaded, unresolved };
}

async function readLatestLog(latestLogPath: string) {
  if (!(await fileExists(latestLogPath))) {
    return "";
  }
  return readFile(latestLogPath, "utf8");
}

async function main() {
  const candidateFile = requiredEnv("GROUND_TRUTH_CANDIDATE_FILE");
  const resultFile = requiredEnv("GROUND_TRUTH_RESULT_FILE");
  const workdir = requiredEnv("GROUND_TRUTH_WORKDIR");
  const templateDir = requiredEnv("GROUND_TRUTH_FORGE_TEMPLATE_DIR");
  const timeoutMs = parseNumberEnv("GROUND_TRUTH_TIMEOUT_MS", 15 * 60 * 1000);
  const readyGraceMs = parseNumberEnv("GROUND_TRUTH_FORGE_READY_GRACE_MS", 8000);
  const launchCommand = optionalEnv("GROUND_TRUTH_FORGE_LAUNCH_COMMAND", defaultLaunchCommand());
  const cacheDir = resolve(optionalEnv("GROUND_TRUTH_MOD_CACHE_DIR", ".ground-truth-cache/mods"));

  const payload = JSON.parse(await readFile(candidateFile, "utf8")) as CandidatePayload;

  if (payload.snapshot.environment.loader !== "forge") {
    throw new Error(
      `Forge runner only supports forge snapshots right now; got loader=${payload.snapshot.environment.loader}.`
    );
  }
  const observedLoaderVersion =
    payload.snapshot.environment.loaderVersion ??
    defaultLoaderVersion("forge", payload.snapshot.environment.minecraftVersion);
  if (!observedLoaderVersion) {
    throw new Error(
      `No Forge loader version configured for Minecraft ${payload.snapshot.environment.minecraftVersion}. ` +
        "Set snapshot.environment.loaderVersion or GROUND_TRUTH_FORGE_VERSION_BY_MINECRAFT."
    );
  }
  payload.snapshot.environment.loaderVersion = observedLoaderVersion;
  payload.candidate.environment.loaderVersion = observedLoaderVersion;

  const instanceDir = join(workdir, "forge-instance");
  const modsDir = join(instanceDir, "mods");
  const logsDir = join(instanceDir, "logs");
  const latestLogPath = join(logsDir, "latest.log");

  await copyTemplate(templateDir, instanceDir);
  await patchForgeRunScript(instanceDir);
  await ensureDir(modsDir);
  await ensureDir(cacheDir);
  await writeFile(join(instanceDir, "eula.txt"), "eula=true\n", "utf8");
  await writeServerProperties(instanceDir);

  const resolution = await resolveAndDownloadMods(payload, modsDir, cacheDir);
  if (resolution.unresolved.length > 0) {
    await writeFile(
      resultFile,
      JSON.stringify(
        {
          reachedMainMenu: false,
          reachedWorld: false,
          verdict: "inconclusive",
          summary: `Failed to resolve download URLs for: ${resolution.unresolved.join(", ")}`,
          observations: [
            {
              kind: "process",
              status: "failed",
              summary: `Unresolved mods: ${resolution.unresolved.join(", ")}`
            }
          ],
          unresolvedMods: resolution.unresolved
        },
        null,
        2
      ),
      "utf8"
    );
    return;
  }

  const startedAt = Date.now();
  let stdoutText = "";
  let stderrText = "";
  let reachedReady = false;
  let crashed = false;
  let crashSummary = "";
  let timedOut = false;

  const child = spawn(launchCommand, {
    cwd: instanceDir,
    shell: true,
    env: {
      ...process.env
    }
  });

  const readyRegex = /Done \([^)]+\)! For help, type "help"/i;
  const crashRegexes = [
    /Encountered an unexpected exception/i,
    /This crash report has been saved to/i,
    /Preparing crash report with UUID/i,
    /Failed to start the minecraft server/i,
    /Mod Loading has failed/i
  ];

  const recordLine = (line: string, stream: "stdout" | "stderr") => {
    if (stream === "stdout") {
      stdoutText += `${line}\n`;
    } else {
      stderrText += `${line}\n`;
    }

    if (!reachedReady && readyRegex.test(line)) {
      reachedReady = true;
    }
    if (!crashed && crashRegexes.some((regex) => regex.test(line))) {
      crashed = true;
      crashSummary = line.trim();
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) {
        recordLine(line, "stdout");
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) {
        recordLine(line, "stderr");
      }
    }
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  let exitCode: number | undefined;
  const exitPromise = new Promise<number | undefined>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", (code) => resolveExit(code ?? undefined));
  });

  while (!reachedReady && !crashed && !timedOut) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      timedOut = true;
      child.kill();
      break;
    }

    const latestLog = await readLatestLog(latestLogPath);
    if (!reachedReady && readyRegex.test(latestLog)) {
      reachedReady = true;
      break;
    }
    if (!crashed) {
      const match = crashRegexes.find((regex) => regex.test(latestLog));
      if (match) {
        crashed = true;
        crashSummary = "Crash signature detected in latest.log";
        break;
      }
    }
    await delay(1000);
  }

  if (reachedReady && child.stdin.writable) {
    await delay(readyGraceMs);
    child.stdin.write("stop\n");
  }

  exitCode = await exitPromise.finally(() => clearTimeout(timeout));
  const durationMs = Date.now() - startedAt;
  const latestLog = await readLatestLog(latestLogPath);

  const verdict =
    timedOut
      ? "timed_out"
      : reachedReady
        ? "passed_startup_and_world"
        : "failed_startup";

  const summary =
    timedOut
      ? `Forge server run timed out after ${timeoutMs} ms.`
      : reachedReady
        ? "Forge server started successfully and loaded the default world."
        : crashSummary || `Forge server exited before reporting ready state (exit code ${exitCode ?? -1}).`;

  const observations = [
    {
      observationId: "obs_process_start",
      kind: "process",
      status: "info",
      summary: `Downloaded ${resolution.downloaded.length} mod files into the Forge instance.`
    },
    {
      observationId: reachedReady ? "obs_world_ready" : "obs_world_failed",
      kind: reachedReady ? "world_load" : "startup",
      status: reachedReady ? "passed" : "failed",
      summary
    }
  ];

  await writeFile(
    resultFile,
    JSON.stringify(
      {
        reachedMainMenu: reachedReady,
        reachedWorld: reachedReady,
        verdict,
        summary,
        observations,
        exitCode,
        durationMs,
        environment: payload.snapshot.environment,
        loaderVersion: observedLoaderVersion,
        downloadedMods: resolution.downloaded.map((mod) => ({
          name: mod.name,
          source: mod.source,
          version: mod.version,
          file: basename(mod.file)
        })),
        latestLogTail: latestLog.split(/\r?\n/).slice(-40),
        stdoutText,
        stderrText
      },
      null,
      2
    ),
    "utf8"
  );
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
