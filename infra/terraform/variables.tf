# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy all resources into."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (e.g. prod, staging, dev)."
  type        = string
  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment must be one of: prod, staging, dev."
  }
}

variable "project_name" {
  description = "Short project identifier used as a prefix on all resource names."
  type        = string
  default     = "modcompat"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for the three public subnets (one per AZ)."
  type        = list(string)
  default     = ["10.0.0.0/20", "10.0.16.0/20", "10.0.32.0/20"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for the three private subnets (one per AZ)."
  type        = list(string)
  default     = ["10.0.128.0/20", "10.0.144.0/20", "10.0.160.0/20"]
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway rather than one per AZ. Set true for non-prod to reduce cost."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# EKS
# ---------------------------------------------------------------------------

variable "eks_cluster_version" {
  description = "Kubernetes version for the EKS control plane."
  type        = string
  default     = "1.31"
}

variable "eks_system_node_instance_types" {
  description = "EC2 instance types for the system (kube-system) node group."
  type        = list(string)
  default     = ["m6i.large"]
}

variable "eks_system_node_min_size" {
  description = "Minimum number of nodes in the system node group."
  type        = number
  default     = 2
}

variable "eks_system_node_max_size" {
  description = "Maximum number of nodes in the system node group."
  type        = number
  default     = 4
}

variable "eks_system_node_desired_size" {
  description = "Desired number of nodes in the system node group."
  type        = number
  default     = 2
}

variable "eks_general_node_instance_types" {
  description = "EC2 instance types for the general-purpose node group."
  type        = list(string)
  default     = ["m6i.2xlarge", "m6a.2xlarge"]
}

variable "eks_general_node_min_size" {
  description = "Minimum number of nodes in the general-purpose node group."
  type        = number
  default     = 3
}

variable "eks_general_node_max_size" {
  description = "Maximum number of nodes in the general-purpose node group."
  type        = number
  default     = 20
}

variable "eks_general_node_desired_size" {
  description = "Desired number of nodes in the general-purpose node group."
  type        = number
  default     = 3
}

variable "eks_node_disk_size_gb" {
  description = "Root EBS volume size (GiB) for all EKS nodes."
  type        = number
  default     = 100
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL
# ---------------------------------------------------------------------------

variable "rds_instance_class" {
  description = "RDS instance class for the PostgreSQL primary instance."
  type        = string
  default     = "db.r6g.xlarge"
}

variable "rds_allocated_storage" {
  description = "Initial allocated storage for RDS in GiB."
  type        = number
  default     = 100
}

variable "rds_max_allocated_storage" {
  description = "Maximum storage autoscaling ceiling for RDS in GiB."
  type        = number
  default     = 1000
}

variable "rds_postgres_version" {
  description = "PostgreSQL engine version."
  type        = string
  default     = "16.3"
}

variable "rds_backup_retention_days" {
  description = "Number of days to retain automated RDS backups."
  type        = number
  default     = 14
}

variable "rds_multi_az" {
  description = "Enable Multi-AZ deployment for RDS."
  type        = bool
  default     = true
}

variable "rds_deletion_protection" {
  description = "Enable deletion protection on the RDS instance."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# ElastiCache Redis
# ---------------------------------------------------------------------------

variable "redis_node_type" {
  description = "ElastiCache node type for Redis."
  type        = string
  default     = "cache.r6g.large"
}

variable "redis_num_node_groups" {
  description = "Number of node groups (shards) for Redis cluster mode."
  type        = number
  default     = 3
}

variable "redis_replicas_per_node_group" {
  description = "Number of read replicas per shard."
  type        = number
  default     = 1
}

variable "redis_engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

# ---------------------------------------------------------------------------
# OpenSearch
# ---------------------------------------------------------------------------

variable "opensearch_instance_type" {
  description = "OpenSearch data node instance type."
  type        = string
  default     = "r6g.large.search"
}

variable "opensearch_instance_count" {
  description = "Number of OpenSearch data nodes."
  type        = number
  default     = 3
}

variable "opensearch_master_instance_type" {
  description = "OpenSearch dedicated master node instance type."
  type        = string
  default     = "r6g.large.search"
}

variable "opensearch_master_count" {
  description = "Number of dedicated master nodes (must be 3 or 5)."
  type        = number
  default     = 3
}

variable "opensearch_ebs_volume_size" {
  description = "EBS volume size in GiB per OpenSearch data node."
  type        = number
  default     = 100
}

variable "opensearch_engine_version" {
  description = "OpenSearch engine version."
  type        = string
  default     = "OpenSearch_2.13"
}

variable "opensearch_deletion_protection" {
  description = "Enable deletion protection on the OpenSearch domain."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# MSK (Managed Kafka)
# ---------------------------------------------------------------------------

variable "msk_broker_instance_type" {
  description = "MSK broker instance type."
  type        = string
  default     = "kafka.m5.large"
}

variable "msk_broker_count" {
  description = "Number of MSK broker nodes (must be a multiple of the number of AZs)."
  type        = number
  default     = 3
}

variable "msk_kafka_version" {
  description = "Apache Kafka version for the MSK cluster."
  type        = string
  default     = "3.6.0"
}

variable "msk_broker_ebs_volume_size" {
  description = "EBS volume size in GiB per MSK broker."
  type        = number
  default     = 1000
}

variable "msk_storage_autoscaling_max_capacity" {
  description = "Maximum EBS capacity in GiB per broker for MSK storage autoscaling."
  type        = number
  default     = 4000
}

variable "msk_storage_autoscaling_target_percentage" {
  description = "Target disk utilisation percentage at which MSK triggers autoscaling."
  type        = number
  default     = 70
}

# ---------------------------------------------------------------------------
# S3 / State
# ---------------------------------------------------------------------------

variable "terraform_state_bucket_suffix" {
  description = "Suffix appended to the Terraform state S3 bucket name for global uniqueness."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

variable "extra_tags" {
  description = "Additional tags to merge onto all resources."
  type        = map(string)
  default     = {}
}
