"use client";

import { useEffect, useState } from "react";
import { getWebhookDeliveries, ApiError } from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardHeader } from "@/components/ui/card";
import { fmtDate } from "@/lib/utils";

interface DeliveryItem {
  attemptId: string;
  webhookId: string;
  eventType: string;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  attemptNumber: number;
  deliveredAt?: string;
  nextRetryAt?: string;
}

export default function WebhooksPage({
  params,
}: {
  params: { projectId: string; analysisId: string };
}) {
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWebhookDeliveries(params.analysisId)
      .then((res) => setItems(res.items as DeliveryItem[]))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [params.analysisId]);

  if (loading) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;

  return (
    <div className="p-8 max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold text-gray-900">Webhook Deliveries</h1>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div className="text-center py-12 text-sm text-gray-400">
          No webhook deliveries for this analysis.
        </div>
      )}

      {items.length > 0 && (
        <Card>
          <CardHeader
            title={`Deliveries (${items.length})`}
            subtitle="Outgoing webhook calls triggered by this analysis"
          />
          <div className="divide-y divide-gray-100">
            {items.map((attempt) => {
              const success =
                attempt.httpStatus !== undefined &&
                attempt.httpStatus >= 200 &&
                attempt.httpStatus < 300;
              return (
                <div key={attempt.attemptId} className="py-3 space-y-1">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${
                          success
                            ? "bg-green-50 text-green-700 border-green-200"
                            : attempt.httpStatus !== undefined
                            ? "bg-red-50 text-red-700 border-red-200"
                            : "bg-gray-50 text-gray-600 border-gray-200"
                        }`}
                      >
                        {attempt.httpStatus ?? "pending"}
                      </span>
                      <span className="text-xs font-medium text-gray-800">
                        {attempt.eventType}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400 shrink-0">
                      {attempt.durationMs !== undefined && (
                        <span>{attempt.durationMs}ms</span>
                      )}
                      <span>#{attempt.attemptNumber}</span>
                    </div>
                  </div>

                  {attempt.error && (
                    <p className="text-xs text-red-600 font-mono">{attempt.error}</p>
                  )}

                  <div className="flex items-center gap-4 text-xs text-gray-400">
                    <span className="font-mono truncate max-w-[200px]">
                      webhook: {attempt.webhookId}
                    </span>
                    {attempt.deliveredAt && (
                      <span>{fmtDate(attempt.deliveredAt)}</span>
                    )}
                    {attempt.nextRetryAt && !attempt.deliveredAt && (
                      <span className="text-yellow-600">
                        retry at {fmtDate(attempt.nextRetryAt)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
