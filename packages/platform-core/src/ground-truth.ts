import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createPlatformId } from "@modcompat/id-generation";
import type {
  AnalysisEnvironment,
  AnalysisVerdict,
  ConfidenceSummary,
  GroundTruthCandidate,
  GroundTruthExactPackRecord,
  GroundTruthKnowledgeSnapshot,
  GroundTruthObservation,
  GroundTruthRun,
  GroundTruthVerdict,
  PackSnapshot,
  PairwiseCompatibilityRecord,
  ResolvedPackMod
} from "@modcompat/domain-models";

import { now, stableHash } from "./helpers.js";
import { InMemoryPlatformRepository } from "./repository.js";
import type { PostgresPlatformPersistence } from "./persistence.js";
import type { CanonicalVersionRecord } from "./types.js";

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function fingerprintKey(
  packFingerprint: string,
  executionProfileKey: string,
  environment: AnalysisEnvironment
) {
  return stableHash({
    packFingerprint,
    executionProfileKey,
    environment
  });
}

function confidenceBand(score: number): ConfidenceSummary["band"] {
  if (score >= 0.95) return "very_high";
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "medium";
  if (score >= 0.35) return "low";
  return "very_low";
}

function baseVerdictScore(verdict: GroundTruthVerdict) {
  switch (verdict) {
    case "passed_startup_and_world":
      return 0.93;
    case "failed_startup":
      return 0.97;
    case "failed_world_load":
      return 0.95;
    case "timed_out":
      return 0.7;
    case "inconclusive":
    default:
      return 0.42;
  }
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
    const configured = parseLoaderVersionMap(process.env.GROUND_TRUTH_FORGE_VERSION_BY_MINECRAFT).get(
      minecraftVersion
    );
    if (configured) {
      return configured;
    }
    if (minecraftVersion === "1.20.1") {
      return process.env.GROUND_TRUTH_FORGE_VERSION?.trim() || "47.4.20";
    }
    return undefined;
  }
  return process.env.GROUND_TRUTH_LOADER_VERSION?.trim() || undefined;
}

function shouldSkipBecauseAlreadyVerified(verdict: GroundTruthVerdict) {
  return (
    verdict === "passed_startup_and_world" ||
    verdict === "failed_startup" ||
    verdict === "failed_world_load"
  );
}

export interface GroundTruthExecutorInput {
  candidate: GroundTruthCandidate;
  snapshot: PackSnapshot;
  workdir: string;
  candidateFile: string;
  resultFile: string;
  timeoutMs: number;
}

export interface GroundTruthExecutorOutput {
  status: GroundTruthRun["status"];
  verdict: GroundTruthVerdict;
  reachedMainMenu: boolean;
  reachedWorld: boolean;
  exitCode?: number;
  durationMs: number;
  summary: string;
  observations: GroundTruthObservation[];
  stdoutText?: string;
  stderrText?: string;
  artifactDirectory?: string;
  rawResult?: Record<string, unknown>;
}

export interface GroundTruthExecutor {
  execute(input: GroundTruthExecutorInput): Promise<GroundTruthExecutorOutput>;
}

interface ParsedRunnerResult {
  reachedMainMenu: boolean;
  reachedWorld: boolean;
  verdict?: GroundTruthVerdict;
  summary?: string;
  observations?: GroundTruthObservation[];
  rawResult?: Record<string, unknown>;
}

function parseRunnerResult(value: Record<string, unknown> | undefined): ParsedRunnerResult | undefined {
  if (!value) {
    return undefined;
  }

  const observations = Array.isArray(value.observations)
    ? value.observations
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item): GroundTruthObservation => ({
          observationId: typeof item.observationId === "string"
            ? item.observationId
            : createPlatformId("gto"),
          kind:
            item.kind === "startup" ||
            item.kind === "world_load" ||
            item.kind === "crash_report" ||
            item.kind === "log_hint"
              ? item.kind
              : "process",
          status:
            item.status === "passed" || item.status === "failed"
              ? item.status
              : "info",
          summary: typeof item.summary === "string" ? item.summary : "Runner observation."
        }))
    : undefined;

  return {
    reachedMainMenu: value.reachedMainMenu === true,
    reachedWorld: value.reachedWorld === true,
    verdict:
      value.verdict === "passed_startup_and_world" ||
      value.verdict === "failed_startup" ||
      value.verdict === "failed_world_load" ||
      value.verdict === "timed_out" ||
      value.verdict === "inconclusive"
        ? value.verdict
        : undefined,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    observations,
    rawResult: value
  };
}

