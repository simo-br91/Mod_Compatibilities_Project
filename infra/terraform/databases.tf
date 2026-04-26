# ---------------------------------------------------------------------------
# RDS — subnet group
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name        = "${local.name_prefix}-rds-subnet-group"
  description = "Private subnets for RDS PostgreSQL"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-rds-subnet-group"
  }
}

# ---------------------------------------------------------------------------
# RDS — parameter group
# ---------------------------------------------------------------------------

resource "aws_db_parameter_group" "postgres" {
  name        = "${local.name_prefix}-postgres16"
  family      = "postgres16"
  description = "Custom parameter group for ${local.name_prefix} PostgreSQL 16"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_duration"
    value = "0"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }

  parameter {
    name  = "pg_stat_statements.track"
    value = "ALL"
  }

  parameter {
    name  = "ssl"
    value = "1"
  }

  tags = {
    Name = "${local.name_prefix}-postgres16-pg"
  }
}

# ---------------------------------------------------------------------------
# KMS key — RDS encryption
# ---------------------------------------------------------------------------

resource "aws_kms_key" "rds" {
  description             = "RDS encryption key for ${local.name_prefix}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-rds-kms"
  }
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${local.name_prefix}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# ---------------------------------------------------------------------------
# RDS — PostgreSQL instance
# ---------------------------------------------------------------------------

resource "aws_db_instance" "postgres" {
  identifier = "${local.name_prefix}-postgres"

  engine         = "postgres"
  engine_version = var.rds_postgres_version
  instance_class = var.rds_instance_class

  allocated_storage     = var.rds_allocated_storage
  max_allocated_storage = var.rds_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  db_name  = "modcompat"
  username = jsondecode(aws_secretsmanager_secret_version.postgres.secret_string)["username"]
  password = jsondecode(aws_secretsmanager_secret_version.postgres.secret_string)["password"]

  multi_az               = var.rds_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.postgres.name

  backup_retention_period   = var.rds_backup_retention_days
  backup_window             = "03:00-04:00"
  maintenance_window        = "Mon:04:00-Mon:05:00"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot     = true

  deletion_protection      = var.rds_deletion_protection
  skip_final_snapshot      = false
  final_snapshot_identifier = "${local.name_prefix}-postgres-final-snapshot"

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.rds.arn
  performance_insights_retention_period = 7

  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_enhanced_monitoring.arn

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  depends_on = [
    aws_db_subnet_group.main,
    aws_secretsmanager_secret_version.postgres,
  ]

  tags = {
    Name = "${local.name_prefix}-postgres"
  }
}

# ---------------------------------------------------------------------------
# IAM role — RDS enhanced monitoring
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "rds_monitoring_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_enhanced_monitoring" {
  name               = "${local.name_prefix}-rds-monitoring-role"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume_role.json

  tags = {
    Name = "${local.name_prefix}-rds-monitoring-role"
  }
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring" {
  role       = aws_iam_role.rds_enhanced_monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ---------------------------------------------------------------------------
# ElastiCache — subnet group
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name        = "${local.name_prefix}-redis-subnet-group"
  description = "Private subnets for ElastiCache Redis"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-redis-subnet-group"
  }
}

# ---------------------------------------------------------------------------
# KMS key — ElastiCache encryption
# ---------------------------------------------------------------------------

resource "aws_kms_key" "redis" {
  description             = "ElastiCache Redis encryption key for ${local.name_prefix}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-redis-kms"
  }
}

resource "aws_kms_alias" "redis" {
  name          = "alias/${local.name_prefix}-redis"
  target_key_id = aws_kms_key.redis.key_id
}

# ---------------------------------------------------------------------------
# ElastiCache — Redis replication group (cluster mode enabled)
# ---------------------------------------------------------------------------

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "Redis cluster for ${local.name_prefix}"

  node_type            = var.redis_node_type
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.redis.name

  engine_version = var.redis_engine_version

  num_node_groups         = var.redis_num_node_groups
  replicas_per_node_group = var.redis_replicas_per_node_group

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.redis.arn
  transit_encryption_enabled = true
  auth_token                 = jsondecode(aws_secretsmanager_secret_version.redis_auth.secret_string)["token"]

  automatic_failover_enabled = true
  multi_az_enabled           = true

  maintenance_window       = "tue:05:00-tue:06:00"
  snapshot_window          = "04:00-05:00"
  snapshot_retention_limit = 7

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_engine.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
  }

  depends_on = [
    aws_elasticache_subnet_group.main,
    aws_secretsmanager_secret_version.redis_auth,
  ]

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}

# ---------------------------------------------------------------------------
# ElastiCache — parameter group (cluster mode)
# ---------------------------------------------------------------------------

resource "aws_elasticache_parameter_group" "redis" {
  name   = "${local.name_prefix}-redis7-cluster"
  family = "redis7"

  parameter {
    name  = "cluster-enabled"
    value = "yes"
  }

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = {
    Name = "${local.name_prefix}-redis-pg"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch log groups — Redis
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "redis_slow" {
  name              = "/aws/elasticache/${local.name_prefix}-redis/slow-log"
  retention_in_days = 30

  tags = {
    Name = "${local.name_prefix}-redis-slow-log"
  }
}

resource "aws_cloudwatch_log_group" "redis_engine" {
  name              = "/aws/elasticache/${local.name_prefix}-redis/engine-log"
  retention_in_days = 30

  tags = {
    Name = "${local.name_prefix}-redis-engine-log"
  }
}
