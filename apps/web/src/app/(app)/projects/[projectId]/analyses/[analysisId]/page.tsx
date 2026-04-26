import { redirect } from "next/navigation";

export default function AnalysisIndexPage({
  params,
}: {
  params: { projectId: string; analysisId: string };
}) {
  redirect(`/projects/${params.projectId}/analyses/${params.analysisId}/progress`);
}
