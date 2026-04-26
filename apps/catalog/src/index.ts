import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadServiceConfig } from "@modcompat/config";
import { createLogger } from "@modcompat/observability";
import { createPhase1Platform } from "@modcompat/platform-core";

import { ModResolver, type ModInfo, type ModLookupInput, type ModSearchOptions } from "./mod-resolver.js";
import { CurseForgeAPI } from "./curseforge.js";
import { ModrinthAPI } from "./modrinth.js";

export interface BulkIngestResult {
  projectsUpserted: number;
  versionsUpserted: number;
  sourceMappingsUpserted: number;
  incompatibilitiesAdded: number;
  sources: { curseforge: number; modrinth: number };
}

export interface CatalogApp {
  config: ReturnType<typeof loadServiceConfig>;
  logger: ReturnType<typeof createLogger>;
  platform: ReturnType<typeof createPhase1Platform>;
  resolver: ModResolver;
  routes: Array<{ method: "GET" | "POST"; path: string; summary: string }>;
  handlers: {
    resolveMods(
      mods: ModLookupInput[],
      options?: ModSearchOptions
    ): Promise<{
      mods: ModInfo[];
      totalRequested: number;
      totalFound: number;
      sources: { curseforge: number; modrinth: number };
    }>;
    ingestResolvedMods(
      mods: ModLookupInput[],
      options?: ModSearchOptions & { createdBy?: string }
    ): Promise<{
      mods: ModInfo[];
      totalRequested: number;
      totalFound: number;
      sources: { curseforge: number; modrinth: number };
      ingest: ReturnType<ReturnType<typeof createPhase1Platform>["catalogIngestion"]["bulkIngest"]>;
    }>;
    ingestPopularMods(options?: {
      limit?: number;
      minecraftVersion?: string;
      loader?: string;
    }): Promise<BulkIngestResult>;
  };
}

interface ServiceErrorPayload {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    traceId: string;
  };
}

function buildRequestContext(request: IncomingMessage) {
  const requestId = request.headers["x-request-id"]?.toString() ?? `req_${randomUUID()}`;
  const traceId = request.headers["x-trace-id"]?.toString() ?? requestId;
  return { requestId, traceId };
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  context: { requestId: string; traceId: string }
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": context.requestId,
    "x-trace-id": context.traceId
  });
  response.end(JSON.stringify(payload));
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  context: { requestId: string; traceId: string },
  input: {
    code: string;
    message: string;
    retryable: boolean;
  }
) {
  writeJson(
    response,
    statusCode,
    {
      error: {
        code: input.code,
        message: input.message,
        retryable: input.retryable,
        requestId: context.requestId,
        traceId: context.traceId
      }
    } satisfies ServiceErrorPayload,
    context
  );
}

function summarizeResolvedMods(mods: ModInfo[]) {
  return {
    mods,
    totalRequested: 0,
    totalFound: mods.length,
    sources: {
      curseforge: mods.filter((mod) => mod.source === "curseforge").length,
      modrinth: mods.filter((mod) => mod.source === "modrinth").length
    }
  };
}

