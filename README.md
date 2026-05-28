# Oracle AI Database Test Tool

Oracle Autonomous Database 23ai 의 **SELECT AI** (`DBMS_CLOUD_AI.GENERATE`), **AI Agent Team** (`DBMS_CLOUD_AI_AGENT.RUN_TEAM`), 그리고 SELECT AI 답변 품질에 영향을 주는 **Object Comment / Annotation 메타데이터** 를 한 화면에서 테스트·관리하는 PoC 도구.

여러 ADB 를 등록해 두고 화면 우측 상단 드롭다운으로 전환하면서 동일한 프롬프트/팀을 **동일 도구로 비교**할 수 있습니다.

---

## 1. 주요 기능

### [메뉴 1] AI Profile Test
- `USER_CLOUD_AI_PROFILES` / `USER_CLOUD_AI_PROFILE_ATTRIBUTES` 로부터 Profile 목록과 속성을 조회.
- **Tab 1 — Profile 목록 / 속성**
  - 각 Profile 행 우측의 `AI Test` 버튼으로 즉시 단일 호출 테스트 (프롬프트 + Action 선택 → 응답·소요시간)
  - 속성 그리드의 Value 셀을 직접 편집 후 `저장` → `DBMS_CLOUD_AI.SET_ATTRIBUTE` 호출
  - 하단 헤더의 `AI Profile 구문 생성` 버튼 → 현재 속성으로 `dbms_cloud_ai.create_profile(...)` PL/SQL 블록 자동 생성 + 복사
- **Tab 2 — 속도 측정 및 비교**
  - 동일 프롬프트로 여러 Profile × 반복 횟수 만큼 `DBMS_CLOUD_AI.GENERATE` 호출
  - 회차별 응답시간 / 평균 / 최소 / 최대를 표 + Chart.js 막대그래프로 시각화
  - `runsql` / `narrate` / `showsql` 선택 시 `object_list` 가 설정된 Profile 만 자동 필터
  - 캐시 회피용으로 회차 번호만큼 `.` 을 프롬프트 끝에 자동 추가

### [메뉴 2] AI Agent Team Test
- `USER_AI_AGENT_TEAMS` / `_AGENTS` / `_TASKS` / `_TOOLS` 와 각 `*_ATTRIBUTES` 를 단일 batch 쿼리로 조회 (`asyncio.gather` 로 병렬화).
- **Tab 1 — Team / Agent / Task / Tool 트리**
  - Team → Agent → Task → Tool 4 레벨 계층 트리
  - 각 노드의 type 배지 + role / instruction 요약 inline 표시
  - 노드 선택 시 하단에 속성 그리드 → Value 직접 편집 후 `저장` → `DBMS_CLOUD_AI_AGENT.SET_ATTRIBUTE` 호출
- **Tab 2 — Team 실행 및 단계별 속도 추적**
  - PL/SQL 블록 (`CREATE_CONVERSATION` + `RUN_TEAM`) 실행, CLOB 결과 + `conversation_id` 반환
  - `USER_AI_AGENT_TEAM_HISTORY` / `_TASK_HISTORY` / `_TOOL_HISTORY` 의 `START_DATE` / `END_DATE` 로 Gantt 스타일 단계 타임라인 재구성
  - Raw 로그 (대화 프롬프트 / Task 이력 / Tool 호출 횟수·시간) 접이식 표

### [메뉴 3] Profile Object Comment & Annotation
- Profile 의 `object_list` 속성 (JSON 배열) 을 파싱하여 등록 테이블 목록 표시.
- 테이블 클릭 시 `ALL_TAB_COMMENTS` / `ALL_COL_COMMENTS` / `USER_ANNOTATIONS_USAGE` 기반의 테이블·컬럼 메타데이터 그리드.
- **테이블 레벨**: Comment textarea 수정 + Annotation (1:N) 관리 모달 (`ALTER TABLE ... ANNOTATIONS (ADD OR REPLACE / DROP ...)`)
- **컬럼 레벨**: 컬럼별 Comment 인라인 편집 → `Comment 일괄 저장`, Annotation 모달로 개별 추가/삭제
- Identifier (owner/table/column/annotation name) 는 `^[A-Z][A-Z0-9_$#]*$` 정규식으로 화이트리스트 검증 후 SQL 보간. Comment / Annotation 값은 single-quote 이스케이프 후 SQL literal 로 삽입.

---

## 2. 기술 스택

| 항목 | 내용 |
|---|---|
| Backend | Python 3.11+ / FastAPI (async) |
| Frontend | Vanilla HTML / CSS / JavaScript (프레임워크 미사용) + Chart.js (CDN) |
| DB | Oracle Autonomous Database 23ai |
| DB 드라이버 | `python-oracledb` **Thin mode** + Wallet (mTLS, Instant Client 불필요) |
| 다중 DB | `config.yaml` 의 `databases:` 리스트 + `X-Database` 헤더 |
| 패키지 관리 | `uv` |

