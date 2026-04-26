"use client";

import { useEffect, useState } from "react";

import { ApiError, exportReport, getReport } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { capitalise } from "@/lib/utils";
import type { AnalysisReport } from "@modcompat/api-contracts";

export default function ReportPage({
  params
}: {
  params: { projectId: string; analysisId: string };
}) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"json" | "markdown" | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    getReport(params.analysisId)
      .then(setReport)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [params.analysisId]);

  async function handleExport(format: "json" | "markdown") {
    setExporting(format);
    setExportMsg(null);

    try {
      const response = await exportReport(params.analysisId, format);
      if (response.content) {
        const blob = new Blob([response.content], {
          type: format === "json" ? "application/json" : "text/markdown"
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `report-${params.analysisId}.${format === "json" ? "json" : "md"}`;
        anchor.click();
        URL.revokeObjectURL(url);
        setExportMsg(`Downloaded ${anchor.download}`);
      } else if (response.downloadUrl) {
        window.open(response.downloadUrl, "_blank");
        setExportMsg("Export opened in a new tab.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center px-4 py-12 sm:px-6 lg:px-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return <div className="px-4 py-6 text-sm text-red-600 sm:px-6 lg:px-8">{error}</div>;
  }

  if (!report) {
    return (
      <div className="px-4 py-6 text-sm text-gray-500 sm:px-6 lg:px-8">
        No report available for this analysis.
      </div>
    );
  }

  const {
    analysis,
    findings,
    recommendations,
    releaseGateDecision,
    decisionSummary,
    latestOutcome
  } = report;

  const gateColour =
    releaseGateDecision?.status === "pass"
      ? "border-green-200 bg-green-50 text-green-700"
      : releaseGateDecision?.status === "block"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-yellow-200 bg-yellow-50 text-yellow-700";

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Analysis Report</h1>
          <p className="mt-1 break-all font-mono text-xs text-gray-400">{report.reportId}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={exporting === "markdown"}
            onClick={() => handleExport("markdown")}
          >
            Export .md
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={exporting === "json"}
            onClick={() => handleExport("json")}
          >
            Export JSON
          </Button>
        </div>
      </div>

      {exportMsg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-xs text-green-700">
          {exportMsg}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5 text-center">
          <p className="text-4xl font-bold text-gray-900">{analysis.score ?? "n/a"}</p>
          <p className="mt-1 text-xs text-gray-500">Compatibility score</p>
        </div>
        {releaseGateDecision && (
          <div className={`rounded-xl border p-5 text-center ${gateColour}`}>
            <p className="text-2xl font-bold uppercase">{releaseGateDecision.status}</p>
            <p className="mt-1 text-xs opacity-75">Release gate</p>
            {releaseGateDecision.reasons.length > 0 && (
              <p className="mt-2 text-xs opacity-70">{releaseGateDecision.reasons[0]}</p>
            )}
          </div>
        )}
      </div>

      {(decisionSummary.minimalUnblockSummary || decisionSummary.stabilityFirstSummary) && (
        <div className="grid gap-3 md:grid-cols-2">
          {decisionSummary.minimalUnblockSummary && (
            <Card>
              <CardHeader title="Minimal unblock" />
              <p className="text-xs text-gray-600">{decisionSummary.minimalUnblockSummary}</p>
            </Card>
          )}
          {decisionSummary.stabilityFirstSummary && (
            <Card>
              <CardHeader title="Stability first" />
              <p className="text-xs text-gray-600">{decisionSummary.stabilityFirstSummary}</p>
            </Card>
          )}
        </div>
      )}

      {findings.length > 0 && (
        <Card>
          <CardHeader title={`Findings (${findings.length})`} />
          <div className="space-y-2">
            {findings.map((finding) => (
              <div
                key={finding.findingId}
                className="flex flex-col gap-2 rounded-xl border border-gray-100 px-3 py-3 sm:flex-row sm:items-center"
              >
                <Badge
                  label={capitalise(finding.severity)}
                  variant="severity"
                  severity={finding.severity}
                />
                <span className="min-w-0 flex-1 text-xs text-gray-800">{finding.title}</span>
                <span className="text-xs text-gray-400">
                  {Math.round(finding.confidence * 100)}%
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {recommendations.length > 0 && (
        <Card>
          <CardHeader title={`Recommendations (${recommendations.length})`} />
          <div className="space-y-2">
            {recommendations.map((recommendation) => (
              <div
                key={recommendation.recommendationId}
                className="flex flex-col gap-2 rounded-xl border border-gray-100 px-3 py-3 sm:flex-row sm:items-start"
              >
                <span className="w-6 shrink-0 text-xs text-gray-400">#{recommendation.rank}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-800">{recommendation.summary}</p>
                  {recommendation.rationale && (
                    <p className="mt-0.5 text-xs text-gray-500">{recommendation.rationale}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-gray-400">
                  {Math.round(recommendation.confidence * 100)}%
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {latestOutcome && (
        <Card>
          <CardHeader title="Applied outcome" />
          <div className="space-y-1 text-xs text-gray-700">
            <p>
              <span className="text-gray-500">Status: </span>
              <span className="font-medium">{latestOutcome.status}</span>
            </p>
            {latestOutcome.validationSummary && (
              <p className="text-gray-600">{latestOutcome.validationSummary}</p>
            )}
            {latestOutcome.appliedRecommendationIds.length > 0 && (
              <p className="text-gray-500">
                {latestOutcome.appliedRecommendationIds.length} recommendation(s) applied
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
