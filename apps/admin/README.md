# Admin

Human curation, verified-rule promotion, evidence moderation, and analyst review workflows belong here.

The local Phase 3 implementation now exposes the first usable admin slice:

- create analyst evidence curations from document/snippet selections
- generate a deterministic verified-rule draft from curated evidence
- promote the curated draft into the in-memory verified-rule registry used by analysis

Phase 8 adds the first live runtime boundary for this service:

- start the service with `pnpm --filter @modcompat/admin exec tsx src/index.ts`
- health check it at `GET /healthz`
- use `ADMIN_HTTP_PORT` to run it alongside gateway and evidence
- when `POSTGRES_URL` is configured, curated drafts and promoted verified rules are persisted and can be rehydrated across service restarts
