# Phase 8 Progress

## Goal area

- Phase 8 source of truth: real service execution and integration boundaries from `NEXT_STEPS_TO_DONE.md`
- Scope implemented as the first live service-boundary slice while preserving the current working Phase 7 persistence and demo flow

## Selected first slice

- Recommended architectural fork:
  - Option 1: move gateway-to-admin first
  - Option 2: move gateway-to-evidence first
- Recommendation: gateway-to-evidence first
  - evidence already has a clean, deterministic API surface
  - search and sync are naturally service-shaped
  - finding-linked evidence can reuse the new Phase 7 Postgres hydration seam
  - admin promotion would immediately create split runtime state for verified rules across processes

## Selected next slice

- Recommended architectural fork:
  - Option 1: move simulation execution fully into a live service call from the orchestrator now
  - Option 2: first remove the seeded simulation read path by letting the simulation service hydrate runs from the live orchestrator
- Recommendation: Option 2 first
  - it removes the highest-friction seeded read path without forcing an async refactor of the current deterministic orchestrator core
  - it mirrors the safer graph-derivation pattern already present in the repo
  - it keeps the current Phase 7 persistence-backed demo flow intact while preparing the later execution handoff

## Selected additional slices

- Recommended architectural fork:
  - Option 1: force graph and simulation service-owned reads with no fallback and take whatever regressions shake out
  - Option 2: keep preferring service-owned reads, but add explicit fallback so mixed-mode local/demo analyses remain safe while the runtime owner transition continues
- Recommendation: Option 2 first
  - it removes another mixed-mode sharp edge without breaking the current demo path
  - it keeps graph aligned with the safer simulation handoff approach
- Recommended architectural fork:
  - Option 1: wait for a full durable worker topology before introducing cancellation at all
  - Option 2: add the first explicit accepted/status/cancel lifecycle now, limited to cancellation before execution begins
- Recommendation: Option 2 first
  - it gives the platform its first honest cancellation contract immediately
  - it improves the gateway-facing orchestrator lifecycle without pretending mid-execution cooperative cancellation already exists
- Recommended architectural fork:
  - Option 1: keep recommendation reads gateway-pushed and leave recommendation feedback/outcome writes in-process until a later broader rewrite
  - Option 2: move recommendation toward service-owned read and write ownership now, while keeping a fallback seam so mixed-mode demo analyses still work
- Recommendation: Option 2 first
  - it finishes the next most self-contained service boundary without forcing the larger simulation-execution refactor yet
  - it removes another split-brain boundary where reads lived remotely but recommendation mutations still happened only in-process
  - it follows the same productionizing pattern that already worked for graph and simulation: live owner first, explicit fallback second

## What was implemented

- `packages/config` now supports service-specific HTTP ports via `<SERVICE>_HTTP_PORT`, so gateway and evidence can run at the same time without shell hacks.
- `apps/evidence` now runs as a real HTTP service instead of only printing route metadata:
  - `GET /healthz`
  - `POST /v1/evidence/sync`
  - `POST /v1/evidence/search`
  - `GET /v1/analyses/:analysisId/findings/:findingId/evidence`
- The evidence service now emits and forwards request-scoped `x-request-id` and `x-trace-id` headers on every HTTP response.
- The evidence service now returns a structured error envelope with code, retryability, request ID, and trace ID instead of raw string-only failures.
- The evidence service now attempts Phase 7 Postgres-backed analysis hydration before serving finding-linked evidence lookups, so a persisted analysis created by gateway can be resolved across the process boundary.
- The evidence sync boundary now requires a deterministic `x-idempotency-key` and replays duplicate sync requests within the service process instead of re-running the same seeded sync work.
- `apps/gateway` now supports an optional live evidence boundary:
  - if `EVIDENCE_SERVICE_URL` is unset, gateway keeps using the existing in-process evidence service
  - if `EVIDENCE_SERVICE_URL` is set, gateway calls the live evidence service over HTTP for evidence sync, search, and finding-linked evidence lookup
- The gateway demo entrypoint now validates the selected evidence runtime mode and reports:
  - whether evidence stayed in-process or crossed the HTTP boundary
  - synced document count
  - remote search hit count
  - linked-evidence lookup result when Postgres-backed hydration is available
- `packages/platform-core` persistence now supports shared admin state for:
  - `evidence_curations`
  - `verified_rules`
  - rehydrating promoted rules back into the in-memory runtime
