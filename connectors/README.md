# Connector Adapters

Real HTTP connector adapters for the Modpack Compatibility Platform.  Each
adapter implements the `LiveConnectorAdapter` interface from
`@modcompat/platform-core` and can be dropped into the
`EvidenceIngestionPipeline` to pull live data from the corresponding source.

All adapters use Node's built-in `fetch` (Node 18+) — no external HTTP
dependencies are required.

---

## CurseForge (`curseforge/index.ts`)

Fetches mod metadata and file/release entries from the CurseForge API v2.

### Constructor

```ts
import CurseForgeAdapter from "./connectors/curseforge/index.js";

const adapter = new CurseForgeAdapter({
  apiKey: process.env.CF_API_KEY!,
  // Optional: target specific mods instead of doing a global search
  projectIds: [238222, 306612],   // numeric mod IDs
  modIds: [549249],               // alias for projectIds — both are merged
});
```

| Option | Type | Description |
|---|---|---|
| `apiKey` | `string` | Required. CurseForge API key from the developer console. |
| `projectIds` | `number[]` | Optional. Fetch file/release history for these mod IDs only. |
| `modIds` | `number[]` | Optional. Alias for `projectIds` — both lists are merged. |

### Behaviour

- **Without `projectIds`/`modIds`**: pages through
  `GET /v1/mods/search?gameId=432&sortField=2&sortOrder=desc` (sorted by
  last-updated), returning `release_note` items with
  `externalId = cf_mod_{id}`.
- **With `projectIds`/`modIds`**: iterates over each mod and pages through
  `GET /v1/mods/{modId}/files`, returning `release_note` items with
  `externalId = cf_file_{id}`.
- Checkpoint: `{ offset, modIndex?, modOffsets? }`.
- Rate limiting: returns partial results with `hasMore: true` on 429 so the
  scheduler retries naturally.
- Throws on 401/403 (invalid API key).

---

## Modrinth (`modrinth/index.ts`)

Fetches project search results and per-project version entries from the
Modrinth API v2.

### Constructor

```ts
import ModrinthAdapter from "./connectors/modrinth/index.js";

const adapter = new ModrinthAdapter({
  userAgent: "myapp/1.0 (contact@example.com)", // required by Modrinth ToS
  // Optional: target specific projects
  projectIds: ["AANobbMI", "P7dR8mSH"],
  // Optional: custom facet filter (default: [["project_type:mod"]])
  facets: [["project_type:mod"], ["categories:fabric"]],
  // Optional: API key for higher rate limits
  apiKey: process.env.MODRINTH_TOKEN,
});
```

| Option | Type | Description |
|---|---|---|
| `userAgent` | `string` | Required. Wrapped as `modcompat-platform/1.0 ({userAgent})`. |
| `projectIds` | `string[]` | Optional. Fetch version history for these projects only. |
| `facets` | `string[][]` | Optional. Modrinth search facets. Default: `[["project_type:mod"]]`. |
| `apiKey` | `string` | Optional. Modrinth PAT for higher rate limits. |

### Behaviour

- **Without `projectIds`**: pages through `GET /v2/search` with the
  configured facets, returning `curated_post` items with
  `externalId = mr_proj_{project_id}`.
- **With `projectIds`**: iterates over each project and pages through
  `GET /v2/project/{id}/version`, returning `release_note` items with
  `externalId = mr_ver_{id}`.
- Respects `X-Ratelimit-Remaining` / `X-Ratelimit-Reset` headers — returns
  early with `hasMore: true` when fewer than 5 requests remain.
- `fetchThread(threadId)` is exposed as a public method for callers that want
  Modrinth v3 thread data; it fails gracefully since v3 is alpha.
- Checkpoint: `{ offset, lastUpdated?, projectIndex?, projectOffsets? }`.

---

## GitHub (`github/index.ts`)

Fetches issues (and pull requests) from one or more GitHub repositories,
filtered by optional labels and an incremental `since` timestamp.

### Constructor

```ts
import GitHubAdapter from "./connectors/github/index.js";

const adapter = new GitHubAdapter({
  token: process.env.GITHUB_TOKEN!,
  repos: [
    "CaffeineMC/sodium",
    "LambdAurora/LambDynamicLights",
  ],
  labels: ["incompatibility", "mod-conflict"],  // optional
  since: "2024-01-01T00:00:00Z",                 // optional ISO timestamp
});
```

| Option | Type | Description |
|---|---|---|
| `token` | `string` | Required. GitHub PAT or fine-grained token with `issues:read`. |
| `repos` | `string[]` | Required. Repositories in `"owner/repo"` format. |
| `labels` | `string[]` | Optional. Only return issues tagged with at least one of these labels. |
| `since` | `string` | Optional. ISO timestamp for the initial sync window. Defaults to 90 days ago. |

### Behaviour

- Iterates over `repos` in order; for each repo calls
  `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc`.
- Issues are mapped to `github_issue`; pull requests to `release_note`.
- `externalId = gh_issue_{owner}_{repo}_{number}`.
- Checkpoint: `{ repoIndex, page, since }` — enables resuming mid-repo and
  advancing the `since` window after a full pass.
- Rate limiting: checks `X-RateLimit-Remaining`; stops with `hasMore: true`
  when fewer than 10 requests remain.  Also handles 403 + `Retry-After`
  (secondary rate limit).
- Throws on 401 or auth-only 403.

---

## Usage with `EvidenceIngestionPipeline`

```ts
import { EvidenceIngestionPipeline, InMemoryPlatformRepository } from "@modcompat/platform-core";
import GitHubAdapter from "./connectors/github/index.js";

const repository = new InMemoryPlatformRepository();
const pipeline = new EvidenceIngestionPipeline(repository);

const adapter = new GitHubAdapter({
  token: process.env.GITHUB_TOKEN!,
  repos: ["CaffeineMC/sodium"],
});

const result = await pipeline.runSync(adapter, { maxItemsPerRun: 200 });
console.log(result);
```

---

## Adding a new connector

1. Create a directory under `connectors/` (e.g. `connectors/my-source/`).
2. Create `index.ts` implementing `LiveConnectorAdapter` from
   `@modcompat/platform-core`.
3. Export the class as both a named export and `default`.
4. The consuming service's `tsconfig.json` must extend `../../tsconfig.base.json`
   (or the root `tsconfig.base.json`) so that `@modcompat/*` path aliases
   resolve correctly.
