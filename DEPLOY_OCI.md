# OCI Resource Manager 배포 가이드

GitHub 리포(`select-ai-test`)를 소스로 삼아 **OCI Resource Manager** 로 Oracle Linux 인스턴스에 본 도구(Oracle AI Database Test Tool)를 원클릭 배포하기 위한 작업 내용과 절차를 정리한 문서입니다.

> 요약: README 상단의 **Deploy to Oracle Cloud** 버튼 → RM 이 GitHub 아카이브 zip 을 스택으로 로드 → 변수 입력 후 Apply → 인스턴스 부팅 시 `git clone → uv sync → systemd 기동` 자동 수행 → `app_url` 접속 → **[Database 관리]** 화면에서 ADB 등록.

---

## 1. 배포 아키텍처

```
[사용자 브라우저]
   │  README 의 "Deploy to Oracle Cloud" 버튼 클릭
   ▼
https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=
        https://github.com/primelyson2/select-ai-test/archive/refs/heads/main.zip
   │
   ▼
[OCI Resource Manager]  ── Terraform 실행 ──┐
   │  main.tf / variables.tf / outputs.tf  │
   │  schema.yaml(입력 UI)                  │
   ▼                                        ▼
[프로비저닝되는 리소스]                  [컴퓨트 부팅: cloud-init.tftpl]
   • VCN (10.0.0.0/16)                      1. dnf install git python3.11 lsof
   • Internet Gateway + Route Table         2. git clone <repo> → /opt/select-ai-test
   • Security List (22, app_port 개방)       3. uv 설치 + uv sync (.venv)
   • Subnet (10.0.1.0/24, 공인 IP)           4. systemd 서비스 등록·기동
   • Compute (Oracle Linux 8/9)             5. firewalld 포트 개방
   │
   ▼
[Outputs] app_url = http://<공인IP>:8000  →  접속 후 [Database 관리]에서 ADB 등록
```

핵심 설계: 앱이 **`config.yaml` 없이도 기동**되므로(빈 설정 허용), 배포 후 화면의 **[Database 관리]** 메뉴에서 Wallet zip 업로드만으로 첫 DB 를 등록할 수 있습니다. 비밀(접속정보·Wallet)을 Terraform/리포에 넣지 않습니다.

---

## 2. 추가/변경된 파일

리포 루트(= `project/` 폴더)에 추가한 스택 구성 파일:

| 파일 | 역할 |
|---|---|
| `main.tf` | provider + VCN/IG/Route/Security List/Subnet + 컴퓨트 인스턴스 + 최신 Oracle Linux 이미지 조회 |
| `variables.tf` | 입력 변수 정의 (shape, OCPU/메모리, OS 버전, SSH 키, 포트, 허용 CIDR, 리포 URL/브랜치) |
| `outputs.tf` | `app_url` / `public_ip` / `ssh_command` 출력 |
| `cloud-init.tftpl` | 부팅 부트스트랩 — `git clone → uv sync → systemd select-ai-test 등록·기동 → 방화벽 개방` |
| `schema.yaml` | Resource Manager 변수 입력 UI (그룹/타입/기본값/출력 버튼) |

함께 변경한 파일:

| 파일 | 변경 내용 |
|---|---|
| `README.md` | 상단에 **Deploy to Oracle Cloud** 버튼 + §4 "OCI Resource Manager 배포" 절 추가 |
| `.gitignore` | Terraform 로컬 산출물(`.terraform/`, `*.tfstate`, `*.tfvars` 등) 제외 |
| `app/config.py` | `config.yaml` 이 없거나 비어 있어도 빈 설정으로 기동 (신규 인스턴스 부트스트랩 지원) |

> 비밀 파일(`config.yaml`, `wallets/`)은 기존 `.gitignore` 로 계속 제외됩니다 — 리포에 올라가지 않습니다.

---

## 3. Deploy 버튼 / URL

README 상단 버튼 마크다운:

```markdown
[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/primelyson2/select-ai-test/archive/refs/heads/main.zip)
```

동작 URL:

```
https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/primelyson2/select-ai-test/archive/refs/heads/main.zip
```

- `zipUrl` 은 GitHub 의 **브랜치 아카이브 zip** 주소입니다. RM 이 이 zip 을 받아 Terraform 구성으로 인식합니다.
- 다른 리포/브랜치로 바꾸려면 경로와 `…/refs/heads/<branch>.zip` 을 수정하세요.
- **공개(public) 리포** 기준입니다. private 리포는 RM 이 zip 을 받지 못하고 인스턴스의 `git clone` 도 실패합니다(별도 토큰/PAR 방식 필요).

---

## 4. 사전 준비

- OCI 테넌시 + 인스턴스를 만들 **구획(Compartment)** 및 적절한 IAM 권한
- 사용할 리전의 **컴퓨트 한도(서비스 리밋)** — 선택한 shape 기준 여유
- **SSH 공개키** (`~/.ssh/id_rsa.pub`). 없으면 생성:
  ```bash
  ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa
  cat ~/.ssh/id_rsa.pub
  ```
- 소스를 올릴 **공개 GitHub 리포** (`select-ai-test`)

---

## 5. 배포 절차

### 단계 0. (최초 1회) GitHub 에 소스 푸시
`project/` 폴더가 **리포 루트**가 되도록 푸시합니다. `config.yaml`·`wallets/` 는 `.gitignore` 로 자동 제외됩니다.

```bash
cd project
git init -b main
git add .
git commit -m "Initial: Oracle AI DB Test Tool + OCI RM stack"
git remote add origin https://github.com/primelyson2/select-ai-test.git
git push -u origin main
```

