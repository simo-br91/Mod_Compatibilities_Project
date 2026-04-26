import { inflateRawSync } from "node:zlib";
import { createPlatformId } from "@modcompat/id-generation";
import type { InMemoryPlatformRepository } from "./repository.js";
import type { EvidenceIngestionService } from "./evidence-ingestion.js";
import type { ArtifactProfileRecord, VerifiedRuleDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal ZIP/JAR parser (no external dependencies)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  dataOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LF_SIG = 0x04034b50;

function findEocd(buf: Buffer): number {
  // Scan backwards from the end; ZIP comment can push EOCD further back.
  const maxScan = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= maxScan; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("ZIP End of Central Directory record not found");
}

function parseZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entryCount = buf.readUInt16LE(eocd + 8);

  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CD_SIG) break;

    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + fileNameLen);

    const lf = localHeaderOffset;
    if (lf + 30 <= buf.length && buf.readUInt32LE(lf) === LF_SIG) {
      const lfFileNameLen = buf.readUInt16LE(lf + 26);
      const lfExtraLen = buf.readUInt16LE(lf + 28);
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        dataOffset: lf + 30 + lfFileNameLen + lfExtraLen
      });
    }

    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const compressed = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
}

function emptyProfile(artifactId: string, versionId: string): ArtifactProfileRecord {
  return {
    artifactId,
    versionId,
    mixinConfigFiles: [],
    mixinTargets: [],
    classTargets: [],
    resourceTargets: [],
    embeddedLibraries: [],
    packageNamespaces: [],
    accessWidenerTargets: [],
    accessTransformerTargets: [],
    refmapTargets: []
  };
}

function extractUtf8ConstantsFromClass(buf: Buffer): string[] {
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xcafebabe) {
    return [];
  }

  const constants: string[] = [];
  const constantPoolCount = buf.readUInt16BE(8);
  let offset = 10;

  for (let index = 1; index < constantPoolCount && offset < buf.length; index++) {
    const tag = buf.readUInt8(offset);
    offset += 1;

    if (tag === 1) {
      const length = buf.readUInt16BE(offset);
      offset += 2;
      constants.push(buf.toString("utf8", offset, offset + length));
      offset += length;
      continue;
    }

    if (tag === 3 || tag === 4) offset += 4;
    else if (tag === 5 || tag === 6) {
      offset += 8;
      index += 1;
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) offset += 2;
    else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) offset += 4;
    else if (tag === 15) offset += 3;
    else break;
  }

  return constants;
}

function normalizeClassRef(value: string): string | undefined {
  const direct = value.match(/^([a-zA-Z0-9_/$]+)$/)?.[1];
  const descriptor = value.match(/L([a-zA-Z0-9_/$]+);/)?.[1];
  const raw = descriptor ?? direct;
  if (!raw || !raw.includes("/")) {
    return undefined;
  }
  if (!raw.startsWith("net/minecraft/") && !raw.startsWith("com/mojang/")) {
    return undefined;
  }
  return raw.replace(/\//g, ".");
}

function extractMixinTargetsFromClassConstants(constants: string[]): string[] {
  const hasMixinAnnotation = constants.some((constant) =>
    constant.includes("org/spongepowered/asm/mixin/Mixin")
  );
  if (!hasMixinAnnotation) {
    return [];
  }

  return [
    ...new Set(
      constants
        .map(normalizeClassRef)
        .filter((value): value is string => Boolean(value))
    )
  ].slice(0, 20);
}

function parseAccessWidenerTargets(content: string): string[] {
  const targets = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("accessWidener")) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const rawTarget = parts.find((part) => part.includes("/"));
    const normalized = rawTarget?.replace(/\//g, ".");
    if (normalized) targets.add(normalized);
  }
  return [...targets];
}

function parseAccessTransformerTargets(content: string): string[] {
  const targets = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const target = trimmed.split(/\s+/)[1]?.split("(")[0]?.replace(/\//g, ".");
    if (target?.includes(".")) targets.add(target);
  }
  return [...targets];
}

