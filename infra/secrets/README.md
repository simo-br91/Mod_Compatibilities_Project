# Secrets Inventory

Terraform now provisions the core runtime secrets in AWS Secrets Manager. This directory documents the intended contract until the Kubernetes deployment layer is added.

## Provisioned Secrets

- `${project}-${environment}/postgres/master`
  Used by services that connect to the primary PostgreSQL database.
- `${project}-${environment}/redis/auth-token`
  Used by Redis clients that require transit-encrypted authenticated access.
- `${project}-${environment}/opensearch/master`
  Used for OpenSearch administrative and bootstrap access.
- `AmazonMSK_${project}_${environment}_kafka_credentials`
  Used for MSK SASL and SCRAM authentication.
- `${project}-${environment}/app/jwt-secret`
  Used by the gateway to sign platform JWTs after OIDC login.
- `${project}-${environment}/app/api-signing-key`
  Reserved for signed internal or partner-facing requests.

## Current Handoff Model

- Terraform owns creation and rotation-safe storage of the secrets.
- Runtime consumers should reference secret ARNs from Terraform outputs rather than copying values into repo-managed files.
- Kubernetes secret sync and pod injection are intentionally deferred to the Kubernetes deployment step.

## Launch-Gate Expectation

For the launch gate, use this inventory as the source of truth for:

- which secrets must exist in AWS before any production rollout
- which services need access to each secret
- which later Kubernetes manifests or External Secrets definitions must be created
