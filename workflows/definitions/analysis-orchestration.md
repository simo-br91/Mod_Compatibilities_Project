# Analysis Orchestration Definition

Phase order aligned to the source documents:

1. ingestion and normalization
2. deterministic compatibility analysis
3. rule evaluation
4. alternative recommendation
5. report materialization and notifications

Phase 1 implements the deterministic workflow path with persisted phases and events:

- normalization
- resolution
- rule_evaluation
- recommendation
- reporting

The implementation models these steps as a Temporal-backed workflow boundary with persisted workflow execution state, analysis phases, and progress events.