function defaultRunnerCommand() {
  const currentFile = fileURLToPath(import.meta.url);
  const runnerPath = resolve(
    dirname(currentFile),
    "../../../scripts/ground_truth/forge_runner.ts"
  );
  return `node --import tsx "${runnerPath}"`;
}

function defaultRunnerCwd() {
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), "../../../");
}

export class LocalGroundTruthCommandExecutor implements GroundTruthExecutor {
  constructor(
    private readonly options: {
      command?: string;
      timeoutMs?: number;
    } = {}
  ) {}

  async execute(input: GroundTruthExecutorInput): Promise<GroundTruthExecutorOutput> {
    const command =
      this.options.command?.trim() ||
      process.env.GROUND_TRUTH_RUNNER_COMMAND?.trim() ||
      defaultRunnerCommand();

    const startedAt = Date.now();
    let stdoutText = "";
    let stderrText = "";
    let exitCode: number | undefined;
    let timedOut = false;

    const child = spawn(command, {
      cwd: defaultRunnerCwd(),
      shell: true,
      env: {
        ...process.env,
        GROUND_TRUTH_WORKDIR: input.workdir,
        GROUND_TRUTH_CANDIDATE_FILE: input.candidateFile,
        GROUND_TRUTH_RESULT_FILE: input.resultFile,
        GROUND_TRUTH_SNAPSHOT_ID: input.snapshot.packSnapshotId
      }
    });

    child.stdout.on("data", (chunk) => {
      stdoutText += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderrText += chunk.toString();
    });

    const timeoutMs = this.options.timeoutMs ?? input.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    exitCode = await new Promise<number | undefined>((resolveExit, rejectExit) => {
      child.on("error", rejectExit);
      child.on("exit", (code) => resolveExit(code ?? undefined));
    }).finally(() => {
      clearTimeout(timer);
    });

    const durationMs = Date.now() - startedAt;
    const resultPayload =
      existsSync(input.resultFile)
        ? parseRunnerResult(JSON.parse(await readFile(input.resultFile, "utf8")) as Record<string, unknown>)
        : undefined;

    if (timedOut) {
      return {
        status: "timed_out",
        verdict: "timed_out",
        reachedMainMenu: resultPayload?.reachedMainMenu ?? false,
        reachedWorld: resultPayload?.reachedWorld ?? false,
        exitCode,
        durationMs,
        summary: resultPayload?.summary ?? `Ground-truth execution timed out after ${timeoutMs} ms.`,
        observations:
          resultPayload?.observations ??
          [
            {
              observationId: createPlatformId("gto"),
              kind: "process",
              status: "failed",
              summary: `Execution timed out after ${timeoutMs} ms.`
            }
          ],
        stdoutText,
        stderrText,
        artifactDirectory: input.workdir,
        rawResult: resultPayload?.rawResult
      };
    }

    if (resultPayload) {
      return {
        status:
          resultPayload.verdict === "timed_out"
            ? "timed_out"
            : resultPayload.verdict === "passed_startup_and_world"
              ? "completed"
              : "failed",
        verdict:
          resultPayload.verdict ??
          (resultPayload.reachedWorld
            ? "passed_startup_and_world"
            : resultPayload.reachedMainMenu
              ? "failed_world_load"
              : exitCode === 0
                ? "inconclusive"
                : "failed_startup"),
        reachedMainMenu: resultPayload.reachedMainMenu,
        reachedWorld: resultPayload.reachedWorld,
        exitCode,
        durationMs,
        summary:
          resultPayload.summary ??
          (resultPayload.reachedWorld
            ? "Runner reached world load successfully."
            : "Runner returned a result payload."),
        observations:
          resultPayload.observations ??
          [
            {
              observationId: createPlatformId("gto"),
              kind: resultPayload.reachedWorld ? "world_load" : "process",
              status: resultPayload.reachedWorld ? "passed" : "info",
              summary:
                resultPayload.summary ??
                "Runner completed without structured observations."
            }
          ],
        stdoutText,
        stderrText,
        artifactDirectory: input.workdir,
        rawResult: resultPayload.rawResult
      };
    }

    if (exitCode === 0) {
      return {
        status: "completed",
        verdict: "inconclusive",
        reachedMainMenu: false,
        reachedWorld: false,
        exitCode,
        durationMs,
        summary:
          "Execution command exited successfully but did not write ground-truth-result.json, so the run is treated as inconclusive.",
        observations: [
          {
            observationId: createPlatformId("gto"),
            kind: "process",
            status: "info",
            summary:
              "Runner exited with code 0 but did not emit structured results."
          }
        ],
        stdoutText,
        stderrText,
        artifactDirectory: input.workdir
      };
    }

    return {
      status: "failed",
      verdict: "failed_startup",
      reachedMainMenu: false,
      reachedWorld: false,
      exitCode,
      durationMs,
      summary: `Execution command failed before emitting a structured result (exit code ${exitCode ?? -1}).`,
      observations: [
        {
          observationId: createPlatformId("gto"),
          kind: "process",
          status: "failed",
          summary: `Runner exited with code ${exitCode ?? -1}.`
        }
      ],
      stdoutText,
      stderrText,
      artifactDirectory: input.workdir
    };
  }
}

