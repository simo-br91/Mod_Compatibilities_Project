import type {
  EvidenceSyncResult,
  LiveConnectorAdapter,
  Phase1Platform
} from "@modcompat/platform-core";
import type { SourceConnector } from "@modcompat/domain-models";
import type { SourceSyncRun } from "@modcompat/domain-models";
import type { createLogger } from "@modcompat/observability";

import { CurseForgeAdapter } from "../../../connectors/curseforge/index.ts";
import { GitHubAdapter } from "../../../connectors/github/index.ts";
import { ModrinthAdapter } from "../../../connectors/modrinth/index.ts";

import { OpenSearchEvidenceStore } from "./opensearch.js";

type Logger = ReturnType<typeof createLogger>;

type SupportedConnectorName = "github" | "curseforge" | "modrinth" | "curated-community";

interface RuntimeConnector {
  name: SupportedConnectorName;
  sync(): Promise<EvidenceSyncResult>;
}

export interface EvidenceRuntime {
  initialize(): Promise<void>;
  sync(connectorNames?: string[]): Promise<EvidenceSyncResult>;
  search: OpenSearchEvidenceStore | undefined;
  configuredConnectorNames: string[];
}

export function buildEvidenceRuntime(
  platform: Phase1Platform,
  logger: Logger
): EvidenceRuntime {
  const opensearch = buildOpenSearchStore();
  const connectors = buildConfiguredConnectors(platform, logger);

  return {
    async initialize() {
      if (!platform.persistence.isEnabled()) {
        return;
      }

      const hydrated = await platform.persistence.hydrateEvidenceState();
      if (
        opensearch &&
        (hydrated.documents.length > 0 ||
          hydrated.snippets.length > 0 ||
          hydrated.searchDocuments.length > 0)
      ) {
        await opensearch.indexSyncResult(buildRepositorySyncResult(platform));
      }
    },
    async sync(connectorNames) {
      const requestedNames = normalizeConnectorNames(connectorNames);
      const toRun =
        requestedNames.length > 0
          ? connectors.filter((connector) => requestedNames.includes(connector.name))
          : connectors;

      const unsupportedNames = requestedNames.filter(
        (connectorName) => !connectors.some((connector) => connector.name === connectorName)
      );

      if (unsupportedNames.length > 0) {
        throw new Error(
          `Requested connectors are not configured: ${unsupportedNames.join(", ")}. ` +
            `Configured connectors: ${connectors.map((connector) => connector.name).join(", ") || "none"}.`
        );
      }

      const parts: EvidenceSyncResult[] = [];
      for (const connector of toRun) {
        const result = await connector.sync();
        parts.push(result);
      }

      const merged = mergeSyncResults(parts);
      if (opensearch) {
        await opensearch.indexSyncResult(merged);
      }
      if (platform.persistence.isEnabled()) {
        await platform.persistence.persistEvidenceState();
      }
      return merged;
    },
    search: opensearch,
    configuredConnectorNames: connectors.map((connector) => connector.name)
  };
}

function buildConfiguredConnectors(
  platform: Phase1Platform,
  logger: Logger
): RuntimeConnector[] {
  const connectors: RuntimeConnector[] = [];

  const gitHubToken = process.env.GITHUB_TOKEN?.trim();
  const gitHubRepos = splitCsv(process.env.GITHUB_REPOS);
  if (gitHubToken && gitHubRepos.length > 0) {
    const adapter = new GitHubAdapter({
      token: gitHubToken,
      repos: gitHubRepos,
      labels: splitCsv(process.env.GITHUB_LABELS),
      since: process.env.GITHUB_SINCE?.trim() || undefined
    });
    connectors.push({
      name: "github",
      sync: () => runLiveSync(platform, adapter)
    });
  }

  const curseForgeApiKey = process.env.CURSEFORGE_API_KEY?.trim();
  if (curseForgeApiKey) {
    const adapter = new CurseForgeAdapter({
      apiKey: curseForgeApiKey,
      projectIds: splitCsv(process.env.CURSEFORGE_PROJECT_IDS).flatMap((value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? [parsed] : [];
      })
    });
    connectors.push({
      name: "curseforge",
      sync: () => runLiveSync(platform, adapter)
    });
  }

  const modrinthUserAgent = process.env.MODRINTH_USER_AGENT?.trim();
  if (modrinthUserAgent) {
    const adapter = new ModrinthAdapter({
      userAgent: modrinthUserAgent,
      projectIds: splitCsv(process.env.MODRINTH_PROJECT_IDS),
      apiKey: process.env.MODRINTH_API_KEY?.trim() || undefined
    });
    connectors.push({
      name: "modrinth",
      sync: () => runLiveSync(platform, adapter)
    });
  }

  connectors.push({
    name: "curated-community",
    sync: async () => platform.evidence.syncFixtures(["curated-community"])
  });

  logger.info("Evidence runtime connector configuration resolved", {
    configuredConnectors: connectors.map((connector) => connector.name),
    opensearchEnabled: Boolean(process.env.OPENSEARCH_URL?.trim())
  });

  return connectors;
}

