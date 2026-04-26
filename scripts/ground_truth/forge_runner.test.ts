import assert from "node:assert/strict";
import test from "node:test";

import { createPhase1Platform } from "../../packages/platform-core/src/index.js";
import { findDownloadUrl } from "./forge_runner.js";
import { selectRandomMods } from "./run_forge_local.js";

test("findDownloadUrl resolves Modrinth-origin mods without CURSEFORGE_API_KEY", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.CURSEFORGE_API_KEY;
  const requestedUrls: string[] = [];

  delete process.env.CURSEFORGE_API_KEY;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("api.modrinth.com/v2/project/AANobbMI/version")) {
      return new Response(JSON.stringify([
        {
          id: "ver_1",
          version_number: "1.20.1-1",
          name: "Forge 1.20.1",
          loaders: ["forge"],
          game_versions: ["1.20.1"],
          files: [
            {
              url: "https://cdn.modrinth.com/data/AANobbMI/versions/ver_1/example.jar",
              primary: true,
              filename: "example.jar"
            }
          ]
        }
      ]), { status: 200 });
    }
    if (url.includes("api.modrinth.com/v2/project/AANobbMI")) {
      return new Response(JSON.stringify({
        id: "AANobbMI",
        slug: "fabric-api",
        title: "Fabric API"
      }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;

  try {
    const resolved = await findDownloadUrl(
      { name: "fabric-api", source: "modrinth", sourceProjectId: "AANobbMI" },
      "1.20.1",
      "forge"
    );

    assert.equal(resolved?.source, "modrinth");
    assert.equal(resolved?.sourceProjectId, "AANobbMI");
    assert.equal(resolved?.downloadUrl, "https://cdn.modrinth.com/data/AANobbMI/versions/ver_1/example.jar");
    assert.ok(requestedUrls.every((url) => !url.includes("api.curseforge.com")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.CURSEFORGE_API_KEY;
    else process.env.CURSEFORGE_API_KEY = originalApiKey;
  }
});

test("findDownloadUrl uses exact Modrinth sourceVersionId when provided", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("api.modrinth.com/v2/version/exact_v2")) {
      return new Response(JSON.stringify({
        id: "exact_v2",
        version_number: "2.0.0",
        name: "Exact Forge 2.0.0",
        loaders: ["forge"],
        game_versions: ["1.20.1"],
        files: [
          {
            url: "https://cdn.modrinth.com/data/AANobbMI/versions/exact_v2/exact.jar",
            primary: true,
            filename: "exact.jar"
          }
        ]
      }), { status: 200 });
    }
    if (url.includes("api.modrinth.com/v2/project/AANobbMI")) {
      return new Response(JSON.stringify({
        id: "AANobbMI",
        slug: "fabric-api",
        title: "Fabric API"
      }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;

  try {
    const resolved = await findDownloadUrl(
      {
        name: "fabric-api",
        source: "modrinth",
        sourceProjectId: "AANobbMI",
        sourceVersionId: "exact_v2"
      },
      "1.20.1",
      "forge"
    );

    assert.equal(resolved?.downloadUrl, "https://cdn.modrinth.com/data/AANobbMI/versions/exact_v2/exact.jar");
    assert.ok(requestedUrls.some((url) => url.includes("api.modrinth.com/v2/version/exact_v2")));
    assert.ok(requestedUrls.every((url) => !url.includes("api.modrinth.com/v2/project/AANobbMI/version?")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selectRandomMods prefers hydrated catalog pool over the small smoke pool", () => {
  const platform = createPhase1Platform();
  platform.repository.canonicalProjects.clear();
  platform.repository.canonicalVersions.clear();
  platform.repository.sourceMappings.clear();

  platform.repository.canonicalProjects.set("modrinth_alpha", {
    projectId: "modrinth_alpha",
    slug: "alpha-mod",
    displayName: "Alpha Mod",
    aliases: ["alpha-mod"]
  });
  platform.repository.canonicalProjects.set("modrinth_beta", {
    projectId: "modrinth_beta",
    slug: "beta-mod",
    displayName: "Beta Mod",
    aliases: ["beta-mod"]
  });
  platform.repository.canonicalVersions.set("modrinth_alpha_v1", {
    versionId: "modrinth_alpha_v1",
    projectId: "modrinth_alpha",
    versionLabel: "1.0.0",
    loaders: ["forge"],
    minecraftVersions: ["1.20.1"],
    javaVersions: ["17"]
  });
  platform.repository.canonicalVersions.set("modrinth_beta_v1", {
    versionId: "modrinth_beta_v1",
    projectId: "modrinth_beta",
    versionLabel: "1.0.0",
    loaders: ["forge"],
    minecraftVersions: ["1.20.1"],
    javaVersions: ["17"]
  });
  platform.repository.sourceMappings.set("modrinth:alpha", {
    sourceName: "modrinth",
    sourceProjectId: "alpha",
    canonicalProjectId: "modrinth_alpha",
    canonicalVersionId: "modrinth_alpha_v1"
  });
  platform.repository.sourceMappings.set("modrinth:beta", {
    sourceName: "modrinth",
    sourceProjectId: "beta",
    canonicalProjectId: "modrinth_beta",
    canonicalVersionId: "modrinth_beta_v1"
  });

  const selected = selectRandomMods(platform, 2, { minecraftVersion: "1.20.1" });

  assert.equal(selected.details.poolSource, "catalog");
  assert.equal(selected.mods.length, 2);
  assert.ok(selected.mods.every((mod) => mod.source === "modrinth"));
  assert.deepEqual(
    new Set(selected.mods.map((mod) => mod.sourceProjectId)),
    new Set(["alpha", "beta"])
  );
});
