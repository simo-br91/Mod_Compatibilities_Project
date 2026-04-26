# ADR 0003: Release Image Lineage and Rollback Source of Truth

## Status

Accepted

## Context

Release promotion previously tracked only the environment pointer and the immediate
previous release. That was not sufficient for historical rollback or for identifying
which registry image set was actually associated with a promoted release.

## Decision

- Every deployable release is represented by a versioned manifest under `infra/releases/manifests/`.
- Each manifest includes the intended deployment target and the full image inventory.
- Image publication is recorded before promotion so the release metadata can identify the promoted image set.
- Environment state tracks active release, historical release records, and rollback candidates derived from that history.
- Rollback targets are selected by manifest version rather than by an untracked image tag.

## Consequences

- operators can audit which image set was promoted
- rollback can target older validated releases, not only the most recent one
- release metadata becomes the launch control plane contract for staging and later production targets
