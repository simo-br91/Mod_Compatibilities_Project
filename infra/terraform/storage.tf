# ---------------------------------------------------------------------------
# KMS key — S3 encryption
# ---------------------------------------------------------------------------

resource "aws_kms_key" "s3" {
  description             = "S3 default encryption key for ${local.name_prefix}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-s3-kms"
  }
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${local.name_prefix}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

# ---------------------------------------------------------------------------
# Local: bucket definitions
# ---------------------------------------------------------------------------

locals {
  s3_buckets = {
    raw_payloads = {
      suffix           = "raw-payloads"
      versioning       = true
      transition_days  = 90
      expiration_days  = 365
      glacier_days     = 180
    }
    artifacts = {
      suffix           = "artifacts"
      versioning       = true
      transition_days  = 180
      expiration_days  = 730
      glacier_days     = 365
    }
    ml_datasets = {
      suffix           = "ml-datasets"
      versioning       = true
      transition_days  = 180
      expiration_days  = 1095
      glacier_days     = 365
    }
    exports = {
      suffix           = "exports"
      versioning       = false
      transition_days  = 30
      expiration_days  = 90
      glacier_days     = 60
    }
  }
}

# ---------------------------------------------------------------------------
# Application S3 buckets (raw-payloads, artifacts, ml-datasets, exports)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "app" {
  for_each = local.s3_buckets

  bucket        = "${local.name_prefix}-${each.value.suffix}"
  force_destroy = false

  tags = {
    Name    = "${local.name_prefix}-${each.value.suffix}"
    Purpose = each.key
  }
}

resource "aws_s3_bucket_versioning" "app" {
  for_each = local.s3_buckets

  bucket = aws_s3_bucket.app[each.key].id

  versioning_configuration {
    status = each.value.versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app" {
  for_each = local.s3_buckets

  bucket = aws_s3_bucket.app[each.key].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "app" {
  for_each = local.s3_buckets

  bucket                  = aws_s3_bucket.app[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "app" {
  for_each = local.s3_buckets

  bucket = aws_s3_bucket.app[each.key].id

  rule {
    id     = "transition-to-glacier"
    status = "Enabled"

    transition {
      days          = each.value.glacier_days
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = each.value.expiration_days
    }

    noncurrent_version_transition {
      noncurrent_days = each.value.transition_days
      storage_class   = "STANDARD_IA"
    }

    noncurrent_version_expiration {
      noncurrent_days = each.value.expiration_days
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_logging" "app" {
  for_each = local.s3_buckets

  bucket        = aws_s3_bucket.app[each.key].id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "${each.value.suffix}/"
}

# ---------------------------------------------------------------------------
# Access logs bucket (receives S3 server access logs from all app buckets)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "access_logs" {
  bucket        = "${local.name_prefix}-s3-access-logs"
  force_destroy = false

  tags = {
    Name    = "${local.name_prefix}-s3-access-logs"
    Purpose = "access_logs"
  }
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "access_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.access_logs]
  bucket     = aws_s3_bucket.access_logs.id
  acl        = "log-delivery-write"
}

# ---------------------------------------------------------------------------
# Terraform state bucket
# ---------------------------------------------------------------------------

locals {
  state_bucket_name = var.terraform_state_bucket_suffix != "" ? "${local.name_prefix}-terraform-state-${var.terraform_state_bucket_suffix}" : "${local.name_prefix}-terraform-state"
}

resource "aws_s3_bucket" "terraform_state" {
  bucket        = local.state_bucket_name
  force_destroy = false

  tags = {
    Name    = local.state_bucket_name
    Purpose = "terraform_state"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "retain-noncurrent"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }
}

# ---------------------------------------------------------------------------
# DynamoDB table — Terraform state locking
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "terraform_locks" {
  name         = "${local.name_prefix}-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.s3.arn
  }

  tags = {
    Name = "${local.name_prefix}-terraform-locks"
  }
}