export class GroundTruthService {
  constructor(
    private readonly repository: InMemoryPlatformRepository,
    private readonly persistence?: PostgresPlatformPersistence,
    private readonly executor: GroundTruthExecutor = new LocalGroundTruthCommandExecutor()
  ) {}

  getExecutionProfileKey() {
    return process.env.GROUND_TRUTH_EXECUTION_PROFILE?.trim() || "default-v1";
  }

  getTimeoutMs() {
    const raw = process.env.GROUND_TRUTH_TIMEOUT_MS?.trim();
    return raw ? Number(raw) : 15 * 60 * 1000;
  }

  recoverInterruptedCandidates() {
    let recovered = 0;
    for (const [candidateId, candidate] of this.repository.groundTruthCandidates.entries()) {
      if (candidate.status !== "running") {
        continue;
      }

      this.repository.groundTruthCandidates.set(candidateId, {
        ...candidate,
        status: "queued",
        updatedAt: now()
      });
      recovered += 1;
    }
    return recovered;
  }

  enqueuePackSnapshot(input: {
    packSnapshotId: string;
    discoveredFrom?: string;
    priority?: number;
    force?: boolean;
  }) {
    const snapshot = this.repository.snapshots.get(input.packSnapshotId);
    if (!snapshot) {
      throw new Error(`Pack snapshot not found: ${input.packSnapshotId}`);
    }

    const executionProfileKey = this.getExecutionProfileKey();
    const existingRecord = this.findSettledRecord(
      snapshot.normalizedHash,
      executionProfileKey,
      snapshot.environment
    );
    if (existingRecord && !input.force) {
      return { candidate: undefined, skipped: "already_verified" as const };
    }

    const dedupeKey = stableHash({
      candidateKind: "pack_snapshot",
      packFingerprint: snapshot.normalizedHash,
      environment: snapshot.environment,
      executionProfileKey
    });
    const existingCandidate = [...this.repository.groundTruthCandidates.values()].find(
      (candidate) =>
        candidate.dedupeKey === dedupeKey &&
        (candidate.status === "queued" || candidate.status === "running")
    );
    if (existingCandidate && !input.force) {
      return { candidate: existingCandidate, skipped: "existing_candidate" as const };
    }

    const createdAt = now();
    const candidate: GroundTruthCandidate = {
      candidateId: createPlatformId("gtc"),
      candidateKind: "pack_snapshot",
      packSnapshotId: snapshot.packSnapshotId,
      packFingerprint: snapshot.normalizedHash,
      environment: snapshot.environment,
      dedupeKey,
      executionProfileKey,
      discoveredFrom: input.discoveredFrom,
      status: "queued",
      priority: input.priority ?? 50,
      attempts: 0,
      tenantId: snapshot.organizationId,
      schemaVersion: 1,
      createdAt,
      updatedAt: createdAt
    };
    this.repository.groundTruthCandidates.set(candidate.candidateId, candidate);
    return { candidate, skipped: undefined };
  }

  enqueueDiscoveredPackSnapshots(limit = 100) {
    let enqueued = 0;
    let skipped = 0;
    for (const snapshot of [...this.repository.snapshots.values()].slice(0, limit)) {
      const result = this.enqueuePackSnapshot({
        packSnapshotId: snapshot.packSnapshotId,
        discoveredFrom: "snapshot_discovery"
      });
      if (result.candidate) {
        enqueued++;
      } else {
        skipped++;
      }
    }
    return { enqueued, skipped };
  }

