# ---------------------------------------------------------------------------
# Terraform backend
#
# Uncomment the backend block below once the S3 bucket and DynamoDB table
# created by storage.tf have been bootstrapped with a local backend first.
# Then run: terraform init -migrate-state
# ---------------------------------------------------------------------------
#
# terraform {
#   backend "s3" {
#     bucket         = "<project_name>-<environment>-terraform-state"
#     key            = "terraform.tfstate"
#     region         = "<aws_region>"
#     encrypt        = true
#     dynamodb_table = "<project_name>-<environment>-terraform-locks"
#   }
# }

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.extra_tags,
  )
}

# ---------------------------------------------------------------------------
# AWS provider
# ---------------------------------------------------------------------------

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

# ---------------------------------------------------------------------------
# Kubernetes provider — targets the EKS cluster created in eks.tf
# ---------------------------------------------------------------------------

provider "kubernetes" {
  host                   = aws_eks_cluster.main.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.main.certificate_authority[0].data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args = [
      "eks",
      "get-token",
      "--cluster-name",
      aws_eks_cluster.main.name,
      "--region",
      var.aws_region,
    ]
  }
}

# ---------------------------------------------------------------------------
# Helm provider
# ---------------------------------------------------------------------------

provider "helm" {
  kubernetes {
    host                   = aws_eks_cluster.main.endpoint
    cluster_ca_certificate = base64decode(aws_eks_cluster.main.certificate_authority[0].data)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args = [
        "eks",
        "get-token",
        "--cluster-name",
        aws_eks_cluster.main.name,
        "--region",
        var.aws_region,
      ]
    }
  }
}

# ---------------------------------------------------------------------------
# Shared data sources (used across multiple files)
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_partition" "current" {}
