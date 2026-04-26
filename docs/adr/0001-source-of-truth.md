# ADR 0001: Contract Source of Truth and Monorepo Baseline

## Status

Accepted for Phase 0.

## Context

The repository started as a documentation and blueprint set. Product behavior is described in prose, but the implementation subset must be governed by machine-readable contracts to prevent drift as services are introduced.

## Decision

- The repository remains a single monorepo.
- `schemas/` is the canonical location for implemented machine-readable contracts.
- Blueprint copies under `Modpack_Compatibility_Platform_Technical_Blueprints/` are maintained as synchronized mirrors during the transition.
- Product and architecture intent continue to come from the existing prose docs until superseded by ADRs.
- When prose and machine-readable contracts disagree, implemented behavior follows the checked-in contracts for the implemented subset and the divergence must be resolved in the same or next change.

## Consequences

- Service teams can build against stable contracts early.
- Contract validation can be automated independently from prose review.
- The repo preserves continuity with the original blueprint documents without making them the executable source of truth.

