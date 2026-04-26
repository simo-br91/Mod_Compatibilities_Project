import { createLogger } from "@modcompat/observability";

const logger = createLogger("modrinth");

const MODRINTH_API_BASE = "https://api.modrinth.com/v2";

interface ModrinthMod {
  id: string;
  slug: string;
  project_type: string;
  team: string;
  title: string;
  description: string;
  body: string;
  body_url: string;
  published: string;
  updated: string;
  approved: string;
  queued: string;
  status: string;
  requested_status: string;
  license: string;
  client_side: string;
  server_side: string;
  downloads: number;
  followers: number;
  categories: string[];
  additional_categories: string[];
  game_versions: string[];
  loaders: string[];
  versions: string[];
  icon_url: string;
  issues_url: string;
  source_url: string;
  wiki_url: string;
  discord_url: string;
  donation_urls: Array<{
    id: string;
    platform: string;
    url: string;
  }>;
}

interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  file_type?: string;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  author_id: string;
  featured: boolean;
  name: string;
  version_number: string;
  changelog: string;
  changelog_url: string;
  dependencies: Array<{
    version_id?: string;
    project_id?: string;
    file_name?: string;
    dependency_type: string;
  }>;
  game_versions: string[];
  loaders: string[];
  files: ModrinthVersionFile[];
  status: string;
  requested_status: string;
  downloads: number;
  date_published: string;
}

export interface ModrinthSearchHit {
  project_id: string;
  project_type: string;
  slug: string;
  author: string;
  title: string;
  description: string;
  categories: string[];
  display_categories: string[];
  versions: string[];
  downloads: number;
  follows: number;
  icon_url: string;
  date_created: string;
  date_modified: string;
  latest_version: string;
  license: string;
  client_side: string;
  server_side: string;
  gallery: Array<{
    url: string;
    featured: boolean;
    description: string;
    created: string;
    ordinal: number;
  }>;
  loader: string[];
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

export class ModrinthAPI {
  private async makeRequest<T>(endpoint: string): Promise<T> {
    const url = `${MODRINTH_API_BASE}${endpoint}`;
    const headers = {
      "Accept": "application/json",
      "User-Agent": "ModCompat-Platform/1.0.0",
    };

    try {
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        throw new Error(`Modrinth API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error("Modrinth API request failed", { endpoint, error });
      throw error;
    }
  }

  async searchMods(
    query: string, 
    minecraftVersion?: string, 
    modLoader?: string,
    limit: number = 50
  ): Promise<ModrinthSearchResponse> {
    const params = new URLSearchParams({
      query,
      limit: limit.toString(),
    });

    const facets: string[][] = [];
    
    if (minecraftVersion) {
      facets.push([`versions:${minecraftVersion}`]);
    }

    if (modLoader) {
      facets.push([`categories:${modLoader}`]);
    }

    if (facets.length > 0) {
      params.append("facets", JSON.stringify(facets));
    }

    return this.makeRequest<ModrinthSearchResponse>(`/search?${params}`);
  }

  async getMod(projectId: string): Promise<ModrinthMod> {
    return this.makeRequest<ModrinthMod>(`/project/${projectId}`);
  }

  async getModVersions(projectId: string, minecraftVersion?: string): Promise<ModrinthVersion[]> {
    const params = new URLSearchParams();
    if (minecraftVersion) {
      params.append("gameVersions", minecraftVersion);
    }

    return this.makeRequest<ModrinthVersion[]>(`/project/${projectId}/version?${params}`);
  }

  async getPopularMods(
    limit: number,
    options: { minecraftVersion?: string; loader?: string } = {}
  ): Promise<ModrinthSearchHit[]> {
    const allHits: ModrinthSearchHit[] = [];
    const pageSize = 100;
    let offset = 0;

    while (allHits.length < limit) {
      const toFetch = Math.min(pageSize, limit - allHits.length);
      const facets: string[][] = [["project_type:mod"]];
      if (options.minecraftVersion) facets.push([`versions:${options.minecraftVersion}`]);
      if (options.loader) facets.push([`categories:${options.loader}`]);

      const params = new URLSearchParams({
        facets: JSON.stringify(facets),
        limit: String(toFetch),
        offset: String(offset),
        index: "downloads",
      });

      let response: ModrinthSearchResponse;
      try {
        response = await this.makeRequest<ModrinthSearchResponse>(`/search?${params}`);
      } catch (error) {
        logger.warn("Modrinth popular mods page failed, stopping early", { offset, error });
        break;
      }

      allHits.push(...response.hits);
      if (response.hits.length < toFetch) break;
      offset += response.hits.length;
    }

    return allHits.slice(0, limit);
  }

  async findModByName(name: string, minecraftVersion?: string, modLoader?: string): Promise<ModrinthMod | null> {
    try {
      const searchResults = await this.searchMods(name, minecraftVersion, modLoader);
      
      // Find exact match first
      const exactMatch = searchResults.hits.find(hit => 
        hit.title.toLowerCase() === name.toLowerCase() ||
        hit.slug.toLowerCase() === name.toLowerCase()
      );
      
      if (exactMatch) {
        return this.getMod(exactMatch.project_id);
      }
      
      // Return best match if no exact match
      if (searchResults.hits.length > 0) {
        return this.getMod(searchResults.hits[0].project_id);
      }
      
      return null;
    } catch (error) {
      logger.error("Failed to find mod by name", { name, error });
      return null;
    }
  }
}