  /**
   * Enqueue a list of mod pairs from the offline synthesis pipeline for ground-truth testing.
   * For each pair, looks up the latest stable versions, builds a minimal 2-mod PackSnapshot,
   * and enqueues it with the pair's priority score.
   *
   * This is the primary way the offline pipeline and the ground-truth pipeline communicate:
   * run the offline pipeline first, then pass its candidate list here.
   */
  enqueuePairCandidates(
    candidates: Array<{ pair: [string, string]; priority: number }>,
    discoveredFrom = "offline_candidate"
  ) {
    let enqueued = 0;
    let skipped = 0;
    let missingVersion = 0;

    for (const candidate of candidates) {
      const [projectIdA, projectIdB] = candidate.pair;
      const result = this.enqueueProjectPair(projectIdA, projectIdB, candidate.priority, discoveredFrom);
      if (result.missingVersion) {
        missingVersion++;
      } else {
        enqueued += result.enqueued;
        skipped += result.skipped;
      }
    }

    return { enqueued, skipped, missingVersion, total: candidates.length };
  }

  private enqueueProjectPair(
    projectIdA: string,
    projectIdB: string,
    priority: number,
    discoveredFrom: string
  ) {
    const projectA = this.repository.canonicalProjects.get(projectIdA);
    const projectB = this.repository.canonicalProjects.get(projectIdB);
    const versionsA = [...this.repository.canonicalVersions.values()].filter(
      (v) =>
        v.projectId === projectIdA &&
        v.loaders.some((loader) => loader.toLowerCase() === "forge") &&
        Boolean(v.primaryFileDownloadUrl)
    );
    const versionsB = [...this.repository.canonicalVersions.values()].filter(
      (v) =>
        v.projectId === projectIdB &&
        v.loaders.some((loader) => loader.toLowerCase() === "forge") &&
        Boolean(v.primaryFileDownloadUrl)
    );

    const selectedPairs = this.selectCompatibleVersionPairs(versionsA, versionsB);
    if (!projectA || !projectB || selectedPairs.length === 0) {
      return { enqueued: 0, skipped: 0, missingVersion: true };
    }
    const mappingA = this.sourceMappingForProject(projectIdA);
    const mappingB = this.sourceMappingForProject(projectIdB);

    let enqueued = 0;
    let skipped = 0;
    for (const { versionA, versionB, minecraftVersion } of selectedPairs) {
      const loaderVersion = defaultLoaderVersion("forge", minecraftVersion);
      const mods: ResolvedPackMod[] = [
        {
          name: projectA.slug,
          version: versionA.versionLabel,
          source: mappingA?.sourceName,
          sourceProjectId: mappingA?.sourceProjectId,
          sourceVersionId: this.externalVersionId(versionA.versionId, mappingA?.sourceName),
          canonicalProjectId: projectIdA,
          canonicalVersionId: versionA.versionId,
          resolutionMethod: "source_mapping",
          confidence: 1.0
        },
        {
          name: projectB.slug,
          version: versionB.versionLabel,
          source: mappingB?.sourceName,
          sourceProjectId: mappingB?.sourceProjectId,
          sourceVersionId: this.externalVersionId(versionB.versionId, mappingB?.sourceName),
          canonicalProjectId: projectIdB,
          canonicalVersionId: versionB.versionId,
          resolutionMethod: "source_mapping",
          confidence: 1.0
        }
      ];

      const packSnapshotId = createPlatformId("pks");
      const normalizedHash = stableHash({
        environment: {
          minecraftVersion,
          loader: "forge",
          loaderVersion,
          javaVersion: "17",
          side: "both"
        },
        mods: [
          { projectId: projectIdA, versionId: versionA.versionId },
          { projectId: projectIdB, versionId: versionB.versionId }
        ].sort((left, right) => left.versionId.localeCompare(right.versionId))
      });
      const environment: AnalysisEnvironment = {
        minecraftVersion,
        loader: "forge",
        loaderVersion,
        javaVersion: "17",
        side: "both"
      };

      const pairSnapshot: PackSnapshot = {
        packSnapshotId,
        projectId: "prj_demo",
        organizationId: "org_demo",
        tenantId: "org_demo",
        sourceType: "mod_list",
        normalizedHash,
        environment,
        mods,
        createdBy: "usr_demo",
        schemaVersion: 1,
        createdAt: now()
      };

      this.repository.snapshots.set(packSnapshotId, pairSnapshot);

      const result = this.enqueuePackSnapshot({
        packSnapshotId,
        discoveredFrom,
        priority: Math.round(priority * 100)
      });
      if (result.candidate) {
        enqueued++;
      } else {
        skipped++;
      }
    }

    return { enqueued, skipped, missingVersion: false };
  }

