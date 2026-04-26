"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  ApiError,
  cancelAnalysisRequest,
  getAnalysisProgress,
  getFindings,
  getGraph,
  getRecommendations,
} from "@/lib/api";
import { fmtDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type {
  AnalysisProgressResponse,
  Finding,
} from "@modcompat/api-contracts";
import type { GraphNode } from "@modcompat/domain-models";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export default function ProgressPage({
  params
}: {
  params: { projectId: string; analysisId: string };
}) {
  const searchParams = useSearchParams();
  const polling = searchParams.get("polling") === "1";

  const [data, setData] = useState<AnalysisProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [recommendations, setRecommendations] = useState<
    Awaited<ReturnType<typeof getRecommendations>>["items"]
  >([]);
  const [modsInPack, setModsInPack] = useState<string[]>([]);
  const [resultLoading, setResultLoading] = useState(false);

  const fetchProgress = useCallback(async () => {
    try {
      const result = await getAnalysisProgress(params.analysisId);
      setData(result);
      return result.analysis.status;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      return "failed";
    }
  }, [params.analysisId]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const status = await fetchProgress();
      if (cancelled) {
        return;
      }
      if (!TERMINAL.has(status)) {
        setTimeout(poll, 1500);
      }
    }

    void poll();
    return () => {
      cancelled = true;
    };
  }, [fetchProgress]);

  useEffect(() => {
    const status = data?.analysis.status;
    if (status !== "completed") {
      return;
    }

    let cancelled = false;
    setResultLoading(true);

    async function loadResultData() {
      try {
        const [findingsResult, recommendationsResult, graphResult] =
          await Promise.all([
            getFindings(params.analysisId),
            getRecommendations(params.analysisId),
            getGraph(params.analysisId),
          ]);

        if (cancelled) {
          return;
        }

        setFindings(findingsResult.findings);
        setRecommendations(recommendationsResult.items);

        const modNodes = graphResult.graph.nodes
          .filter((node: GraphNode) => node.nodeType === "mod")
          .map((node: GraphNode) => node.label.trim())
          .filter(Boolean);
        const dedupedSortedMods = [...new Set(modNodes)].sort((a, b) =>
          a.localeCompare(b)
        );
        setModsInPack(dedupedSortedMods);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setResultLoading(false);
        }
      }
    }

    void loadResultData();
    return () => {
      cancelled = true;
    };
  }, [data?.analysis.status, params.analysisId]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelAnalysisRequest(params.analysisId);
      await fetchProgress();
    } catch {
      // Keep the current UI state and let the polling loop refresh.
    } finally {
      setCancelling(false);
    }
  }

  const analysis = data?.analysis;
  const phases = data?.phases ?? [];
  const events = data?.events ?? [];
  const isRunning = Boolean(analysis && !TERMINAL.has(analysis.status));
  const isCompleted = analysis?.status === "completed";

  const incompatibilityFindings = findings.filter((finding) => {
    const text = `${finding.type} ${finding.title} ${finding.summary ?? ""}`.toLowerCase();
    return (
      /incompat|conflict|crash|break/.test(text) || finding.subjects.length >= 2
    );
  });

  const incompatibleMods = new Set(
    incompatibilityFindings.flatMap((finding) =>
      finding.subjects.map((subject) => subject.projectId)
    )
  );
  const compatibleMods = modsInPack.filter((mod) => !incompatibleMods.has(mod));

  const statusColour =
    analysis?.status === "completed"
      ? "border-green-200 bg-green-50 text-green-700"
      : analysis?.status === "failed" || analysis?.status === "cancelled"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-indigo-200 bg-indigo-50 text-indigo-700";

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Analysis Progress</h1>
          <p className="mt-1 break-all font-mono text-xs text-gray-500">{params.analysisId}</p>
          {polling && (
            <p className="mt-2 text-xs text-indigo-600">
              Waiting for the queued analysis request to resolve into a live analysis.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {isRunning && (
            <Button size="sm" variant="danger" loading={cancelling} onClick={handleCancel}>
              Cancel
            </Button>
          )}
          {analysis?.status === "completed" && (
            <>
              <Link
                href={`/projects/${params.projectId}/analyses/${params.analysisId}/findings`}
                className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
              >
                View findings
              </Link>
              <Link
                href={`/projects/${params.projectId}/analyses/${params.analysisId}/diff`}
                className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Review pack diff
              </Link>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {analysis ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px]">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="space-y-2">
              <span
                className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-semibold ${statusColour}`}
              >
                {isRunning && <Spinner size="sm" />}
                <span className={isRunning ? "ml-1.5" : ""}>{analysis.status.toUpperCase()}</span>
              </span>
              {analysis.counts && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {analysis.counts.critical > 0 && (
                    <Badge label={`${analysis.counts.critical} critical`} variant="severity" severity="critical" />
                  )}
                  {analysis.counts.high > 0 && (
                    <Badge label={`${analysis.counts.high} high`} variant="severity" severity="high" />
                  )}
                  {analysis.counts.medium > 0 && (
                    <Badge label={`${analysis.counts.medium} medium`} variant="severity" severity="medium" />
                  )}
                  {analysis.counts.low > 0 && (
                    <Badge label={`${analysis.counts.low} low`} variant="severity" severity="low" />
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 text-left lg:text-right">
            <p className="text-3xl font-bold text-gray-900">{analysis.score ?? "n/a"}</p>
            <p className="text-xs text-gray-500">compatibility score</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <Spinner /> Loading...
        </div>
      )}

      {isCompleted ? (
        <div className="space-y-5">
          {resultLoading ? (
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
              <Spinner size="sm" /> Loading simplified results...
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold text-gray-900">
                  Incompatibilities
                </h2>
                {incompatibilityFindings.length === 0 ? (
                  <p className="mt-2 text-sm text-green-700">
                    No incompatibilities detected.
                  </p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {incompatibilityFindings.map((finding) => {
                      const recsForFinding = recommendations.filter((rec) => {
                        if (rec.findingIds?.includes(finding.findingId)) {
                          return true;
                        }

                        if (!rec.replacesSubjects || rec.replacesSubjects.length === 0) {
                          return false;
                        }

                        const findingSubjects = new Set(
                          finding.subjects.map((subject) => subject.projectId)
                        );
                        return rec.replacesSubjects.some((subject: { projectId: string }) =>
                          findingSubjects.has(subject.projectId)
                        );
                      });

                      return (
                        <div
                          key={finding.findingId}
                          className="rounded-lg border border-red-200 bg-red-50 p-3"
                        >
                          <p className="text-sm font-medium text-red-800">
                            {finding.title}
                          </p>
                          {finding.summary && (
                            <p className="mt-1 text-xs text-red-700">{finding.summary}</p>
                          )}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {finding.subjects.map((subject, index) => (
                              <Badge
                                key={`${subject.projectId}-${index}`}
                                label={subject.projectId}
                                variant="severity"
                                severity="high"
                              />
                            ))}
                          </div>

                          <div className="mt-3 rounded-md border border-red-100 bg-white/70 p-2">
                            <p className="text-xs font-semibold text-gray-800">
                              Recommendations
                            </p>
                            {recsForFinding.length === 0 ? (
                              <p className="mt-1 text-xs text-gray-600">
                                No direct recommendation linked to this incompatibility.
                              </p>
                            ) : (
                              <ul className="mt-1 space-y-1">
                                {recsForFinding.slice(0, 3).map((rec) => (
                                  <li
                                    key={rec.recommendationId}
                                    className="text-xs text-gray-700"
                                  >
                                    - {rec.summary}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold text-gray-900">
                  Mods That Work Well Together
                </h2>
                {compatibleMods.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-600">
                    No clearly compatible mod list available yet.
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {compatibleMods.map((mod) => (
                      <Badge key={mod} label={mod} variant="status" severity="success" />
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-500">
                Need detailed diagnostics? Use the tabs above for full findings, graph, evidence, and report.
              </div>
            </>
          )}
        </div>
      ) : phases.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          {phases.map((phase) => (
            <div
              key={phase.phaseId}
              className="flex flex-col gap-2 border-b border-gray-100 px-5 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 shrink-0 rounded-full bg-green-400" />
                <span className="text-sm text-gray-800">
                  {phase.phaseName.replace(/_/g, " ")}
                </span>
              </div>
              <span className="text-xs text-gray-400">{phase.durationMs}ms</span>
            </div>
          ))}
          {isRunning && (
            <div className="flex items-center gap-3 px-5 py-3 text-sm text-indigo-600">
              <Spinner size="sm" /> Running...
            </div>
          )}
        </div>
      ) : null}

      {!isCompleted && events.length > 0 && (
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
            Events
          </h2>
          <div className="space-y-2">
            {events.slice(-20).map((event) => (
              <div
                key={event.eventId}
                className="grid gap-1 rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-600 sm:grid-cols-[170px_170px_minmax(0,1fr)] sm:gap-3"
              >
                <span className="font-mono text-gray-400">{fmtDate(event.occurredAt)}</span>
                <span className="text-indigo-600">{event.eventType}</span>
                <span>{event.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
