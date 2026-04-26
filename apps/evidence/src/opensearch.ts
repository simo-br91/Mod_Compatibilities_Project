import type {
  EvidenceDocument,
  EvidenceSearchDocument,
  EvidenceSearchHit,
  EvidenceSnippet
} from "@modcompat/domain-models";
import type {
  EvidenceSearchInput,
  EvidenceSearchResult,
  EvidenceSyncResult
} from "@modcompat/platform-core";

interface OpenSearchHit {
  _index: string;
  _score: number | null;
  _source: Record<string, unknown>;
}

interface OpenSearchSearchResponse {
  hits: {
    total: { value: number } | number;
    hits: OpenSearchHit[];
  };
}

const INDEX_DEFINITIONS: Array<{
  name: EvidenceSearchDocument["index"];
  mappings: Record<string, unknown>;
}> = [
  {
    name: "evidence-documents",
    mappings: {
      properties: {
        index: { type: "keyword" },
        id: { type: "keyword" },
        documentId: { type: "keyword" },
        snippetId: { type: "keyword" },
        title: { type: "text" },
        text: { type: "text" },
        connectorId: { type: "keyword" },
        trustTier: { type: "keyword" },
        trustScore: { type: "float" },
        recencyScore: { type: "float" },
        relevance: { type: "keyword" },
        stance: { type: "keyword" },
        findingTypes: { type: "keyword" },
        relatedProjectIds: { type: "keyword" },
        relatedVersionIds: { type: "keyword" },
        clusterId: { type: "keyword" },
        contradictedByDocumentIds: { type: "keyword" },
        supersededByDocumentId: { type: "keyword" },
        sourceUrl: { type: "keyword", ignore_above: 2048 },
        publishedAt: { type: "date" }
      }
    }
  },
  {
    name: "evidence-snippets",
    mappings: {
      properties: {
        index: { type: "keyword" },
        id: { type: "keyword" },
        documentId: { type: "keyword" },
        snippetId: { type: "keyword" },
        title: { type: "text" },
        text: { type: "text" },
        connectorId: { type: "keyword" },
        trustTier: { type: "keyword" },
        trustScore: { type: "float" },
        recencyScore: { type: "float" },
        relevance: { type: "keyword" },
        stance: { type: "keyword" },
        findingTypes: { type: "keyword" },
        relatedProjectIds: { type: "keyword" },
        relatedVersionIds: { type: "keyword" },
        clusterId: { type: "keyword" },
        contradictedByDocumentIds: { type: "keyword" },
        supersededByDocumentId: { type: "keyword" },
        sourceUrl: { type: "keyword", ignore_above: 2048 },
        publishedAt: { type: "date" }
      }
    }
  }
];

export class OpenSearchEvidenceStore {
  private ensured = false;

  constructor(
    private readonly baseUrl: string,
    private readonly auth?: { username: string; password: string }
  ) {}

  async ensureIndices() {
    if (this.ensured) {
      return;
    }

    for (const definition of INDEX_DEFINITIONS) {
      const existing = await fetch(new URL(`/${definition.name}`, this.baseUrl), {
        method: "HEAD",
        headers: this.buildHeaders()
      });

      if (existing.ok) {
        continue;
      }

      if (existing.status !== 404) {
        throw new Error(
          `OpenSearch index probe failed for ${definition.name}: ${existing.status} ${existing.statusText}`
        );
      }

      const response = await fetch(new URL(`/${definition.name}`, this.baseUrl), {
        method: "PUT",
        headers: {
          ...this.buildHeaders(),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          settings: {
            index: {
              number_of_shards: 1,
              number_of_replicas: 0
            }
          },
          mappings: definition.mappings
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `OpenSearch index creation failed for ${definition.name}: ${response.status} ${response.statusText}: ${text}`
        );
      }
    }

    this.ensured = true;
  }

  async indexSyncResult(syncResult: EvidenceSyncResult) {
    const searchDocuments = buildSearchDocuments(syncResult);
    if (searchDocuments.length === 0) {
      return;
    }

    await this.ensureIndices();

    const bulkPayload = searchDocuments
      .flatMap((document) => [
        JSON.stringify({ index: { _index: document.index, _id: document.id } }),
        JSON.stringify(document)
      ])
      .join("\n");

    const response = await fetch(new URL("/_bulk?refresh=true", this.baseUrl), {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "content-type": "application/x-ndjson"
      },
      body: `${bulkPayload}\n`
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OpenSearch bulk index failed: ${response.status} ${response.statusText}: ${text}`
      );
    }
  }

  async search(input: EvidenceSearchInput): Promise<EvidenceSearchResult> {
    await this.ensureIndices();

    const must: Record<string, unknown>[] = [];
    const filter: Record<string, unknown>[] = [];
    const mustNot: Record<string, unknown>[] = [];

    if (input.query?.trim()) {
      must.push({
        simple_query_string: {
          query: input.query.trim(),
          fields: ["title^2", "text"],
          default_operator: "and",
          lenient: true
        }
      });
    }

    if (input.projectIds && input.projectIds.length > 0) {
      filter.push({
        terms: {
          relatedProjectIds: input.projectIds
        }
      });
    }

    if (input.findingTypes && input.findingTypes.length > 0) {
      filter.push({
        terms: {
          findingTypes: input.findingTypes
        }
      });
    }

    if (!input.includeContradicted) {
      mustNot.push({
        exists: {
          field: "contradictedByDocumentIds"
        }
      });
    }

    if (!input.includeSuperseded) {
      mustNot.push({
        exists: {
          field: "supersededByDocumentId"
        }
      });
    }

    const response = await fetch(
      new URL("/evidence-documents,evidence-snippets/_search", this.baseUrl),
      {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          size: input.limit ?? 10,
          query: {
            bool: {
              must: must.length > 0 ? must : [{ match_all: {} }],
              filter,
              must_not: mustNot
            }
          },
          sort: [{ _score: "desc" }, { publishedAt: "desc" }]
        })
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OpenSearch search failed: ${response.status} ${response.statusText}: ${text}`
      );
    }

    const payload = (await response.json()) as OpenSearchSearchResponse;
    const hits: EvidenceSearchHit[] = payload.hits.hits.map((hit) => ({
      score: hit._score ?? 0,
      document: hydrateSearchDocument(hit)
    }));

    return {
      total:
        typeof payload.hits.total === "number"
          ? payload.hits.total
          : payload.hits.total.value,
      hits
    };
  }

