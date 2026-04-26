"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ApiError, getFindingEvidence, getFindings } from "@/lib/api";
import { capitalise } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { Finding } from "@modcompat/api-contracts";

export default function FindingsPage({
  params
}: {
  params: { projectId: string; analysisId: string };
}) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Finding | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidence, setEvidence] = useState<{
    hits: Array<{
      score: number;
      document: { title?: string; summary?: string; sourceUrl?: string };
    }>;
  } | null>(null);

  useEffect(() => {
    getFindings(params.analysisId)
      .then((result) => {
        setFindings(result.findings);
        setSelected(result.findings[0] ?? null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [params.analysisId]);

  useEffect(() => {
    if (!selected) {
      return;
    }

    const selectedFindingId = selected.findingId;

    async function loadEvidence() {
      setEvidence(null);
      setEvidenceLoading(true);
      try {
        const result = await getFindingEvidence(params.analysisId, selectedFindingId);
        setEvidence(result);
      } catch {
        // Keep the current selected finding even if evidence lookup fails.
      } finally {
        setEvidenceLoading(false);
      }
    }

    void loadEvidence();
  }, [params.analysisId, selected]);

  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4
  };

  const sorted = [...findings].sort(
    (left, right) =>
      (severityOrder[left.severity] ?? 5) - (severityOrder[right.severity] ?? 5)
  );

  return (
    <div className="grid min-h-full gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="border-b border-gray-200 bg-white lg:border-b-0 lg:border-r">
        <div className="border-b border-gray-100 px-4 py-3">
          <p className="text-xs font-medium text-gray-900">
            {loading ? "Loading..." : `${findings.length} finding${findings.length !== 1 ? "s" : ""}`}
          </p>
        </div>

        {loading && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}

        {error && <p className="p-4 text-sm text-red-600">{error}</p>}

        <div className="max-h-[40vh] overflow-y-auto lg:max-h-[calc(100vh-11rem)]">
          {sorted.map((finding) => (
            <button
              key={finding.findingId}
              onClick={() => setSelected(finding)}
              className={`w-full border-b border-gray-100 px-4 py-3 text-left transition-colors hover:bg-gray-50 ${
                selected?.findingId === finding.findingId ? "bg-indigo-50" : ""
              }`}
            >
              <div className="flex items-start gap-2">
                <Badge
                  label={capitalise(finding.severity)}
                  variant="severity"
                  severity={finding.severity}
                  className="mt-0.5 shrink-0"
                />
                <p className="text-xs leading-snug text-gray-800">{finding.title}</p>
              </div>
              <p className="mt-1 truncate text-xs text-gray-500">{finding.type}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        {!selected ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            Select a finding to inspect
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <Badge
                  label={capitalise(selected.severity)}
                  variant="severity"
                  severity={selected.severity}
                />
                <Badge label={selected.type} />
                <span className="text-xs text-gray-500">
                  confidence {Math.round(selected.confidence * 100)}%
                </span>
              </div>
              <h2 className="text-base font-semibold text-gray-900">{selected.title}</h2>
              {selected.summary && (
                <p className="mt-1 text-sm text-gray-600">{selected.summary}</p>
              )}
            </div>

            {selected.subjects.length > 0 && (
              <Card>
                <CardHeader title="Affected mods" />
                <ul className="space-y-1">
                  {selected.subjects.map((subject, index) => (
                    <li key={`${subject.projectId}-${index}`} className="text-xs font-mono text-gray-700">
                      {subject.projectId}
                      {subject.versionId && (
                        <span className="text-gray-400"> @ {subject.versionId}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {selected.recommendedActions && selected.recommendedActions.length > 0 && (
              <Card>
                <CardHeader title="Recommended actions" />
                <ul className="space-y-1">
                  {selected.recommendedActions.map((action, index) => (
                    <li key={`${action}-${index}`} className="text-xs text-gray-700">
                      {action}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Evidence"
                action={
                  <Link
                    href={`/projects/${params.projectId}/analyses/${params.analysisId}/evidence?findingId=${selected.findingId}`}
                    className="text-xs text-indigo-600 hover:underline"
                  >
                    Search more
                  </Link>
                }
              />
              {evidenceLoading ? (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              ) : evidence && evidence.hits.length > 0 ? (
                <ul className="space-y-3">
                  {evidence.hits.slice(0, 5).map((hit, index) => (
                    <li key={`${hit.document.sourceUrl ?? hit.document.title ?? "ev"}-${index}`} className="rounded-lg border border-gray-100 p-3">
                      <p className="text-xs font-medium text-gray-800">
                        {hit.document.title ?? "Evidence document"}
                      </p>
                      {hit.document.summary && (
                        <p className="mt-0.5 text-xs text-gray-600">{hit.document.summary}</p>
                      )}
                      {hit.document.sourceUrl && (
                        <a
                          href={hit.document.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block truncate text-xs text-indigo-600 hover:underline"
                        >
                          {hit.document.sourceUrl}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-gray-500">No linked evidence for this finding.</p>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