- `apps/admin` now runs as a real HTTP service with:
  - `GET /healthz`
  - `POST /v1/admin/evidence-curations`
  - `POST /v1/admin/evidence-curations/:curationId/promote`
- The admin service now returns the same structured error envelope shape used by the orchestrator and evidence services.
- The gateway now supports an optional live admin boundary:
  - if `ADMIN_SERVICE_URL` is unset, gateway keeps using the existing in-process admin/evidence promotion path
  - if `ADMIN_SERVICE_URL` is set, gateway creates curations and promotes verified rules through the live admin service over HTTP
  - after remote promotion, gateway rehydrates persisted admin state so future in-process analyses can see the promoted rule immediately
- The gateway now normalizes structured evidence/admin error payloads into clearer boundary errors instead of surfacing raw response blobs.
- The admin write boundary now has replay-safe idempotency for:
  - evidence curation creation
  - verified-rule promotion
  - duplicate submissions replay the original curation or promotion response instead of creating new state
- `apps/recommendation` now runs as a live Go HTTP service with:
  - `GET /healthz`
  - `POST /v1/internal/recommendations/generate`
  - `POST /v1/internal/recommendations/sets`
  - `GET /v1/analyses/:analysisId/recommendations`
  - `POST /v1/recommendations/:recommendationId/feedback`
  - `POST /v1/recommendation-sets/:recommendationSetId/outcomes`
- The recommendation service now returns structured JSON errors with code, retryability, request ID, and trace ID.
- The gateway now supports an optional live recommendation boundary:
  - if `RECOMMENDATION_SERVICE_URL` is unset, gateway keeps using the in-process recommendation service
  - if `RECOMMENDATION_SERVICE_URL` is set, gateway now sends analysis facts and snapshot context to the live Go service, which generates the recommendation set itself and serves it back over HTTP
- The recommendation generation route now requires `x-idempotency-key` and replays duplicate generation requests within the service process.
- The orchestrator now exposes `GET /v1/internal/analyses/:analysisId/recommendation-context`, so downstream services can hydrate recommendation generation input directly from the current runtime owner instead of depending on a gateway-pushed payload for every read.
- The recommendation service can now lazy-generate a recommendation set from that live orchestrator context on cache miss when `ORCHESTRATOR_SERVICE_URL` is configured.
- The orchestrator now returns a structured `404 recommendation_context_not_found` response for missing internal recommendation hydration instead of surfacing that case as a generic `500`.
- The gateway now gives recommendation the same mixed-mode transition seam as graph and simulation:
  - when both recommendation and orchestrator boundaries are live, gateway prefers the service-owned recommendation read first
  - if the live recommendation service responds `404` for a locally available analysis, gateway falls back to the existing payload-push generation path once and then reads the set back from the service
  - this keeps local/demo analyses working while the recommendation runtime shifts toward owning its own read path
- Recommendation feedback and outcome writes now also cross the live recommendation boundary when it is enabled instead of mutating only the in-process service.
- The recommendation feedback and outcome routes now require `x-idempotency-key` and replay duplicate write requests within the service process, bringing recommendation write semantics closer to the other replay-safe Phase 8 boundaries.
- The gateway now rehydrates local recommendation state from remote recommendation-set, feedback, and outcome responses so the rest of the still-in-process demo flow stays coherent after boundary-owned writes.
- The gateway demo entrypoint now exercises recommendation feedback and outcome updates through the active gateway runtime, and in live-boundary mode it also validates replay safety for those writes.
- `apps/graph` now runs as a live Go HTTP service with:
  - `GET /healthz`
  - `POST /v1/internal/graph/upsert`
  - `GET /v1/internal/graph/snapshot`
  - `GET /v1/internal/graph/neighborhood`
  - `POST /v1/internal/graph/explanations`
  - `GET /v1/internal/graph/explanations`
- The graph service now returns the same structured JSON error envelope instead of plain text errors.
- The gateway now supports an optional live graph boundary:
  - if `GRAPH_SERVICE_URL` is unset, gateway keeps using the in-process graph service
  - if `GRAPH_SERVICE_URL` is set, gateway seeds graph snapshots and explanation paths into the live Go service and reads graph data back over HTTP
- The graph service can also derive graph snapshots and explanation paths from the live orchestrator on cache miss, and gateway now prefers that service-owned derivation path whenever both graph and orchestrator boundaries are live.
- The orchestrator now returns a structured `404 graph_context_not_found` response for missing internal graph-context hydration instead of surfacing that case as a generic `500`.
- The gateway now gives graph the same mixed-mode safety seam as simulation:
  - when both graph and orchestrator boundaries are live, gateway prefers service-owned graph derivation first
  - if the live graph service responds `404` for a locally available analysis, gateway falls back to syncing the local graph/explanation once and then retries the live read
  - this keeps the current local demo analysis path working while graph transitions away from gateway-seeded ownership
