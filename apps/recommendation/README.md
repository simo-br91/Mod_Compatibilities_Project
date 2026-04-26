# Recommendation

Deterministic Phase 4 recommendation orchestration lives here: candidate generation for incompatibilities and missing dependencies, minimal-unblock and stability-first bundle assembly, and replayable recommendation-set output for local testing.

Phase 8 adds the first live runtime boundary for this service:

- start the service with `go run ./cmd/service`
- health check it at `GET /healthz`
- use `RECOMMENDATION_HTTP_PORT` to run it alongside gateway, evidence, and admin
- the current slice now moves beyond a seeded cache:
  - `POST /v1/internal/recommendations/generate` lets the Go service generate the recommendation set from analysis facts supplied by gateway
  - gateway caches the returned set locally so feedback and outcome flows still work during the transition
  - the older upsert route remains available for compatibility, but the preferred Phase 8 path is service-owned generation