function normalizeSlug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildCatalogApp(): CatalogApp {
  const config = loadServiceConfig("catalog");
  const logger = createLogger("catalog");
  const platform = createPhase1Platform();
  const resolver = new ModResolver(process.env.CURSEFORGE_API_KEY);
  const curseforgeApi = new CurseForgeAPI(process.env.CURSEFORGE_API_KEY ?? "");
  const modrinthApi = new ModrinthAPI();
  if (platform.persistence.isEnabled()) {
    void platform.persistence.hydrateCatalogState();
  }

  const routes = [
    { method: "GET" as const, path: "/healthz", summary: "Health check" },
    { method: "POST" as const, path: "/v1/catalog/resolve", summary: "Resolve mods via live catalog sources" },
    { method: "POST" as const, path: "/v1/catalog/ingest-live", summary: "Resolve mods via live sources and ingest them into the canonical catalog" },
    { method: "POST" as const, path: "/v1/catalog/ingest-popular", summary: "Bulk-crawl popular mods from CurseForge and Modrinth and ingest them into the canonical catalog" }
  ];

  logger.info("Catalog service ready", {
    routeCount: routes.length,
    features: ["curseforge_api_integration", "modrinth_api_integration", "canonical_catalog_ingestion", "bulk_popular_ingestion"]
  });

  return {
    config,
    logger,
    platform,
    resolver,
    routes,
    handlers: {
      async resolveMods(mods, options = {}) {
        const resolved = await resolver.resolveMultipleMods(mods, options);
        const summary = summarizeResolvedMods(resolved);
        return { ...summary, totalRequested: mods.length };
      },
      async ingestResolvedMods(mods, options = {}) {
        const resolved = await resolver.resolveMultipleMods(mods, options);
        let projectsUpserted = 0;
        let versionsUpserted = 0;
        let sourceMappingsUpserted = 0;

        for (const mod of resolved) {
          const project = platform.catalogIngestion.ingestProject({
            slug: normalizeSlug(mod.name),
            displayName: mod.name,
            aliases: [mod.name, String(mod.sourceId)]
          });
          projectsUpserted++;

          platform.catalogIngestion.ingestVersion({
            projectId: project.projectId,
            versionLabel: mod.version,
            loaders: mod.loaders.length > 0 ? mod.loaders : ["unknown"],
            minecraftVersions: mod.gameVersions.length > 0 ? mod.gameVersions : ["unknown"],
            javaVersions: ["21"],
            primaryFileDownloadUrl: mod.downloadUrl
          });
          versionsUpserted++;

          platform.catalogIngestion.ingestSourceMapping({
            externalKey: `${mod.source}:${String(mod.sourceId)}`,
            sourceName: mod.source,
            sourceProjectId: String(mod.sourceId),
            canonicalProjectId: project.projectId
          });
          sourceMappingsUpserted++;
        }
        const ingest = {
          projectsUpserted,
          versionsUpserted,
          sourceMappingsUpserted,
          incompatibilitiesAdded: 0
        };
        if (platform.persistence.isEnabled()) {
          await platform.persistence.persistCatalogState();
        }

        const summary = summarizeResolvedMods(resolved);
        return {
          ...summary,
          totalRequested: mods.length,
          ingest
        };
      },

      async ingestPopularMods(options = {}) {
        const { limit = 200, minecraftVersion, loader } = options;
        const halfLimit = Math.ceil(limit / 2);

        logger.info("Starting bulk popular mod ingestion", { limit, minecraftVersion, loader });

        let cfCount = 0;
        let mrCount = 0;
        let projectsUpserted = 0;
        let versionsUpserted = 0;
        let sourceMappingsUpserted = 0;

        // Fetch and ingest from CurseForge
        try {
          const cfMods = await curseforgeApi.getPopularMods(halfLimit, { minecraftVersion, loader });
          cfCount = cfMods.length;
          for (const mod of cfMods) {
            const latestFile = mod.gameLatestFiles?.[0];
            const project = platform.catalogIngestion.ingestProject({
              slug: normalizeSlug(mod.slug || mod.name),
              displayName: mod.name,
              aliases: [mod.name, mod.slug, String(mod.id)].filter(Boolean)
            });
            projectsUpserted++;

            if (latestFile) {
              platform.catalogIngestion.ingestVersion({
                projectId: project.projectId,
                versionLabel: latestFile.displayName || latestFile.fileName,
                loaders: latestFile.modLoaders ?? [],
                minecraftVersions: latestFile.gameVersions ?? [],
                javaVersions: ["21"],
                primaryFileDownloadUrl: latestFile.downloadUrl
              });
              versionsUpserted++;
            }

            platform.catalogIngestion.ingestSourceMapping({
              externalKey: `curseforge:${mod.id}`,
              sourceName: "curseforge",
              sourceProjectId: String(mod.id),
              canonicalProjectId: project.projectId
            });
            sourceMappingsUpserted++;
          }
          logger.info("CurseForge bulk ingestion done", { count: cfCount });
        } catch (error) {
          logger.error("CurseForge bulk ingestion failed", { error: error instanceof Error ? error.message : String(error) });
        }

        // Fetch and ingest from Modrinth
        try {
          const mrHits = await modrinthApi.getPopularMods(halfLimit, { minecraftVersion, loader });
          mrCount = mrHits.length;
          for (const hit of mrHits) {
            const project = platform.catalogIngestion.ingestProject({
              slug: normalizeSlug(hit.slug || hit.title),
              displayName: hit.title,
              aliases: [hit.title, hit.slug, hit.project_id].filter(Boolean)
            });
            projectsUpserted++;

            if (hit.latest_version) {
              platform.catalogIngestion.ingestVersion({
                projectId: project.projectId,
                versionLabel: hit.latest_version,
                loaders: hit.loader ?? hit.categories?.filter((c) => ["forge", "fabric", "quilt", "neoforge"].includes(c)) ?? [],
                minecraftVersions: hit.versions ?? [],
                javaVersions: ["21"]
              });
              versionsUpserted++;
            }

            platform.catalogIngestion.ingestSourceMapping({
              externalKey: `modrinth:${hit.project_id}`,
              sourceName: "modrinth",
              sourceProjectId: hit.project_id,
              canonicalProjectId: project.projectId
            });
            sourceMappingsUpserted++;
          }
          logger.info("Modrinth bulk ingestion done", { count: mrCount });
        } catch (error) {
          logger.error("Modrinth bulk ingestion failed", { error: error instanceof Error ? error.message : String(error) });
        }

        if (platform.persistence.isEnabled()) {
          await platform.persistence.persistCatalogState();
        }

        return {
          projectsUpserted,
          versionsUpserted,
          sourceMappingsUpserted,
          incompatibilitiesAdded: 0,
          sources: { curseforge: cfCount, modrinth: mrCount }
        };
      }
    }
  };
}

