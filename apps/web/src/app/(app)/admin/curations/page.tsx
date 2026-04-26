"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createEvidenceCuration, promoteVerifiedRule, ApiError } from "@/lib/api";
import { canAccessAdminFeatures, getCurrentActorId, loadSession } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { capitalise } from "@/lib/utils";
import type { EvidenceCurationRecord } from "@modcompat/domain-models";

type Severity = "critical" | "high" | "medium" | "low" | "info";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

const EMPTY_FORM = {
  title: "",
  findingType: "",
  severity: "medium" as Severity,
  summary: "",
  subjectProjectIds: "",
  evidenceDocumentIds: "",
};

export default function CurationsPage() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [curations, setCurations] = useState<EvidenceCurationRecord[]>([]);
  const [promoting, setPromoting] = useState<Record<string, boolean>>({});
  const [promoteMsg, setPromoteMsg] = useState<Record<string, string>>({});
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.replace("/sign-in");
      return;
    }
    if (!canAccessAdminFeatures()) {
      router.replace("/dashboard");
      return;
    }
    setAuthorized(true);
  }, [router]);

  function setField(field: keyof typeof EMPTY_FORM, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const actorId = getCurrentActorId();
      if (!actorId) {
        throw new Error("Your session has expired. Please sign in again.");
      }
      const res = await createEvidenceCuration({
        title: form.title.trim(),
        findingType: form.findingType.trim(),
        severity: form.severity,
        summary: form.summary.trim(),
        subjectProjectIds: form.subjectProjectIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        evidenceDocumentIds: form.evidenceDocumentIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        evidenceSnippetIds: [],
        createdBy: actorId,
      });
      setCurations((c) => [res.curation, ...c]);
      setSuccessMsg(`Curation "${res.curation.title}" created.`);
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePromote(curationId: string) {
    setPromoting((p) => ({ ...p, [curationId]: true }));
    setPromoteMsg((m) => ({ ...m, [curationId]: "" }));
    try {
      const actorId = getCurrentActorId();
      if (!actorId) {
        throw new Error("Your session has expired. Please sign in again.");
      }
      const res = await promoteVerifiedRule(curationId, {
        curationId,
        promotedBy: actorId,
      });
      setCurations((c) =>
        c.map((cur) =>
          cur.curationId === curationId ? res.curation : cur
        )
      );
      setPromoteMsg((m) => ({
        ...m,
        [curationId]: `Promoted → rule ${res.rule.ruleId} (v${res.rule.version})`,
      }));
    } catch (err) {
      setPromoteMsg((m) => ({
        ...m,
        [curationId]: err instanceof ApiError ? err.message : String(err),
      }));
    } finally {
      setPromoting((p) => ({ ...p, [curationId]: false }));
    }
  }

  if (!authorized) {
    return <div className="p-8 text-sm text-gray-500">Checking admin access...</div>;
  }

  return (
    <div className="p-8 max-w-2xl space-y-8">
      <h1 className="text-xl font-semibold text-gray-900">Evidence Curations</h1>

      {/* Create form */}
      <Card>
        <CardHeader title="New curation" subtitle="Curate evidence into a verified rule draft" />
        <form onSubmit={handleCreate} className="space-y-3 mt-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Title</label>
              <input
                required
                value={form.title}
                onChange={(e) => setField("title", e.target.value)}
                placeholder="e.g. OptiFine + Sodium crash"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Finding type</label>
              <input
                required
                value={form.findingType}
                onChange={(e) => setField("findingType", e.target.value)}
                placeholder="e.g. render_crash"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">Severity</label>
            <select
              value={form.severity}
              onChange={(e) => setField("severity", e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{capitalise(s)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">Summary</label>
            <textarea
              required
              rows={3}
              value={form.summary}
              onChange={(e) => setField("summary", e.target.value)}
              placeholder="Describe the compatibility issue and evidence…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">
              Subject project IDs <span className="text-gray-400">(comma-separated)</span>
            </label>
            <input
              value={form.subjectProjectIds}
              onChange={(e) => setField("subjectProjectIds", e.target.value)}
              placeholder="e.g. proj_abc, proj_def"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">
              Evidence document IDs <span className="text-gray-400">(comma-separated, optional)</span>
            </label>
            <input
              value={form.evidenceDocumentIds}
              onChange={(e) => setField("evidenceDocumentIds", e.target.value)}
              placeholder="e.g. doc_xyz"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            {successMsg ? (
              <span className="text-xs text-green-700">{successMsg}</span>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" loading={submitting}>
              Create curation
            </Button>
          </div>
        </form>
      </Card>

      {/* Curation list */}
      {curations.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-gray-700">
            Created this session ({curations.length})
          </h2>
          {curations.map((cur) => (
            <Card key={cur.curationId}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge
                      label={capitalise(cur.severity)}
                      variant="severity"
                      severity={cur.severity}
                    />
                    <span className="text-xs text-gray-500">{cur.findingType}</span>
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs border font-medium ${
                        cur.status === "promoted"
                          ? "bg-green-100 text-green-800 border-green-200"
                          : "bg-gray-100 text-gray-600 border-gray-200"
                      }`}
                    >
                      {cur.status}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-gray-900">{cur.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{cur.summary}</p>
                  {cur.subjectProjectIds.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1 font-mono">
                      {cur.subjectProjectIds.join(", ")}
                    </p>
                  )}
                  {promoteMsg[cur.curationId] && (
                    <p className={`text-xs mt-1 ${cur.status === "promoted" ? "text-green-700" : "text-red-600"}`}>
                      {promoteMsg[cur.curationId]}
                    </p>
                  )}
                </div>
                {cur.status === "draft" && (
                  <div className="shrink-0">
                    <Button
                      size="sm"
                      variant="primary"
                      loading={promoting[cur.curationId]}
                      onClick={() => handlePromote(cur.curationId)}
                    >
                      Promote
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
