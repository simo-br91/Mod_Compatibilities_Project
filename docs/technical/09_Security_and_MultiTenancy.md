# 09. Security and Multi-Tenancy

## Tenant model
Use organization-based multi-tenancy.

A tenant owns:
- workspaces
- projects
- analyses
- uploaded artifacts
- private reports
- API keys
- webhooks

## Isolation rules
- every user-facing row must be tenant-scoped or globally shared by design
- catalog data may be global
- workspace/project data must be tenant-scoped
- evidence from public sources may be global
- uploaded artifacts and internal reports must be tenant-scoped

## Auth model
- OAuth/OIDC for user login
- short-lived access tokens
- refresh token rotation
- service-to-service auth via mTLS or workload identity
- scoped API keys for B2B usage

## Authorization model
Recommended RBAC roles:
- Org Owner
- Org Admin
- Project Maintainer
- Analyst
- Viewer
- Billing Admin

## API protection
- per-key quotas
- burst limits
- idempotency-key enforcement on write-heavy endpoints
- signed webhook secrets
- request body size limits
- malware scanning for uploaded artifacts

## Data security
- encrypt object storage at rest
- encrypt DB storage at rest
- TLS everywhere
- secrets in managed secret store
- no raw third-party tokens in logs

## Artifact handling safety
Uploaded jars should be treated as untrusted binaries.

Controls:
- scan files before processing
- isolate parsing workers
- never execute unknown jars in shared worker pools
- simulation workers must run sandboxed and disposable
- strict network egress controls in simulation environments

## Compliance posture
This is not a regulated healthcare or banking product, but still implement:
- audit logs for admin actions
- data retention policies
- deletion workflows
- export workflows
- clear terms for user-submitted reports

## Abuse risks
- malicious repeated uploads
- excessive analysis spam
- poisoned public reports
- prompt injection in scraped content for LLM explanation layers

Mitigations:
- connector sanitization
- strong content separation between evidence retrieval and explanation generation
- rate limits
- trust scoring
- moderation queues
