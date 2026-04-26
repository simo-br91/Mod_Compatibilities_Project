"use client";

import { useEffect, useState } from "react";
import { getSimulationRun, getReleaseGate, ApiError } from "@/lib/api";
import { Card, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { fmtDate, gateStatusClass } from "@/lib/utils";
import type { SimulationRun, ReleaseGateDecision } from "@modcompat/domain-models";

export default function SimulationPage({
  params,
}: {
  params: { projectId: string; analysisId: string };
}) {
  const [simRun, setSimRun] = useState<SimulationRun | null>(null);
  const [gate, setGate] = useState<ReleaseGateDecision | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [simRes, gateRes] = await Promise.all([
          getSimulationRun(params.analysisId).catch(() => null),
          getReleaseGate(params.analysisId).catch(() => null),
        ]);
        setSimRun(simRes?.simulationRun ?? null);
        setGate(gateRes?.releaseGateDecision ?? null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [params.analysisId]);

  if (loading) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>;

  return (
    <div className="p-8 max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Simulation &amp; Release Gate</h1>

      {/* Release Gate */}
      {gate ? (
        <Card>
          <CardHeader title="Release Gate Decision" subtitle={`Policy: ${gate.policyKey}`} />
          <div className="space-y-3">
            <span
              className={`inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold border uppercase ${gateStatusClass(gate.status)}`}
            >
              {gate.status}
            </span>

            {gate.summary && (
              <p className="text-sm text-gray-700">{gate.summary}</p>
            )}

            {gate.reasons.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">Reasons</p>
                <ul className="space-y-1 list-disc list-inside">
                  {gate.reasons.map((reason, i) => (
                    <li key={i} className="text-xs text-gray-700">{reason}</li>
                  ))}
                </ul>
              </div>
            )}

            {gate.blockingFindingIds.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">
                  Blocking findings ({gate.blockingFindingIds.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {gate.blockingFindingIds.map((id) => (
                    <span key={id} className="font-mono text-xs bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 rounded">
                      {id}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-gray-400">{fmtDate(gate.createdAt)}</p>
          </div>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-gray-500">No release gate decision available for this analysis.</p>
        </Card>
      )}

      {/* Simulation Run */}
      {simRun ? (
        <Card>
          <CardHeader
            title="Simulation Run"
            subtitle={`${simRun.simulationRunId}`}
          />
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                  simRun.status === "completed"
                    ? "bg-green-50 text-green-700 border-green-200"
                    : "bg-red-50 text-red-700 border-red-200"
                }`}
              >
                {simRun.status}
              </span>
              <span className="text-xs text-gray-500 font-mono">{simRun.recipeId}</span>
            </div>

            {simRun.summary && (
              <p className="text-sm text-gray-700">{simRun.summary}</p>
            )}

            {simRun.observations.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">
                  Observations ({simRun.observations.length})
                </p>
                <div className="space-y-2">
                  {simRun.observations.map((obs) => (
                    <div
                      key={obs.observationId}
                      className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${
                            obs.status === "failed"
                              ? "bg-red-50 text-red-700 border-red-200"
                              : "bg-green-50 text-green-700 border-green-200"
                          }`}
                        >
                          {obs.kind.replace(/_/g, " ")}
                        </span>
                        <span
                          className={`text-xs font-medium ${
                            obs.status === "failed" ? "text-red-600" : "text-green-600"
                          }`}
                        >
                          {obs.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-800">{obs.summary}</p>
                      {obs.findingTypes.length > 0 && (
                        <p className="text-xs text-gray-400 mt-1">
                          finding types: {obs.findingTypes.join(", ")}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500">No observations recorded.</p>
            )}

            <p className="text-xs text-gray-400">{fmtDate(simRun.createdAt)}</p>
          </div>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-gray-500">No simulation run available for this analysis.</p>
        </Card>
      )}
    </div>
  );
}
