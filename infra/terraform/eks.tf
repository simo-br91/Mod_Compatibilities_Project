# ---------------------------------------------------------------------------
# IAM role — EKS control plane
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "eks_assume_role" {
  statement {
    sid     = "EKSClusterAssumeRole"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks_cluster" {
  name               = "${local.name_prefix}-eks-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.eks_assume_role.json

  tags = {
    Name = "${local.name_prefix}-eks-cluster-role"
  }
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_role_policy_attachment" "eks_vpc_resource_controller" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSVPCResourceController"
}

# ---------------------------------------------------------------------------
# EKS Cluster
# ---------------------------------------------------------------------------

resource "aws_eks_cluster" "main" {
  name     = "${local.name_prefix}-eks"
  version  = var.eks_cluster_version
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids              = concat(aws_subnet.private[*].id, aws_subnet.public[*].id)
    security_group_ids      = [aws_security_group.eks_control_plane.id]
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  enabled_cluster_log_types = [
    "api",
    "audit",
    "authenticator",
    "controllerManager",
    "scheduler",
  ]

  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = aws_kms_key.eks.arn
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_policy,
    aws_iam_role_policy_attachment.eks_vpc_resource_controller,
    aws_cloudwatch_log_group.eks,
  ]

  tags = {
    Name = "${local.name_prefix}-eks"
  }
}

# ---------------------------------------------------------------------------
# KMS key — EKS secrets encryption
# ---------------------------------------------------------------------------

resource "aws_kms_key" "eks" {
  description             = "EKS secrets encryption key for ${local.name_prefix}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-eks-kms"
  }
}

resource "aws_kms_alias" "eks" {
  name          = "alias/${local.name_prefix}-eks"
  target_key_id = aws_kms_key.eks.key_id
}

# ---------------------------------------------------------------------------
# CloudWatch log group for EKS control plane logs
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.name_prefix}-eks/cluster"
  retention_in_days = 90

  tags = {
    Name = "${local.name_prefix}-eks-logs"
  }
}

# ---------------------------------------------------------------------------
# OIDC provider (required for IRSA)
# ---------------------------------------------------------------------------

data "tls_certificate" "eks_oidc" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks_oidc.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer

  tags = {
    Name = "${local.name_prefix}-eks-oidc"
  }
}

# ---------------------------------------------------------------------------
# IAM role — EKS node groups
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "eks_node_assume_role" {
  statement {
    sid     = "EKSNodeGroupAssumeRole"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks_node_group" {
  name               = "${local.name_prefix}-eks-node-role"
  assume_role_policy = data.aws_iam_policy_document.eks_node_assume_role.json

  tags = {
    Name = "${local.name_prefix}-eks-node-role"
  }
}

resource "aws_iam_role_policy_attachment" "eks_worker_node_policy" {
  role       = aws_iam_role.eks_node_group.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "eks_cni_policy" {
  role       = aws_iam_role.eks_node_group.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "eks_container_registry_readonly" {
  role       = aws_iam_role.eks_node_group.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "eks_ssm_policy" {
  role       = aws_iam_role.eks_node_group.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ---------------------------------------------------------------------------
# Managed node group — system (kube-system workloads)
# ---------------------------------------------------------------------------

resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.name_prefix}-system"
  node_role_arn   = aws_iam_role.eks_node_group.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = var.eks_system_node_instance_types
  disk_size       = var.eks_node_disk_size_gb
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = var.eks_system_node_min_size
    max_size     = var.eks_system_node_max_size
    desired_size = var.eks_system_node_desired_size
  }

  update_config {
    max_unavailable_percentage = 25
  }

  taint {
    key    = "dedicated"
    value  = "system"
    effect = "NO_SCHEDULE"
  }

  labels = {
    role = "system"
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_worker_node_policy,
    aws_iam_role_policy_attachment.eks_cni_policy,
    aws_iam_role_policy_attachment.eks_container_registry_readonly,
  ]

  tags = {
    Name = "${local.name_prefix}-system-node-group"
  }
}

# ---------------------------------------------------------------------------
# Managed node group — general purpose (application workloads)
# ---------------------------------------------------------------------------

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.name_prefix}-general"
  node_role_arn   = aws_iam_role.eks_node_group.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = var.eks_general_node_instance_types
  disk_size       = var.eks_node_disk_size_gb
  capacity_type   = "ON_DEMAND"

  scaling_config {
    min_size     = var.eks_general_node_min_size
    max_size     = var.eks_general_node_max_size
    desired_size = var.eks_general_node_desired_size
  }

  update_config {
    max_unavailable_percentage = 25
  }

  labels = {
    role = "general"
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_worker_node_policy,
    aws_iam_role_policy_attachment.eks_cni_policy,
    aws_iam_role_policy_attachment.eks_container_registry_readonly,
  ]

  tags = {
    Name = "${local.name_prefix}-general-node-group"
  }
}

