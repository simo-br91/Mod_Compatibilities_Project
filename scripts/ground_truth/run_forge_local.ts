import { createPhase1Platform } from "../../packages/platform-core/src/index.js";
import { loadLocalEnvFile } from "../load_local_env.ts";
import type { PackModReference } from "@modcompat/domain-models";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

type SelectionMode = "auto" | "random" | "knowledge";
type PackSide = "client" | "server" | "both";

interface SelectionResult {
  source: "explicit" | "random_pool" | "knowledge_snapshot";
  mods: PackModReference[];
  details: Record<string, unknown>;
}

loadLocalEnvFile();

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
      continue;
    }
    args.set(key, next);
    index += 1;
  }
  return args;
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

function defaultForgeVersion(minecraftVersion: string) {
  return (
    parseLoaderVersionMap(process.env.GROUND_TRUTH_FORGE_VERSION_BY_MINECRAFT).get(
      minecraftVersion
    ) ||
    (minecraftVersion === "1.20.1"
      ? process.env.GROUND_TRUTH_FORGE_VERSION?.trim() || "47.4.20"
      : undefined)
  );
}

function printHelp() {
  console.log(`Usage:
  pnpm truth:run:forge-local -- [options]

Options:
  --mods "modA,modB"            Run these exact mods together.
  --selection auto|random|knowledge
                                Candidate source. Default: auto
  --random-count 2              How many mods to pick from the random pool.
  --allow-ephemeral             Permit a local-only run without POSTGRES_URL.
  --force                       Re-run even if this exact pack was tested before.
  --mc 1.20.1                   Minecraft version for the imported snapshot.
  --loader-version 47.4.20      Forge version for the imported snapshot.
  --java 17                     Java version for the imported snapshot.
  --side server                 Snapshot side. Default: server
  --created-by USER_ID          Existing platform user id. Default: usr_demo
  --knowledge-version VERSION   Force a specific inferred knowledge snapshot version.
  --help                        Show this help.

Notes:
  - This command does not start the platform HTTP services.
  - It runs locally, writes imports and ground-truth results directly to Postgres,
    and prints the created internal snapshot id in its JSON output.
  - Knowledge and catalog selections preserve Modrinth/CurseForge project ids
    so the runner can download from the original registry when possible.
  - If --mods is omitted, auto mode tries inferred knowledge first, then falls
    back to a catalog-derived Forge pool, then the small smoke-test pool.`);
}

function randomPick<T>(items: T[], count: number) {
  const pool = [...items];
  const picked: T[] = [];
  while (pool.length > 0 && picked.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]!);
  }
  return picked;
}

