import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlatformId } from "@modcompat/id-generation";
import type {
  ConfidenceInput,
  EvidenceCurationRecord,
  EvidenceDocument,
  EvidenceRef,
  EvidenceSearchDocument,
  EvidenceSearchHit,
  EvidenceSnippet,
  ExtractedEntity,
  ExtractedRelation,
  FindingProvenance,
  RawPayloadRecord,
  SourceConnector,
  SourceSyncRun
} from "@modcompat/domain-models";
import type { Finding } from "@modcompat/api-contracts";
import { now, stableHash } from "./helpers.js";
import { InMemoryPlatformRepository } from "./repository.js";
import type {
  CreateEvidenceCurationInput,
  EvidenceFixtureRecord,
  EvidenceFixtureSet,
  EvidenceSearchInput,
  EvidenceSearchResult,
  EvidenceSyncResult,
  FindingEvidenceLookup,
  PromotionResult,
  PromoteVerifiedRuleInput,
  VerifiedRuleDefinition
} from "./types.js";

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
}

function loadEvidenceFixtures(): EvidenceFixtureSet {
  return JSON.parse(
    readFileSync(resolve(repoRoot(), "fixtures/evidence/phase3-evidence-fixtures.json"), "utf8")
  ) as EvidenceFixtureSet;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_.+]+/g)
    .filter((token) => token.length > 1);
}

function averageConfidence(inputs: ConfidenceInput[]): number {
  if (inputs.length === 0) {
    return 0;
  }

  const totalWeight = inputs.reduce((sum, input) => sum + input.weight, 0);
  const weighted = inputs.reduce((sum, input) => sum + input.value * input.weight, 0);
  return Number((weighted / totalWeight).toFixed(4));
}

function evidenceRefFromHit(hit: EvidenceSearchHit): EvidenceRef {
  return {
    type: hit.document.snippetId ? "evidence_snippet" : "evidence_document",
    id: hit.document.documentId,
    snippetId: hit.document.snippetId
  };
}

function provenanceFromHit(hit: EvidenceSearchHit): FindingProvenance {
  return {
    kind: "evidence",
    sourceId: hit.document.id,
    sourceType: hit.document.index,
    note: hit.document.title
  };
}

function confidenceFromHit(hit: EvidenceSearchHit): ConfidenceInput {
  return {
    source: "evidence",
    value: Number(
      Math.min(
        1,
        hit.document.trustScore * 0.65 +
          hit.document.recencyScore * 0.2 +
          (hit.document.relevance === "direct" ? 0.15 : 0.05)
      ).toFixed(4)
    ),
    weight: 0.6,
    rationale: `Evidence hit "${hit.document.title}" matched the finding query and subjects.`
  };
}

export class EvidenceService {
  private readonly fixtures = loadEvidenceFixtures();

  constructor(private readonly repository: InMemoryPlatformRepository) {}

