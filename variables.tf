# OCI Resource Manager 변수.
# tenancy_ocid / compartment_ocid / region 은 Resource Manager 가 자동 주입한다
# (schema.yaml 에서 tenancy/region 은 숨김 처리).

variable "tenancy_ocid" {
  type        = string
  description = "테넌시 OCID (Resource Manager 자동 주입)"
}

variable "compartment_ocid" {
  type        = string
  description = "리소스를 생성할 구획 OCID"
}

variable "region" {
  type        = string
  description = "리전 (Resource Manager 자동 주입)"
}

variable "app_name" {
  type        = string
  description = "생성되는 리소스 이름 접두사"
  default     = "select-ai-test"
}

# ───── Compute ─────
variable "availability_domain" {
  type        = string
  description = "가용 도메인 이름 (비우면 첫 번째 AD 사용)"
  default     = ""
}

variable "instance_shape" {
  type        = string
  description = "컴퓨트 shape"
  default     = "VM.Standard.E4.Flex"
}

variable "instance_ocpus" {
  type        = number
  description = "OCPU 수 (Flex shape 전용)"
  default     = 1
}

variable "instance_memory_gbs" {
  type        = number
  description = "메모리 GB (Flex shape 전용)"
  default     = 8
}

variable "os_version" {
  type        = string
  description = "Oracle Linux 버전"
  default     = "9"
}

variable "ssh_public_key" {
  type        = string
  description = "인스턴스 SSH 접속용 공개키 (한 줄)"
}

# ───── Network ─────
variable "app_port" {
  type        = number
  description = "애플리케이션 포트"
  default     = 8000
}

variable "app_allowed_cidr" {
  type        = string
  description = "앱 포트 접근 허용 CIDR"
  default     = "0.0.0.0/0"
}

variable "ssh_allowed_cidr" {
  type        = string
  description = "SSH(22) 접근 허용 CIDR"
  default     = "0.0.0.0/0"
}

# ───── Application source ─────
variable "repo_url" {
  type        = string
  description = "애플리케이션 Git 리포지토리 URL"
  default     = "https://github.com/primelyson2/select-ai-test.git"
}

variable "repo_branch" {
  type        = string
  description = "체크아웃할 브랜치"
  default     = "main"
}