---

## 3. 로컬 개발

### 사전 준비
- **Python 3.11+**
- **uv** — `curl -LsSf https://astral.sh/uv/install.sh | sh` 또는 `brew install uv`
- **Oracle ADB Wallet** — OCI 콘솔 > Autonomous Database > DB Connection > **Download Wallet (Instance Wallet)**

### 설정 파일 작성
```bash
cp config.yaml.example config.yaml
vi config.yaml
```
다중 DB 예시는 `config.yaml.example` 참조. 필수 키:
- `name` / `label` — UI 헤더 드롭다운에 표시되는 이름
- `user` / `password` — DB 사용자
- `dsn` — `tnsnames.ora` 의 alias (예: `ailakehouse_high`)
- `wallet_location` / `config_dir` — Wallet 압축 해제 경로
- `wallet_password` — Wallet 다운로드 시 설정한 비밀번호

### Wallet 배치
```bash
mkdir -p wallets/<db-name>
unzip Wallet_<db-name>.zip -d wallets/<db-name>/
```
`config.yaml` 의 `wallet_location` / `config_dir` 와 일치시킬 것.

### 실행
```bash
uv sync
uv run uvicorn app.main:app --reload --port 8000
```
브라우저: <http://localhost:8000>

### 포트 점유 시
```bash
lsof -i :8000
kill -9 <PID>
```

---

## 4. VM 배포

VM 에 소스를 복사한 후 `scripts/*.sh` 를 사용해 설치 → 실행합니다. 비밀 파일 (`config.yaml`, `wallets/`) 은 전송 대상에서 제외되며, VM 측에서 별도로 작성·배치합니다.

### 사전 준비 (VM 측)
- Oracle Linux 8/9, Ubuntu 22.04 등 (`python3 --version` 기준 **3.11 이상**)
- 인터넷 접근 — uv 자동 설치 + `uv sync` 가 의존성을 받아옴

### 단계 1. 로컬 → VM 소스 전송
```bash
# 로컬 (project/ 디렉토리에서)
bash scripts/deploy.sh ec2-user@<vm-host> ~/oracle-ai-tool
```
내부적으로 `rsync` 사용. 다음 항목은 자동 제외 — `.venv/`, `__pycache__/`, `wallets/`, `config.yaml`, `.git/`, `*.log`.

`rsync` 가 없거나 수동 전송하려면:
```bash
tar -czf oracle-ai-tool.tar.gz \
  --exclude='.venv' --exclude='__pycache__' \
  --exclude='wallets' --exclude='config.yaml' \
  -C project .
scp oracle-ai-tool.tar.gz ec2-user@<vm-host>:~/
ssh ec2-user@<vm-host> "mkdir -p ~/oracle-ai-tool && tar -xzf ~/oracle-ai-tool.tar.gz -C ~/oracle-ai-tool"
```

### 단계 2. VM 초기 설치
```bash
ssh ec2-user@<vm-host>
cd ~/oracle-ai-tool
bash scripts/install.sh
```
`install.sh` 동작:
1. Python 3.11+ 검증
2. `uv` 미설치 시 자동 설치 (`~/.local/bin/uv`)
3. `uv sync` 로 의존성 동기화
4. `config.yaml`, `wallets/` 누락 여부 점검 (경고만)

### 단계 3. 설정 파일 / Wallet 배치
```bash
cp config.yaml.example config.yaml
vi config.yaml                                    # ADB 접속정보 입력

mkdir -p wallets/<db-name>
unzip Wallet_<db-name>.zip -d wallets/<db-name>/  # 또는 scp 로 미리 업로드
```

### 단계 4. 실행
```bash
bash scripts/run.sh                # foreground 실행 (0.0.0.0:8000)
PORT=9000 bash scripts/run.sh      # 포트 변경
```
백그라운드 (간단):
```bash
nohup bash scripts/run.sh > server.log 2>&1 &
```

### 단계 5. 종료
```bash
bash scripts/stop.sh               # 기본 PORT=8000
PORT=9000 bash scripts/stop.sh
```

### 단계 6. (선택) systemd 자동 시작
```bash
# 경로 / 사용자 환경에 맞게 수정
vi scripts/oracle-ai-tool.service

sudo cp scripts/oracle-ai-tool.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oracle-ai-tool
sudo systemctl status oracle-ai-tool
journalctl -u oracle-ai-tool -f
```

