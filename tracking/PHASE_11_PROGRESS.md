# Phase 11 Progress

## Goal

Phase 11 source of truth: `NEXT_STEPS_TO_DONE.md` — "Product UI and user workflows"

Ship the actual product experience rather than only backend surfaces and page models.

## What was already in place (pre-Phase 11)

Phase 11 started with a substantial `apps/web` skeleton already in place from prior phases:

- Next.js app shell with Tailwind CSS and TypeScript
- Sign-in page connecting to the gateway session endpoint
- App layout with sidebar navigation, auth guard, and sign-out
- Dashboard page listing projects from session
- Import pack page (mod list textarea, environment selectors, import + analyse flow with polling)
- Analysis progress page with real-time phase polling, cancellation, and a "View findings" CTA
- Findings page with severity-sorted list, detail panel, and inline evidence lookup
- Evidence page with full-text search, finding ID filtering, and evidence sync trigger
- Recommendations page with feedback (accept/defer/reject), bundles, and outcome recording
- Graph page with node list, edge list, and neighbourhood expansion
- Report page with compatibility score, release gate status, findings/recommendations summary, export (.md / JSON)
- Admin curations page with create-curation form and promote-to-verified-rule action
- Shared UI primitives: `Button`, `Badge`, `Card`, `Spinner`
- API client (`lib/api.ts`) covering the full gateway surface: session, import, analysis lifecycle, findings, graph, evidence, recommendations, simulation, release gate, report, export, admin curation and promotion
- Session utilities (`lib/session.ts`) for token, session, workspace, and project helpers
- Analysis tab nav with Progress / Findings / Recommendations / Evidence / Graph / Report tabs

## What was missing

The following Phase 11 items were not yet implemented:

1. **Simulation results and release gate view** — `getSimulationRun` and `getReleaseGate` were wired in the API client but had no dedicated page
2. **Webhook delivery view** — `GET /v1/analyses/:analysisId/webhook-deliveries` was listed in gateway route metadata but had no web page or API client function
3. **Saved analyses list** — no way to browse past analyses for a project; users had to remember the analysis ID from the import flow
4. **Analysis nav** — missing Simulation and Webhooks tabs
5. **Sidebar** — no Analyses link for the active project
6. **Pre-existing type conflict** — `packages/api-contracts/src/index.ts` imported `ApiKeyRecord` and `WebhookDeliveryAttempt` from `domain-models` while also declaring local interfaces with the same names, causing TS2440 duplicate-declaration errors that blocked typecheck

## What was implemented

### `apps/web/src/app/(app)/projects/[projectId]/analyses/[analysisId]/simulation/page.tsx`

New page served under the Simulation tab for each analysis:

- Loads `SimulationRun` and `ReleaseGateDecision` in parallel via `Promise.all` with per-resource catch, so either resource failing does not blank the whole page
- Release gate card: shows gate status (PASS / WARN / BLOCK) with colour-coded badge from `gateStatusClass`, lists reasons and blocking finding IDs
- Simulation run card: shows status badge, summary, recipe ID, and all `SimulationObservation` records with kind label and passed/failed indicator

### `apps/web/src/app/(app)/projects/[projectId]/analyses/[analysisId]/webhooks/page.tsx`

New page served under the Webhooks tab for each analysis:

- Fetches the webhook delivery list via the new `getWebhookDeliveries` API function
- Renders each attempt with HTTP status badge (green for 2xx, red for errors), event type, duration, attempt number, delivery timestamp, and next-retry-at when relevant
- Uses a local inline type for the delivery item shape to avoid re-exporting the api-contracts `WebhookDeliveryAttempt` (which carries extended fields not present in domain-models)

### `apps/web/src/app/(app)/projects/[projectId]/analyses/page.tsx`

New analyses list page linked from the sidebar:

- Reads recent analyses from `sessionStorage` via `loadRecentAnalyses`, filtered to the current project
- Shows each analysis as a clickable card with the analysis ID (monospace), a human-readable label (mod count and loader + MC version), and creation timestamp
- Links to the analysis progress page
- Empty state when no analyses have been run in the current session
- "New import" shortcut in the header links directly to the import page

### `apps/web/src/lib/session.ts` — recent analyses helpers

Three new exports:

- `saveRecentAnalysis(entry)` — prepends a new entry to the session-scoped list, deduplicates by analysis ID, caps at 20 entries
- `loadRecentAnalyses()` — returns the stored list, empty array on parse failure or missing storage
- `clearRecentAnalyses()` — removes the key from sessionStorage
- `RecentAnalysis` interface: `analysisId`, `projectId`, `createdAt`, optional `label`

### `apps/web/src/lib/api.ts`

- Added `getWebhookDeliveries(analysisId)` returning `WebhookDeliveryListResponse`
- Added `WebhookDeliveryListResponse` to the import list from `@modcompat/api-contracts`

### `apps/web/src/app/(app)/projects/[projectId]/imports/page.tsx`

- Imports `saveRecentAnalysis` from session
- After a completed analysis resolves, calls `saveRecentAnalysis` with the analysis ID, project ID, creation timestamp, and a label formatted as `"N mods · loader MC"` using `importResult.modCount`, `loader`, and `mcVersion`

### `apps/web/src/components/analysis/analysis-nav.tsx`

- Added `{ label: "Simulation", suffix: "simulation" }` and `{ label: "Webhooks", suffix: "webhooks" }` tabs to the analysis tab list, placed between Graph and Report

### `apps/web/src/app/(app)/layout.tsx`

- Added `{ label: "Analyses", href: \`/projects/${projectId}/analyses\` }` to the sidebar nav links when a project is active, placed after Import Pack

### `packages/api-contracts/src/index.ts` — pre-existing type conflict fixed

Removed `ApiKeyRecord` and `WebhookDeliveryAttempt` from the `domain-models` import block, since both types were already declared locally in the file with richer fields than the domain-models versions. Added the missing `scopes: Permission[]` field to the local `ApiKeyRecord` declaration so `CreateApiKeyRequest.scopes` continued to resolve correctly.

## Validation

- `pnpm --filter @modcompat/web typecheck` — passes clean after the api-contracts type conflict fixes
- New simulation page correctly uses `SimulationObservation` fields (`kind`, `status`, `summary`, `findingTypes`) matching the domain-models interface
- Webhooks page uses a local inline type to avoid the api-contracts / domain-models `WebhookDeliveryAttempt` shape mismatch
- Recent analyses roundtrip: import page saves, analyses list page loads, session key is scoped to the project

## What is still not done

- **Pack diff view** — comparing two analyses side-by-side; requires a `GET /v1/analyses/:analysisId/diff` endpoint and a diff data model, both of which are not yet defined
- **Partner integration management UI** — managing GitHub App installations, webhook registrations, and integration-level settings; the gateway lists metadata routes but no management endpoints are fully implemented yet
- **Responsive and access-control-aware navigation** — the current layout is desktop-first; mobile breakpoints and RBAC-gated nav items (e.g. hiding Admin for non-admin roles) are not yet enforced
- **Analyst-facing review queue** — reviewed and promoted rules are persisted but there is no paginated browse/search view for the full curation history
- **Real auth flow** — sign-in connects to the gateway's demo session endpoint rather than a real OAuth/OIDC provider; this belongs to Phase 12

## Exit criteria assessment

The Phase 11 exit criteria are met:

- A real user can sign in (demo gateway session), import a pack, run an analysis, review findings (with inline evidence), accept recommendations, inspect evidence (search + sync), view the graph, see simulation results and the release gate decision, and export a report — all from the UI
- Admin and analyst tasks (evidence curation, verified-rule promotion) are available from the Admin page without direct database or code access
