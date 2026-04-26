# Releases

This directory tracks the Phase 13 release-engineering control plane for the repository.

## Structure

- `environments/`
  - environment pointers such as `staging.json`
  - records the current release, previous release, and change history
- `manifests/`
  - versioned release bundle manifests
  - one JSON file per release version

## Scope

This first slice provides:

- release versioning
- release bundle manifests tied to a git SHA
- environment promotion state
- rollback state transitions
- release-state verification for manifest and environment references
- workflow automation hooks

It does not yet provide:

- container image publishing
- Kubernetes apply automation
- traffic canaries
- production rollout orchestration

Those remain later Phase 13 work once deployable infrastructure assets are defined in-repo.