- The graph upsert and explanation write routes now require `x-idempotency-key` and replay duplicate gateway seed writes within the service process.
- `apps/simulation` now runs as a live Go HTTP service with:
  - `GET /healthz`
  - `POST /v1/internal/simulation/runs`
  - `GET /v1/internal/simulation/runs`
  - `GET /v1/analyses/:analysisId/simulation`
- The simulation service now returns the same structured JSON error envelope instead of plain text errors.
- The gateway now supports an optional live simulation boundary:
  - if `SIMULATION_SERVICE_URL` is unset, gateway keeps using the in-process simulation service
  - if `SIMULATION_SERVICE_URL` is set, gateway seeds the simulation run into the live Go service and reads it back over HTTP
- The orchestrator now exposes `GET /v1/internal/analyses/:analysisId/simulation-run`, so downstream services can hydrate an existing simulation run from the live runtime owner instead of requiring a gateway seed write first.
- The simulation service can now hydrate simulation runs from the live orchestrator on cache miss when `ORCHESTRATOR_SERVICE_URL` is configured.
- The gateway now prefers that service-owned simulation hydration path whenever both simulation and orchestrator boundaries are live, while still falling back to the existing sync path on `404` so the local demo analysis flow keeps working.
- The gateway demo entrypoint now awaits the simulation lookup explicitly, so the live simulation boundary path is handled correctly when it resolves asynchronously.
- The simulation run upsert route now requires `x-idempotency-key` and replays duplicate gateway seed writes within the service process.
- The gateway now normalizes structured error payloads from recommendation, graph, and simulation services the same way it does for the TypeScript boundaries.
- `apps/analysis-orchestrator` now runs as a live TypeScript HTTP service for the current runtime-owner path with:
  - `GET /healthz`
  - `POST /v1/analyses`
  - `GET /v1/analyses/:analysisId`
- The gateway now supports an optional live orchestrator boundary:
  - if `ORCHESTRATOR_SERVICE_URL` is unset, gateway keeps using the in-process orchestrator
  - if `ORCHESTRATOR_SERVICE_URL` is set, gateway persists import state to Postgres, submits the analysis request to the live orchestrator service, and reads the completed analysis back over HTTP
- The orchestrator service now owns deterministic execution for the current pack-snapshot path:
  - it hydrates the requested snapshots and shared verified-rule state from Postgres
  - it accepts the request and executes the existing deterministic orchestration pipeline asynchronously in its own process
  - it persists the completed analysis back to Postgres
- The orchestrator boundary now has the first shared retry/idempotency seam:
  - gateway sends a deterministic `x-idempotency-key` for analysis submission
  - the orchestrator service persists dedupe records for `create-analysis`
  - duplicate submissions replay the original result instead of creating a second analysis
  - service errors now return a structured envelope with code, retryability, request ID, and trace ID
- The orchestrator boundary now has the first async lifecycle seam:
  - `POST /v1/analyses` returns an accepted in-progress response for new work
  - `GET /v1/analysis-requests/:idempotencyKey` exposes request status polling
  - gateway polls until the request reaches a terminal state, then reads the final analysis by ID
- The orchestrator boundary now has the first explicit cancellation seam:
  - service request state now supports `cancelled` alongside `started`, `completed`, and `failed`
  - `POST /v1/analysis-requests/:idempotencyKey/cancel` cancels an accepted request before execution begins
  - gateway now exposes submit/status/cancel request handlers and route metadata for that lifecycle
  - duplicate local or persisted request submissions now respect the existing in-flight or cancelled request state instead of always starting a fresh run in no-Postgres mode
- The current cancellation implementation is intentionally honest about scope:
  - requests are cancellable during the accepted/scheduled window before background execution starts
  - once deterministic execution has started, the current pipeline is not yet cooperatively cancellable mid-flight
- The gateway now caches the remotely executed analysis result locally after readback so recommendation, graph, simulation, and other still-in-process services continue to work during the transition
- `apps/artifact-analysis` now has the first real JVM execution boundary for artifact analysis:
  - `ArtifactAnalysisBoundary.java` runs through Java source-file mode and accepts artifact-analysis requests over stdin/stdout
  - `packages/platform-core` can route overlap and embedded-library divergence analysis through that JVM process when `ARTIFACT_ANALYSIS_JAVA_SOURCE` is configured
  - TypeScript still builds the artifact records locally, but the decisioning for overlap/divergence now crosses a real runtime boundary into the JVM