function parseRefmapTargets(content: string): string[] {
  const targets = new Set<string>();
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const raw = JSON.stringify(parsed);
    for (const match of raw.matchAll(/(?:net\/minecraft|com\/mojang)\/[A-Za-z0-9_/$]+/g)) {
      targets.add(match[0].replace(/\//g, "."));
    }
  } catch {
    // Refmaps are best-effort evidence.
  }
  return [...targets].slice(0, 100);
}

// ---------------------------------------------------------------------------
// Artifact profile extraction
// ---------------------------------------------------------------------------

export function extractProfileFromJarBuffer(
  buf: Buffer,
  versionId: string,
  artifactId: string
): ArtifactProfileRecord {
  let entries: ZipEntry[];
  try {
    entries = parseZipEntries(buf);
  } catch {
    return emptyProfile(artifactId, versionId);
  }

  const mixinConfigFiles: string[] = [];
  const mixinTargets = new Set<string>();
  const classTargets: string[] = [];
  const resourceTargets: string[] = [];
  const embeddedLibraries: ArtifactProfileRecord["embeddedLibraries"] = [];
  const packageNamespaces = new Map<string, number>();
  const accessWidenerTargets = new Set<string>();
  const accessTransformerTargets = new Set<string>();
  const refmapTargets = new Set<string>();

  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;

    if (entry.name.endsWith(".class")) {
      const className = entry.name.replace(/\.class$/, "").replace(/\//g, ".");
      const namespace = className.split(".").slice(0, 3).join(".");
      if (namespace.split(".").length >= 3) {
        packageNamespaces.set(namespace, (packageNamespaces.get(namespace) ?? 0) + 1);
      }
      // Skip deeply-nested anonymous/synthetic classes to keep profiles concise
      if (classTargets.length < 300 && (className.split("$").length - 1) < 2) {
        classTargets.push(className);
      }
      try {
        const constants = extractUtf8ConstantsFromClass(readZipEntry(buf, entry));
        for (const target of extractMixinTargetsFromClassConstants(constants)) {
          mixinTargets.add(target);
        }
      } catch {
        // Broken class entries should not fail the whole profile.
      }
      continue;
    }

    if (entry.name.endsWith(".mixins.json")) {
      mixinConfigFiles.push(entry.name);
      try {
        const cfg = JSON.parse(readZipEntry(buf, entry).toString("utf8")) as {
          package?: string;
          mixins?: string[];
          client?: string[];
          server?: string[];
        };
        const pkg = cfg.package ? cfg.package + "." : "";
        for (const m of [...(cfg.mixins ?? []), ...(cfg.client ?? []), ...(cfg.server ?? [])]) {
          mixinTargets.add(pkg + m);
        }
      } catch { /* malformed config — skip */ }
      continue;
    }

    if (entry.name.endsWith(".refmap.json")) {
      try {
        for (const target of parseRefmapTargets(readZipEntry(buf, entry).toString("utf8"))) {
          refmapTargets.add(target);
          mixinTargets.add(target);
        }
      } catch { /* malformed refmap - skip */ }
      continue;
    }

    if (entry.name.endsWith(".accesswidener")) {
      try {
        for (const target of parseAccessWidenerTargets(readZipEntry(buf, entry).toString("utf8"))) {
          accessWidenerTargets.add(target);
        }
      } catch { /* malformed access widener - skip */ }
      continue;
    }

    if (entry.name.endsWith("accesstransformer.cfg") || entry.name.endsWith("_at.cfg")) {
      try {
        for (const target of parseAccessTransformerTargets(readZipEntry(buf, entry).toString("utf8"))) {
          accessTransformerTargets.add(target);
        }
      } catch { /* malformed access transformer - skip */ }
      continue;
    }

    // Fabric Jar-in-Jar: extract embedded library coordinates
    if (entry.name.startsWith("META-INF/jars/") && entry.name.endsWith(".jar")) {
      try {
        const embeddedBuf = readZipEntry(buf, entry);
        const embeddedEntries = parseZipEntries(embeddedBuf);

        const fabricEntry = embeddedEntries.find(e => e.name === "fabric.mod.json");
        const manifestEntry = embeddedEntries.find(e => e.name === "META-INF/MANIFEST.MF");

        let coordinates = "";
        let packageHints: string[] = [];

        if (fabricEntry) {
          const fabric = JSON.parse(readZipEntry(embeddedBuf, fabricEntry).toString("utf8")) as {
            id?: string; version?: string;
          };
          if (fabric.id && fabric.version) {
            coordinates = `${fabric.id}:${fabric.id}:${fabric.version}`;
            packageHints = [fabric.id];
          }
        } else if (manifestEntry) {
          const manifest = readZipEntry(embeddedBuf, manifestEntry).toString("utf8");
          const title = manifest.match(/^Implementation-Title:\s*(.+)$/m)?.[1]?.trim();
          const version = manifest.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim();
          if (title && version) {
            const group = title.includes(".") ? title.split(".").slice(0, 2).join(".") : title;
            coordinates = `${group}:${title}:${version}`;
            packageHints = [group];
          }
        }

        if (coordinates) embeddedLibraries.push({ coordinates, packageHints });
      } catch { /* unreadable embedded JAR — skip */ }
      continue;
    }

    // Resource files: exclude metadata/config files that aren't assets
    if (
      !entry.name.startsWith("META-INF/") &&
      !entry.name.endsWith(".json") &&
      !entry.name.endsWith(".toml") &&
      !entry.name.endsWith(".txt") &&
      !entry.name.endsWith(".md") &&
      resourceTargets.length < 500
    ) {
      resourceTargets.push(entry.name);
    }
  }

  return {
    artifactId,
    versionId,
    mixinConfigFiles,
    mixinTargets: [...mixinTargets],
    classTargets,
    resourceTargets,
    embeddedLibraries,
    packageNamespaces: [...packageNamespaces.entries()]
      .filter(([, count]) => count >= 1)
      .sort((left, right) => right[1] - left[1])
      .map(([namespace]) => namespace)
      .slice(0, 50),
    accessWidenerTargets: [...accessWidenerTargets],
    accessTransformerTargets: [...accessTransformerTargets],
    refmapTargets: [...refmapTargets]
  };
}

async function downloadAndExtractJar(
  downloadUrl: string,
  versionId: string,
  artifactId: string
): Promise<ArtifactProfileRecord> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`JAR download failed: HTTP ${response.status} for ${downloadUrl}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  return extractProfileFromJarBuffer(buf, versionId, artifactId);
}

// ---------------------------------------------------------------------------
// Cross-mod incompatibility detection helpers
// ---------------------------------------------------------------------------

export interface JarIncompatibilityFinding {
  projectA: string;
  projectB: string;
  conflictType:
    | "mixin_target_overlap"
    | "library_version_conflict"
    | "resource_path_conflict"
    | "class_path_collision"
    | "package_namespace_conflict"
    | "access_transform_overlap";
  details: string;
  confidence: number;
  evidence: string[];
}

/**
 * Strip Mixin prefix/suffix from a class's simple name to get the likely target class name.
 * Two mixin classes whose stripped names match are heuristically targeting the same class.
 */
function getMixinBaseName(mixinClass: string): string {
  const last = mixinClass.split(".").at(-1) ?? mixinClass;
  return last.replace(/^Mixin/i, "").replace(/Mixin$/i, "").toLowerCase();
}

function findMixinTargetOverlaps(
  profileA: ArtifactProfileRecord,
  profileB: ArtifactProfileRecord
): string[] {
  const baseNamesA = new Map<string, string>();
  for (const m of profileA.mixinTargets) {
    const base = getMixinBaseName(m);
    if (base.length > 3) baseNamesA.set(base, m);
  }

  const overlaps: string[] = [];
  for (const m of profileB.mixinTargets) {
    const base = getMixinBaseName(m);
    const matchA = baseNamesA.get(base);
    if (matchA && base.length > 3) {
      overlaps.push(`${matchA} ↔ ${m}`);
    }
  }
  return overlaps;
}

function findLibraryVersionConflicts(
  profileA: ArtifactProfileRecord,
  profileB: ArtifactProfileRecord
): Array<{ summary: string }> {
  const libsA = new Map<string, string>();
  for (const lib of profileA.embeddedLibraries) {
    const parts = lib.coordinates.split(":");
    if (parts.length >= 3) {
      libsA.set(`${parts[0]}:${parts[1]}`, parts[2] ?? "");
    }
  }

  const conflicts: Array<{ summary: string }> = [];
  for (const lib of profileB.embeddedLibraries) {
    const parts = lib.coordinates.split(":");
    if (parts.length >= 3) {
      const key = `${parts[0]}:${parts[1]}`;
      const versionA = libsA.get(key);
      const versionB = parts[2] ?? "";
      if (versionA !== undefined && versionA !== versionB) {
        conflicts.push({ summary: `${key}: ${versionA} vs ${versionB}` });
      }
    }
  }
  return conflicts;
}

function findResourcePathConflicts(
  profileA: ArtifactProfileRecord,
  profileB: ArtifactProfileRecord
): string[] {
  const setA = new Set(profileA.resourceTargets);
  return profileB.resourceTargets.filter((r) => setA.has(r));
}

const SHARED_PACKAGE_PREFIXES = [
  "com.google.",
  "com.mojang.",
  "com.electronwill.",
  "cpw.mods.",
  "it.unimi.",
  "javax.",
  "kotlin.",
  "net.minecraft.",
  "net.minecraftforge.",
  "org.apache.",
  "org.jetbrains.",
  "org.objectweb.",
  "org.slf4j.",
  "org.spongepowered."
];

function findPackageNamespaceConflicts(
  profileA: ArtifactProfileRecord,
  profileB: ArtifactProfileRecord
): string[] {
  const setA = new Set(
    (profileA.packageNamespaces ?? []).filter(
      (namespace) => !SHARED_PACKAGE_PREFIXES.some((prefix) => namespace.startsWith(prefix))
    )
  );
  return (profileB.packageNamespaces ?? []).filter((namespace) => setA.has(namespace));
}

function findAccessTransformOverlaps(
  profileA: ArtifactProfileRecord,
  profileB: ArtifactProfileRecord
): string[] {
  const leftTargets = new Set([
    ...(profileA.accessWidenerTargets ?? []),
    ...(profileA.accessTransformerTargets ?? [])
  ]);
  return [
    ...(profileB.accessWidenerTargets ?? []),
    ...(profileB.accessTransformerTargets ?? [])
  ].filter((target) => leftTargets.has(target));
}

// ---------------------------------------------------------------------------
// JarAnalysisService
// ---------------------------------------------------------------------------

export class JarAnalysisService {
  constructor(
    private readonly repository: InMemoryPlatformRepository,
    private readonly evidenceIngestion: EvidenceIngestionService
  ) {}

  async fetchAndIngestProfiles(versionIds: string[]): Promise<{
    analyzed: number;
    skipped: number;
    failed: number;
    failedVersionIds: string[];
  }> {
    let analyzed = 0;
    let skipped = 0;
    let failed = 0;
    const failedVersionIds: string[] = [];

    for (const versionId of versionIds) {
      if (this.repository.artifactProfiles.has(versionId)) {
        skipped++;
        continue;
      }

      const versionRecord = this.repository.canonicalVersions.get(versionId);
      if (!versionRecord?.primaryFileDownloadUrl) {
        skipped++;
        continue;
      }

      try {
        const profile = await downloadAndExtractJar(
          versionRecord.primaryFileDownloadUrl,
          versionId,
          createPlatformId("art")
        );
        this.evidenceIngestion.ingestArtifactProfile(profile);
        analyzed++;
      } catch {
        failed++;
        failedVersionIds.push(versionId);
      }
    }

    return { analyzed, skipped, failed, failedVersionIds };
  }

  /**
   * Compare all analyzed mod profiles pairwise and surface structural incompatibilities:
   * mixin target overlaps, class path collisions, bundled library version conflicts,
   * and resource file overrides. Pass projectIds to restrict the comparison set.
   */
  detectCrossModIncompatibilities(projectIds?: string[]): JarIncompatibilityFinding[] {
    const profilesByProject = new Map<string, ArtifactProfileRecord[]>();

    for (const [versionId, profile] of this.repository.artifactProfiles) {
      const version = this.repository.canonicalVersions.get(versionId);
      if (!version) continue;
      const list = profilesByProject.get(version.projectId) ?? [];
      list.push(profile);
      profilesByProject.set(version.projectId, list);
    }

    const targets = projectIds
      ? projectIds.filter((id) => profilesByProject.has(id))
      : [...profilesByProject.keys()];

    const findings: JarIncompatibilityFinding[] = [];

    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const projectA = targets[i]!;
        const projectB = targets[j]!;
        const profileA = profilesByProject.get(projectA)![0]!;
        const profileB = profilesByProject.get(projectB)![0]!;

        const mixinOverlaps = findMixinTargetOverlaps(profileA, profileB);
        if (mixinOverlaps.length > 0) {
          findings.push({
            projectA,
            projectB,
            conflictType: "mixin_target_overlap",
            details: `${mixinOverlaps.length} shared mixin target(s): ${mixinOverlaps.slice(0, 3).join(", ")}`,
            confidence: Math.min(0.85, 0.55 + mixinOverlaps.length * 0.05),
            evidence: mixinOverlaps.slice(0, 10)
          });
        }

        const classSetA = new Set(profileA.classTargets);
        const classCollisions = profileB.classTargets.filter((c) => classSetA.has(c));
        if (classCollisions.length > 0) {
          findings.push({
            projectA,
            projectB,
            conflictType: "class_path_collision",
            details: `${classCollisions.length} duplicate class definition(s): ${classCollisions.slice(0, 3).join(", ")}`,
            confidence: Math.min(0.90, 0.70 + classCollisions.length * 0.02),
            evidence: classCollisions.slice(0, 10)
          });
        }

        const libConflicts = findLibraryVersionConflicts(profileA, profileB);
        if (libConflicts.length > 0) {
          findings.push({
            projectA,
            projectB,
            conflictType: "library_version_conflict",
            details: `${libConflicts.length} bundled library version conflict(s): ${libConflicts.slice(0, 2).map((c) => c.summary).join(", ")}`,
            confidence: Math.min(0.80, 0.60 + libConflicts.length * 0.05),
            evidence: libConflicts.map((c) => c.summary).slice(0, 10)
          });
        }

        const resourceConflicts = findResourcePathConflicts(profileA, profileB);
        if (resourceConflicts.length > 0) {
          findings.push({
            projectA,
            projectB,
            conflictType: "resource_path_conflict",
            details: `${resourceConflicts.length} overlapping resource file(s): ${resourceConflicts.slice(0, 3).join(", ")}`,
            confidence: Math.min(0.65, 0.40 + resourceConflicts.length * 0.02),
            evidence: resourceConflicts.slice(0, 10)
          });
        }

        const packageConflicts = findPackageNamespaceConflicts(profileA, profileB);
        if (packageConflicts.length > 0) {
          findings.push({
            projectA,
            projectB,
            conflictType: "package_namespace_conflict",
            details: `${packageConflicts.length} overlapping non-platform package namespace(s): ${packageConflicts.slice(0, 3).join(", ")}`,
            confidence: Math.min(0.70, 0.55 + packageConflicts.length * 0.03),
            evidence: packageConflicts.slice(0, 10)
          });
        }

        const accessOverlaps = findAccessTransformOverlaps(profileA, profileB);
        if (accessOverlaps.length > 0) {
          findings.push({
            projectA,
            projectB,
            conflictType: "access_transform_overlap",
            details: `${accessOverlaps.length} shared access-widener/transformer target(s): ${accessOverlaps.slice(0, 3).join(", ")}`,
            confidence: Math.min(0.78, 0.62 + accessOverlaps.length * 0.04),
            evidence: accessOverlaps.slice(0, 10)
          });
        }
      }
    }

    return findings;
  }

  /**
   * Run detectCrossModIncompatibilities and convert high-confidence findings into
   * VerifiedRuleDefinition objects, ingesting them via the evidence service.
   */
  generateRulesFromJarAnalysis(projectIds?: string[]): VerifiedRuleDefinition[] {
    const findings = this.detectCrossModIncompatibilities(projectIds);
    const rules: VerifiedRuleDefinition[] = [];

    const conflictLabel: Record<JarIncompatibilityFinding["conflictType"], string> = {
      mixin_target_overlap: "mixin target overlap",
      library_version_conflict: "bundled library version conflict",
      resource_path_conflict: "resource path conflict",
      class_path_collision: "class path collision",
      package_namespace_conflict: "package namespace conflict",
      access_transform_overlap: "access transformer overlap"
    };

    for (const finding of findings) {
      if (finding.confidence < 0.60) continue;

      const rule: VerifiedRuleDefinition = {
        rule_id: `jar_${finding.conflictType}_${finding.projectA}_${finding.projectB}`,
        version: 1,
        title: `${finding.projectA} ↔ ${finding.projectB}: ${conflictLabel[finding.conflictType]}`,
        finding_type: `jar_${finding.conflictType}`,
        severity: finding.confidence >= 0.80 ? "high" : "medium",
        confidence: finding.confidence,
        reproducibility: "confirmed",
        summary: finding.details,
        recommended_actions: ["Verify compatibility manually", "Check for compatibility patches"],
        conditions: [
          { type: "project_present", project_id: finding.projectA },
          { type: "project_present", project_id: finding.projectB }
        ]
      };

      this.evidenceIngestion.ingestRuleDefinition(rule);
      rules.push(rule);
    }

    return rules;
  }
}
