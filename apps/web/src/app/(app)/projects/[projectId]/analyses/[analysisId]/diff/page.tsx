"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiError, createPackDiff, getAnalysis } from "@/lib/api";
import { loadRecentAnalyses } from "@/lib/session";
import { capitalise, fmtDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { PackDiff } from "@modcompat/domain-models";

type DiffStatus = "idle" | "loading" | "ready";

const CHANGE_LABELS: Record<PackDiff["changes"][number]["changeType"], string> = {
  mod_added: "Mod added",
  mod_removed: "Mod removed",
  version_changed: "Version changed",
  environment_changed: "Environment changed",
  finding_added: "Finding added",
  finding_resolved: "Finding resolved"
};

export default function PackDiffPage({
  params
}: {
  params: { projectId: string; analysisId: string };
}) {
  const [status, setStatus] = useState<DiffStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [analysisSnapshotId, setAnalysisSnapshotId] = useState<string | null>(null);
  const [diff, setDiff] = useState<PackDiff | null>(null);
  const [baselineAnalysisId, setBaselineAnalysisId] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("loading");
      setError(null);

      try {
        const analysis = await getAnalysis(params.analysisId);
        if (cancelled) {
          return;
        }

        setAnalysisSnapshotId(analysis.analysis.packSnapshotId ?? null);
        setDiff(analysis.packDiff ?? null);
        setBaselineAnalysisId(analysis.packDiff?.baselineAnalysisId ?? "");
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : String(err));
          setStatus("ready");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [params.analysisId]);

  const recentAnalyses = useMemo(
    () =>
      loadRecentAnalyses()
        .filter(
          (entry) =>
            entry.projectId === params.projectId && entry.analysisId !== params.analysisId
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [params.analysisId, params.projectId]
  );

  async function handleCreateDiff() {
    if (!analysisSnapshotId) {
      setError("This analysis does not have a pack snapshot to compare.");
      return;
    }

    if (!baselineAnalysisId) {
      setError("Select a baseline analysis first.");
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const baseline = await getAnalysis(baselineAnalysisId);
      const baseSnapshotId = baseline.analysis.packSnapshotId;

      if (!baseSnapshotId) {
        throw new Error("The selected baseline analysis has no pack snapshot.");
      }

      const result = await createPackDiff(params.projectId, {
        baseSnapshotId,
        targetSnapshotId: analysisSnapshotId,
        baselineAnalysisId,
        targetAnalysisId: params.analysisId
      });

      setDiff(result.diff);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="flex justify-center px-4 py-12 sm:px-6 lg:px-8">
        <Spinner size="lg" />
      </div>
    );
  }

  const hasDiff = Boolean(diff);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Pack Diff</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Compare this analysis snapshot against a previous run to see mod, environment,
            and finding deltas.
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs text-gray-500">Current analysis</p>
          <p className="break-all font-mono text-xs text-gray-800">{params.analysisId}</p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!hasDiff && (
        <Card>
          <CardHeader
            title="Generate a comparison"
            subtitle="Choose a previous analysis from this session as the baseline."
          />
          {recentAnalyses.length === 0 ? (
            <p className="text-sm text-gray-500">
              No earlier analyses are available in this session yet. Run another pack
              analysis first, then return here to compare them.
            </p>
          ) : (
            <div className="space-y-4">
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Baseline analysis</span>
                <select
                  value={baselineAnalysisId}
                  onChange={(e) => setBaselineAnalysisId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select an analysis</option>
                  {recentAnalyses.map((entry) => (
                    <option key={entry.analysisId} value={entry.analysisId}>
                      {entry.label ? `${entry.label} - ` : ""}
                      {fmtDate(entry.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="primary" loading={creating} onClick={handleCreateDiff}>
                Create pack diff
              </Button>
            </div>
          )}
        </Card>
      )}

      {diff && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">Added mods</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{diff.summary.addedMods}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">Removed mods</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{diff.summary.removedMods}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">Version changes</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">
                {diff.summary.changedVersions}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">Findings added</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{diff.summary.findingAdds}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">Findings resolved</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">
                {diff.summary.findingResolutions}
              </p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card>
              <CardHeader
                title={`Changes (${diff.changes.length})`}
                subtitle="Ordered from the generated diff record."
              />
              {diff.changes.length === 0 ? (
                <p className="text-sm text-gray-500">No differences were recorded.</p>
              ) : (
                <div className="space-y-3">
                  {diff.changes.map((change, index) => (
                    <div
                      key={`${change.changeType}-${change.projectId ?? "global"}-${index}`}
                      className="rounded-xl border border-gray-100 px-4 py-4"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {CHANGE_LABELS[change.changeType]}
                          </p>
                          {change.projectId && (
                            <p className="mt-0.5 text-xs font-mono text-gray-500">
                              {change.projectId}
                            </p>
                          )}
                        </div>
                        <span className="inline-flex rounded-lg bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
                          {capitalise(change.changeType.replace(/_/g, " "))}
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-gray-700">{change.summary}</p>
                      {(change.before || change.after) && (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div className="rounded-lg bg-gray-50 px-3 py-2">
                            <p className="text-[11px] uppercase tracking-wide text-gray-400">
                              Before
                            </p>
                            <p className="mt-1 break-all font-mono text-xs text-gray-700">
                              {change.before ?? "n/a"}
                            </p>
                          </div>
                          <div className="rounded-lg bg-gray-50 px-3 py-2">
                            <p className="text-[11px] uppercase tracking-wide text-gray-400">
                              After
                            </p>
                            <p className="mt-1 break-all font-mono text-xs text-gray-700">
                              {change.after ?? "n/a"}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="Diff metadata" />
              <div className="space-y-3 text-xs text-gray-600">
                <div>
                  <p className="text-gray-400">Diff ID</p>
                  <p className="mt-1 break-all font-mono text-gray-800">{diff.packDiffId}</p>
                </div>
                <div>
                  <p className="text-gray-400">Baseline analysis</p>
                  <p className="mt-1 break-all font-mono text-gray-800">
                    {diff.baselineAnalysisId ?? "n/a"}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400">Target analysis</p>
                  <p className="mt-1 break-all font-mono text-gray-800">
                    {diff.targetAnalysisId ?? params.analysisId}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400">Base snapshot</p>
                  <p className="mt-1 break-all font-mono text-gray-800">{diff.baseSnapshotId}</p>
                </div>
                <div>
                  <p className="text-gray-400">Target snapshot</p>
                  <p className="mt-1 break-all font-mono text-gray-800">
                    {diff.targetSnapshotId}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400">Created</p>
                  <p className="mt-1 text-gray-800">{fmtDate(diff.createdAt)}</p>
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
