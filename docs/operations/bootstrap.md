# Bootstrap

## Local prerequisites

- Node.js 22+
- `pnpm` 10+
- Go 1.23+
- Python 3.12+
- Java 21
- Docker Desktop with Compose

## Local infrastructure

Start the local platform dependencies:

```bash
docker compose up -d
```

The Compose stack provisions:

- PostgreSQL
- Redis
- Temporal + Temporal UI
- Neo4j
- OpenSearch + Dashboards
- MinIO

Kafka is currently kept behind the optional Compose profile because the Phase 13 staging runtime does not consume it yet:

```bash
docker compose --profile optional up -d kafka
```

## TypeScript workspace

Install dependencies:

```bash
pnpm install
```

Useful commands:

```bash
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm release:status -- --environment staging
pnpm runtime:staging:up
pnpm smoke:staging -- --probe-only
pnpm runtime:staging:down
pnpm --filter @modcompat/evidence exec tsx src/index.ts
pnpm --filter @modcompat/admin exec tsx src/index.ts
pnpm --filter @modcompat/analysis-orchestrator exec tsx src/index.ts
pnpm --filter @modcompat/gateway exec tsx src/index.ts
go run ./apps/recommendation/cmd/service
go run ./apps/graph/cmd/service
go run ./apps/simulation/cmd/service
```

Release workflow details live in [release-management.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/docs/operations/release-management.md).
Reliability and monitoring details live in [reliability.md](/c:/Users/simor/Documents/Mod_Compatibilities_Project/docs/operations/reliability.md).

Run the JVM artifact-analysis boundary in process mode through the TypeScript platform by setting:

```bash
ARTIFACT_ANALYSIS_JAVA_SOURCE=apps/artifact-analysis/src/main/java/com/modcompat/artifactanalysis/ArtifactAnalysisBoundary.java
JAVA_BIN=java
```

The current Phase 8 slice uses Java source-file mode, so no Gradle wrapper or external dependency download is required for local validation.

## Polyglot services

Phase 0 adds service skeletons for the documented language split:

- Go: `analysis-orchestrator`, `resolver`, `graph`, `recommendation`, `simulation`
- Kotlin/JVM: `artifact-analysis`
- Python: `ml`
- TypeScript/Node.js: `gateway`, `workspace`, `catalog`, `evidence`, `notification`, `admin`, `web`

Business logic is intentionally deferred. Each service README describes the intended ownership boundary and the first Phase 1 implementation target.

## Database contracts

Use the canonical SQL from [`schemas/sql/postgres_core.sql`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/schemas/sql/postgres_core.sql). The same schema is seeded in migration [`0001_phase0_core.sql`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/schemas/sql/migrations/0001_phase0_core.sql).

## Contract workflow

1. Update root `schemas/` first.
2. Mirror contract changes into the blueprint copies under `Modpack_Compatibility_Platform_Technical_Blueprints/`.
3. Keep prose docs and machine-readable contracts aligned in the same change whenever behavior changes.
