"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadRecentAnalyses, type RecentAnalysis } from "@/lib/session";
import { fmtDate } from "@/lib/utils";

export default function AnalysesListPage({
  params,
}: {
  params: { projectId: string };
}) {
  const [analyses, setAnalyses] = useState<RecentAnalysis[]>([]);

  useEffect(() => {
    const all = loadRecentAnalyses();
    setAnalyses(all.filter((a) => a.projectId === params.projectId));
  }, [params.projectId]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Recent Analyses</h1>
          <p className="text-sm text-gray-500 mt-0.5">Analyses run in this session</p>
        </div>
        <Link
          href={`/projects/${params.projectId}/imports`}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          + New import
        </Link>
      </div>

      {analyses.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
          <p className="text-sm text-gray-500">No analyses in this session yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            Import a pack to run your first analysis.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {analyses.map((a) => (
            <Link
              key={a.analysisId}
              href={`/projects/${params.projectId}/analyses/${a.analysisId}/progress`}
              className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4 transition-all hover:border-indigo-300 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs text-gray-800 truncate">{a.analysisId}</p>
                {a.label && (
                  <p className="text-xs text-gray-500 mt-0.5">{a.label}</p>
                )}
              </div>
              <div className="ml-0 flex shrink-0 items-center gap-4 sm:ml-4">
                <span className="text-xs text-gray-400">{fmtDate(a.createdAt)}</span>
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
