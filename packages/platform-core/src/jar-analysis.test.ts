import assert from "node:assert/strict";
import test from "node:test";

import { extractProfileFromJarBuffer, JarAnalysisService } from "./jar-analysis.js";
import { EvidenceIngestionService } from "./evidence-ingestion.js";
import { KnowledgeSynthesisService } from "./knowledge-synthesis.js";
import { InMemoryPlatformRepository } from "./repository.js";

const LF_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function makeStoredZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LF_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CD_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function makeClassWithUtf8Constants(constants: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(10);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(61, 6);
  header.writeUInt16BE(constants.length + 1, 8);
  parts.push(header);

  for (const constant of constants) {
    const value = Buffer.from(constant, "utf8");
    const entry = Buffer.alloc(3);
    entry.writeUInt8(1, 0);
    entry.writeUInt16BE(value.length, 1);
    parts.push(entry, value);
  }

  return Buffer.concat(parts);
}

test("extractProfileFromJarBuffer extracts bytecode mixin constants and access targets", () => {
  const jar = makeStoredZip([
    {
      name: "com/example/render/MixinWorldRenderer.class",
      data: makeClassWithUtf8Constants([
        "Lorg/spongepowered/asm/mixin/Mixin;",
        "Lnet/minecraft/client/render/WorldRenderer;"
      ])
    },
    {
      name: "mod.accesswidener",
      data: "accessWidener v2 named\naccessible class net/minecraft/world/level/chunk/ChunkStatus\n"
    },
    {
      name: "META-INF/accesstransformer.cfg",
      data: "public net.minecraft.client.renderer.LevelRenderer\n"
    },
    {
      name: "example.refmap.json",
      data: JSON.stringify({
        mappings: {
          "com.example.Mixin": {
            "net/minecraft/client/render/WorldRenderer": "target"
          }
        }
      })
    }
  ]);

  const profile = extractProfileFromJarBuffer(jar, "ver_test", "art_test");

  assert.ok(profile.mixinTargets.includes("net.minecraft.client.render.WorldRenderer"));
  assert.ok(profile.accessWidenerTargets?.includes("net.minecraft.world.level.chunk.ChunkStatus"));
  assert.ok(profile.accessTransformerTargets?.includes("net.minecraft.client.renderer.LevelRenderer"));
  assert.ok(profile.refmapTargets?.includes("net.minecraft.client.render.WorldRenderer"));
  assert.ok(profile.packageNamespaces?.includes("com.example.render"));
});

test("JarAnalysisService surfaces namespace and access-transform overlap findings", () => {
  const repository = new InMemoryPlatformRepository();
  repository.canonicalProjects.set("cp_a", {
    projectId: "cp_a",
    slug: "a",
    displayName: "A",
    aliases: ["a"]
  });
  repository.canonicalProjects.set("cp_b", {
    projectId: "cp_b",
    slug: "b",
    displayName: "B",
    aliases: ["b"]
  });
  repository.canonicalVersions.set("ver_a", {
    versionId: "ver_a",
    projectId: "cp_a",
    versionLabel: "1.0.0",
    loaders: ["forge"],
    minecraftVersions: ["1.20.1"],
    javaVersions: ["17"]
  });
  repository.canonicalVersions.set("ver_b", {
    versionId: "ver_b",
    projectId: "cp_b",
    versionLabel: "1.0.0",
    loaders: ["forge"],
    minecraftVersions: ["1.20.1"],
    javaVersions: ["17"]
  });
  repository.artifactProfiles.set("ver_a", {
    artifactId: "art_a",
    versionId: "ver_a",
    mixinConfigFiles: [],
    mixinTargets: [],
    classTargets: [],
    resourceTargets: [],
    embeddedLibraries: [],
    packageNamespaces: ["com.shared.compat"],
    accessWidenerTargets: ["net.minecraft.world.level.Level"],
    accessTransformerTargets: []
  });
  repository.artifactProfiles.set("ver_b", {
    artifactId: "art_b",
    versionId: "ver_b",
    mixinConfigFiles: [],
    mixinTargets: [],
    classTargets: [],
    resourceTargets: [],
    embeddedLibraries: [],
    packageNamespaces: ["com.shared.compat"],
    accessWidenerTargets: [],
    accessTransformerTargets: ["net.minecraft.world.level.Level"]
  });

  const service = new JarAnalysisService(repository, new EvidenceIngestionService(repository));
  const findings = service.detectCrossModIncompatibilities(["cp_a", "cp_b"]);

  assert.ok(findings.some((finding) => finding.conflictType === "package_namespace_conflict"));
  assert.ok(findings.some((finding) => finding.conflictType === "access_transform_overlap"));
});