  private selectCompatibleVersionPairs(
    versionsA: CanonicalVersionRecord[],
    versionsB: CanonicalVersionRecord[]
  ) {
    const pairs: Array<{
      versionA: CanonicalVersionRecord;
      versionB: CanonicalVersionRecord;
      minecraftVersion: string;
    }> = [];
    for (const versionA of versionsA) {
      for (const versionB of versionsB) {
        const minecraftVersion = versionA.minecraftVersions.find((version) =>
          versionB.minecraftVersions.includes(version)
        );
        if (minecraftVersion && defaultLoaderVersion("forge", minecraftVersion)) {
          pairs.push({ versionA, versionB, minecraftVersion });
        }
      }
    }
    return pairs;
  }

  private sourceMappingForProject(projectId: string) {
    const mappings = [...this.repository.sourceMappings.values()].filter(
      (mapping) => mapping.canonicalProjectId === projectId
    );
    return (
      mappings.find((mapping) => mapping.sourceName === "modrinth") ??
      mappings.find((mapping) => mapping.sourceName === "curseforge") ??
      mappings[0]
    );
  }

  private externalVersionId(versionId: string, sourceName?: string) {
    if (sourceName === "modrinth" && versionId.startsWith("modrinth_")) {
      return versionId.slice("modrinth_".length);
    }
    return versionId;
  }

  listPendingCandidates() {
    return [...this.repository.groundTruthCandidates.values()]
      .filter((candidate) => candidate.status === "queued")
      .sort((left, right) => {
        if (right.priority !== left.priority) {
          return right.priority - left.priority;
        }
        return left.createdAt.localeCompare(right.createdAt);
      });
  }

