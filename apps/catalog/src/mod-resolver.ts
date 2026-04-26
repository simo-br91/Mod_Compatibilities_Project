import { createLogger } from "@modcompat/observability";
import { CurseForgeAPI } from "./curseforge.js";
import { ModrinthAPI } from "./modrinth.js";

const logger = createLogger("mod-resolver");

export interface ModInfo {
  id: string;
  name: string;
  version: string;
  source: "curseforge" | "modrinth";
  sourceId: number | string;
  description?: string;
  downloadUrl?: string;
  dependencies?: Array<{
    id: string;
    name: string;
    version: string;
    source: "curseforge" | "modrinth";
    required: boolean;
  }>;
  gameVersions: string[];
  loaders: string[];
  downloads: number;
  author?: string;
  iconUrl?: string;
}

export interface ModSearchOptions {
  minecraftVersion?: string;
  loader?: string;
  exactMatch?: boolean;
}

export interface ModLookupInput {
  name: string;
  curseforgeProjectId?: number;
  modrinthProjectId?: string;
}

export class ModResolver {
  private curseforge: CurseForgeAPI;
  private modrinth: ModrinthAPI;

  constructor(curseforgeApiKey?: string) {
    this.curseforge = new CurseForgeAPI(curseforgeApiKey || "");
    this.modrinth = new ModrinthAPI();
  }

  async resolveMod(input: ModLookupInput, options: ModSearchOptions = {}): Promise<ModInfo | null> {
    const { name, curseforgeProjectId, modrinthProjectId } = input;
    const { minecraftVersion, loader, exactMatch = false } = options;

    logger.info("Resolving mod", { name, curseforgeProjectId, modrinthProjectId, minecraftVersion, loader, exactMatch });

    // Prefer direct CurseForge project ID lookup from manifest.json.
    if (typeof curseforgeProjectId === "number") {
      try {
        const curseforgeMod = await this.curseforge.getMod(curseforgeProjectId);
        if (curseforgeMod) {
          logger.info("Found mod on CurseForge by project ID", { name, modId: curseforgeMod.id });
          return this.convertCurseForgeMod(curseforgeMod, minecraftVersion);
        }
      } catch (error) {
        logger.warn("CurseForge ID lookup failed", { name, curseforgeProjectId, error });
      }
    }

    // Try CurseForge name/slug search first.
    try {
      const curseforgeMod = await this.curseforge.findModByName(name, minecraftVersion, loader);
      if (curseforgeMod) {
        logger.info("Found mod on CurseForge", { name, modId: curseforgeMod.id });
        return this.convertCurseForgeMod(curseforgeMod, minecraftVersion);
      }
    } catch (error) {
      logger.warn("CurseForge search failed", { name, error });
    }

    // Fallback to Modrinth (direct ID first for index.json, then search).
    if (modrinthProjectId) {
      try {
        const modrinthMod = await this.modrinth.getMod(modrinthProjectId);
        if (modrinthMod) {
          logger.info("Found mod on Modrinth by project ID", { name, projectId: modrinthMod.id });
          return this.convertModrinthMod(modrinthMod, minecraftVersion);
        }
      } catch (error) {
        logger.warn("Modrinth ID lookup failed", { name, modrinthProjectId, error });
      }
    }

    try {
      const modrinthMod = await this.modrinth.findModByName(name, minecraftVersion, loader);
      if (modrinthMod) {
        logger.info("Found mod on Modrinth", { name, projectId: modrinthMod.id });
        return this.convertModrinthMod(modrinthMod, minecraftVersion);
      }
    } catch (error) {
      logger.warn("Modrinth search failed", { name, error });
    }

    logger.warn("Mod not found on any platform", { name });
    return null;
  }

  async resolveMultipleMods(mods: ModLookupInput[], options: ModSearchOptions = {}): Promise<ModInfo[]> {
    const results: ModInfo[] = [];
    const errors: string[] = [];

    // Process mods in parallel batches to avoid overwhelming APIs
    const batchSize = 5;
    for (let i = 0; i < mods.length; i += batchSize) {
      const batch = mods.slice(i, i + batchSize);
      const batchPromises = batch.map(async (mod) => {
        const { name } = mod;
        try {
          const modInfo = await this.resolveMod(mod, options);
          return { name, modInfo, error: null };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error("Failed to resolve mod", { name, error: errorMsg });
          return { name, modInfo: null, error: errorMsg };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach(({ name, modInfo, error }) => {
        if (modInfo) {
          results.push(modInfo);
        } else if (error) {
          errors.push(`${name}: ${error}`);
        }
      });

      // Small delay between batches to be respectful to APIs
      if (i + batchSize < mods.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (errors.length > 0) {
      logger.warn("Some mods failed to resolve", { errors });
    }

    return results;
  }

  private convertCurseForgeMod(curseforgeMod: any, minecraftVersion?: string): ModInfo {
    const latestFile = curseforgeMod.gameLatestFiles?.[0];
    
    return {
      id: `curseforge-${curseforgeMod.id}`,
      name: curseforgeMod.name,
      version: latestFile?.displayName || "unknown",
      source: "curseforge",
      sourceId: curseforgeMod.id,
      description: curseforgeMod.summary,
      downloadUrl: latestFile?.downloadUrl,
      dependencies: latestFile?.dependencies?.map((dep: any) => ({
        id: `curseforge-${dep.modId}`,
        name: `mod-${dep.modId}`,
        version: "unknown",
        source: "curseforge" as const,
        required: dep.relationType === 1,
      })) || [],
      gameVersions: latestFile?.gameVersions || [],
      loaders: latestFile?.modLoaders || [],
      downloads: curseforgeMod.downloadCount,
      author: curseforgeMod.authors?.[0]?.name,
      iconUrl: curseforgeMod.logo?.thumbnailUrl,
    };
  }

  private async convertModrinthMod(modrinthMod: any, minecraftVersion?: string): Promise<ModInfo> {
    let downloadUrl: string | undefined;
    let version = modrinthMod.versions?.[0] || "unknown";

    try {
      const versions = await this.modrinth.getModVersions(modrinthMod.id, minecraftVersion);
      const latest = versions[0];
      if (latest) {
        version = latest.version_number;
        const primaryFile = latest.files?.find((f: { primary: boolean }) => f.primary) ?? latest.files?.[0];
        downloadUrl = primaryFile?.url;
      }
    } catch {
      // Non-fatal — we still return the mod without a download URL
    }

    return {
      id: `modrinth-${modrinthMod.id}`,
      name: modrinthMod.title,
      version,
      source: "modrinth",
      sourceId: modrinthMod.id,
      description: modrinthMod.description,
      downloadUrl,
      dependencies: [],
      gameVersions: modrinthMod.game_versions,
      loaders: modrinthMod.loaders,
      downloads: modrinthMod.downloads,
      iconUrl: modrinthMod.icon_url,
    };
  }
}
