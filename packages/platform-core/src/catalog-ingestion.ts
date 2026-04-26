import { createPlatformId } from "@modcompat/id-generation";
import { InMemoryPlatformRepository } from "./repository.js";
import type {
  CanonicalProjectRecord,
  CanonicalVersionRecord,
  IncompatibilityRecord
} from "./types.js";

export interface IngestProjectInput {
  projectId?: string;
  slug: string;
  displayName: string;
  aliases?: string[];
  recommendedReplacementProjectIds?: string[];
}

export interface IngestVersionInput {
  versionId?: string;
  projectId: string;
  versionLabel: string;
  loaders: string[];
  minecraftVersions: string[];
  javaVersions?: string[];
  primaryFileDownloadUrl?: string;
  releaseDate?: string;
}

export interface IngestSourceMappingInput {
  externalKey: string;
  sourceName: string;
  sourceProjectId: string;
  canonicalProjectId: string;
  canonicalVersionId?: string;
}

export interface IngestIncompatibilityInput {
  versionId: string;
  incompatibleProjectId: string;
  reason: string;
}

export interface BulkIngestPayload {
  projects?: IngestProjectInput[];
  versions?: IngestVersionInput[];
  sourceMappings?: IngestSourceMappingInput[];
  incompatibilities?: IngestIncompatibilityInput[];
}

export interface BulkIngestResult {
  projectsUpserted: number;
  versionsUpserted: number;
  sourceMappingsUpserted: number;
  incompatibilitiesAdded: number;
}

export class CatalogIngestionService {
  constructor(private readonly repository: InMemoryPlatformRepository) {}

  ingestProject(input: IngestProjectInput): CanonicalProjectRecord {
    const projectId =
      input.projectId ??
      // Re-use existing record if slug already maps to one
      [...this.repository.canonicalProjects.values()].find((p) => p.slug === input.slug)
        ?.projectId ??
      createPlatformId("cp");

    const record: CanonicalProjectRecord = {
      projectId,
      slug: input.slug,
      displayName: input.displayName,
      aliases: input.aliases ?? [],
      recommendedReplacementProjectIds: input.recommendedReplacementProjectIds
    };

    this.repository.canonicalProjects.set(projectId, record);
    return record;
  }

  ingestVersion(input: IngestVersionInput): CanonicalVersionRecord {
    const existing = [...this.repository.canonicalVersions.values()].find(
      (v) => v.projectId === input.projectId && v.versionLabel === input.versionLabel
    );

    const versionId = input.versionId ?? existing?.versionId ?? createPlatformId("ver");

    const record: CanonicalVersionRecord = {
      versionId,
      projectId: input.projectId,
      versionLabel: input.versionLabel,
      loaders: input.loaders,
      minecraftVersions: input.minecraftVersions,
      javaVersions: input.javaVersions ?? ["21"],
      primaryFileDownloadUrl: input.primaryFileDownloadUrl ?? existing?.primaryFileDownloadUrl,
      releaseDate: input.releaseDate ?? existing?.releaseDate
    };

    this.repository.canonicalVersions.set(versionId, record);

    if (record.primaryFileDownloadUrl && !this.repository.artifactProfiles.has(versionId)) {
      const alreadyQueued = this.repository.pendingArtifactAnalysisQueue.includes(versionId);
      if (!alreadyQueued) {
        this.repository.pendingArtifactAnalysisQueue.push(versionId);
      }
    }

    return record;
  }

  ingestSourceMapping(input: IngestSourceMappingInput): void {
    this.repository.sourceMappings.set(input.externalKey, {
      sourceName: input.sourceName,
      sourceProjectId: input.sourceProjectId,
      canonicalProjectId: input.canonicalProjectId,
      canonicalVersionId: input.canonicalVersionId
    });
  }

  ingestIncompatibility(input: IngestIncompatibilityInput): void {
    const alreadyExists = this.repository.incompatibilities.some(
      (r) =>
        r.versionId === input.versionId &&
        r.incompatibleProjectId === input.incompatibleProjectId
    );
    if (alreadyExists) return;

    const record: IncompatibilityRecord = {
      versionId: input.versionId,
      incompatibleProjectId: input.incompatibleProjectId,
      reason: input.reason
    };

    this.repository.incompatibilities.push(record);
  }

  bulkIngest(payload: BulkIngestPayload): BulkIngestResult {
    let projectsUpserted = 0;
    let versionsUpserted = 0;
    let sourceMappingsUpserted = 0;
    let incompatibilitiesAdded = 0;

    for (const p of payload.projects ?? []) {
      this.ingestProject(p);
      projectsUpserted++;
    }

    for (const v of payload.versions ?? []) {
      this.ingestVersion(v);
      versionsUpserted++;
    }

    for (const m of payload.sourceMappings ?? []) {
      this.ingestSourceMapping(m);
      sourceMappingsUpserted++;
    }

    const beforeCount = this.repository.incompatibilities.length;
    for (const i of payload.incompatibilities ?? []) {
      this.ingestIncompatibility(i);
    }
    incompatibilitiesAdded = this.repository.incompatibilities.length - beforeCount;

    return { projectsUpserted, versionsUpserted, sourceMappingsUpserted, incompatibilitiesAdded };
  }
}