async function runLiveSync(
  platform: Phase1Platform,
  adapter: LiveConnectorAdapter
): Promise<EvidenceSyncResult> {
  const result = await platform.ingestion.runSync(adapter, {
    maxItemsPerRun: numberFromEnv("EVIDENCE_SYNC_MAX_ITEMS", 100)
  });

  return buildSyncResult(platform, result.syncRunId, result.connectorId);
}

function buildSyncResult(
  platform: Phase1Platform,
  syncRunId: string,
  connectorId: string
): EvidenceSyncResult {
  const connectors = [platform.repository.sourceConnectors.get(connectorId)].filter(
    (connector): connector is SourceConnector => Boolean(connector)
  );
  const runs = [platform.repository.sourceSyncRuns.get(syncRunId)].filter(
    (run): run is SourceSyncRun => Boolean(run)
  );
  const rawPayloads = [...platform.repository.rawPayloads.values()].filter(
    (payload) => payload.syncRunId === syncRunId
  );
  const documents = [...platform.repository.evidenceDocuments.values()].filter(
    (document) => document.syncRunId === syncRunId
  );
  const documentIds = new Set(documents.map((document) => document.documentId));
  const snippets = [...platform.repository.evidenceSnippets.values()].filter((snippet) =>
    documentIds.has(snippet.documentId)
  );

  return {
    connectors,
    runs,
    rawPayloads,
    documents,
    snippets
  };
}

function mergeSyncResults(results: EvidenceSyncResult[]): EvidenceSyncResult {
  return {
    connectors: dedupeBy(results.flatMap((result) => result.connectors), (item) => item.connectorId),
    runs: dedupeBy(results.flatMap((result) => result.runs), (item) => item.syncRunId),
    rawPayloads: dedupeBy(results.flatMap((result) => result.rawPayloads), (item) => item.rawPayloadId),
    documents: dedupeBy(results.flatMap((result) => result.documents), (item) => item.documentId),
    snippets: dedupeBy(results.flatMap((result) => result.snippets), (item) => item.snippetId)
  };
}

function buildRepositorySyncResult(platform: Phase1Platform): EvidenceSyncResult {
  return {
    connectors: [...platform.repository.sourceConnectors.values()],
    runs: [...platform.repository.sourceSyncRuns.values()],
    rawPayloads: [...platform.repository.rawPayloads.values()],
    documents: [...platform.repository.evidenceDocuments.values()],
    snippets: [...platform.repository.evidenceSnippets.values()]
  };
}

function buildOpenSearchStore() {
  const baseUrl = process.env.OPENSEARCH_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }

  const username = process.env.OPENSEARCH_USERNAME?.trim();
  const password = process.env.OPENSEARCH_PASSWORD?.trim();

  return new OpenSearchEvidenceStore(
    baseUrl,
    username && password ? { username, password } : undefined
  );
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeConnectorNames(connectorNames?: string[]): SupportedConnectorName[] {
  return [...new Set((connectorNames ?? []).map((connectorName) => connectorName.trim()))].filter(
    (connectorName): connectorName is SupportedConnectorName =>
      connectorName === "github" ||
      connectorName === "curseforge" ||
      connectorName === "modrinth" ||
      connectorName === "curated-community"
  );
}

function numberFromEnv(key: string, defaultValue: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    seen.set(key(item), item);
  }
  return [...seen.values()];
}
