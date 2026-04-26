# Evidence

Connector coordination, raw payload retention, sync-run tracking, normalized evidence documents/snippets, contradiction and supersession handling, and deterministic public-source ingestion orchestration now live here for the local Phase 3 slice.

The executable surface is fixture-backed and exposes:

- deterministic sync for `github` and `curated-community`
- OpenSearch-style search across `evidence-documents` and `evidence-snippets`
- finding-linked evidence lookup for analysis enrichment and explainability

Phase 8 adds the first live runtime boundary for this service:

- start the service with `pnpm --filter @modcompat/evidence exec tsx src/index.ts`
- health check it at `GET /healthz`
- use `EVIDENCE_HTTP_PORT` to run it alongside the gateway
- when `POSTGRES_URL` is configured, finding-linked lookups can hydrate persisted analyses created by gateway

NLP-heavy enrichment remains heuristic and deterministic in `packages/platform-core`; ML-driven extraction is still deferred to `apps/ml`.
