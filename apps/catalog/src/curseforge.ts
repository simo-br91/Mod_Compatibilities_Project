import { createLogger } from "@modcompat/observability";

const logger = createLogger("curseforge");

const CURSEFORGE_API_BASE = "https://api.curseforge.com/v1";

interface CurseForgeMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  gamePopularityRank: number;
  gameLatestFiles: CurseForgeFile[];
  categories: Array<{
    id: number;
    name: string;
    url: string;
  }>;
  authors: Array<{
    id: number;
    name: string;
    url: string;
  }>;
  logo: {
    thumbnailUrl: string;
    url: string;
  };
  dateCreated: string;
  dateModified: string;
  dateReleased: string;
}

interface CurseForgeFile {
  id: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  fileLength: number;
  releaseType: 1 | 2 | 3; /* 1=Release, 2=Beta, 3=Alpha */
  downloadUrl: string;
  gameVersions: string[];
  modLoaders: string[];
  dependencies: Array<{
    modId: number;
    relationType: 1 | 2 | 3; /* 1=Required, 2=Optional, 3=Incompatible */
  }>;
}

interface CurseForgeSearchResponse {
  data: CurseForgeMod[];
  pagination: {
    index: number;
    pageSize: number;
    resultCount: number;
    totalCount: number;
  };
}

interface CurseForgeSingleResponse {
  data: CurseForgeMod;
}

export class CurseForgeAPI {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async makeRequest<T>(endpoint: string): Promise<T> {
    const url = `${CURSEFORGE_API_BASE}${endpoint}`;
    const headers = {
      "Accept": "application/json",
      "x-api-key": this.apiKey,
    };

    try {
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        throw new Error(`CurseForge API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error("CurseForge API request failed", { endpoint, error });
      throw error;
    }
  }

  async searchMods(query: string, minecraftVersion?: string, modLoader?: string): Promise<CurseForgeMod[]> {
    const params = new URLSearchParams({
      gameId: "432", // Minecraft game ID
      searchFilter: query,
      pageSize: "50",
    });

    if (minecraftVersion) {
      params.append("gameVersion", minecraftVersion);
    }

    if (modLoader) {
      const modLoaderType =
        modLoader === "forge"
          ? "1"
          : modLoader === "fabric"
            ? "4"
            : modLoader === "quilt"
              ? "5"
              : modLoader === "neoforge"
                ? "6"
                : undefined;
      if (modLoaderType) {
        params.append("modLoaderType", modLoaderType);
      }
    }

    const response = await this.makeRequest<CurseForgeSearchResponse>(`/mods/search?${params}`);
    return response.data;
  }

  async getMod(modId: number): Promise<CurseForgeMod> {
    const response = await this.makeRequest<CurseForgeSingleResponse>(`/mods/${modId}`);
    return response.data;
  }

  async getModFiles(modId: number, minecraftVersion?: string): Promise<CurseForgeFile[]> {
    const params = new URLSearchParams();
    if (minecraftVersion) {
      params.append("gameVersion", minecraftVersion);
    }

    const response = await this.makeRequest<{ data: CurseForgeFile[] }>(`/mods/${modId}/files?${params}`);
    return response.data;
  }

  async getPopularMods(
    limit: number,
    options: { minecraftVersion?: string; loader?: string } = {}
  ): Promise<CurseForgeMod[]> {
    const results: CurseForgeMod[] = [];
    const pageSize = 50;
    let index = 0;

    while (results.length < limit) {
      const toFetch = Math.min(pageSize, limit - results.length);
      const params = new URLSearchParams({
        gameId: "432",
        classId: "6", // Mods only
        pageSize: String(toFetch),
        sortField: "6", // TotalDownloads
        sortOrder: "desc",
        index: String(index),
      });

      if (options.minecraftVersion) {
        params.append("gameVersion", options.minecraftVersion);
      }

      if (options.loader) {
        const loaderType: Record<string, string> = { forge: "1", fabric: "4", quilt: "5", neoforge: "6" };
        const type = loaderType[options.loader];
        if (type) params.append("modLoaderType", type);
      }

      let response: CurseForgeSearchResponse;
      try {
        response = await this.makeRequest<CurseForgeSearchResponse>(`/mods/search?${params}`);
      } catch (error) {
        logger.warn("CurseForge popular mods page failed, stopping early", { index, error });
        break;
      }

      results.push(...response.data);
      if (response.data.length < toFetch) break;
      index += response.data.length;
    }

    return results.slice(0, limit);
  }

  async findModByName(name: string, minecraftVersion?: string, modLoader?: string): Promise<CurseForgeMod | null> {
    try {
      const results = await this.searchMods(name, minecraftVersion, modLoader);
      
      // Find exact match first
      const exactMatch = results.find(mod => 
        mod.name.toLowerCase() === name.toLowerCase() ||
        mod.slug.toLowerCase() === name.toLowerCase()
      );
      
      if (exactMatch) return exactMatch;
      
      // Return best match if no exact match
      return results[0] || null;
    } catch (error) {
      logger.error("Failed to find mod by name", { name, error });
      return null;
    }
  }
}