function configuredForgeModPool(): PackModReference[] {
  const raw =
    process.env.GROUND_TRUTH_RANDOM_FORGE_MOD_POOL?.trim() ||
    "balm,bookshelf,collective,curios,architectury-api,placebo,ferritecore,modernfix";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function parseModsArg(value?: string) {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function modRefName(mod: PackModReference) {
  return mod.name;
}

function isSelectionMode(value: string): value is SelectionMode {
  return value === "auto" || value === "random" || value === "knowledge";
}

function isPackSide(value: string): value is PackSide {
  return value === "client" || value === "server" || value === "both";
}

function sideMatches(recordSide: string | undefined, requestedSide: PackSide) {
  if (!recordSide || recordSide === "both") {
    return true;
  }
  if (requestedSide === "both") {
    return recordSide === "both";
  }
  return recordSide === requestedSide;
}

function verdictPriority(verdict?: string) {
  switch (verdict) {
    case "known_incompatible":
      return 5;
    case "likely_incompatible":
      return 4;
    case "mixed_or_conditional":
      return 3;
    case "no_known_issue_found":
      return 2;
    case "insufficient_evidence":
    default:
      return 1;
  }
}

async function hydrateRequestedKnowledge(
  platform: ReturnType<typeof createPhase1Platform>,
  version?: string
) {
  if (!platform.persistence.isEnabled()) {
    return undefined;
  }

  try {
    if (version?.trim()) {
      return await platform.persistence.hydrateKnowledgeSnapshotByVersion(version.trim());
    }

    return await platform.persistence.hydrateLatestPromotedKnowledgeSnapshot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('relation "knowledge_snapshots" does not exist') ||
      message.includes('relation "knowledge_snapshot_components" does not exist')
    ) {
      return undefined;
    }
    throw error;
  }
}

export function selectModsFromKnowledge(
  platform: ReturnType<typeof createPhase1Platform>,
  input: {
    minecraftVersion: string;
    loaderVersion?: string;
    javaVersion: string;
    side: PackSide;
  }
): SelectionResult | undefined {
  const snapshot = platform.snapshotAnalysis.getActiveSnapshot();
  if (!snapshot) {
    return undefined;
  }

  const pairwiseIds = platform.repository.pairwiseCompatibilityBySnapshot.get(snapshot.snapshotId) ?? [];
  const candidates = pairwiseIds
    .map((id) => platform.repository.pairwiseCompatibilityRecords.get(id))
    .filter((record): record is NonNullable<typeof record> => Boolean(record))
    .filter((record) => {
      const environment = record.environment;
      if (!environment) {
        return false;
      }
      return (
        environment.loader === "forge" &&
        environment.minecraftVersion === input.minecraftVersion &&
        (!input.loaderVersion ||
          !environment.loaderVersion ||
          environment.loaderVersion === input.loaderVersion) &&
        environment.javaVersion === input.javaVersion &&
        sideMatches(environment.side, input.side)
      );
    })
    .map((record) => {
      const leftProject = platform.repository.canonicalProjects.get(record.leftProjectId);
      const rightProject = platform.repository.canonicalProjects.get(record.rightProjectId);
      if (!leftProject || !rightProject) {
        return undefined;
      }
      const leftMapping = sourceMappingForProject(platform, leftProject.projectId);
      const rightMapping = sourceMappingForProject(platform, rightProject.projectId);

      return {
        record,
        mods: [
          {
            name: leftProject.slug,
            source: leftMapping?.sourceName,
            sourceProjectId: leftMapping?.sourceProjectId
          },
          {
            name: rightProject.slug,
            source: rightMapping?.sourceName,
            sourceProjectId: rightMapping?.sourceProjectId
          }
        ],
        labels: [leftProject.displayName, rightProject.displayName]
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => {
      const verdictDelta =
        verdictPriority(right.record.verdict) - verdictPriority(left.record.verdict);
      if (verdictDelta !== 0) {
        return verdictDelta;
      }
      return right.record.confidence.score - left.record.confidence.score;
    });

  const best = candidates[0];
  if (!best) {
    return undefined;
  }

  return {
    source: "knowledge_snapshot",
    mods: best.mods,
    details: {
      knowledgeSnapshotId: snapshot.snapshotId,
      knowledgeSnapshotVersion: snapshot.version,
      pairwiseCompatibilityId: best.record.pairwiseCompatibilityId,
      pairwiseVerdict: best.record.verdict,
      pairwiseConfidence: best.record.confidence.score,
      selectedProjects: best.labels
    }
  };
}

function sourceMappingForProject(
  platform: ReturnType<typeof createPhase1Platform>,
  projectId: string
) {
  const mappings = [...platform.repository.sourceMappings.values()].filter(
    (mapping) => mapping.canonicalProjectId === projectId
  );
  return (
    mappings.find((mapping) => mapping.sourceName === "modrinth") ??
    mappings.find((mapping) => mapping.sourceName === "curseforge") ??
    mappings[0]
  );
}

function catalogForgeModPool(
  platform: ReturnType<typeof createPhase1Platform>,
  input: { minecraftVersion: string }
): PackModReference[] {
  const projectIds = new Set(
    [...platform.repository.canonicalVersions.values()]
      .filter((version) =>
        version.loaders.some((loader) => loader.toLowerCase() === "forge") &&
        version.minecraftVersions.includes(input.minecraftVersion)
      )
      .map((version) => version.projectId)
  );

  return [...projectIds]
    .map((projectId) => {
      const project = platform.repository.canonicalProjects.get(projectId);
      if (!project) return undefined;
      const mapping = sourceMappingForProject(platform, projectId);
      return {
        name: project.slug,
        source: mapping?.sourceName,
        sourceProjectId: mapping?.sourceProjectId
      };
    })
    .filter((mod): mod is PackModReference => Boolean(mod));
}

export function selectRandomMods(
  platform: ReturnType<typeof createPhase1Platform>,
  randomCount: number,
  input: { minecraftVersion: string }
): SelectionResult {
  const catalogPool = catalogForgeModPool(platform, input);
  const pool = catalogPool.length >= randomCount ? catalogPool : configuredForgeModPool();
  const mods = randomPick(pool, randomCount);
  if (mods.length === 0) {
    throw new Error(
      "No Forge mods were selected. Pass --mods \"modA,modB\" or configure GROUND_TRUTH_RANDOM_FORGE_MOD_POOL."
    );
  }

  return {
    source: "random_pool",
    mods,
    details: {
      pool: pool.map(modRefName),
      poolSource: catalogPool.length >= randomCount ? "catalog" : "configured_env",
      randomCount
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.get("help") === true) {
    printHelp();
    return;
  }

  const mcVersion = String(args.get("mc") ?? "1.20.1");
  const javaVersion = String(args.get("java") ?? "17");
  const loaderVersion =
    typeof args.get("loader-version") === "string"
      ? String(args.get("loader-version"))
      : defaultForgeVersion(mcVersion);
  if (!loaderVersion) {
    throw new Error(
      `No Forge loader version configured for Minecraft ${mcVersion}. ` +
        "Pass --loader-version or set GROUND_TRUTH_FORGE_VERSION_BY_MINECRAFT."
    );
  }
  const sideRaw = String(args.get("side") ?? "server");
  if (!isPackSide(sideRaw)) {
    throw new Error(`Unsupported --side value: ${sideRaw}`);
  }
  const side = sideRaw;

  const selectionRaw = String(args.get("selection") ?? "auto");
  if (!isSelectionMode(selectionRaw)) {
    throw new Error(`Unsupported --selection value: ${selectionRaw}`);
  }
  const selection = selectionRaw;

  const randomCount = Number(args.get("random-count") ?? 2);
  const createdBy =
    typeof args.get("created-by") === "string"
      ? String(args.get("created-by"))
      : "usr_demo";
  const projectId =
    typeof args.get("project-id") === "string" ? String(args.get("project-id")) : "prj_demo";
  const knowledgeVersion =
    typeof args.get("knowledge-version") === "string"
      ? String(args.get("knowledge-version"))
      : undefined;
  const allowEphemeral = args.get("allow-ephemeral") === true;
  const force = args.get("force") === true;
  const explicitMods = parseModsArg(
    typeof args.get("mods") === "string" ? String(args.get("mods")) : undefined
  );

  const platform = createPhase1Platform();

  if (!platform.persistence.isEnabled() && !allowEphemeral) {
    throw new Error(
      "POSTGRES_URL is required for the default Forge ground-truth workflow. " +
      "Configure a shared/remote Postgres connection in .env or pass --allow-ephemeral " +
      "if you intentionally want a non-persistent local-only run."
    );
  }

  if (platform.persistence.isEnabled()) {
    await platform.persistence.ensureSchema();
    await platform.groundTruth.hydrateState();
    await hydrateRequestedKnowledge(platform, knowledgeVersion);
  }

  let selected: SelectionResult;
  if (explicitMods.length > 0) {
    selected = {
      source: "explicit",
      mods: explicitMods.map((name) => ({ name })),
      details: {
        providedByUser: true
      }
    };
  } else if (selection === "random") {
    selected = selectRandomMods(platform, randomCount, { minecraftVersion: mcVersion });
  } else {
    const fromKnowledge = selectModsFromKnowledge(platform, {
      minecraftVersion: mcVersion,
      loaderVersion,
      javaVersion,
      side
    });

    if (fromKnowledge) {
      selected = fromKnowledge;
    } else if (selection === "knowledge") {
      throw new Error(
        `No Forge knowledge candidate matched minecraft=${mcVersion}, java=${javaVersion}, side=${side}.`
      );
    } else {
      selected = selectRandomMods(platform, randomCount, { minecraftVersion: mcVersion });
    }
  }

  const importResult = platform.imports.importModList({
    projectId,
    createdBy,
    environment: {
      minecraftVersion: mcVersion,
      loader: "forge",
      loaderVersion,
      javaVersion,
      side
    },
    mods: selected.mods
  });

  if (platform.persistence.isEnabled()) {
    await platform.persistence.persistImportsForProject(importResult.snapshot.projectId);
  }

  const enqueue = platform.groundTruth.enqueuePackSnapshot({
    packSnapshotId: importResult.snapshot.packSnapshotId,
    discoveredFrom: selected.source,
    priority: selected.source === "knowledge_snapshot" ? 200 : 100,
    force
  });

  if (enqueue.candidate && platform.persistence.isEnabled()) {
    await platform.persistence.persistGroundTruthCandidate(enqueue.candidate);
  }

  let runResult: {
    attempted: number;
    completed: number;
    failed: number;
    timedOut: number;
    runs: Array<Awaited<ReturnType<typeof platform.groundTruth.runCandidate>>>;
  };
  if (enqueue.candidate) {
    const run = await platform.groundTruth.runCandidate(enqueue.candidate.candidateId);
    runResult = {
      attempted: 1,
      completed: run.status === "completed" ? 1 : 0,
      failed: run.status === "failed" ? 1 : 0,
      timedOut: run.status === "timed_out" ? 1 : 0,
      runs: [run]
    };
  } else {
    runResult = {
      attempted: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      runs: []
    };
  }
  const empiricalSnapshot = platform.groundTruth.buildKnowledgeSnapshot({
    createdBy,
    promote: true
  });

  if (platform.persistence.isEnabled()) {
    await platform.persistence.persistGroundTruthKnowledgeSnapshot(empiricalSnapshot);
    for (const record of platform.repository.groundTruthExactPackRecords.values()) {
      await platform.persistence.persistGroundTruthExactPackRecord(record);
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: "forge_local",
        database: {
          engine: platform.persistence.isEnabled() ? "postgres" : "in_memory",
          url: process.env.POSTGRES_URL,
          persistent: platform.persistence.isEnabled()
        },
        selection: {
          requested: selection,
          resolvedFrom: selected.source,
          details: selected.details
        },
        input: {
          mods: selected.mods.map((mod) => ({
            name: mod.name,
            source: mod.source,
            sourceProjectId: mod.sourceProjectId
          })),
          environment: {
            minecraftVersion: mcVersion,
            loader: "forge",
            loaderVersion,
            javaVersion,
            side
          }
        },
        snapshot: {
          explanation:
            "A snapshot is the internal normalized record for the exact mod list + environment that was just imported.",
          packSnapshotId: importResult.snapshot.packSnapshotId,
          normalizedHash: importResult.snapshot.normalizedHash
        },
        queue: {
          enqueued: Boolean(enqueue.candidate),
          skipReason: enqueue.skipped,
          force
        },
        execution: {
          attempted: runResult.attempted,
          completed: runResult.completed,
          failed: runResult.failed,
          timedOut: runResult.timedOut,
          runIds: runResult.runs.map((run) => run.groundTruthRunId)
        },
        empiricalSnapshot: {
          groundTruthSnapshotId: empiricalSnapshot.groundTruthSnapshotId,
          version: empiricalSnapshot.version,
          recordCount: empiricalSnapshot.recordCount
        }
      },
      null,
      2
    )
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
