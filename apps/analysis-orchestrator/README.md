# Analysis Orchestrator

Durable workflow ownership lives here. Temporal is the authoritative orchestration layer for analysis execution, retries, fan-out, and incremental re-analysis.

Phase 8 now includes the first real execution-ownership slice for this service:

- start the current runtime-owner service with `pnpm --filter @modcompat/analysis-orchestrator exec tsx src/index.ts`
- health check it at `GET /healthz`
- use `ORCHESTRATOR_HTTP_PORT` to run it alongside the other local services
- the current slice moves execution ownership out of gateway for the pack-snapshot path:
  - gateway persists import and snapshot state to Postgres
  - gateway submits the analysis request to the live orchestrator service
  - the service accepts the request and runs it asynchronously
  - the orchestrator service hydrates the persisted snapshot and shared admin state
  - the orchestrator service executes the deterministic analysis pipeline itself
  - the orchestrator service persists the completed analysis
  - gateway polls request status, then reads the analysis back over HTTP and rehydrates its local runtime cache so the still-in-process services keep working
  - gateway retries are now replay-safe through `x-idempotency-key` backed by persisted dedupe records
  - duplicate submissions return the original analysis result instead of creating a second analysis

The older Go HTTP service remains in the repo as the earlier boundary prototype, but the TypeScript HTTP service is the current Phase 8 runtime-owner path because it can safely reuse the existing deterministic orchestration implementation.