  private buildHeaders() {
    const headers: Record<string, string> = {
      accept: "application/json"
    };

    if (this.auth) {
      headers.authorization = `Basic ${Buffer.from(
        `${this.auth.username}:${this.auth.password}`
      ).toString("base64")}`;
    }

    return headers;
  }
}

function buildSearchDocuments(syncResult: EvidenceSyncResult): EvidenceSearchDocument[] {
  const documentsById = new Map<string, EvidenceDocument>(
    syncResult.documents.map((document) => [document.documentId, document])
  );

  const documents = syncResult.documents.map((document) => ({
    index: "evidence-documents" as const,
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
  }));

  const snippets = syncResult.snippets.flatMap((snippet) => {
    const document = documentsById.get(snippet.documentId);
    if (!document) {
      return [];
    }

    return [
      {
        index: "evidence-snippets" as const,
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
      }
    ];
  });

  return [...documents, ...snippets];
}

function hydrateSearchDocument(hit: OpenSearchHit): EvidenceSearchDocument {
  const source = hit._source;

  return {
    index:
      source.index === "evidence-snippets" ? "evidence-snippets" : "evidence-documents",
    id: String(source.id ?? ""),
    documentId: String(source.documentId ?? ""),
    snippetId:
      typeof source.snippetId === "string" && source.snippetId.length > 0
        ? source.snippetId
        : undefined,
    title: String(source.title ?? ""),
    text: String(source.text ?? ""),
    connectorId: String(source.connectorId ?? ""),
    trustTier:
      source.trustTier === "official" ||
      source.trustTier === "maintainer" ||
      source.trustTier === "curated" ||
      source.trustTier === "community"
        ? source.trustTier
        : "community",
    trustScore: Number(source.trustScore ?? 0),
    recencyScore: Number(source.recencyScore ?? 0),
    relevance:
      source.relevance === "direct" ||
      source.relevance === "supporting" ||
      source.relevance === "background" ||
      source.relevance === "irrelevant"
        ? source.relevance
        : "supporting",
    stance:
      source.stance === "supports" ||
      source.stance === "contradicts" ||
      source.stance === "neutral"
        ? source.stance
        : "neutral",
    findingTypes: Array.isArray(source.findingTypes)
      ? source.findingTypes.map((value) => String(value))
      : [],
    relatedProjectIds: Array.isArray(source.relatedProjectIds)
      ? source.relatedProjectIds.map((value) => String(value))
      : [],
    relatedVersionIds: Array.isArray(source.relatedVersionIds)
      ? source.relatedVersionIds.map((value) => String(value))
      : [],
    clusterId: String(source.clusterId ?? ""),
    contradictedByDocumentIds: Array.isArray(source.contradictedByDocumentIds)
      ? source.contradictedByDocumentIds.map((value) => String(value))
      : [],
    supersededByDocumentId:
      typeof source.supersededByDocumentId === "string" &&
      source.supersededByDocumentId.length > 0
        ? source.supersededByDocumentId
        : undefined,
    sourceUrl: String(source.sourceUrl ?? ""),
    publishedAt: String(source.publishedAt ?? "")
  };
}