## Validation

- `pnpm typecheck`
- `pnpm contracts:check`
- `pnpm exec tsx --test apps/analysis-orchestrator/src/index.test.ts`
- `go test ./...` in `apps/recommendation` with workspace-local `GOCACHE` and `GOTELEMETRY=off`
- `go test ./...` in `apps/simulation` with workspace-local `GOCACHE` and `GOTELEMETRY=off`
- `go test ./...` in `apps/graph` with workspace-local `GOCACHE` and `GOTELEMETRY=off`
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts`
- `pnpm --filter @modcompat/evidence exec tsx src/index.ts` started as a live HTTP process
- `pnpm --filter @modcompat/analysis-orchestrator exec tsx src/index.ts` started as a live HTTP process
- `pnpm --filter @modcompat/gateway exec tsx src/index.ts` with:
  - `EVIDENCE_SERVICE_URL=http://127.0.0.1:8081`
  - `EVIDENCE_HTTP_PORT=8081`
  - `ADMIN_SERVICE_URL=http://127.0.0.1:8082`
  - `ADMIN_HTTP_PORT=8082`
  - `RECOMMENDATION_SERVICE_URL=http://127.0.0.1:8083`
  - `RECOMMENDATION_HTTP_PORT=8083`
  - `GRAPH_SERVICE_URL=http://127.0.0.1:8084`
  - `GRAPH_HTTP_PORT=8084`
  - `SIMULATION_SERVICE_URL=http://127.0.0.1:8085`
  - `SIMULATION_HTTP_PORT=8085`
  - `ORCHESTRATOR_SERVICE_URL=http://127.0.0.1:8086`
  - `ORCHESTRATOR_HTTP_PORT=8086`
  - `GATEWAY_HTTP_PORT=8080`
  - `POSTGRES_URL` configured so the evidence service can hydrate linked analyses
- live orchestrator replay validation confirmed `idempotentReplaySameAnalysis: true`
- live orchestrator async validation confirmed request-status polling before final analysis readback
- live admin replay validation confirmed:
  - `curationReplaySameId: true`
  - `promotionReplaySameRule: true`
- live evidence replay validation confirmed `replaySameDocumentIds: true`
- live gateway-seeded Go boundary replay validation confirmed:
  - `recommendation.replaySameSetId: true`
  - `graph.replaySameShape: true`
  - `simulation.replaySameRunId: true`
- new simulation hydration coverage confirmed:
  - the Go simulation service now lazy-loads a run from `/v1/internal/analyses/:analysisId/simulation-run` on cache miss in `apps/simulation/internal/app/service_test.go`
  - TypeScript typecheck passed after switching gateway to prefer service-owned simulation reads when the live orchestrator boundary is present
- new recommendation ownership coverage confirmed:
  - the Go recommendation service now lazy-loads generation context from `/v1/internal/analyses/:analysisId/recommendation-context` on cache miss in `apps/recommendation/internal/app/service_test.go`
  - the TypeScript orchestrator server test now verifies missing internal recommendation, graph, and simulation hydration routes return clean `404` envelopes instead of generic failures
  - TypeScript typecheck passed after switching gateway to prefer service-owned recommendation reads and to route recommendation feedback/outcome writes over the live boundary when enabled
- new orchestrator lifecycle coverage confirmed:
  - the TypeScript orchestrator server test now verifies an accepted analysis request can be cancelled before background execution starts and remains terminally `cancelled`
- new graph mixed-mode coverage confirmed:
  - TypeScript typecheck passed after adding service-owned graph preference with fallback back to local graph/explanation sync on `404`
- live JVM artifact-analysis validation confirmed:
  - the Java boundary emitted overlap and divergence records for fixture-equivalent artifact inputs
  - gateway reported `artifactAnalysis.mode: "jvm-process"` during the end-to-end run
- attempted live gateway/orchestrator/simulation smoke in this session was blocked by local Postgres availability:
  - `localhost:5432` was not accepting TCP connections here
  - the existing live gateway-orchestrator demo path still depends on Postgres-backed import/analysis hydration before the full end-to-end smoke can complete

## What this slice proves

