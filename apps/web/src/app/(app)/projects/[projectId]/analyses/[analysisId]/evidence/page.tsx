"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { searchEvidence, triggerEvidenceSync, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

interface EvidenceHit {
  score: number;
  document: {
    documentId: string;
    kind?: string;
    title?: string;
    summary?: string;
    sourceUrl?: string;
    createdAt?: string;
  };
  snippets?: Array<{ snippetId: string; content: string }>;
}

export default function EvidencePage({
  params,
}: {
  params: { projectId: string; analysisId: string };
}) {
  const searchParams = useSearchParams();
  const initialFindingId = searchParams.get("findingId") ?? "";

  const [query, setQuery] = useState("");
  const [findingId, setFindingId] = useState(initialFindingId);
  const [hits, setHits] = useState<EvidenceHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const doSearch = useCallback(async (q: string, fId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await searchEvidence({
        query: q || undefined,
        analysisId: params.analysisId,
        findingId: fId || undefined,
        limit: 20,
      });
      setHits(res.hits as EvidenceHit[]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [params.analysisId]);

  useEffect(() => {
    doSearch("", initialFindingId);
  }, [doSearch, initialFindingId]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const result = await triggerEvidenceSync();
      setSyncMsg(`Synced ${result.documents?.length ?? 0} documents, ${result.snippets?.length ?? 0} snippets.`);
      await doSearch(query, findingId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="p-8 max-w-2xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Evidence</h1>
        <Button size="sm" variant="secondary" loading={syncing} onClick={handleSync}>
          Sync sources
        </Button>
      </div>

      {syncMsg && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-2 text-xs text-green-700">
          {syncMsg}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); doSearch(query, findingId); }}
        className="flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search evidence…"
          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <input
          value={findingId}
          onChange={(e) => setFindingId(e.target.value)}
          placeholder="Finding ID (optional)"
          className="w-48 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <Button type="submit" variant="primary" loading={loading}>Search</Button>
      </form>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : hits.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">
          No evidence found. Try syncing sources first.
        </div>
      ) : (
        <div className="space-y-3">
          {hits.map((hit) => (
            <Card key={hit.document.documentId} className="hover:border-indigo-200 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {hit.document.title ?? hit.document.documentId}
                  </p>
                  {hit.document.kind && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600 border border-gray-200 mr-1">
                      {hit.document.kind}
                    </span>
                  )}
                  {hit.document.summary && (
                    <p className="text-xs text-gray-600 mt-1 line-clamp-3">{hit.document.summary}</p>
                  )}
                  {hit.snippets && hit.snippets.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {hit.snippets.slice(0, 2).map((snippet) => (
                        <p key={snippet.snippetId} className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1 italic line-clamp-2">
                          {snippet.content}
                        </p>
                      ))}
                    </div>
                  )}
                  {hit.document.sourceUrl && (
                    <a href={hit.document.sourceUrl} target="_blank" rel="noreferrer"
                      className="text-xs text-indigo-600 hover:underline mt-1 block truncate">
                      {hit.document.sourceUrl}
                    </a>
                  )}
                </div>
                <span className="text-xs text-gray-400 shrink-0">
                  {Math.round(hit.score * 100)}%
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
