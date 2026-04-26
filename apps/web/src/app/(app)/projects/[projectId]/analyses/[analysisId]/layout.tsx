import { AnalysisNav } from "@/components/analysis/analysis-nav";

export default function AnalysisLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { projectId: string; analysisId: string };
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <p className="text-xs text-gray-500">
          Analysis <span className="font-mono">{params.analysisId}</span>
        </p>
      </div>
      <AnalysisNav projectId={params.projectId} analysisId={params.analysisId} />
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