### 단계 7. 방화벽 / 보안 그룹
VM 측 8000 포트 inbound 허용. OCI VCN 의 Security List, AWS Security Group 등 환경에 맞게 설정.
```bash
# Oracle Linux firewalld 예시
sudo firewall-cmd --add-port=8000/tcp --permanent
sudo firewall-cmd --reload
```

---

## 5. 다중 ADB 사용

`config.yaml` 의 `databases:` 리스트에 ADB 여러 개를 등록하면 화면 우측 상단에 드롭다운이 생깁니다.
- 선택값은 `localStorage` 에 저장 → 새로고침 후에도 유지
- 모든 API 호출에 `X-Database: <db-name>` 헤더 자동 첨부
- 한 ADB 의 Wallet 초기화가 실패해도 다른 ADB 는 정상 동작 (실패 항목만 드롭다운에서 비활성화)
- 드롭다운 변경 시 현재 메뉴의 뷰가 새 DB 기준으로 즉시 재조회

---

## 6. 프로젝트 구조

```
project/
├─ README.md                  # 본 문서
├─ pyproject.toml             # uv 관리 의존성 (fastapi, oracledb, pyyaml, uvicorn)
├─ config.yaml.example        # 설정 샘플 — config.yaml 로 복사 후 작성
├─ config.yaml                # 실제 설정 (git ignored — 비밀 포함)
├─ wallets/                   # ADB Wallet (git ignored)
│   └─ <db-name>/             # tnsnames.ora, cwallet.sso, ewallet.pem 등
├─ app/
│  ├─ main.py                 # FastAPI 엔트리 + lifespan 으로 풀 초기화
│  ├─ config.py               # config.yaml 로더 (다중 ADB)
│  ├─ db.py                   # 비동기 풀 dict + fetch_all/fetch_one/execute
│  ├─ deps.py                 # current_db dependency (X-Database 헤더 검증)
│  └─ routers/
│     ├─ databases.py         # GET /api/databases
│     ├─ profiles.py          # 메뉴 1 — Profile/Attributes/Benchmark + objects(stub→실DB)
│     ├─ agents.py            # 메뉴 2 — Tree(batch)/Detail/Run/Timeline/SET_ATTRIBUTE
│     └─ objects.py           # 메뉴 3 — Metadata/Comment/Annotation DDL
├─ static/
│  ├─ index.html
│  ├─ css/  (redwood.css, layout.css)
│  └─ js/   (app.js, api.js, db_selector.js, views/*, components/*)
└─ scripts/
   ├─ install.sh              # 초기 설치 (uv + uv sync + 점검)
   ├─ run.sh                  # 서버 기동
   ├─ stop.sh                 # 서버 종료
   ├─ deploy.sh               # 로컬 → VM rsync (비밀 제외)
   └─ oracle-ai-tool.service  # systemd unit 샘플
```

---

## 7. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| 기동 시 `database unavailable` | `config.yaml` 의 `wallet_password` 또는 `dsn` 오류. 로그에서 ORA 메시지 확인. |
| `DPY-3022: named time zones are not supported` | `oracledb` thin mode 가 `TIMESTAMP WITH TIME ZONE` 미지원. 본 도구는 `CAST(SYS_EXTRACT_UTC(...) AS TIMESTAMP)` 로 우회 — 사용자 SQL 추가 시 동일 패턴 적용. |
| `Annotations: 미지원` 배지 | DB 버전이 23ai 미만이거나 `USER_ANNOTATIONS_USAGE` 뷰 없음. Annotation 기능만 비활성. |
| `DPY-4008: no bind placeholder ... :txt` | thin mode async 가 일부 DDL (COMMENT ON ...) 의 bind 를 인식 못 함. 본 도구는 SQL literal + single-quote escape 로 우회. |
| 포트 점유 | `bash scripts/stop.sh` 또는 `lsof -i :8000` 후 `kill <PID>` |
| `RUN_TEAM` 응답이 즉시 오류 | Team / Task / Tool 구성의 참조 무결성 문제 (`ORA-20051: Task X does not exist` 등). `*_ATTRIBUTES` 의 JSON 값 확인. |

---

## 8. 제한 사항 / 범위 외

PoC 단계 도구로 다음 항목은 의도적으로 구현하지 않았습니다:

- 사용자 인증 / 권한 관리
- Profile / Agent 의 신규 생성 (DDL 수준 관리는 미지원, 조회·측정만)
- 측정 결과 영속화 (세션 단위 휘발)
- 다국어 (한국어 UI 만)
- 테이블 / 컬럼의 신규 생성 / 삭제 (Comment / Annotation 수정에 한정)

운영 환경 도입 시 HTTPS 종단 (nginx / Oracle Load Balancer), 인증 (OAuth / mTLS), 모니터링 등을 별도로 구성하세요.
