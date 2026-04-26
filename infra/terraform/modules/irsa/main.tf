# ---------------------------------------------------------------------------
# IRSA helper module
# Generates the assume-role trust policy document for a Kubernetes service
# account using the cluster OIDC provider.
# ---------------------------------------------------------------------------

variable "name_prefix" {
  type = string
}

variable "service_account_name" {
  type = string
}

variable "namespace" {
  type = string
}

variable "oidc_provider_arn" {
  type = string
}

variable "oidc_provider_url" {
  type = string
}

variable "policy_arns" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  oidc_host = replace(var.oidc_provider_url, "https://", "")
}

data "aws_iam_policy_document" "assume" {
  statement {
    sid     = "AllowEKSOIDC"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account_name}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

output "assume_role_policy_json" {
  value = data.aws_iam_policy_document.assume.json
}
