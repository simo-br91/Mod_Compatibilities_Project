#!/usr/bin/env node
/**
 * Load 10 real Forge mods from Modrinth
 * Uses known popular mod IDs for reliability
 */

import { createPhase1Platform } from "../packages/platform-core/src/index.js";
import { createLogger } from "../packages/observability/src/index.js";

interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  loaders: string[];
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  name: string;
  loaders: string[];
  game_versions: string[];
  date_published: string;
  files: { url: string }[];
}

async function fetchPopularForgeModsFromModrinth(): Promise<
  Array<{ project: ModrinthProject; version: ModrinthVersion }>
> {
  const logger = createLogger("catalog-loader");

  // Known popular Forge mods (IDs from Modrinth)
  const knownModIds = [
    "IXjuzNUL", // JEI
    "jLPq5eOG", // Flywheel
    "K80H4yXM", // Sophisticated Storage
    "7E0R1YXD", // Create
    "L8sssAKB", // Extreme Reactors
    "VPnmK9VN", // Immersive Engineering
    "Z3SeCdnv", // Mekanism
    "6LqvvN7E", // IndustrialCraft
    "yb3sYJYS", // Applied Energistics 2
    "8GgFVqvF" // Botania
  ];

  logger.info("Fetching popular Forge mods from Modrinth...", {
    modCount: knownModIds.length
  });

  const results: Array<{
    project: ModrinthProject;
    version: ModrinthVersion;
  }> = [];

  for (const modId of knownModIds) {
    try {
      // Fetch project details
      const projectUrl = `https://api.modrinth.com/v2/project/${modId}`;
      const projectResponse = await fetch(projectUrl);
      if (!projectResponse.ok) continue;

      const project = (await projectResponse.json()) as ModrinthProject;

      // Only include Forge mods
      if (!project.loaders?.includes("forge")) continue;

      // Fetch versions
      const versionsUrl = `https://api.modrinth.com/v2/project/${modId}/versions`;
      const versionsResponse = await fetch(versionsUrl);
      if (!versionsResponse.ok) continue;

      const versions = (await versionsResponse.json()) as ModrinthVersion[];

      // Filter to versions 6+ months old with Forge support
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const oldEnoughVersion = versions.find(
        (v) =>
          new Date(v.date_published) < sixMonthsAgo &&
          v.files.length > 0 &&
          v.loaders.includes("forge")
      );

      if (oldEnoughVersion) {
        results.push({ project, version: oldEnoughVersion });
        logger.info("Found Forge mod", {
          name: project.title,
          version: oldEnoughVersion.version_number
        });
      }

      if (results.length >= 10) break;
    } catch (error) {
      logger.debug("Skipped mod", { modId, error });
      continue;
    }
  }

  logger.info("Selected mods for ingestion", { count: results.length });
  return results;
}

async function loadRealCatalog() {
  const logger = createLogger("catalog-loader");
  const platform = createPhase1Platform();

  logger.info("Starting real catalog load");

  try {
    const mods = await fetchPopularForgeModsFromModrinth();

    logger.info("Ingesting mods into catalog", { count: mods.length });

    for (const { project, version } of mods) {
      // Ingest project
      platform.catalogIngestion.ingestProject({
        projectId: `modrinth_${project.id}`,
        slug: project.slug,
        displayName: project.title,
        aliases: [project.slug]
      });

      // Ingest version
      const downloadUrl = version.files[0]?.url;
      if (downloadUrl) {
        platform.catalogIngestion.ingestVersion({
          projectId: `modrinth_${project.id}`,
          versionId: `modrinth_${version.id}`,
          versionLabel: version.version_number,
          loaders: version.loaders,
          minecraftVersions: version.game_versions,
          javaVersions: [], // Not available from API
          primaryFileDownloadUrl: downloadUrl
        });

        logger.info("Ingested mod", {
          project: project.title,
          version: version.version_number
        });
      }
    }

    const projects = [
      ...platform.repository.canonicalProjects.values()
    ];
    const versions = [...platform.repository.canonicalVersions.values()];

    logger.info("Catalog load complete", {
      totalProjects: projects.length,
      totalVersions: versions.length
    });

    console.log("\n" + "=".repeat(80));
    console.log("CATALOG LOAD COMPLETE");
    console.log("=".repeat(80));
    console.log(
      JSON.stringify(
        {
          projects: projects.length,
          versions: versions.length,
          mods: mods.map((m) => ({
            name: m.project.title,
            slug: m.project.slug,
            version: m.version.version_number,
            downloadUrl: m.version.files[0]?.url
          }))
        },
        null,
        2
      )
    );
    console.log("=".repeat(80) + "\n");

    process.exit(0);
  } catch (error) {
    logger.error("Catalog load failed", { error });
    process.exit(1);
  }
}

loadRealCatalog();
