# ---------------------------------------------------------------------------
# Random passwords
# ---------------------------------------------------------------------------

resource "random_password" "postgres_master" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "random_password" "redis_auth_token" {
  length  = 64
  special = false # Redis auth tokens must be alphanumeric only
}

resource "random_password" "opensearch_master" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
}

resource "random_password" "msk_sasl" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "random_password" "api_signing_key" {
  length  = 64
  special = false
}

# ---------------------------------------------------------------------------
# KMS key — Secrets Manager
# ---------------------------------------------------------------------------

resource "aws_kms_key" "secrets" {
  description             = "Secrets Manager encryption key for ${local.name_prefix}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-secrets-kms"
  }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# ---------------------------------------------------------------------------
# PostgreSQL master credentials
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "postgres" {
  name                    = "${local.name_prefix}/postgres/master"
  description             = "PostgreSQL master credentials for ${local.name_prefix}"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = {
    Name = "${local.name_prefix}-postgres-secret"
  }
}

resource "aws_secretsmanager_secret_version" "postgres" {
  secret_id = aws_secretsmanager_secret.postgres.id
  secret_string = jsonencode({
    username = "modcompat_admin"
    password = random_password.postgres_master.result
    engine   = "postgres"
    host     = "" # populated via output after RDS is created
    port     = 5432
    dbname   = "modcompat"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# Redis auth token
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "${local.name_prefix}/redis/auth-token"
  description             = "Redis authentication token for ${local.name_prefix}"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = {
    Name = "${local.name_prefix}-redis-auth-secret"
  }
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id = aws_secretsmanager_secret.redis_auth.id
  secret_string = jsonencode({
    token = random_password.redis_auth_token.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# OpenSearch master credentials
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "opensearch" {
  name                    = "${local.name_prefix}/opensearch/master"
  description             = "OpenSearch master credentials for ${local.name_prefix}"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = {
    Name = "${local.name_prefix}-opensearch-secret"
  }
}

resource "aws_secretsmanager_secret_version" "opensearch" {
  secret_id = aws_secretsmanager_secret.opensearch.id
  secret_string = jsonencode({
    username = "opensearch_admin"
    password = random_password.opensearch_master.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# MSK SASL/SCRAM credentials
# MSK requires the secret to be tagged with "AmazonMSKIntegration"
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "msk_credentials" {
  name                    = "AmazonMSK_${local.name_prefix}_kafka_credentials"
  description             = "MSK SASL/SCRAM credentials for ${local.name_prefix}"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = {
    Name                 = "${local.name_prefix}-msk-secret"
    AmazonMSKIntegration = "true"
  }
}

resource "aws_secretsmanager_secret_version" "msk_credentials" {
  secret_id = aws_secretsmanager_secret.msk_credentials.id
  secret_string = jsonencode({
    username = "kafka_client"
    password = random_password.msk_sasl.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# JWT signing secret
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "jwt_secret" {
  name                    = "${local.name_prefix}/app/jwt-secret"
  description             = "JWT signing secret for ${local.name_prefix}"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = {
    Name = "${local.name_prefix}-jwt-secret"
  }
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id = aws_secretsmanager_secret.jwt_secret.id
  secret_string = jsonencode({
    secret = random_password.jwt_secret.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# API signing key
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "api_signing_key" {
  name                    = "${local.name_prefix}/app/api-signing-key"
  description             = "API request signing key for ${local.name_prefix}"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30

  tags = {
    Name = "${local.name_prefix}-api-signing-key-secret"
  }
}

resource "aws_secretsmanager_secret_version" "api_signing_key" {
  secret_id = aws_secretsmanager_secret.api_signing_key.id
  secret_string = jsonencode({
    key = random_password.api_signing_key.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