# ---------------------------------------------------------------------------
# aws-auth ConfigMap — maps IAM node role into the cluster
# ---------------------------------------------------------------------------

resource "kubernetes_config_map_v1_data" "aws_auth" {
  metadata {
    name      = "aws-auth"
    namespace = "kube-system"
  }

  data = {
    mapRoles = yamlencode([
      {
        rolearn  = aws_iam_role.eks_node_group.arn
        username = "system:node:{{EC2PrivateDNSName}}"
        groups   = ["system:bootstrappers", "system:nodes"]
      },
    ])
  }

  force = true

  depends_on = [aws_eks_cluster.main]
}

# ---------------------------------------------------------------------------
# EKS Add-ons
# ---------------------------------------------------------------------------

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "coredns"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [
    aws_eks_node_group.system,
    aws_eks_node_group.general,
  ]

  tags = {
    Name = "${local.name_prefix}-coredns"
  }
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "kube-proxy"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_cluster.main]

  tags = {
    Name = "${local.name_prefix}-kube-proxy"
  }
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_update = "OVERWRITE"
  service_account_role_arn    = aws_iam_role.irsa_vpc_cni.arn

  depends_on = [aws_eks_cluster.main]

  tags = {
    Name = "${local.name_prefix}-vpc-cni"
  }
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "aws-ebs-csi-driver"
  resolve_conflicts_on_update = "OVERWRITE"
  service_account_role_arn    = aws_iam_role.irsa_ebs_csi.arn

  depends_on = [
    aws_eks_node_group.system,
    aws_eks_node_group.general,
  ]

  tags = {
    Name = "${local.name_prefix}-ebs-csi"
  }
}

# ---------------------------------------------------------------------------
# IRSA — VPC CNI
# ---------------------------------------------------------------------------

module "irsa_vpc_cni" {
  source = "./modules/irsa"

  name_prefix          = local.name_prefix
  service_account_name = "aws-node"
  namespace            = "kube-system"
  oidc_provider_arn    = aws_iam_openid_connect_provider.eks.arn
  oidc_provider_url    = aws_eks_cluster.main.identity[0].oidc[0].issuer
  policy_arns = [
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKS_CNI_Policy",
  ]
  tags = local.common_tags
}

resource "aws_iam_role" "irsa_vpc_cni" {
  name               = "${local.name_prefix}-irsa-vpc-cni"
  assume_role_policy = module.irsa_vpc_cni.assume_role_policy_json

  tags = {
    Name = "${local.name_prefix}-irsa-vpc-cni"
  }
}

resource "aws_iam_role_policy_attachment" "irsa_vpc_cni" {
  role       = aws_iam_role.irsa_vpc_cni.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}

# ---------------------------------------------------------------------------
# IRSA — EBS CSI Driver
# ---------------------------------------------------------------------------

module "irsa_ebs_csi" {
  source = "./modules/irsa"

  name_prefix          = local.name_prefix
  service_account_name = "ebs-csi-controller-sa"
  namespace            = "kube-system"
  oidc_provider_arn    = aws_iam_openid_connect_provider.eks.arn
  oidc_provider_url    = aws_eks_cluster.main.identity[0].oidc[0].issuer
  policy_arns = [
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
  ]
  tags = local.common_tags
}

resource "aws_iam_role" "irsa_ebs_csi" {
  name               = "${local.name_prefix}-irsa-ebs-csi"
  assume_role_policy = module.irsa_ebs_csi.assume_role_policy_json

  tags = {
    Name = "${local.name_prefix}-irsa-ebs-csi"
  }
}

resource "aws_iam_role_policy_attachment" "irsa_ebs_csi" {
  role       = aws_iam_role.irsa_ebs_csi.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