- gateway can drive a live downstream TypeScript service over HTTP without breaking the Phase 7 persistence-backed demo flow
- the evidence service can be started and health-checked independently
- a persisted analysis can cross the new runtime boundary for read-side evidence lookup
- failure semantics are now explicit at the transport layer instead of being hidden by in-process calls
- admin curation and verified-rule promotion can now cross a real HTTP boundary without losing rule state on service restart
- the gateway can pull promoted rules back from Postgres so the existing in-process analysis flow remains usable during the transition
- admin write retries can now replay safely instead of creating duplicate curation or promotion side effects
- evidence sync retries can now replay safely inside the live service process instead of re-running the same seeded sync work
- evidence, admin, and orchestrator now share the same basic transport-level error shape for request tracing and clearer cross-service failures
- gateway can now cross a real TypeScript-to-Go boundary for recommendation retrieval without changing the current in-process analysis creation path
- gateway can now cross a real TypeScript-to-Go boundary for graph snapshot, neighborhood, and explanation retrieval without changing the current in-process analysis creation path
- gateway can now cross a real TypeScript-to-Go boundary for simulation run retrieval without changing the current in-process analysis creation path
- recommendation, graph, and simulation now share that same basic transport-level error shape as well
- the currently seeded Go write boundaries now have explicit replay-safe semantics for the gateway's repeated sync/upsert calls, which reduces duplicate side effects during retries while service ownership is still mixed-mode
- recommendation generation is now genuinely service-owned inside the Go boundary instead of only storing a recommendation set prebuilt by TypeScript
- recommendation reads can now be hydrated from live orchestrator-owned context instead of always requiring gateway to push a generation payload first
- recommendation feedback and outcome writes can now cross the live Go boundary too, so recommendation state no longer has to split between a remote read path and local-only mutation path
- graph snapshot and explanation reads can now be service-derived from live orchestrator context instead of only replaying gateway-seeded state
- graph reads now have the same safe mixed-mode fallback behavior as simulation, so service-owned preference no longer has to break local-only analyses during the transition
- simulation run reads can now be hydrated from the live orchestrator instead of only depending on gateway-seeded state
- the simulation boundary can move toward runtime ownership incrementally without regressing the existing demo flow, because the gateway still has a safe fallback for local-only analyses
- gateway can now cross a real runtime-owner orchestration boundary for analysis execution and analysis-result retrieval
- the orchestrator service can execute from persisted snapshot state instead of depending on gateway's in-memory runtime
- the gateway can keep mixed-mode read paths working by caching the remotely executed analysis back into its local runtime
- the orchestrator boundary now has an explicit replay-safe submission contract for client retries
- the orchestrator boundary now exposes an explicit accepted/poll/completed lifecycle instead of only synchronous submission
- the orchestrator boundary now exposes the first real cancel operation with an explicit terminal `cancelled` state, which is a meaningful step toward durable workflow control even though cooperative mid-flight cancellation is still ahead
- the artifact-analysis phase can now cross a real TypeScript-to-JVM boundary without changing the rest of the deterministic analysis pipeline

## Second implementation slice

### What was implemented

- `packages/api-contracts` now exports a shared `ServiceErrorEnvelope` interface plus `IDEMPOTENCY_KEY_HEADER` and `IDEMPOTENT_REPLAY_HEADER` constants so all platform services share a single typed error envelope definition rather than each duplicating the same inline interface.
- `apps/admin` now has in-memory replay caches (`curationReplayCache`, `promotionReplayCache`) that replay completed create-curation and promote-verified-rule results when Postgres is not available, matching the no-Postgres replay safety already present in the evidence service's sync path.
- `packages/platform-core` `TemporalBackedAnalysisOrchestrator.createAnalysis` now accepts an optional `AbortSignal` and calls `checkCancelled(signal)` between every major phase boundary (normalization → resolution → rule_evaluation → static_analysis → graph_enrichment → merge_findings → evidence_enrichment → risk_scoring → simulation). This gives the pipeline its first cooperative cancellation contract at phase granularity.
- A new `AnalysisCancelledError` class is exported from `packages/platform-core` and `orchestration.ts` so callers can distinguish a cooperative cancellation from a genuine execution failure.
- `apps/analysis-orchestrator` now creates an `AbortController` per analysis request, stores it in `cancellationControllers: Map<string, AbortController>`, and passes the signal to `executeAnalysis`. When a cancel is requested for an in-flight analysis, the controller's `abort()` is called immediately and the HTTP response is `202 Accepted` rather than `409 Conflict`. The background runner catches `AnalysisCancelledError` and transitions the request state to `cancelled` rather than `failed`.
- The orchestrator's `POST /v1/analyses` handler now resolves `inputRef.type === "import"` to its associated `packSnapshotId` before executing, via the new `resolveInputRefSnapshotId` helper. When Postgres is enabled, `hydrateExecutionContext` hydrates all project imports first so the resolution works across the process boundary. The `manifest` and `uploaded_mods` input types fall through to a direct snapshot ID lookup (full processing for those types is deferred to Phase 9).
- `apps/artifact-analysis` now has a long-lived HTTP service mode:
  - `ArtifactAnalysisBoundary.java` now exposes `static String processInput(String input)` extracted from `main()` so both the subprocess and HTTP code paths share the same analysis logic.
  - `ArtifactAnalysisServer.java` is a new JDK-only HTTP server (no external dependencies, uses `com.sun.net.httpserver.HttpServer` with virtual threads) that exposes `GET /healthz` and `POST /v1/artifact-analysis/analyze`. It calls `ArtifactAnalysisBoundary.processInput()` on each request and returns the same tab-delimited output.
  - `ArtifactAnalysisService` in `packages/platform-core` now supports a third mode `"jvm-http"` when `ARTIFACT_ANALYSIS_SERVICE_URL` is set. In this mode, it sends the serialized artifact payload to the live service via a synchronous Node subprocess HTTP call (keeping the current synchronous pipeline intact) and parses the same response format.

