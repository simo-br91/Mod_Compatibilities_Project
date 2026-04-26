/**
 * Webhook delivery subsystem.
 *
 * Covers:
 *  - HMAC-SHA256 payload signing and signature verification
 *  - Retry scheduler with exponential back-off (max 5 attempts)
 *  - Dead-letter queue for deliveries that exhaust all retries
 *  - In-memory delivery attempt tracking
 *
 * The HTTP transport itself is injected as a callback so this module has no
 * dependency on any HTTP client library and is easily testable.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { WebhookDeliveryAttempt, WebhookDeadLetter } from "@modcompat/api-contracts";

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Compute the HMAC-SHA256 signature for a webhook payload.
 *
 * The signature is a hex-encoded HMAC of `${timestamp}.${payload}` using
 * the webhook's signing secret.  Including the timestamp prevents replay
 * attacks when the receiver validates the timestamp.
 *
 * Receivers should:
 *   1. Extract the `X-Modcompat-Signature` and `X-Modcompat-Timestamp` headers.
 *   2. Reject requests where the timestamp is >5 minutes old.
 *   3. Recompute `computeWebhookSignature(payload, secret, timestamp)` and
 *      compare using a constant-time equals.
 */
export function computeWebhookSignature(
  payload: string,
  secret: string,
  timestamp: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
}

/**
 * Verify an inbound webhook signature.
 * Returns `false` if the signature is invalid OR if the timestamp is stale.
 */
export function verifyWebhookSignature(
  payload: string,
  secret: string,
  signature: string,
  timestamp: string,
  /** Maximum allowed age in seconds (default 300 = 5 minutes). */
  maxAgeSeconds = 300
): boolean {
  const ts = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > maxAgeSeconds) {
    return false;
  }
  const expected = computeWebhookSignature(payload, secret, timestamp);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/** Maximum delivery attempts before dead-lettering. */
const MAX_ATTEMPTS = 5;

/** Back-off delays in seconds: 10s, 30s, 2m, 10m, 30m */
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800] as const;

export function nextRetryDelaySeconds(attemptNumber: number): number {
  const idx = Math.min(attemptNumber, BACKOFF_SECONDS.length - 1);
  return BACKOFF_SECONDS[idx]!;
}

// ---------------------------------------------------------------------------
// HTTP transport abstraction
// ---------------------------------------------------------------------------

export interface WebhookTransport {
  deliver(
    url: string,
    payload: string,
    headers: Record<string, string>
  ): Promise<{ httpStatus: number; durationMs: number; error?: string }>;
}

// ---------------------------------------------------------------------------
// Delivery scheduler
// ---------------------------------------------------------------------------

export interface ScheduledDelivery {
  deliveryId: string;
  webhookId: string;
  url: string;
  signingSecret: string;
  eventType: string;
  payload: string;
  attemptNumber: number;
  scheduledAt: number; // ms epoch
}

export class WebhookDeliveryScheduler {
  private readonly attempts: WebhookDeliveryAttempt[] = [];
  private readonly deadLetters: WebhookDeadLetter[] = [];
  private readonly pending: ScheduledDelivery[] = [];

  constructor(private readonly transport: WebhookTransport) {}

  /**
   * Schedule a new first-attempt delivery.
   * Returns the delivery ID.
   */
  schedule(
    webhookId: string,
    url: string,
    signingSecret: string,
    eventType: string,
    payload: string
  ): string {
    const deliveryId = randomUUID();
    this.pending.push({
      deliveryId,
      webhookId,
      url,
      signingSecret,
      eventType,
      payload,
      attemptNumber: 1,
      scheduledAt: Date.now(),
    });
    return deliveryId;
  }

  /**
   * Process all pending deliveries that are due.
   * In production this is called by a background worker on a tight loop.
   * In tests, call it manually after advancing the clock.
   */
  async processDue(now = Date.now()): Promise<void> {
    const due = this.pending.filter((d) => d.scheduledAt <= now);
    // Remove due entries from pending before processing (avoid double-delivery)
    for (const d of due) {
      const idx = this.pending.indexOf(d);
      if (idx !== -1) this.pending.splice(idx, 1);
    }

    await Promise.all(due.map((d) => this.deliver(d)));
  }

  private async deliver(delivery: ScheduledDelivery): Promise<void> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeWebhookSignature(delivery.payload, delivery.signingSecret, timestamp);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-modcompat-event": delivery.eventType,
      "x-modcompat-delivery": delivery.deliveryId,
      "x-modcompat-timestamp": timestamp,
      "x-modcompat-signature": signature,
    };

    const start = Date.now();
    let result: { httpStatus: number; durationMs: number; error?: string };
    try {
      result = await this.transport.deliver(delivery.url, delivery.payload, headers);
    } catch (err) {
      result = {
        httpStatus: 0,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const attempt: WebhookDeliveryAttempt = {
      attemptId: randomUUID(),
      webhookId: delivery.webhookId,
      eventType: delivery.eventType,
      payload: delivery.payload,
      signature,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      error: result.error,
      attemptNumber: delivery.attemptNumber,
      deliveredAt: result.httpStatus >= 200 && result.httpStatus < 300
        ? new Date().toISOString()
        : undefined,
      createdAt: new Date().toISOString(),
    };

    const success = result.httpStatus >= 200 && result.httpStatus < 300;

    if (!success && delivery.attemptNumber < MAX_ATTEMPTS) {
      const delaySecs = nextRetryDelaySeconds(delivery.attemptNumber);
      const nextRetryAt = Date.now() + delaySecs * 1000;
      attempt.nextRetryAt = new Date(nextRetryAt).toISOString();

      this.pending.push({
        ...delivery,
        attemptNumber: delivery.attemptNumber + 1,
        scheduledAt: nextRetryAt,
      });
    } else if (!success) {
      // Exhausted retries — move to dead-letter queue
      this.deadLetters.push({
        deadLetterId: randomUUID(),
        webhookId: delivery.webhookId,
        eventType: delivery.eventType,
        payload: delivery.payload,
        totalAttempts: delivery.attemptNumber,
        lastError: result.error ?? `HTTP ${result.httpStatus}`,
        deadLetteredAt: new Date().toISOString(),
      });
    }

    this.attempts.push(attempt);
  }

  getAttempts(webhookId: string): WebhookDeliveryAttempt[] {
    return this.attempts.filter((a) => a.webhookId === webhookId);
  }

  getDeadLetters(webhookId?: string): WebhookDeadLetter[] {
    if (!webhookId) return this.deadLetters.slice();
    return this.deadLetters.filter((d) => d.webhookId === webhookId);
  }

  pendingCount(): number {
    return this.pending.length;
  }
}

// ---------------------------------------------------------------------------
// No-op transport (for tests / dev without real endpoints)
// ---------------------------------------------------------------------------

export const noopWebhookTransport: WebhookTransport = {
  async deliver(_url, _payload, _headers) {
    return { httpStatus: 200, durationMs: 0 };
  },
};
