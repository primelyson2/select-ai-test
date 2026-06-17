output "app_url" {
  description = "애플리케이션 접속 URL"
  value       = "http://${oci_core_instance.app.public_ip}:${var.app_port}"
}

output "public_ip" {
  description = "인스턴스 공인 IP"
  value       = oci_core_instance.app.public_ip
}

output "ssh_command" {
  description = "SSH 접속 명령"
  value       = "ssh opc@${oci_core_instance.app.public_ip}"
}