test("KnowledgeSynthesisService merges duplicate technical signatures across version pairs", () => {
  const repository = new InMemoryPlatformRepository();
  repository.canonicalProjects.clear();
  repository.canonicalVersions.clear();
  repository.artifactProfiles.clear();
  repository.pendingArtifactAnalysisQueue.length = 0;
  repository.technicalConflictSignatures.clear();
  repository.technicalConflictSignaturesBySnapshot.clear();
  repository.canonicalProjects.set("cp_a", {
    projectId: "cp_a",
    slug: "a",
    displayName: "A",
    aliases: ["a"]
  });
  repository.canonicalProjects.set("cp_b", {
    projectId: "cp_b",
    slug: "b",
    displayName: "B",
    aliases: ["b"]
  });

  for (const versionId of ["ver_a1", "ver_a2"]) {
    repository.canonicalVersions.set(versionId, {
      versionId,
      projectId: "cp_a",
      versionLabel: versionId,
      loaders: ["forge"],
      minecraftVersions: ["1.20.1"],
      javaVersions: ["17"]
    });
  }
  for (const versionId of ["ver_b1", "ver_b2"]) {
    repository.canonicalVersions.set(versionId, {
      versionId,
      projectId: "cp_b",
      versionLabel: versionId,
      loaders: ["forge"],
      minecraftVersions: ["1.20.1"],
      javaVersions: ["17"]
    });
  }

  repository.artifactProfiles.set("ver_a1", {
    artifactId: "art_a1",
    versionId: "ver_a1",
    mixinConfigFiles: [],
    mixinTargets: ["net.minecraft.client.render.WorldRenderer"],
    classTargets: [],
    resourceTargets: [],
    embeddedLibraries: [],
    packageNamespaces: [],
    accessWidenerTargets: [],
    accessTransformerTargets: []
  });
  repository.artifactProfiles.set("ver_a2", {
    artifactId: "art_a2",
    versionId: "ver_a2",
    mixinConfigFiles: [],
    mixinTargets: ["net.minecraft.client.render.WorldRenderer"],
    classTargets: [],
    resourceTargets: [],
    embeddedLibraries: [],
    packageNamespaces: [],
    accessWidenerTargets: [],
    accessTransformerTargets: []
  });
  repository.artifactProfiles.set("ver_b1", {
    artifactId: "art_b1",
    versionId: "ver_b1",
    mixinConfigFiles: [],
    mixinTargets: ["net.minecraft.client.render.WorldRenderer"],
    classTargets: [],
    resourceTargets: [],
    embeddedLibraries: [],
    packageNamespaces: [],
    accessWidenerTargets: [],
    accessTransformerTargets: []
  });
  repository.artifactProfiles.set("ver_b2", {
    artifactId: "art_b2",
    versionId: "ver_b2",
    mixinConfigFiles: [],
    mixinTargets: ["net.minecraft.client.render.WorldRenderer"],
    classTargets: [],
    resourceTargets: [],
    embeddedLibraries: [],
    packageNamespaces: [],
    accessWidenerTargets: [],
    accessTransformerTargets: []
  });

  repository.pendingArtifactAnalysisQueue.push("ver_a1", "ver_a2", "ver_b1", "ver_b2");

  const synthesis = new KnowledgeSynthesisService(repository);
  const result = synthesis.processPendingArtifactAnalysis(10);
  const synthesized = [...repository.technicalConflictSignatures.values()].filter(
    (signature) => signature.projectIds.includes("cp_a") && signature.projectIds.includes("cp_b")
  );

  assert.equal(result.signaturesGenerated, 1);
  assert.equal(synthesized.length, 1);

  const signature = synthesized[0]!;
  assert.equal(signature.signatureKey, "mixin-overlap:cp_a:cp_b");
  assert.deepEqual(signature.versionIds.sort(), ["ver_a1", "ver_a2", "ver_b1", "ver_b2"]);
  assert.equal(signature.evidenceRefs.length, 4);
});
