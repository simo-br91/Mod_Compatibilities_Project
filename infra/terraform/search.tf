# ---------------------------------------------------------------------------
# KMS key — OpenSearch encryption
# ---------------------------------------------------------------------------

resource "aws_kms_key" "opensearch" {
  description             = "OpenSearch encryption key for ${local.name_prefix}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-opensearch-kms"
  }
}

resource "aws_kms_alias" "opensearch" {
  name          = "alias/${local.name_prefix}-opensearch"
  target_key_id = aws_kms_key.opensearch.key_id
}

# ---------------------------------------------------------------------------
# Service-linked role for OpenSearch VPC access
# ---------------------------------------------------------------------------

resource "aws_iam_service_linked_role" "opensearch" {
  aws_service_name = "opensearchservice.amazonaws.com"

  # Ignore if the role already exists in the account
  lifecycle {
    ignore_changes = [aws_service_name]
  }
}

# ---------------------------------------------------------------------------
# OpenSearch domain access policy
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "opensearch_access" {
  statement {
    sid    = "DenyUnauthenticated"
    effect = "Deny"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions   = ["es:*"]
    resources = ["arn:${data.aws_partition.current.partition}:es:${var.aws_region}:${data.aws_caller_identity.current.account_id}:domain/${local.name_prefix}-opensearch/*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalType"
      values   = ["AssumedRole", "IAMUser"]
    }
  }

  statement {
    sid    = "AllowIRSARoles"
    effect = "Allow"
    principals {
      type = "AWS"
      identifiers = [
        aws_iam_role.irsa_evidence.arn,
        aws_iam_role.irsa_ml.arn,
        aws_iam_role.irsa_gateway.arn,
      ]
    }
    actions   = ["es:ESHttp*"]
    resources = ["arn:${data.aws_partition.current.partition}:es:${var.aws_region}:${data.aws_caller_identity.current.account_id}:domain/${local.name_prefix}-opensearch/*"]
  }
}

# ---------------------------------------------------------------------------
# OpenSearch domain
# ---------------------------------------------------------------------------

resource "aws_opensearch_domain" "main" {
  domain_name    = "${local.name_prefix}-opensearch"
  engine_version = var.opensearch_engine_version

  cluster_config {
    instance_type            = var.opensearch_instance_type
    instance_count           = var.opensearch_instance_count
    zone_awareness_enabled   = true
    dedicated_master_enabled = true
    dedicated_master_type    = var.opensearch_master_instance_type
    dedicated_master_count   = var.opensearch_master_count

    zone_awareness_config {
      availability_zone_count = 3
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = var.opensearch_ebs_volume_size
    throughput  = 250
    iops        = 3000
  }

  vpc_options {
    subnet_ids         = slice(aws_subnet.private[*].id, 0, 3)
    security_group_ids = [aws_security_group.opensearch.id]
  }

  encrypt_at_rest {
    enabled    = true
    kms_key_id = aws_kms_key.opensearch.arn
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  advanced_security_options {
    enabled                        = true
    anonymous_auth_enabled         = false
    internal_user_database_enabled = true

    master_user_options {
      master_user_name     = jsondecode(aws_secretsmanager_secret_version.opensearch.secret_string)["username"]
      master_user_password = jsondecode(aws_secretsmanager_secret_version.opensearch.secret_string)["password"]
    }
  }

  log_publishing_options {
    cloudwatch_log_group_arn = aws_cloudwatch_log_group.opensearch_index.arn
    log_type                 = "INDEX_SLOW_LOGS"
  }

  log_publishing_options {
    cloudwatch_log_group_arn = aws_cloudwatch_log_group.opensearch_search.arn
    log_type                 = "SEARCH_SLOW_LOGS"
  }

  log_publishing_options {
    cloudwatch_log_group_arn = aws_cloudwatch_log_group.opensearch_app.arn
    log_type                 = "ES_APPLICATION_LOGS"
  }

  access_policies = data.aws_iam_policy_document.opensearch_access.json

  auto_tune_options {
    desired_state       = "ENABLED"
    rollback_on_disable = "NO_ROLLBACK"
  }

  depends_on = [
    aws_iam_service_linked_role.opensearch,
    aws_secretsmanager_secret_version.opensearch,
  ]

  tags = {
    Name = "${local.name_prefix}-opensearch"
  }
}

# ---------------------------------------------------------------------------
# OpenSearch deletion protection (managed via a separate resource for clarity)
# ---------------------------------------------------------------------------

resource "aws_opensearch_domain_policy" "main" {
  domain_name     = aws_opensearch_domain.main.domain_name
  access_policies = data.aws_iam_policy_document.opensearch_access.json
}

# ---------------------------------------------------------------------------
# CloudWatch log groups — OpenSearch
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "opensearch_index" {
  name              = "/aws/opensearch/${local.name_prefix}/index-slow-logs"
  retention_in_days = 30
  tags = { Name = "${local.name_prefix}-opensearch-index-logs" }
}

resource "aws_cloudwatch_log_group" "opensearch_search" {
  name              = "/aws/opensearch/${local.name_prefix}/search-slow-logs"
  retention_in_days = 30
  tags = { Name = "${local.name_prefix}-opensearch-search-logs" }
}

resource "aws_cloudwatch_log_group" "opensearch_app" {
  name              = "/aws/opensearch/${local.name_prefix}/application-logs"
  retention_in_days = 30
  tags = { Name = "${local.name_prefix}-opensearch-app-logs" }
}

# CloudWatch resource policy so OpenSearch can publish to the log groups
data "aws_iam_policy_document" "opensearch_cloudwatch" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["es.amazonaws.com"]
    }
    actions = [
      "logs:PutLogEvents",
      "logs:PutLogEventsBatch",
      "logs:CreateLogStream",
    ]
    resources = [
      "${aws_cloudwatch_log_group.opensearch_index.arn}:*",
      "${aws_cloudwatch_log_group.opensearch_search.arn}:*",
      "${aws_cloudwatch_log_group.opensearch_app.arn}:*",
    ]
  }
}

resource "aws_cloudwatch_log_resource_policy" "opensearch" {
  policy_name     = "${local.name_prefix}-opensearch-logs-policy"
  policy_document = data.aws_iam_policy_document.opensearch_cloudwatch.json
}
