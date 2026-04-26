# Simulation

Deterministic simulation replay and smoke-test execution live here.

Phase 8 adds the first live runtime boundary for this service:

- start the service with `go run ./cmd/service`
- health check it at `GET /healthz`
- use `SIMULATION_HTTP_PORT` to run it alongside the other local services
- the current slice is a safe read-side boundary: gateway seeds the simulation run into the live Go service, then reads it back over HTTP

Deterministic Phase 6 simulation lives here: replayable smoke-test recipes, crash-signature reproduction for known conflict paths, and simulation output that can feed release-gating and confidence updates.
