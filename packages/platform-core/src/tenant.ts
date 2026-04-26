/**
 * Tenant scoping utilities.
 *
 * All repository reads and writes must be filtered by the acting organization.
 * These helpers make it easy to assert tenant ownership and build consistent
 * query predicates without repeating the same checks across every handler.
 */

import type { TenantContext } from "@modcompat/api-contracts";
import type { TenantScopedRecord } from "@modcompat/domain-models";

// ---------------------------------------------------------------------------
// Isolation errors
// ---------------------------------------------------------------------------

export class TenantIsolationError extends Error {
  readonly code = "tenant_isolation_violation" as const;
  constructor(
    resourceKind: string,
    resourceId: string,
    expectedOrg: string
  ) {
    super(
      `Tenant isolation violation: ${resourceKind}/${resourceId} does not belong to organization '${expectedOrg}'.`
    );
    this.name = "TenantIsolationError";
  }
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a tenant-scoped record belongs to the acting organization.
 * Throws `TenantIsolationError` when the tenantId is present and does not
 * match.  Records without a tenantId are assumed to be organization-global
 * (e.g. seed/demo data) and are allowed through.
 */
export function assertTenantOwnership(
  record: TenantScopedRecord & { [key: string]: unknown },
  context: TenantContext,
  resourceKind: string,
  resourceId: string
): void {
  if (record.tenantId && record.tenantId !== context.organizationId) {
    throw new TenantIsolationError(resourceKind, resourceId, context.organizationId);
  }
}

/**
 * Assert that a raw organizationId string matches the acting tenant.
 * Useful for validating path parameters like `/v1/projects/:projectId`
 * where the project record exposes its owning org separately.
 */
export function assertOrganizationMatch(
  recordOrgId: string | undefined,
  context: TenantContext,
  resourceKind: string,
  resourceId: string
): void {
  if (recordOrgId && recordOrgId !== context.organizationId) {
    throw new TenantIsolationError(resourceKind, resourceId, context.organizationId);
  }
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Return a predicate that accepts only records belonging to the acting
 * organization.  Records with no tenantId pass through (backward-compatible
 * with unseeded demo data).
 */
export function tenantFilter(
  context: TenantContext
): (record: TenantScopedRecord) => boolean {
  return (record) =>
    !record.tenantId || record.tenantId === context.organizationId;
}

/**
 * Filter an array of records to those owned by the acting organization.
 */
export function filterByTenant<T extends TenantScopedRecord>(
  records: T[],
  context: TenantContext
): T[] {
  return records.filter(tenantFilter(context));
}

/**
 * Attach the acting organization's ID as `tenantId` on a new record before
 * persisting it, ensuring it is always scoped at write time.
 */
export function stampTenant<T extends TenantScopedRecord>(
  record: T,
  context: TenantContext
): T {
  return { ...record, tenantId: context.organizationId };
}

// ---------------------------------------------------------------------------
// Context forwarding
// ---------------------------------------------------------------------------

/**
 * Extract standard HTTP propagation headers from a TenantContext so they can
 * be forwarded on outbound service-to-service calls.
 */
export function tenantForwardHeaders(
  context: TenantContext
): Record<string, string> {
  return {
    "x-organization-id": context.organizationId,
    "x-actor-id": context.actorId,
    "x-actor-role": context.role,
    "x-request-id": context.requestId,
    "x-trace-id": context.traceId,
  };
}

/**
 * Parse inbound forwarding headers back into a partial TenantContext.
 * Used by downstream services (evidence, admin, etc.) to reconstruct the
 * calling context without re-running auth.
 */
export function tenantContextFromHeaders(headers: Record<string, string | string[] | undefined>): Partial<TenantContext> {
  function first(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
  }
  return {
    organizationId: first(headers["x-organization-id"]),
    actorId: first(headers["x-actor-id"]),
    role: first(headers["x-actor-role"]) as TenantContext["role"] | undefined,
    requestId: first(headers["x-request-id"]),
    traceId: first(headers["x-trace-id"]),
  };
}
