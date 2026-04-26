# ---------------------------------------------------------------------------
# EKS
# ---------------------------------------------------------------------------

output "eks_cluster_name" {
  description = "Name of the EKS cluster."
  value       = aws_eks_cluster.main.name
}

output "eks_cluster_endpoint" {
  description = "API server endpoint URL of the EKS cluster."
  value       = aws_eks_cluster.main.endpoint
}

output "eks_cluster_certificate_authority_data" {
  description = "Base64-encoded certificate authority data for the EKS cluster."
  value       = aws_eks_cluster.main.certificate_authority[0].data
  sensitive   = true
}

output "eks_oidc_provider_arn" {
  description = "ARN of the OIDC provider used for IRSA."
  value       = aws_iam_openid_connect_provider.eks.arn
}

output "eks_node_role_arn" {
  description = "IAM role ARN assigned to EKS worker nodes."
  value       = aws_iam_role.eks_node_group.arn
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets."
  value       = aws_subnet.private[*].id
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL
# ---------------------------------------------------------------------------

output "rds_endpoint" {
  description = "Connection endpoint for the RDS PostgreSQL instance."
  value       = aws_db_instance.postgres.endpoint
}

output "rds_port" {
  description = "Port on which the RDS PostgreSQL instance is listening."
  value       = aws_db_instance.postgres.port
}

output "rds_database_name" {
  description = "Name of the default database on the RDS instance."
  value       = aws_db_instance.postgres.db_name
}

# ---------------------------------------------------------------------------
# ElastiCache Redis
# ---------------------------------------------------------------------------

output "redis_configuration_endpoint" {
  description = "Configuration endpoint for the Redis replication group (cluster mode)."
  value       = aws_elasticache_replication_group.redis.configuration_endpoint_address
}

output "redis_primary_endpoint" {
  description = "Primary endpoint for the Redis replication group."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_port" {
  description = "Port for the Redis replication group."
  value       = aws_elasticache_replication_group.redis.port
}

# ---------------------------------------------------------------------------
# OpenSearch
# ---------------------------------------------------------------------------

output "opensearch_endpoint" {
  description = "Domain-specific HTTPS endpoint for the OpenSearch domain."
  value       = aws_opensearch_domain.main.endpoint
}

output "opensearch_domain_arn" {
  description = "ARN of the OpenSearch domain."
  value       = aws_opensearch_domain.main.arn
}

output "opensearch_kibana_endpoint" {
  description = "Endpoint for OpenSearch Dashboards (formerly Kibana)."
  value       = aws_opensearch_domain.main.kibana_endpoint
}

# ---------------------------------------------------------------------------
# MSK Kafka
# ---------------------------------------------------------------------------

output "msk_cluster_arn" {
  description = "ARN of the MSK cluster."
  value       = aws_msk_cluster.main.arn
}

output "msk_bootstrap_brokers_sasl_scram" {
  description = "Bootstrap broker string for SASL/SCRAM over TLS."
  value       = aws_msk_cluster.main.bootstrap_brokers_sasl_scram
  sensitive   = true
}

output "msk_bootstrap_brokers_tls" {
  description = "Bootstrap broker string for TLS (no auth)."
  value       = aws_msk_cluster.main.bootstrap_brokers_tls
  sensitive   = true
}

output "msk_zookeeper_connect_string" {
  description = "ZooKeeper connection string for the MSK cluster."
  value       = aws_msk_cluster.main.zookeeper_connect_string
  sensitive   = true
}

# ---------------------------------------------------------------------------
# S3 buckets
# ---------------------------------------------------------------------------

output "s3_bucket_raw_payloads" {
  description = "Name of the raw-payloads S3 bucket."
  value       = aws_s3_bucket.app["raw_payloads"].id
}

output "s3_bucket_artifacts" {
  description = "Name of the artifacts S3 bucket."
  value       = aws_s3_bucket.app["artifacts"].id
}

output "s3_bucket_ml_datasets" {
  description = "Name of the ml-datasets S3 bucket."
  value       = aws_s3_bucket.app["ml_datasets"].id
}

output "s3_bucket_exports" {
  description = "Name of the exports S3 bucket."
  value       = aws_s3_bucket.app["exports"].id
}

output "s3_bucket_terraform_state" {
  description = "Name of the Terraform state S3 bucket."
  value       = aws_s3_bucket.terraform_state.id
}

output "dynamodb_terraform_locks_table" {
  description = "Name of the DynamoDB table used for Terraform state locking."
  value       = aws_dynamodb_table.terraform_locks.id
}

# ---------------------------------------------------------------------------
# Secrets Manager ARNs
# ---------------------------------------------------------------------------

output "secret_arn_postgres" {
  description = "ARN of the PostgreSQL master credentials secret."
  value       = aws_secretsmanager_secret.postgres.arn
}

output "secret_arn_redis_auth" {
  description = "ARN of the Redis auth token secret."
  value       = aws_secretsmanager_secret.redis_auth.arn
}

output "secret_arn_opensearch" {
  description = "ARN of the OpenSearch master credentials secret."
  value       = aws_secretsmanager_secret.opensearch.arn
}

output "secret_arn_msk_credentials" {
  description = "ARN of the MSK SASL/SCRAM credentials secret."
  value       = aws_secretsmanager_secret.msk_credentials.arn
}

output "secret_arn_jwt_secret" {
  description = "ARN of the JWT signing secret."
  value       = aws_secretsmanager_secret.jwt_secret.arn
}

output "secret_arn_api_signing_key" {
  description = "ARN of the API signing key secret."
  value       = aws_secretsmanager_secret.api_signing_key.arn
}

# ---------------------------------------------------------------------------
# IRSA role ARNs
# ---------------------------------------------------------------------------

output "irsa_role_arn_gateway" {
  description = "IAM role ARN for the Gateway service IRSA."
  value       = aws_iam_role.irsa_gateway.arn
}

output "irsa_role_arn_evidence" {
  description = "IAM role ARN for the Evidence service IRSA."
  value       = aws_iam_role.irsa_evidence.arn
}

output "irsa_role_arn_graph" {
  description = "IAM role ARN for the Graph service IRSA."
  value       = aws_iam_role.irsa_graph.arn
}

output "irsa_role_arn_ml" {
  description = "IAM role ARN for the ML service IRSA."
  value       = aws_iam_role.irsa_ml.arn
}

output "irsa_role_arn_simulation" {
  description = "IAM role ARN for the Simulation service IRSA."
  value       = aws_iam_role.irsa_simulation.arn
}

# ---------------------------------------------------------------------------
# KMS key ARNs
# ---------------------------------------------------------------------------

output "kms_key_arn_eks" {
  description = "ARN of the KMS key used for EKS secrets encryption."
  value       = aws_kms_key.eks.arn
}

output "kms_key_arn_rds" {
  description = "ARN of the KMS key used for RDS storage encryption."
  value       = aws_kms_key.rds.arn
}

output "kms_key_arn_s3" {
  description = "ARN of the KMS key used for S3 server-side encryption."
  value       = aws_kms_key.s3.arn
}

output "kms_key_arn_secrets" {
  description = "ARN of the KMS key used for Secrets Manager encryption."
  value       = aws_kms_key.secrets.arn
}
