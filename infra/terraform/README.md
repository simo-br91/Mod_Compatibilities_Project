# Terraform Foundation

This directory provisions the production cloud foundation for the launch gate:

- VPC with public/private subnets, NAT, and VPC endpoints
- EKS cluster with managed node groups, IRSA, and core add-ons
- RDS PostgreSQL
- ElastiCache Redis
- OpenSearch
- MSK
- S3 buckets for raw payloads, artifacts, exports, ML datasets, and Terraform state
- Secrets Manager and KMS keys for runtime secrets

This is infrastructure foundation only. Application deployment manifests still belong to the Kubernetes workstream that comes later in the launch checklist.

## Bootstrap Flow

1. Copy `terraform.tfvars.example` to `terraform.tfvars` and set environment-specific values.
2. Run `terraform init`.
3. Run `terraform plan`.
4. Apply once with the local backend so the state bucket and lock table are created.
5. Uncomment and fill the `backend "s3"` block in `main.tf` with the created bucket and table names.
6. Run `terraform init -migrate-state`.
7. Run `terraform apply` again with the remote backend enabled.

## Operational Notes

- `terraform.tfvars` and state files must stay local; they are ignored by `.gitignore`.
- `single_nat_gateway=true` is appropriate for non-production cost control. Keep it `false` for production.
- Secrets are created in AWS Secrets Manager. The inventory and intended runtime consumption are documented in `infra/secrets/README.md`.
- Outputs from `terraform output` are the hand-off contract for the later Kubernetes and deployment work.

## Important Outputs

- `eks_cluster_name`
- `eks_cluster_endpoint`
- `vpc_id`
- `rds_endpoint`
- `redis_configuration_endpoint`
- `opensearch_endpoint`
- `msk_bootstrap_brokers_sasl_scram`
- `secret_arn_postgres`
- `secret_arn_redis_auth`
- `secret_arn_opensearch`
- `secret_arn_jwt_secret`

## Readiness Boundary

After this stack is applied, the cloud primitives exist, but the platform is not deployable until:

- Kubernetes manifests are added under `infra/kubernetes/`
- Runtime workloads are wired to the provisioned services
- Secret injection is connected in-cluster
- Release and deployment automation target the real cluster