  syncFixtures(connectorNames?: string[]): EvidenceSyncResult {
    const selected = this.fixtures.connectors.filter(
      (connector) =>
        !connectorNames || connectorNames.length === 0 || connectorNames.includes(connector.connectorName)
    );
    const runs: SourceSyncRun[] = [];
    const rawPayloads: RawPayloadRecord[] = [];
    const documents: EvidenceDocument[] = [];
    const snippets: EvidenceSnippet[] = [];

    for (const fixtureConnector of selected) {
      const connector = this.repository.sourceConnectorsByName.get(fixtureConnector.connectorName);

      if (!connector) {
        continue;
      }

      const startedAt = now();
      const run: SourceSyncRun = {
        syncRunId: createPlatformId("esr"),
        connectorId: connector.connectorId,
        status: "running",
        startedAt,
        stats: {
          rawPayloadCount: 0,
          documentCount: 0,
          snippetCount: 0,
          contradictionCount: 0,
          supersessionCount: 0
        },
        checkpoint: {
          connectorName: fixtureConnector.connectorName,
          fixtureRecordCount: fixtureConnector.records.length
        },
        schemaVersion: 1,
        createdAt: startedAt
      };
      this.repository.sourceSyncRuns.set(run.syncRunId, run);

      for (const record of fixtureConnector.records) {
        const externalKey = `${fixtureConnector.connectorName}:${record.externalDocumentId}`;
        if (this.repository.evidenceDocumentsByExternalRef.has(externalKey)) {
          continue;
        }

        const rawPayload: RawPayloadRecord = {
          rawPayloadId: createPlatformId("raw"),
          connectorId: connector.connectorId,
          syncRunId: run.syncRunId,
          externalDocumentId: record.externalDocumentId,
          contentType: "application/json",
          checksum: stableHash(record),
          body: record as unknown as Record<string, unknown>,
          fetchedAt: now(),
          schemaVersion: 1,
          createdAt: now()
        };
        this.repository.rawPayloads.set(rawPayload.rawPayloadId, rawPayload);
        rawPayloads.push(rawPayload);
        run.stats.rawPayloadCount += 1;

        const document = this.normalizeDocument(connector, run, rawPayload, record);
        this.repository.evidenceDocuments.set(document.documentId, document);
        this.repository.evidenceDocumentsByExternalRef.set(externalKey, document.documentId);
        documents.push(document);
        run.stats.documentCount += 1;

        const documentSnippets = this.normalizeSnippets(document, record);
        for (const snippet of documentSnippets) {
          this.repository.evidenceSnippets.set(snippet.snippetId, snippet);
          snippets.push(snippet);
        }
        run.stats.snippetCount += documentSnippets.length;
      }

      this.applyDocumentRelations(fixtureConnector.connectorName, fixtureConnector.records, run);
      this.rebuildSearchDocuments();

      const completedRun: SourceSyncRun = {
        ...run,
        status: "completed",
        finishedAt: now()
      };
      this.repository.sourceSyncRuns.set(completedRun.syncRunId, completedRun);
      runs.push(completedRun);
    }

    return {
      connectors: selected
        .map((connector) => this.repository.sourceConnectorsByName.get(connector.connectorName))
        .filter((connector): connector is SourceConnector => Boolean(connector)),
      runs,
      rawPayloads,
      documents,
      snippets
    };
  }

