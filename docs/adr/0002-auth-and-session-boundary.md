# ADR 0002: Auth and Session Boundary

## Status

Accepted

## Context

The platform now uses a real OAuth or OIDC sign-in flow at the gateway boundary. The
web application needs authenticated access but should not become a second source of
truth for session state or token storage.

## Decision

- The gateway owns session creation, logout, JWT issuance, cookie setting, and tenant resolution.
- The web client uses `/auth/login`, `/auth/logout`, and `/v1/auth/session` only.
- Browser storage may cache non-secret session summary data for convenience, but never the raw auth token as the authoritative source of truth.
- RBAC and tenant context enforcement remain gateway responsibilities.

## Consequences

- auth policy changes stay centralized
- the web app can be replaced without changing the core auth model
- incident response and audit trails remain consistent at the gateway boundary