### Validation

- `pnpm typecheck` passes clean
- `pnpm contracts:check` passes
- `pnpm exec tsx --test apps/analysis-orchestrator/src/index.test.ts` — all 4 tests pass:
  - `analysis requests with inputRef.type 'import' resolve to the import's snapshot`
  - `in-flight analysis requests can be cooperatively cancelled via abort signal`
  - `accepted analysis requests can be cancelled before background execution starts`
  - `internal recommendation, graph, and simulation hydration routes return 404 for unknown analyses`

### What this slice proves

- every service that returns an error now has a single canonical type definition for the error envelope in `api-contracts` rather than each service maintaining its own copy
- admin write retries now replay safely even without Postgres, matching the pattern already in evidence sync
- analyses in the deterministic pipeline can now be aborted cooperatively between phases, not just before they start, which is the first real in-flight cancellation contract in the platform
- cancellation of a running analysis now signals the abort controller and waits for the phase-boundary check rather than immediately rejecting with 409; the request lifecycle is now honest about the intermediate "cancel requested" state
- the orchestrator can now accept analysis requests for any previously-imported pack, not only those where the caller already holds the snapshot ID
- the JVM artifact-analysis service can now run as a persistent HTTP server alongside the rest of the platform services, removing the per-analysis subprocess spawn overhead and enabling health-checking and independent deployment

## Remaining work inside Phase 8

- full cross-service retry, idempotency, and tracing standards are not yet unified: Go services (graph, recommendation, simulation) still use in-memory-only replay caches with no durable persistence, while the TypeScript services have Postgres-backed deduplication; the platform needs a shared durable replay contract
- the `manifest` and `uploaded_mods` input types are passed through without import processing; a real ingest path for those types belongs in Phase 9 (Live data ingestion)
- cooperative cancellation works at phase granularity; sub-phase and real durable worker cancellation (Temporal signal-based) are still ahead once the Temporal worker topology replaces the in-process deterministic runner
- the JVM HTTP service uses a synchronous Node subprocess for the HTTP call so the current synchronous orchestration pipeline stays intact; this should become a real async fetch once the pipeline moves to an async Temporal worker

## What is still not done

- the evidence runtime is live, but it still uses deterministic fixtures and in-memory indexing rather than OpenSearch-backed execution
- the recommendation runtime is live and can now derive generation input from live orchestrator context, but it still relies on in-memory cache/runtime state rather than durable persisted analysis/event streams
- the graph runtime is live and can now derive from live orchestrator context, but it still depends on in-memory derivation plus orchestrator-provided context rather than Postgres/events or Neo4j
- the simulation runtime is live and can now hydrate existing runs from the live orchestrator, but the orchestrator still performs the deterministic simulation phase in-process and the service is not yet the runtime owner for execution itself
- the orchestrator runtime now owns deterministic execution for the current pack-snapshot and import input flows, but it still reuses the shared TypeScript platform code rather than a durable Temporal worker topology
- the orchestrator now supports cooperative in-flight cancellation at phase boundaries, but sub-phase cooperative cancellation, durable worker cancellation, and richer retry policies are still ahead
