# Temporal Workflows

Phase 1 introduces the first Temporal-backed orchestration boundary for deterministic analysis:

- workflow execution identity is tracked alongside analyses
- each deterministic phase persists progress and artifacts
- findings and recommendations are materialized from the workflow run

The current repository implementation uses an in-repo Temporal adapter abstraction so the orchestration flow, event model, and persistence seams are wired before the external Temporal runtime is integrated.
