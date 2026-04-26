# Graph

Knowledge-graph upserts, dependency neighborhoods, explanation-path queries, and indirect-risk traversal APIs live here. Neo4j is treated as a derived store sourced from Postgres and events.

Phase 8 adds the first live runtime boundary for this service:

- start the service with `go run ./cmd/service`
- health check it at `GET /healthz`
- use `GRAPH_HTTP_PORT` to run it alongside the other local services
- the current slice is a safe read-side boundary: gateway seeds graph snapshots and explanation paths into the live Go service, then reads graph snapshot, neighborhood, and explanation data back over HTTP