export function startCatalogServer(app = buildCatalogApp()) {
  const server = createServer(async (request, response) => {
    const context = buildRequestContext(request);
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${app.config.port}`);

    try {
      if (method === "GET" && requestUrl.pathname === "/healthz") {
        writeJson(
          response,
          200,
          {
            service: app.config.serviceName,
            status: "ok",
            routes: app.routes.length,
            persistence: app.platform.persistence.getStatus()
          },
          context
        );
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/catalog/resolve") {
        const body = await readJsonBody<{ mods?: ModLookupInput[]; minecraftVersion?: string; loader?: string }>(request);
        if (!body?.mods || !Array.isArray(body.mods)) {
          writeError(response, 400, context, {
            code: "request_body_required",
            message: "`mods` array is required.",
            retryable: false
          });
          return;
        }
        const result = await app.handlers.resolveMods(body.mods, {
          minecraftVersion: body.minecraftVersion,
          loader: body.loader
        });
        writeJson(response, 200, result, context);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/catalog/ingest-live") {
        const body = await readJsonBody<{
          mods?: ModLookupInput[];
          minecraftVersion?: string;
          loader?: string;
          createdBy?: string;
        }>(request);
        if (!body?.mods || !Array.isArray(body.mods)) {
          writeError(response, 400, context, {
            code: "request_body_required",
            message: "`mods` array is required.",
            retryable: false
          });
          return;
        }
        const result = await app.handlers.ingestResolvedMods(body.mods, {
          minecraftVersion: body.minecraftVersion,
          loader: body.loader,
          createdBy: body.createdBy
        });
        writeJson(response, 200, result, context);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/v1/catalog/ingest-popular") {
        const body = await readJsonBody<{
          limit?: number;
          minecraftVersion?: string;
          loader?: string;
        }>(request);
        const result = await app.handlers.ingestPopularMods({
          limit: body?.limit,
          minecraftVersion: body?.minecraftVersion,
          loader: body?.loader
        });
        writeJson(response, 200, result, context);
        return;
      }

      writeError(response, 404, context, {
        code: "route_not_found",
        message: "Route not found.",
        retryable: false
      });
    } catch (error) {
      writeError(response, 500, context, {
        code: "catalog_request_failed",
        message: error instanceof Error ? error.message : "Unknown error",
        retryable: true
      });
    }
  });

  server.listen(app.config.port, () => {
    app.logger.info("Catalog HTTP server listening", {
      port: app.config.port,
      routeCount: app.routes.length,
      persistence: app.platform.persistence.getStatus()
    });
  });

  return server;
}

export { ModResolver };
export type { ModInfo, ModSearchOptions, ModLookupInput } from "./mod-resolver.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startCatalogServer();
}