  search(input: EvidenceSearchInput): EvidenceSearchResult {
    const derived = this.deriveSearchContext(input);
    const limit = input.limit ?? 10;
    const queryTokens = new Set(tokenize(derived.query));
    const projectIds = new Set(derived.projectIds);
    const findingTypes = new Set(derived.findingTypes);

    const hits = [...this.repository.evidenceSearchDocuments.values()]
      .filter((document) => {
        if (!input.includeContradicted && document.contradictedByDocumentIds.length > 0) {
          return false;
        }
        if (!input.includeSuperseded && document.supersededByDocumentId) {
          return false;
        }
        if (projectIds.size > 0 && !document.relatedProjectIds.some((projectId) => projectIds.has(projectId))) {
          return false;
        }
        if (findingTypes.size > 0 && !document.findingTypes.some((findingType) => findingTypes.has(findingType))) {
          return false;
        }
        if (queryTokens.size === 0) {
          return true;
        }
        const textTokens = new Set(tokenize(`${document.title} ${document.text}`));
        return [...queryTokens].some((token) => textTokens.has(token));
      })
      .map((document) => ({
        score: this.scoreDocument(document, queryTokens, projectIds, findingTypes),
        document
      }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.document.publishedAt.localeCompare(right.document.publishedAt))
      .slice(0, limit);

    return {
      total: hits.length,
      hits
    };
  }

  getFindingEvidence(analysisId: string, findingId: string, limit = 5): FindingEvidenceLookup {
    const analysis = this.repository.analyses.get(analysisId);
    const finding = analysis?.findings.find((item) => item.findingId === findingId);

    if (!finding) {
      throw new Error(`Finding not found: ${analysisId}/${findingId}`);
    }

    return {
      analysisId,
      findingId,
      hits: this.search({
        analysisId,
        findingId,
        query: [finding.title, finding.summary].filter(Boolean).join(" "),
        projectIds: finding.subjects.map((subject) => subject.projectId),
        findingTypes: [finding.type],
        limit
      }).hits
    };
  }

  enrichFindings(analysisId: string, findings: Finding[]): { bundleId: string; findings: Finding[] } {
    const enriched = findings.map((finding) => {
      const hits = this.search({
        analysisId,
        findingId: finding.findingId,
        query: [finding.title, finding.summary, finding.explanation].filter(Boolean).join(" "),
        projectIds: finding.subjects.map((subject) => subject.projectId),
        findingTypes: [finding.type],
        limit: 3
      }).hits;

      if (hits.length === 0) {
        return finding;
      }

      const appendedEvidence = [
        ...finding.evidence,
        ...hits.map((hit) => evidenceRefFromHit(hit))
      ];
      const uniqueEvidence = new Map(
        appendedEvidence.map((evidence) => [`${evidence.type}:${evidence.id}:${evidence.snippetId ?? ""}`, evidence])
      );
      const provenance = [...(finding.provenance ?? []), ...hits.map((hit) => provenanceFromHit(hit))];
      const confidenceInputs = [
        ...(finding.confidenceInputs ?? []),
        ...hits.map((hit) => confidenceFromHit(hit))
      ];
      const explanationTail = hits
        .map((hit) => `${hit.document.title} (${hit.document.trustTier}, score ${hit.score.toFixed(3)})`)
        .join("; ");

      return {
        ...finding,
        evidence: [...uniqueEvidence.values()],
        provenance,
        confidenceInputs,
        confidence: averageConfidence(
          confidenceInputs.length > 0
            ? confidenceInputs
            : [
                {
                  source: "resolver",
                  value: finding.confidence,
                  weight: 1,
                  rationale: "Base finding confidence."
                }
              ]
        ),
        explanation: `${finding.explanation ?? finding.summary ?? ""} Evidence context: ${explanationTail}`.trim()
      };
    });

    return {
      bundleId: createPlatformId("ebd"),
      findings: enriched
    };
  }

  createCuration(input: CreateEvidenceCurationInput): EvidenceCurationRecord {
    const ruleId = `rule_${slugify(input.findingType)}_${slugify(input.title)}`;
    const ruleDraft: VerifiedRuleDefinition = {
      rule_id: ruleId,
      version: 1,
      title: input.title,
      finding_type: input.findingType,
      severity: input.severity,
      confidence: 0.88,
      reproducibility: "likely",
      summary: input.summary,
      recommended_actions: ["Review the implicated project set and apply the promoted mitigation."],
      conditions: input.subjectProjectIds.map((projectId) => ({
        type: "project_present" as const,
        project_id: projectId
      }))
    };

    const curation: EvidenceCurationRecord = {
      curationId: createPlatformId("cur"),
      title: input.title,
      findingType: input.findingType,
      severity: input.severity,
      summary: input.summary,
      subjectProjectIds: input.subjectProjectIds,
      evidenceDocumentIds: input.evidenceDocumentIds,
      evidenceSnippetIds: input.evidenceSnippetIds ?? [],
      ruleDraft: ruleDraft as unknown as Record<string, unknown>,
      status: "draft",
      createdBy: input.createdBy,
      schemaVersion: 1,
      createdAt: now()
    };

    this.repository.evidenceCurations.set(curation.curationId, curation);
    return curation;
  }

  promoteVerifiedRule(input: PromoteVerifiedRuleInput): PromotionResult {
    const curation = this.repository.evidenceCurations.get(input.curationId);

    if (!curation) {
      throw new Error(`Evidence curation not found: ${input.curationId}`);
    }

    const draft = curation.ruleDraft as unknown as VerifiedRuleDefinition;
    const existing = this.repository.verifiedRules.find((rule) => rule.rule_id === draft.rule_id);
    const version = (existing?.version ?? 0) + 1;
    const rule: VerifiedRuleDefinition = {
      ...draft,
      version
    };

    if (existing) {
      const index = this.repository.verifiedRules.indexOf(existing);
      this.repository.verifiedRules.splice(index, 1, rule);
    } else {
      this.repository.verifiedRules.push(rule);
    }

    const promoted: EvidenceCurationRecord = {
      ...curation,
      status: "promoted",
      promotedRuleId: rule.rule_id,
      promotedAt: now()
    };
    this.repository.evidenceCurations.set(promoted.curationId, promoted);

    return {
      curation: promoted,
      rule: {
        ruleId: rule.rule_id,
        version: rule.version
      }
    };
  }

  private deriveSearchContext(input: EvidenceSearchInput): {
    query: string;
    projectIds: string[];
    findingTypes: string[];
  } {
    if (input.analysisId && input.findingId) {
      const analysis = this.repository.analyses.get(input.analysisId);
      const finding = analysis?.findings.find((item) => item.findingId === input.findingId);

      if (finding) {
        return {
          query: input.query ?? [finding.title, finding.summary, finding.explanation].filter(Boolean).join(" "),
          projectIds: input.projectIds ?? finding.subjects.map((subject) => subject.projectId),
          findingTypes: input.findingTypes ?? [finding.type]
        };
      }
    }

    return {
      query: input.query ?? "",
      projectIds: input.projectIds ?? [],
      findingTypes: input.findingTypes ?? []
    };
  }

  private scoreDocument(
    document: EvidenceSearchDocument,
    queryTokens: Set<string>,
    projectIds: Set<string>,
    findingTypes: Set<string>
  ): number {
    const textTokens = new Set(tokenize(`${document.title} ${document.text}`));
    const tokenMatches = [...queryTokens].filter((token) => textTokens.has(token)).length;
    const lexicalScore = queryTokens.size > 0 ? tokenMatches / queryTokens.size : 0.4;
    const projectBoost =
      projectIds.size > 0 && document.relatedProjectIds.some((projectId) => projectIds.has(projectId))
        ? 0.25
        : 0;
    const findingBoost =
      findingTypes.size > 0 && document.findingTypes.some((findingType) => findingTypes.has(findingType))
        ? 0.2
        : 0;
    const stanceBoost = document.stance === "supports" ? 0.1 : document.stance === "neutral" ? 0.03 : 0;

    return Number(
      (
        lexicalScore +
        document.trustScore * 0.35 +
        document.recencyScore * 0.15 +
        projectBoost +
        findingBoost +
        stanceBoost
      ).toFixed(4)
    );
  }

  private normalizeDocument(
    connector: SourceConnector,
    run: SourceSyncRun,
    rawPayload: RawPayloadRecord,
    record: EvidenceFixtureRecord
  ): EvidenceDocument {
    const aliases = [...this.repository.canonicalProjects.values()].flatMap((project) =>
      [project.slug, project.displayName, ...project.aliases].map((value) => ({
        value: value.toLowerCase(),
        projectId: project.projectId
      }))
    );
    const inferredProjects = aliases
      .filter((alias) => record.body.toLowerCase().includes(alias.value) || record.title.toLowerCase().includes(alias.value))
      .map((alias) => alias.projectId);
    const relatedProjectIds = [...new Set([...(record.relatedProjectIds ?? []), ...inferredProjects])];
    const extractedEntities: ExtractedEntity[] = [
      ...relatedProjectIds.map((projectId) => ({
        entityType: "project" as const,
        value: projectId,
        confidence: 0.98
      })),
      ...(record.relatedVersionIds ?? []).map((versionId) => ({
        entityType: "version" as const,
        value: versionId,
        confidence: 0.95
      }))
    ];
    const extractedRelations: ExtractedRelation[] = (record.extractedRelations ?? []).map((relation) => ({
      relationType: relation.relationType,
      subject: relation.subject,
      object: relation.object,
      confidence: relation.confidence ?? 0.9
    }));
    const trustSignals =
      connector.connectorName === "github"
        ? ["maintainer-thread", "direct-issue-tracking"]
        : ["curated-source", "community-corroborated"];
    const trustScore = connector.connectorName === "github" ? 0.84 : 0.72;
    const recencyScore = Number(
      Math.max(
        0.25,
        1 - (Date.now() - Date.parse(record.publishedAt)) / (1000 * 60 * 60 * 24 * 365 * 4)
      ).toFixed(4)
    );
    const clusterId = stableHash({
      title: slugify(record.title.replace(/\b(closed|resolved|updated)\b/gi, "")),
      relatedProjectIds: relatedProjectIds.slice().sort(),
      findingTypes: (record.findingTypes ?? []).slice().sort()
    }).slice(0, 16);
    const stance = record.relationHints?.some((relation) => relation.type === "contradicts")
      ? "contradicts"
      : "supports";
    const relevance =
      relatedProjectIds.length > 0 || (record.findingTypes?.length ?? 0) > 0 ? "direct" : "supporting";

    return {
      documentId: createPlatformId("evd"),
      connectorId: connector.connectorId,
      syncRunId: run.syncRunId,
      rawPayloadId: rawPayload.rawPayloadId,
      externalDocumentId: record.externalDocumentId,
      kind: record.kind,
      title: record.title,
      sourceUrl: record.sourceUrl,
      author: record.author,
      publishedAt: record.publishedAt,
      updatedAt: record.updatedAt,
      harvestedAt: now(),
      trust: {
        tier: connector.trustTier,
        score: trustScore,
        signals: trustSignals
      },
      recencyScore,
      relevance,
      stance,
      summary: record.snippets?.[0]?.text ?? record.body.slice(0, 240),
      content: record.body,
      tags: record.tags ?? [],
      relatedProjectIds,
      relatedVersionIds: record.relatedVersionIds ?? [],
      findingTypes: record.findingTypes ?? [],
      extractedEntities,
      extractedRelations,
      provenance: {
        connectorName: connector.connectorName,
        syncRunId: run.syncRunId,
        externalDocumentId: record.externalDocumentId,
        rawPayloadId: rawPayload.rawPayloadId
      },
      clusterId,
      duplicateDocumentIds: [],
      contradictedByDocumentIds: [],
      schemaVersion: 1,
      createdAt: now()
    };
  }

  private normalizeSnippets(document: EvidenceDocument, record: EvidenceFixtureRecord): EvidenceSnippet[] {
    const snippets = record.snippets ?? [{ kind: "summary" as const, text: record.body.slice(0, 260) }];

    return snippets.map((snippet) => ({
      snippetId: createPlatformId("snp"),
      documentId: document.documentId,
      kind: snippet.kind,
      text: snippet.text,
      textHash: stableHash(snippet.text),
      relevance: document.relevance,
      stance: document.stance,
      trustScore: document.trust.score,
      relatedProjectIds: document.relatedProjectIds,
      relatedVersionIds: document.relatedVersionIds,
      extractedEntities: document.extractedEntities,
      extractedRelations: document.extractedRelations,
      contradictionDocumentIds: [],
      supersededByDocumentId: undefined,
      schemaVersion: 1,
      createdAt: now()
    }));
  }

  private applyDocumentRelations(
    connectorName: string,
    records: EvidenceFixtureRecord[],
    run: SourceSyncRun
  ) {
    const byCluster = new Map<string, EvidenceDocument[]>();

    for (const document of this.repository.evidenceDocuments.values()) {
      const items = byCluster.get(document.clusterId) ?? [];
      items.push(document);
      byCluster.set(document.clusterId, items);
    }

    for (const documents of byCluster.values()) {
      if (documents.length < 2) {
        continue;
      }
      const duplicateIds = documents.map((document) => document.documentId);
      for (const document of documents) {
        this.repository.evidenceDocuments.set(document.documentId, {
          ...document,
          duplicateDocumentIds: duplicateIds.filter((documentId) => documentId !== document.documentId)
        });
      }
    }

    for (const record of records) {
      const sourceKey = `${connectorName}:${record.externalDocumentId}`;
      const documentId = this.repository.evidenceDocumentsByExternalRef.get(sourceKey);

      if (!documentId) {
        continue;
      }

      const document = this.repository.evidenceDocuments.get(documentId);

      if (!document) {
        continue;
      }

      let contradictedByDocumentIds = [...document.contradictedByDocumentIds];
      let supersededByDocumentId = document.supersededByDocumentId;

      for (const relation of record.relationHints ?? []) {
        const targetDocumentId = this.repository.evidenceDocumentsByExternalRef.get(
          `${connectorName}:${relation.targetExternalDocumentId}`
        );

        if (!targetDocumentId) {
          continue;
        }

        if (relation.type === "contradicts") {
          contradictedByDocumentIds = [...new Set([...contradictedByDocumentIds, targetDocumentId])];
          run.stats.contradictionCount += 1;
        }

        if (relation.type === "supersedes") {
          const target = this.repository.evidenceDocuments.get(targetDocumentId);

          if (target) {
            this.repository.evidenceDocuments.set(targetDocumentId, {
              ...target,
              supersededByDocumentId: document.documentId
            });
            supersededByDocumentId = document.supersededByDocumentId;
            run.stats.supersessionCount += 1;
          }
        }
      }

      this.repository.evidenceDocuments.set(document.documentId, {
        ...document,
        contradictedByDocumentIds,
        supersededByDocumentId
      });
    }
  }

  private rebuildSearchDocuments() {
    this.repository.evidenceSearchDocuments.clear();

    for (const document of this.repository.evidenceDocuments.values()) {
      const searchDocument: EvidenceSearchDocument = {
        index: "evidence-documents",
        id: document.documentId,
        documentId: document.documentId,
        title: document.title,
        text: document.content,
        connectorId: document.connectorId,
        trustTier: document.trust.tier,
        trustScore: document.trust.score,
        recencyScore: document.recencyScore,
        relevance: document.relevance,
        stance: document.stance,
        findingTypes: document.findingTypes,
        relatedProjectIds: document.relatedProjectIds,
        relatedVersionIds: document.relatedVersionIds,
        clusterId: document.clusterId,
        contradictedByDocumentIds: document.contradictedByDocumentIds,
        supersededByDocumentId: document.supersededByDocumentId,
        sourceUrl: document.sourceUrl,
        publishedAt: document.publishedAt
      };
      this.repository.evidenceSearchDocuments.set(searchDocument.id, searchDocument);
    }

    for (const snippet of this.repository.evidenceSnippets.values()) {
      const document = this.repository.evidenceDocuments.get(snippet.documentId);

      if (!document) {
        continue;
      }

      const searchDocument: EvidenceSearchDocument = {
        index: "evidence-snippets",
        id: snippet.snippetId,
        documentId: document.documentId,
        snippetId: snippet.snippetId,
        title: document.title,
        text: snippet.text,
        connectorId: document.connectorId,
        trustTier: document.trust.tier,
        trustScore: snippet.trustScore,
        recencyScore: document.recencyScore,
        relevance: snippet.relevance,
        stance: snippet.stance,
        findingTypes: document.findingTypes,
        relatedProjectIds: snippet.relatedProjectIds,
        relatedVersionIds: snippet.relatedVersionIds,
        clusterId: document.clusterId,
        contradictedByDocumentIds: document.contradictedByDocumentIds,
        supersededByDocumentId: document.supersededByDocumentId,
        sourceUrl: document.sourceUrl,
        publishedAt: document.publishedAt
      };
      this.repository.evidenceSearchDocuments.set(searchDocument.id, searchDocument);
    }
  }
}
