"use client";

import { useEffect, useState } from "react";
import {
  getRecommendations,
  submitRecommendationFeedback,
  recordRecommendationOutcome,
  ApiError,
} from "@/lib/api";
import { getCurrentActorId } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { RecommendationsResponse } from "@modcompat/api-contracts";

export default function RecommendationsPage({
  params,
}: {
  params: { projectId: string; analysisId: string };
}) {
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<Record<string, string>>({});
  const [outcomeLoading, setOutcomeLoading] = useState(false);
  const [outcomeMsg, setOutcomeMsg] = useState<string | null>(null);

  useEffect(() => {
    getRecommendations(params.analysisId)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [params.analysisId]);

  async function handleFeedback(
    recId: string,
    feedbackType: "accepted" | "dismissed" | "not_helpful"
  ) {
    try {
      const actorId = getCurrentActorId();
      if (!actorId) {
        throw new Error("Your session has expired. Please sign in again.");
      }
      await submitRecommendationFeedback(recId, {
        feedbackType,
        createdBy: actorId,
      });
      setFeedbackMsg((m) => ({ ...m, [recId]: feedbackType }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleRecordOutcome() {
    if (!data) return;
    setOutcomeLoading(true);
    setOutcomeMsg(null);
    try {
      const actorId = getCurrentActorId();
      if (!actorId) {
        throw new Error("Your session has expired. Please sign in again.");
      }
      const acceptedIds = Object.entries(feedbackMsg)
        .filter(([, v]) => v === "accepted")
        .map(([k]) => k);
      await recordRecommendationOutcome(data.recommendationSetId, {
        status: "validated",
        appliedRecommendationIds: acceptedIds,
        validationSummary: `Applied ${acceptedIds.length} recommendation(s).`,
        createdBy: actorId,
      });
      setOutcomeMsg("Outcome recorded successfully.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setOutcomeLoading(false);
    }
  }

  if (loading) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  if (error) return <div className="px-4 py-6 text-sm text-red-600 sm:px-6 lg:px-8">{error}</div>;
  if (!data || data.items.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-gray-500 sm:px-6 lg:px-8">No recommendations for this analysis.</div>
    );
  }

  const kindColour: Record<string, string> = {
    upgrade:       "bg-green-100 text-green-800 border-green-200",
    replace:       "bg-blue-100 text-blue-800 border-blue-200",
    remove:        "bg-red-100 text-red-800 border-red-200",
    configuration: "bg-yellow-100 text-yellow-800 border-yellow-200",
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Recommendations</h1>
        {data.summary && (
          <span className="text-xs text-gray-500">
            {data.summary.unresolvedFindingCount} unresolved findings
          </span>
        )}
      </div>

      {outcomeMsg && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-2 text-xs text-green-700">
          {outcomeMsg}
        </div>
      )}

      {data.bundles && data.bundles.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {data.bundles.map((bundle) => (
            <Card key={bundle.bundleId}>
              <p className="text-xs font-semibold text-gray-900 mb-0.5">
                {bundle.strategy === "minimal_unblock" ? "Minimal unblock" : "Stability first"}
              </p>
              <p className="text-xs text-gray-500">{bundle.summary}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {data.items.map((rec) => {
          const fb = feedbackMsg[rec.recommendationId];
          return (
            <Card key={rec.recommendationId}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${kindColour[rec.kind] ?? "bg-gray-100 text-gray-700 border-gray-200"}`}>
                      {rec.kind}
                    </span>
                    <span className="text-xs text-gray-400">#{rec.rank}</span>
                    <span className="text-xs text-gray-400">{Math.round(rec.confidence * 100)}% confidence</span>
                  </div>
                  <p className="text-sm text-gray-900">{rec.summary}</p>
                  {rec.rationale && (
                    <p className="text-xs text-gray-500 mt-1">{rec.rationale}</p>
                  )}
                  {rec.steps && rec.steps.length > 0 && (
                    <ol className="mt-2 space-y-0.5 list-decimal list-inside">
                      {rec.steps.map((step, i) => (
                        <li key={i} className="text-xs text-gray-600">{step.summary}</li>
                      ))}
                    </ol>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5 lg:flex-col lg:items-end">
                  {fb ? (
                    <span className="text-xs font-medium text-gray-500 capitalize">{fb}</span>
                  ) : (
                    <>
                      <Button size="sm" variant="primary" onClick={() => handleFeedback(rec.recommendationId, "accepted")}>
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleFeedback(rec.recommendationId, "not_helpful")}>
                        Defer
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => handleFeedback(rec.recommendationId, "dismissed")}>
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {Object.keys(feedbackMsg).length > 0 && (
        <div className="pt-2">
          <Button variant="primary" loading={outcomeLoading} onClick={handleRecordOutcome}>
            Record outcome for accepted recommendations
          </Button>
        </div>
      )}
    </div>
  );
}
