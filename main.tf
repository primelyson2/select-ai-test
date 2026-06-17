terraform {
  required_version = ">= 1.2.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0.0"
    }
  }
}

provider "oci" {
  tenancy_ocid = var.tenancy_ocid
  region       = var.region
}

# ───── 가용 도메인 / 이미지 조회 ─────
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ol" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Oracle Linux"
  operating_system_version = var.os_version
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  ad_name  = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.ads.availability_domains[0].name
  image_id = data.oci_core_images.ol.images[0].id
  is_flex  = length(regexall("Flex", var.instance_shape)) > 0
}

# ───── 네트워크 ─────
resource "oci_core_vcn" "vcn" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "${var.app_name}-vcn"
  dns_label      = "selectai"
}

resource "oci_core_internet_gateway" "ig" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.app_name}-ig"
}

resource "oci_core_route_table" "rt" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.app_name}-rt"
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.ig.id
  }
}

resource "oci_core_security_list" "sl" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.app_name}-sl"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  # SSH
  ingress_security_rules {
    protocol = "6" # TCP
    source   = var.ssh_allowed_cidr
    tcp_options {
      min = 22
      max = 22
    }
  }

  # 애플리케이션 포트
  ingress_security_rules {
    protocol = "6"
    source   = var.app_allowed_cidr
    tcp_options {
      min = var.app_port
      max = var.app_port
    }
  }
}

resource "oci_core_subnet" "subnet" {
  compartment_id    = var.compartment_ocid
  vcn_id            = oci_core_vcn.vcn.id
  cidr_block        = "10.0.1.0/24"
  display_name      = "${var.app_name}-subnet"
  route_table_id    = oci_core_route_table.rt.id
  security_list_ids = [oci_core_security_list.sl.id]
  dns_label         = "app"
}

# ───── 컴퓨트 인스턴스 ─────
resource "oci_core_instance" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.ad_name
  display_name        = "${var.app_name}-vm"
  shape               = var.instance_shape

  dynamic "shape_config" {
    for_each = local.is_flex ? [1] : []
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gbs
    }
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.subnet.id
    assign_public_ip = true
    display_name     = "${var.app_name}-vnic"
  }

  source_details {
    source_type = "image"
    source_id   = local.image_id
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.tftpl", {
      repo_url    = var.repo_url
      repo_branch = var.repo_branch
      app_port    = var.app_port
    }))
  }
}
