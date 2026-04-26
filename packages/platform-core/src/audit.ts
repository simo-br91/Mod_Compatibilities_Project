/**
 * Audit logging subsystem.
 *
 * Every sensitive platform operation (auth, imports, analyses, curation,
 * promotion, export, webhook delivery) should record an AuditLogEntry via
 * the AuditLogger interface.
 *
 * The InMemoryAuditLogger is used in development and tests.  Production
 * deployments replace it with a Postgres-backed or streaming implementation.
 */

import { randomUUID } from "node:crypto";

import type { AuditLogEntry, AuditEventType, TenantContext } from "@modcompat/api-contracts";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AuditLogger {
  /**
   * Record a single audit event.  Implementations must not throw — if the
   * write fails, the error should be swallowed and logged to stderr so it
   * never disrupts the primary request path.
   */
  record(entry: AuditLogEntry): void | Promise<void>;

  /**
   * Query recent entries for an organization (used by admin views and tests).
   * May return an empty array when the backing store is not queryable
   * (e.g. a streaming-only sink).
   */
  query(organizationId: string, options?: AuditQueryOptions): AuditLogEntry[];
}

export interface AuditQueryOptions {
  /** Filter to specific event types. */
  eventTypes?: AuditEventType[];
  /** Filter to a specific actor. */
  actorId?: string;
  /** Filter to a specific resource kind. */
  resourceKind?: string;
  /** Filter to a specific resource ID. */
  resourceId?: string;
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
  /** Maximum number of entries to return (default 100). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryAuditLogger implements AuditLogger {
  /** All entries across all organizations. */
  private readonly entries: AuditLogEntry[] = [];
  /** Per-organization index for fast queries. */
  private readonly byOrg = new Map<string, AuditLogEntry[]>();

  record(entry: AuditLogEntry): void {
    this.entries.push(entry);
    const orgEntries = this.byOrg.get(entry.organizationId) ?? [];
    orgEntries.push(entry);
    this.byOrg.set(entry.organizationId, orgEntries);
  }

  query(organizationId: string, options: AuditQueryOptions = {}): AuditLogEntry[] {
    let entries = this.byOrg.get(organizationId) ?? [];

    if (options.eventTypes?.length) {
      entries = entries.filter((e) => options.eventTypes!.includes(e.eventType));
    }
    if (options.actorId) {
      entries = entries.filter((e) => e.actorId === options.actorId);
    }
    if (options.resourceKind) {
      entries = entries.filter((e) => e.resourceKind === options.resourceKind);
    }
    if (options.resourceId) {
      entries = entries.filter((e) => e.resourceId === options.resourceId);
    }
    if (options.from) {
      entries = entries.filter((e) => e.occurredAt >= options.from!);
    }
    if (options.to) {
      entries = entries.filter((e) => e.occurredAt <= options.to!);
    }

    // Most-recent-first
    entries = entries.slice().reverse();
    return entries.slice(0, options.limit ?? 100);
  }

  /** Total count across all organizations (useful in tests). */
  totalCount(): number {
    return this.entries.length;
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build an AuditLogEntry from a TenantContext and event-specific fields.
 * The caller must still pass the entry to `auditLogger.record()`.
 */
export function buildAuditEntry(
  context: TenantContext,
  eventType: AuditEventType,
  fields: {
    httpMethod?: string;
    httpPath?: string;
    resourceKind?: string;
    resourceId?: string;
    outcome: "success" | "failure" | "denied";
    failureCode?: string;
    metadata?: Record<string, unknown>;
  }
): AuditLogEntry {
  return {
    auditId: randomUUID(),
    eventType,
    organizationId: context.organizationId,
    actorId: context.actorId,
    actorKind: context.actorKind,
    httpMethod: fields.httpMethod,
    httpPath: fields.httpPath,
    resourceKind: fields.resourceKind,
    resourceId: fields.resourceId,
    outcome: fields.outcome,
    failureCode: fields.failureCode,
    occurredAt: new Date().toISOString(),
    metadata: fields.metadata,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

/**
 * Convenience wrapper: build and record a success event in one call.
 */
export function auditSuccess(
  logger: AuditLogger,
  context: TenantContext,
  eventType: AuditEventType,
  fields: Omit<Parameters<typeof buildAuditEntry>[2], "outcome"> = {}
): void {
  const entry = buildAuditEntry(context, eventType, { ...fields, outcome: "success" });
  void logger.record(entry);
}

/**
 * Convenience wrapper: build and record a denied event in one call.
 */
export function auditDenied(
  logger: AuditLogger,
  context: TenantContext,
  eventType: AuditEventType,
  fields: Omit<Parameters<typeof buildAuditEntry>[2], "outcome"> = {}
): void {
  const entry = buildAuditEntry(context, eventType, { ...fields, outcome: "denied" });
  void logger.record(entry);
}

/**
 * Convenience wrapper: build and record a failure event in one call.
 */
export function auditFailure(
  logger: AuditLogger,
  context: TenantContext,
  eventType: AuditEventType,
  failureCode: string,
  fields: Omit<Parameters<typeof buildAuditEntry>[2], "outcome" | "failureCode"> = {}
): void {
  const entry = buildAuditEntry(context, eventType, { ...fields, outcome: "failure", failureCode });
  void logger.record(entry);
}

// ---------------------------------------------------------------------------
// No-op logger (for tests that don't care about audit output)
// ---------------------------------------------------------------------------

export const noopAuditLogger: AuditLogger = {
  record(): void { /* intentionally empty */ },
  query(): AuditLogEntry[] { return []; },
};
