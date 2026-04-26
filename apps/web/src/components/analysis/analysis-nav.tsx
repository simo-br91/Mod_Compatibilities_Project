"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { label: "Progress",        suffix: "progress" },
  { label: "Findings",        suffix: "findings" },
  { label: "Pack Diff",       suffix: "diff" },
  { label: "Recommendations", suffix: "recommendations" },
  { label: "Evidence",        suffix: "evidence" },
  { label: "Graph",           suffix: "graph" },
  { label: "Simulation",      suffix: "simulation" },
  { label: "Report",          suffix: "report" },
  { label: "Webhooks",        suffix: "webhooks" },
];

export function AnalysisNav({
  projectId,
  analysisId,
}: {
  projectId: string;
  analysisId: string;
}) {
  const pathname = usePathname();
  const base = `/projects/${projectId}/analyses/${analysisId}`;

  return (
    <div className="border-b border-gray-200 bg-white">
      <div className="flex gap-0.5 overflow-x-auto px-4 sm:px-6">
      {TABS.map((tab) => {
        const href = `${base}/${tab.suffix}`;
        const active = pathname.startsWith(href);
        return (
          <Link
            key={tab.suffix}
            href={href}
            className={cn(
              "px-3 py-3 text-sm font-medium border-b-2 -mb-px transition-colors",
              active
                ? "border-indigo-600 text-indigo-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
      </div>
    </div>
  );
}