  async runPending(
    limit = 1,
    options: { requireSnapshotInMemory?: boolean; concurrency?: number } = {}
  ) {
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    const pending: GroundTruthCandidate[] = [];
    const selectedKeys = new Set<string>();
    for (const candidate of this.listPendingCandidates()) {
      const existingRecord = this.findSettledRecordForCandidate(candidate);
      if (existingRecord) {
        const skippedCandidate: GroundTruthCandidate = {
          ...candidate,
          status: "skipped",
          latestVerdict: existingRecord.verdict,
          updatedAt: now(),
          completedAt: now()
        };
        this.repository.groundTruthCandidates.set(candidate.candidateId, skippedCandidate);
        if (this.persistence?.isEnabled()) {
          await this.persistence.persistGroundTruthCandidate(skippedCandidate);
        }
        continue;
      }

      if (
        options.requireSnapshotInMemory &&
        !this.repository.snapshots.has(candidate.packSnapshotId)
      ) {
        continue;
      }

      const selectionKey = fingerprintKey(
        candidate.packFingerprint,
        candidate.executionProfileKey,
        candidate.environment
      );
      if (selectedKeys.has(selectionKey)) {
        continue;
      }

      pending.push(candidate);
      selectedKeys.add(selectionKey);
      if (pending.length >= limit) {
        break;
      }
    }
    const completed: GroundTruthRun[] = [];
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, pending.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const candidate = pending[currentIndex];
        if (!candidate) {
          return;
        }

        const run = await this.runCandidate(candidate.candidateId);
        completed.push(run);
      }
    });

    await Promise.all(workers);

    return {
      attempted: pending.length,
      completed: completed.filter((run) => run.status === "completed").length,
      failed: completed.filter((run) => run.status === "failed").length,
      timedOut: completed.filter((run) => run.status === "timed_out").length,
      runs: completed
    };
  }

  private findSettledRecordForCandidate(candidate: GroundTruthCandidate) {
    return this.findSettledRecord(
      candidate.packFingerprint,
      candidate.executionProfileKey,
      candidate.environment
    );
  }

  private findSettledRecord(
    packFingerprint: string,
    executionProfileKey: string,
    environment: AnalysisEnvironment
  ): GroundTruthExactPackRecord | undefined {
    const recordKey = fingerprintKey(packFingerprint, executionProfileKey, environment);
    const exactPackRecordId = this.repository.groundTruthExactPackRecordByKey.get(recordKey);
    const existingRecord = exactPackRecordId
      ? this.repository.groundTruthExactPackRecords.get(exactPackRecordId)
      : undefined;
    return existingRecord && shouldSkipBecauseAlreadyVerified(existingRecord.verdict)
      ? existingRecord
      : undefined;
  }

  async runCandidate(candidateId: string) {
    const candidate = this.repository.groundTruthCandidates.get(candidateId);
    if (!candidate) {
      throw new Error(`Ground-truth candidate not found: ${candidateId}`);
    }
    let snapshot = this.repository.snapshots.get(candidate.packSnapshotId);
    if (!snapshot && this.persistence?.isEnabled()) {
      await this.persistence.hydrateSnapshot(candidate.packSnapshotId);
      snapshot = this.repository.snapshots.get(candidate.packSnapshotId);
    }
    if (!snapshot) {
      const summary = `Pack snapshot not found: ${candidate.packSnapshotId}`;
      const failedRun: GroundTruthRun = {
        groundTruthRunId: createPlatformId("gtr"),
        candidateId: candidate.candidateId,
        packSnapshotId: candidate.packSnapshotId,
        packFingerprint: candidate.packFingerprint,
        environment: candidate.environment,
        executionProfileKey: candidate.executionProfileKey,
        status: "failed",
        verdict: "inconclusive",
        reachedMainMenu: false,
        reachedWorld: false,
        durationMs: 0,
        summary,
        observations: [
          {
            observationId: createPlatformId("gto"),
            kind: "process",
            status: "failed",
            summary
          }
        ],
        tenantId: candidate.tenantId,
        schemaVersion: 1,
        createdAt: now()
      };
      this.repository.groundTruthRuns.set(failedRun.groundTruthRunId, failedRun);

      const failedCandidate: GroundTruthCandidate = {
        ...candidate,
        status: "failed",
        latestRunId: failedRun.groundTruthRunId,
        latestVerdict: failedRun.verdict,
        updatedAt: now(),
        completedAt: now()
      };
      this.repository.groundTruthCandidates.set(failedCandidate.candidateId, failedCandidate);

      const recordKey = fingerprintKey(
        failedRun.packFingerprint,
        failedRun.executionProfileKey,
        failedRun.environment
      );
      const timestamp = now();
      const record: GroundTruthExactPackRecord = {
        groundTruthExactPackRecordId: createPlatformId("gxp"),
        packFingerprint: failedRun.packFingerprint,
        packSnapshotId: failedRun.packSnapshotId,
        environment: failedRun.environment,
        executionProfileKey: failedRun.executionProfileKey,
        verdict: failedRun.verdict,
        confidence: {
          score: 0.336,
          band: "very_low",
          explanation: summary,
          primaryDrivers: [summary]
        },
        runIds: [failedRun.groundTruthRunId],
        latestRunId: failedRun.groundTruthRunId,
        summary,
        reproducibilityScore: 0,
        tenantId: failedRun.tenantId,
        schemaVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.repository.groundTruthRuns.set(failedRun.groundTruthRunId, failedRun);
      this.repository.groundTruthExactPackRecords.set(record.groundTruthExactPackRecordId, record);
      this.repository.groundTruthExactPackRecordByKey.set(
        recordKey,
        record.groundTruthExactPackRecordId
      );

      if (this.persistence?.isEnabled()) {
        await this.persistence.persistGroundTruthRun(failedRun);
        await this.persistence.persistGroundTruthCandidate(failedCandidate);
        await this.persistence.persistGroundTruthExactPackRecord(record);
      }

      return failedRun;
    }

    const runningCandidate: GroundTruthCandidate = {
      ...candidate,
      status: "running",
      attempts: candidate.attempts + 1,
      updatedAt: now()
    };
    this.repository.groundTruthCandidates.set(candidateId, runningCandidate);
    if (this.persistence?.isEnabled()) {
      await this.persistence.persistGroundTruthCandidate(runningCandidate);
    }

    const workdir = resolve(
      process.env.GROUND_TRUTH_WORKDIR_ROOT?.trim() || join(tmpdir(), "modcompat-ground-truth"),
      runningCandidate.candidateId
    );
    await mkdir(workdir, { recursive: true });

    const candidateFile = join(workdir, "ground-truth-candidate.json");
    const resultFile = join(workdir, "ground-truth-result.json");
    await writeFile(
      candidateFile,
      JSON.stringify(
        {
          candidate: runningCandidate,
          snapshot
        },
        null,
        2
      ),
      "utf8"
    );

    let executorResult: GroundTruthExecutorOutput;
    try {
      executorResult = await this.executor.execute({
        candidate: runningCandidate,
        snapshot,
        workdir,
        candidateFile,
        resultFile,
        timeoutMs: this.getTimeoutMs()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown executor error";
      executorResult = {
        status: "failed",
        verdict: "inconclusive",
        reachedMainMenu: false,
        reachedWorld: false,
        durationMs: 0,
        summary: `Ground-truth executor failed before returning a structured result: ${message}`,
        observations: [
          {
            observationId: createPlatformId("gto"),
            kind: "process",
            status: "failed",
            summary: message
          }
        ],
        artifactDirectory: workdir
      };
    }

    const run: GroundTruthRun = {
      groundTruthRunId: createPlatformId("gtr"),
      candidateId: runningCandidate.candidateId,
      packSnapshotId: snapshot.packSnapshotId,
      packFingerprint: snapshot.normalizedHash,
      environment: snapshot.environment,
      executionProfileKey: runningCandidate.executionProfileKey,
      status: executorResult.status,
      verdict: executorResult.verdict,
      reachedMainMenu: executorResult.reachedMainMenu,
      reachedWorld: executorResult.reachedWorld,
      exitCode: executorResult.exitCode,
      durationMs: executorResult.durationMs,
      summary: executorResult.summary,
      observations: executorResult.observations,
      stdoutText: executorResult.stdoutText,
      stderrText: executorResult.stderrText,
      artifactDirectory: executorResult.artifactDirectory,
      rawResult: executorResult.rawResult,
      tenantId: snapshot.organizationId,
      schemaVersion: 1,
      createdAt: now()
    };
    this.repository.groundTruthRuns.set(run.groundTruthRunId, run);

    const finalCandidate: GroundTruthCandidate = {
      ...runningCandidate,
      status: executorResult.status,
      latestRunId: run.groundTruthRunId,
      latestVerdict: run.verdict,
      updatedAt: now(),
      completedAt: now()
    };
    this.repository.groundTruthCandidates.set(finalCandidate.candidateId, finalCandidate);

    const record = this.upsertExactPackRecord(snapshot, run);

    if (this.persistence?.isEnabled()) {
      await this.persistence.persistGroundTruthRun(run);
      await this.persistence.persistGroundTruthCandidate(finalCandidate);
      await this.persistence.persistGroundTruthExactPackRecord(record);
    }

    return run;
  }

  /**
   * After a ground-truth run, update the confidence on any matching pairwise records
   * stored in the repository.
   *
   * Scope: this updates startup-crash-detection confidence only. A "passed" result means
   * the pair did not crash on startup or world load — not full gameplay compatibility.
   * The confidence explanation reflects this explicitly.
   */
  private applyGroundTruthFeedbackToPairwise(snapshot: PackSnapshot, run: GroundTruthRun): string[] {
    if (run.verdict === "inconclusive" || run.verdict === "timed_out") return [];

    const projectIds = snapshot.mods
      .map((m) => m.canonicalProjectId)
      .filter((id): id is string => Boolean(id));

    if (projectIds.length !== 2) return [];

    const [leftId, rightId] = [...projectIds].sort() as [string, string];

    const groundTruthVerdict: AnalysisVerdict =
      run.verdict === "passed_startup_and_world" ? "no_known_issue_found" : "known_incompatible";
    const groundTruthConfidence = baseVerdictScore(run.verdict);

    const scopeNote =
      run.verdict === "passed_startup_and_world"
        ? "Did not crash on startup or world load (crash-detection only — not a full compatibility guarantee)."
        : "Crashed on startup or world load.";

    const updatedIds: string[] = [];

    for (const record of this.repository.pairwiseCompatibilityRecords.values()) {
      const recLeft = [record.leftProjectId, record.rightProjectId].sort()[0];
      const recRight = [record.leftProjectId, record.rightProjectId].sort()[1];
      if (recLeft !== leftId || recRight !== rightId) continue;

      // Skip if the existing record already has equal or higher confidence for the same verdict
      if (record.verdict === groundTruthVerdict && record.confidence.score >= groundTruthConfidence) {
        continue;
      }

      const updatedRecord: PairwiseCompatibilityRecord = {
        ...record,
        verdict: groundTruthVerdict,
        confidence: {
          score: Number(groundTruthConfidence.toFixed(4)),
          band: confidenceBand(groundTruthConfidence),
          explanation: `Ground-truth execution (${run.verdict}). ${scopeNote}`,
          primaryDrivers: [
            `Ground-truth verdict: ${run.verdict}`,
            `Run ID: ${run.groundTruthRunId}`,
            scopeNote
          ]
        }
      };
      this.repository.pairwiseCompatibilityRecords.set(record.pairwiseCompatibilityId, updatedRecord);
      updatedIds.push(record.pairwiseCompatibilityId);
    }

    return updatedIds;
  }

  private upsertExactPackRecord(snapshot: PackSnapshot, run: GroundTruthRun) {
    const recordKey = fingerprintKey(
      run.packFingerprint,
      run.executionProfileKey,
      run.environment
    );
    const existingId = this.repository.groundTruthExactPackRecordByKey.get(recordKey);
    const existing = existingId
      ? this.repository.groundTruthExactPackRecords.get(existingId)
      : undefined;

    const runIds = existing ? [...existing.runIds, run.groundTruthRunId] : [run.groundTruthRunId];
    const reproducibilityScore =
      runIds.length <= 1
        ? run.verdict === "inconclusive" ? 0.4 : 1
        : clamp(
            runIds
              .map((runId) => this.repository.groundTruthRuns.get(runId))
              .filter((item): item is GroundTruthRun => Boolean(item))
              .filter((item) => item.verdict === run.verdict).length / runIds.length
          );

    const confidenceScore = clamp(
      baseVerdictScore(run.verdict) * (0.8 + reproducibilityScore * 0.2)
    );
    const confidence: ConfidenceSummary = {
      score: Number(confidenceScore.toFixed(4)),
      band: confidenceBand(confidenceScore),
      explanation:
        run.verdict === "passed_startup_and_world"
          ? "Empirical execution reached startup and world load successfully."
          : run.verdict === "failed_world_load"
            ? "Empirical execution reached startup but failed during world creation or load."
            : run.verdict === "failed_startup"
              ? "Empirical execution failed during startup before a world could load."
              : run.verdict === "timed_out"
                ? "Empirical execution exceeded the configured timeout."
                : "Empirical execution completed without enough structured evidence to classify the result conclusively.",
      primaryDrivers: [
        `Execution profile: ${run.executionProfileKey}`,
        `Observed verdict: ${run.verdict}`,
        `Reproducibility: ${reproducibilityScore.toFixed(2)}`
      ]
    };

    const timestamp = now();
    const record: GroundTruthExactPackRecord = {
      groundTruthExactPackRecordId:
        existing?.groundTruthExactPackRecordId ?? createPlatformId("gxp"),
      groundTruthSnapshotId: existing?.groundTruthSnapshotId,
      packFingerprint: run.packFingerprint,
      packSnapshotId: snapshot.packSnapshotId,
      environment: snapshot.environment,
      executionProfileKey: run.executionProfileKey,
      verdict: run.verdict,
      confidence,
      runIds,
      latestRunId: run.groundTruthRunId,
      summary: run.summary,
      reproducibilityScore: Number(reproducibilityScore.toFixed(4)),
      tenantId: snapshot.organizationId,
      schemaVersion: 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.repository.groundTruthExactPackRecords.set(record.groundTruthExactPackRecordId, record);
    this.repository.groundTruthExactPackRecordByKey.set(
      recordKey,
      record.groundTruthExactPackRecordId
    );
    return record;
  }

  buildKnowledgeSnapshot(input: {
    createdBy?: string;
    versionLabel?: string;
    promote?: boolean;
  } = {}) {
    const exactPackRecords = [...this.repository.groundTruthExactPackRecords.values()]
      .filter((record) => record.verdict !== "inconclusive");
    const createdAt = now();
    const version =
      input.versionLabel?.trim() ||
      `ground_truth_snapshot_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const snapshot: GroundTruthKnowledgeSnapshot = {
      groundTruthSnapshotId: createPlatformId("gks"),
      version,
      status: input.promote === false ? "draft" : "promoted",
      recordCount: exactPackRecords.length,
      includedRecordIds: exactPackRecords.map((record) => record.groundTruthExactPackRecordId),
      checksums: {
        exactPackRecords: stableHash(
          exactPackRecords.map((record) => ({
            id: record.groundTruthExactPackRecordId,
            fingerprint: record.packFingerprint,
            verdict: record.verdict,
            updatedAt: record.updatedAt
          }))
        )
      },
      createdBy: input.createdBy,
      activatedAt: input.promote === false ? undefined : createdAt,
      schemaVersion: 1,
      createdAt
    };
    this.repository.groundTruthKnowledgeSnapshots.set(
      snapshot.groundTruthSnapshotId,
      snapshot
    );
    this.repository.groundTruthKnowledgeSnapshotsByVersion.set(snapshot.version, snapshot.groundTruthSnapshotId);

    for (const record of exactPackRecords) {
      this.repository.groundTruthExactPackRecords.set(record.groundTruthExactPackRecordId, {
        ...record,
        groundTruthSnapshotId: snapshot.groundTruthSnapshotId
      });
    }

    return snapshot;
  }

  async hydrateState() {
    if (!this.persistence?.isEnabled()) {
      return;
    }
    await this.persistence.hydrateGroundTruthState();
    const recovered = this.recoverInterruptedCandidates();
    if (recovered > 0) {
      for (const candidate of this.repository.groundTruthCandidates.values()) {
        if (candidate.status === "queued") {
          await this.persistence.persistGroundTruthCandidate(candidate);
        }
      }
    }
  }
}