### 단계 1. Deploy 버튼 클릭 → Stack information
- GitHub 리포 README 의 **Deploy to Oracle Cloud** 버튼 클릭 → OCI 로그인 → **Create stack** 진입(구성 자동 로드)
- "I have reviewed and accept the Oracle Terms of Use" 체크 → **Next**

### 단계 2. Configure variables

| 변수 | 설명 | 기본값 |
|---|---|---|
| **구획 (Compartment)** | 리소스를 만들 구획 | — (선택) |
| **가용 도메인** | 비우면 첫 번째 AD 자동 사용 | (빈값) |
| **Shape** | 컴퓨트 형상 | `VM.Standard.E4.Flex` |
| **OCPU 수 / 메모리 GB** | Flex shape 전용 (Micro 는 무시) | 1 / 8 |
| **Oracle Linux 버전** | 9 또는 8 | `9` |
| **SSH 공개키** | 인스턴스 SSH 접속용 (한 줄) | — (필수) |
| **앱 포트** | 서비스 포트 | `8000` |
| **앱/SSH 허용 CIDR** | 접근 허용 대역 | `0.0.0.0/0` |
| **Git 리포지토리 URL / 브랜치** | 소스 위치 | 위 리포 / `main` |

> **Always Free** 로 쓰려면 Shape 를 `VM.Standard.A1.Flex`(ARM, 권장) 또는 `VM.Standard.E2.1.Micro` 로 변경. oracledb 는 Thin 모드라 ARM 에서도 동작합니다.

### 단계 3. Review → Create → Apply
- **Create** 시 "Run apply" 를 켜두거나, 스택 생성 후 **Apply** 버튼 클릭
- Apply Job 로그 끝의 **Outputs** 에서 `app_url`(예: `http://<공인IP>:8000`) 확인

### 단계 4. 첫 DB 등록
- 브라우저로 `app_url` 접속 → 좌측 **[Database 관리]** 메뉴
- **+ 새 데이터베이스** → ADB Wallet(zip) 업로드 → 사용자/비밀번호/DSN 입력 → **저장** → **연결 테스트**
- 헤더 드롭다운에 등록되면 각 메뉴에서 테스트 시작

> 부팅 후 `git clone`+`uv sync` 에 보통 **1~3분** 소요됩니다. 접속이 안 되면 잠시 후 재시도하거나 아래 로그를 확인하세요.

---

## 6. 운영 / 재배포

### 진행·상태 확인 (SSH)
```bash
ssh opc@<공인IP>
sudo tail -f /var/log/select-ai-deploy.log     # 부트스트랩 진행 로그
systemctl status select-ai-test                 # 서비스 상태
journalctl -u select-ai-test -f                 # 앱 로그
```

### 소스 업데이트 후 재기동
```bash
# 로컬: GitHub 에 푸시
git push

# 인스턴스
ssh opc@<공인IP>
cd /opt/select-ai-test && git pull && ~/.local/bin/uv sync
sudo systemctl restart select-ai-test
```

### 깨끗한 재배포 / 정리
- Resource Manager 스택에서 **Destroy** → 다시 **Apply** 하면 새 인스턴스로 재배포
- 더 이상 쓰지 않으면 **Destroy** 로 전체 리소스(VCN/서브넷/인스턴스 등) 제거

---

## 7. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| RM 에서 zip 로드 실패 | 리포가 private 이거나 브랜치명이 다름. public 인지, `…/refs/heads/<branch>.zip` 의 브랜치가 맞는지 확인 |
| `app_url` 접속 안 됨 (부팅 직후) | clone+sync 진행 중. 1~3분 후 재시도. `/var/log/select-ai-deploy.log` 확인 |
| 접속 안 됨 (시간 지나도) | ① Security List 의 app_port 인그레스 ② 인스턴스 firewalld ③ 허용 CIDR ④ 서비스 상태(`systemctl status select-ai-test`) 순서로 점검 |
| `git clone` 권한 오류 | private 리포. public 으로 전환하거나 토큰 방식 적용 필요 |
| 이미지 조회 실패/빈 결과 | 선택한 shape 에서 해당 OL 버전 이미지가 없을 수 있음. OS 버전(9↔8) 또는 shape 변경 |
| 컴퓨트 한도 초과 | 리전/구획의 서비스 리밋 부족. 다른 shape 선택 또는 한도 증설 요청 |

---

## 8. 보안 메모

- 기본 허용 CIDR 이 `0.0.0.0/0` 입니다. **데모용**이며, 운영/외부 노출 시 SSH·앱 포트 CIDR 을 사내 IP 대역으로 좁히세요.
- 현재 앱은 **HTTP(비암호)·인증 없음** 입니다. 외부 공개 시 HTTPS 종단(nginx/Load Balancer)과 인증을 별도 구성하세요.
- ADB 접속정보/Wallet 은 리포·Terraform 에 포함하지 않고, 배포 후 **[Database 관리]** 화면에서 등록합니다. 인스턴스 내부 `/opt/select-ai-test/config.yaml` 및 `wallets/` 에 저장되므로 인스턴스 접근 통제가 곧 비밀 보호입니다.

---

## 9. 검증 상태

- `terraform init` + `terraform validate` → **Success** (oracle/oci provider 기준)
- `terraform fmt` → 포맷 정상
- `cloud-init.tftpl` 템플릿 치환 변수 → `repo_url` / `repo_branch` / `app_port` 3개만(나머지 bash `$VAR` 는 보존)
- `schema.yaml` → YAML 파싱 정상 (변수 13, 그룹 5)
