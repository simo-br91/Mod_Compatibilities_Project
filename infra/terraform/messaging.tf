# ---------------------------------------------------------------------------
# KMS key — MSK encryption
# ---------------------------------------------------------------------------

resource "aws_kms_key" "msk" {
  description             = "MSK Kafka encryption key for ${local.name_prefix}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-msk-kms"
  }
}

resource "aws_kms_alias" "msk" {
  name          = "alias/${local.name_prefix}-msk"
  target_key_id = aws_kms_key.msk.key_id
}

# ---------------------------------------------------------------------------
# MSK configuration
# ---------------------------------------------------------------------------

resource "aws_msk_configuration" "main" {
  name              = "${local.name_prefix}-msk-config"
  kafka_versions    = [var.msk_kafka_version]
  description       = "MSK configuration for ${local.name_prefix}"

  server_properties = <<-EOT
    auto.create.topics.enable=false
    default.replication.factor=3
    min.insync.replicas=2
    num.partitions=6
    num.io.threads=8
    num.network.threads=5
    num.replica.fetchers=2
    socket.request.max.bytes=104857600
    unclean.leader.election.enable=false
    log.retention.hours=168
    log.segment.bytes=1073741824
    log.retention.check.interval.ms=300000
    offsets.topic.replication.factor=3
    transaction.state.log.replication.factor=3
    transaction.state.log.min.isr=2
  EOT
}

# ---------------------------------------------------------------------------
# MSK Cluster
# ---------------------------------------------------------------------------

resource "aws_msk_cluster" "main" {
  cluster_name           = "${local.name_prefix}-msk"
  kafka_version          = var.msk_kafka_version
  number_of_broker_nodes = var.msk_broker_count

  broker_node_group_info {
    instance_type   = var.msk_broker_instance_type
    client_subnets  = aws_subnet.private[*].id
    security_groups = [aws_security_group.msk.id]

    storage_info {
      ebs_storage_info {
        volume_size = var.msk_broker_ebs_volume_size

        provisioned_throughput {
          enabled           = true
          volume_throughput = 250
        }
      }
    }

    connectivity_info {
      public_access {
        type = "DISABLED"
      }
    }
  }

  client_authentication {
    sasl {
      scram = true
    }
    unauthenticated = false
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
    encryption_at_rest_kms_key_arn = aws_kms_key.msk.arn
  }

  configuration_info {
    arn      = aws_msk_configuration.main.arn
    revision = aws_msk_configuration.main.latest_revision
  }

  open_monitoring {
    prometheus {
      jmx_exporter {
        enabled_in_broker = true
      }
      node_exporter {
        enabled_in_broker = true
      }
    }
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk.name
      }
    }
  }

  depends_on = [aws_msk_configuration.main]

  tags = {
    Name = "${local.name_prefix}-msk"
  }
}

# ---------------------------------------------------------------------------
# MSK SCRAM secret association
# ---------------------------------------------------------------------------

resource "aws_msk_scram_secret_association" "main" {
  cluster_arn     = aws_msk_cluster.main.arn
  secret_arn_list = [aws_secretsmanager_secret.msk_credentials.arn]

  depends_on = [
    aws_msk_cluster.main,
    aws_secretsmanager_secret_version.msk_credentials,
  ]
}

# ---------------------------------------------------------------------------
# MSK storage autoscaling
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "msk" {
  max_capacity       = var.msk_storage_autoscaling_max_capacity
  min_capacity       = var.msk_broker_ebs_volume_size
  resource_id        = aws_msk_cluster.main.arn
  scalable_dimension = "kafka:broker-storage:VolumeSize"
  service_namespace  = "kafka"
}

resource "aws_appautoscaling_policy" "msk_storage" {
  name               = "${local.name_prefix}-msk-storage-autoscaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.msk.resource_id
  scalable_dimension = aws_appautoscaling_target.msk.scalable_dimension
  service_namespace  = aws_appautoscaling_target.msk.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "KafkaBrokerStorageUtilization"
    }
    target_value = var.msk_storage_autoscaling_target_percentage
  }
}

# ---------------------------------------------------------------------------
# CloudWatch log group — MSK broker logs
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "msk" {
  name              = "/aws/msk/${local.name_prefix}/broker-logs"
  retention_in_days = 30

  tags = {
    Name = "${local.name_prefix}-msk-logs"
  }
}
