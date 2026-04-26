# Modpack Compatibility Platform — Technical Blueprints

This pack is the implementation-facing companion to the strategy pack.

It is organized for real engineering use:
- service boundaries
- API contracts
- event contracts
- relational and graph schemas
- workflow orchestration
- security and tenancy guidance
- diagram source files

## Recommended reading order
1. `01_Service_Catalog.md`
2. `02_API_Contracts.md`
3. `05_Database_Schema_Postgres.md`
4. `06_Graph_Model_Neo4j.md`
5. `08_Analysis_Workflows.md`
6. `09_Security_and_MultiTenancy.md`
7. `10_Diagrams.md`

## Folder overview
- `openapi/` — API skeletons and REST surface
- `schemas/sql/` — PostgreSQL DDL starter
- `schemas/json/` — JSON Schema examples for event payloads
- `diagrams/` — Mermaid sources

## Design intent
These documents are not toy examples. They are designed to serve as:
- architecture decision support
- implementation kickoff material
- internal onboarding documentation
- future context for iterative chats and design work

## External integration references
Some external-source integration notes in this pack assume current official platform docs:
- CurseForge REST API docs (base URL, API key, pagination constraints)
- Modrinth API docs (rate limit, identifiers, dependency model)
- GitHub REST/GraphQL rate-limit docs

These external platforms can evolve, so integration code should treat these docs as reference inputs and keep runtime connector behavior configurable.
