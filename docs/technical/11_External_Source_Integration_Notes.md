# 11. External Source Integration Notes

This file captures integration-level notes for the main external platforms the system depends on.

## CurseForge
Use the official REST API with API-key authentication. The current docs state:
- base URL: `https://api.curseforge.com`
- API key passed via `x-api-key`
- maximum page size: 50
- paginated results capped at 10,000 total items

Engineering implications:
- connector code must support pagination windows
- backfills must checkpoint indexes carefully
- hot-project refresh schedules matter because full deep scans are capped

## Modrinth
The official API docs currently describe:
- stable unique base62 IDs for entities
- version files addressable by hashes
- current rate limit of 300 requests per minute per IP
- a required uniquely identifying `User-Agent`
- explicit dependency types including `required`, `optional`, `incompatible`, and `embedded`

Engineering implications:
- store stable IDs, not slugs, for long-term references
- set a product-specific `User-Agent`
- exploit explicit dependency types in the rule engine and catalog normalization

## GitHub
The official GitHub docs currently describe:
- unauthenticated REST API requests are severely limited
- authenticated REST usage is typically 5,000 requests per hour
- secondary limits include concurrency and endpoint point budgets
- issue endpoints can include pull requests and must be filtered accordingly when issue-only semantics are required

Engineering implications:
- use authenticated app-based access
- implement aggressive conditional requests and checkpoints
- bound concurrency centrally
- handle abuse/secondary limit backoff

## Design rule
All connector limits, headers, pagination rules, and source-specific quirks should be stored in connector configuration rather than hardcoded deep inside workers.
