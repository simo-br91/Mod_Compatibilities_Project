# ---------------------------------------------------------------------------
# Helper: IRSA trust policy generator
# ---------------------------------------------------------------------------

locals {
  oidc_host = replace(
    aws_eks_cluster.main.identity[0].oidc[0].issuer,
    "https://",
    ""
  )
}

data "aws_iam_policy_document" "irsa_trust" {
  for_each = {
    gateway   = { sa = "gateway",   ns = "gateway" }
    evidence  = { sa = "evidence",  ns = "evidence" }
    graph     = { sa = "graph",     ns = "graph" }
    ml        = { sa = "ml",        ns = "ml" }
    simulation = { sa = "simulation", ns = "simulation" }
  }

  statement {
    sid     = "AllowEKSOIDC"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["system:serviceaccount:${each.value.ns}:${each.value.sa}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# IRSA role — API Gateway service
# ---------------------------------------------------------------------------

resource "aws_iam_role" "irsa_gateway" {
  name               = "${local.name_prefix}-irsa-gateway"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["gateway"].json

  tags = { Name = "${local.name_prefix}-irsa-gateway" }
}

resource "aws_iam_policy" "gateway_policy" {
  name        = "${local.name_prefix}-gateway-policy"
  description = "Permissions for the Gateway service pod"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadExports"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.app["exports"].arn,
          "${aws_s3_bucket.app["exports"].arn}/*",
        ]
      },
      {
        Sid    = "WriteExports"
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.app["exports"].arn}/*"]
      },
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [
          aws_secretsmanager_secret.postgres.arn,
          aws_secretsmanager_secret.redis_auth.arn,
          aws_secretsmanager_secret.jwt_secret.arn,
          aws_secretsmanager_secret.api_signing_key.arn,
        ]
      },
      {
        Sid      = "ReadKMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.secrets.arn]
      },
      {
        Sid    = "OpenSearchRead"
        Effect = "Allow"
        Action = ["es:ESHttpGet", "es:ESHttpPost"]
        Resource = ["${aws_opensearch_domain.main.arn}/*"]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "gateway_policy" {
  role       = aws_iam_role.irsa_gateway.name
  policy_arn = aws_iam_policy.gateway_policy.arn
}

# ---------------------------------------------------------------------------
# IRSA role — Evidence service
# ---------------------------------------------------------------------------

resource "aws_iam_role" "irsa_evidence" {
  name               = "${local.name_prefix}-irsa-evidence"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["evidence"].json

  tags = { Name = "${local.name_prefix}-irsa-evidence" }
}

resource "aws_iam_policy" "evidence_policy" {
  name        = "${local.name_prefix}-evidence-policy"
  description = "Permissions for the Evidence service pod"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RawPayloadsReadWrite"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.app["raw_payloads"].arn,
          "${aws_s3_bucket.app["raw_payloads"].arn}/*",
        ]
      },
      {
        Sid      = "OpenSearchReadWrite"
        Effect   = "Allow"
        Action   = ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete", "es:ESHttpHead"]
        Resource = ["${aws_opensearch_domain.main.arn}/*"]
      },
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [
          aws_secretsmanager_secret.postgres.arn,
          aws_secretsmanager_secret.opensearch.arn,
        ]
      },
      {
        Sid      = "ReadKMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.secrets.arn, aws_kms_key.s3.arn]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "evidence_policy" {
  role       = aws_iam_role.irsa_evidence.name
  policy_arn = aws_iam_policy.evidence_policy.arn
}

# ---------------------------------------------------------------------------
# IRSA role — Graph service
# ---------------------------------------------------------------------------

resource "aws_iam_role" "irsa_graph" {
  name               = "${local.name_prefix}-irsa-graph"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["graph"].json

  tags = { Name = "${local.name_prefix}-irsa-graph" }
}

resource "aws_iam_policy" "graph_policy" {
  name        = "${local.name_prefix}-graph-policy"
  description = "Permissions for the Graph service pod"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [
          aws_secretsmanager_secret.postgres.arn,
          aws_secretsmanager_secret.redis_auth.arn,
        ]
      },
      {
        Sid      = "ReadKMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.secrets.arn]
      },
      {
        Sid    = "ReadArtifacts"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.app["artifacts"].arn,
          "${aws_s3_bucket.app["artifacts"].arn}/*",
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "graph_policy" {
  role       = aws_iam_role.irsa_graph.name
  policy_arn = aws_iam_policy.graph_policy.arn
}

# ---------------------------------------------------------------------------
# IRSA role — ML / NLP service
# ---------------------------------------------------------------------------

resource "aws_iam_role" "irsa_ml" {
  name               = "${local.name_prefix}-irsa-ml"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["ml"].json

  tags = { Name = "${local.name_prefix}-irsa-ml" }
}

resource "aws_iam_policy" "ml_policy" {
  name        = "${local.name_prefix}-ml-policy"
  description = "Permissions for the ML/NLP service pod"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "MLDatasetsReadWrite"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"]
        Resource = [
          aws_s3_bucket.app["ml_datasets"].arn,
          "${aws_s3_bucket.app["ml_datasets"].arn}/*",
        ]
      },
      {
        Sid    = "RawPayloadsRead"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.app["raw_payloads"].arn,
          "${aws_s3_bucket.app["raw_payloads"].arn}/*",
        ]
      },
      {
        Sid      = "OpenSearchReadWrite"
        Effect   = "Allow"
        Action   = ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpHead"]
        Resource = ["${aws_opensearch_domain.main.arn}/*"]
      },
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [
          aws_secretsmanager_secret.postgres.arn,
          aws_secretsmanager_secret.opensearch.arn,
        ]
      },
      {
        Sid      = "ReadKMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.secrets.arn, aws_kms_key.s3.arn]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ml_policy" {
  role       = aws_iam_role.irsa_ml.name
  policy_arn = aws_iam_policy.ml_policy.arn
}

# ---------------------------------------------------------------------------
# IRSA role — Simulation service
# ---------------------------------------------------------------------------

resource "aws_iam_role" "irsa_simulation" {
  name               = "${local.name_prefix}-irsa-simulation"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["simulation"].json

  tags = { Name = "${local.name_prefix}-irsa-simulation" }
}

resource "aws_iam_policy" "simulation_policy" {
  name        = "${local.name_prefix}-simulation-policy"
  description = "Permissions for the Simulation service pod"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ArtifactsRead"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.app["artifacts"].arn,
          "${aws_s3_bucket.app["artifacts"].arn}/*",
        ]
      },
      {
        Sid    = "ExportsWrite"
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = ["${aws_s3_bucket.app["exports"].arn}/*"]
      },
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [
          aws_secretsmanager_secret.postgres.arn,
          aws_secretsmanager_secret.msk_credentials.arn,
        ]
      },
      {
        Sid      = "ReadKMS"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.secrets.arn, aws_kms_key.s3.arn]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "simulation_policy" {
  role       = aws_iam_role.irsa_simulation.name
  policy_arn = aws_iam_policy.simulation_policy.arn
}

# ---------------------------------------------------------------------------
# Kubernetes ServiceAccounts for each IRSA-backed service
# ---------------------------------------------------------------------------

locals {
  irsa_service_accounts = {
    gateway    = { role_arn = aws_iam_role.irsa_gateway.arn,    ns = "gateway" }
    evidence   = { role_arn = aws_iam_role.irsa_evidence.arn,   ns = "evidence" }
    graph      = { role_arn = aws_iam_role.irsa_graph.arn,      ns = "graph" }
    ml         = { role_arn = aws_iam_role.irsa_ml.arn,         ns = "ml" }
    simulation = { role_arn = aws_iam_role.irsa_simulation.arn, ns = "simulation" }
  }
}

resource "kubernetes_namespace" "services" {
  for_each = local.irsa_service_accounts

  metadata {
    name = each.value.ns
    labels = {
      name        = each.value.ns
      environment = var.environment
      managed-by  = "terraform"
    }
  }

  depends_on = [aws_eks_node_group.general]
}

resource "kubernetes_service_account" "irsa" {
  for_each = local.irsa_service_accounts

  metadata {
    name      = each.key
    namespace = each.value.ns
    annotations = {
      "eks.amazonaws.com/role-arn" = each.value.role_arn
    }
    labels = {
      app        = each.key
      managed-by = "terraform"
    }
  }

  depends_on = [
    kubernetes_namespace.services,
    aws_iam_openid_connect_provider.eks,
  ]
}
