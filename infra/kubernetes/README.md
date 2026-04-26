# Kubernetes Runtime

This directory contains a production-oriented baseline Kubernetes runtime for the
deployable backend services that already exist in this repository:

- `artifact-analysis`
- `evidence`
- `admin`
- `analysis-orchestrator`
- `recommendation`
- `graph`
- `simulation`
- `temporal` frontend
- `temporal-ui`

The manifests intentionally assume that the durable dependencies created outside
the cluster are supplied by Terraform and secrets management:

- PostgreSQL
- Redis
- Neo4j
- OpenSearch
- S3-compatible object storage

Temporal is deployed in-cluster here because the current Terraform stack does
not provision a managed Temporal control plane.

## Files

- `namespace.yaml`: namespace and shared service account
- `configmap.yaml`: non-secret shared runtime environment
- `secrets.example.yaml`: secret shape to copy into your secret manager workflow
- `runtime.yaml`: backend Deployments and Services
- `temporal.yaml`: Temporal frontend and UI Deployments and Services
- `kustomization.yaml`: base bundle

## Apply

1. Copy `secrets.example.yaml` into your deployment pipeline and replace the
   placeholder values.
2. Publish images matching the names in `runtime.yaml`.
3. Apply the manifests:

```powershell
kubectl apply -k infra/kubernetes
```

## Notes

- `analysis-orchestrator` expects `TEMPORAL_ADDRESS` and runs the Temporal
  worker in-process when that address is configured.
- `web` is still intentionally excluded here because the release inventory marks
  it as buildable but not yet part of the deployable backend runtime.
- `gateway` is also excluded from this baseline because the current release
  inventory and staging backend runtime do not publish it as part of the
  deployable service set yet.
