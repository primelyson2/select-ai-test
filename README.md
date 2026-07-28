# Oracle AI Database Test Tool

Oracle Autonomous Database 23ai 의 **SELECT AI** (`DBMS_CLOUD_AI.GENERATE`), **AI Agent Team** (`DBMS_CLOUD_AI_AGENT.RUN_TEAM`), 그리고 SELECT AI 답변 품질에 영향을 주는 **Object Comment / Annotation 메타데이터** 를 한 화면에서 테스트·관리하는 PoC 도구.

여러 ADB 를 등록해 두고 화면 우측 상단 드롭다운으로 전환하면서 동일한 프롬프트/팀을 **동일 도구로 비교**할 수 있습니다.

> ⚠️ **본 도구는 PoC/데모 목적이며 프로덕션 사용을 보장하지 않습니다.** "있는 그대로(AS IS)" 제공되며 어떠한 보증도 하지 않습니다 (Apache License 2.0, §7·§8 참조).

## ☁️ OCI 원클릭 배포 (Resource Manager)

아래 버튼을 누르면 OCI Resource Manager 의 **Create Stack** 화면으로 이동하며, 이 리포의 Terraform 스택이 자동으로 로드됩니다. 부팅 시 소스를 clone → 의존성 설치 → 서비스 기동까지 자동 수행합니다.

[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/primelyson2/select-ai-test/archive/refs/heads/main.zip)

> 버튼은 **하나**입니다. 배포 방식(HTTP/HTTPS/HTTPS+기존VM)은 클릭 후 **Create Stack 화면의 `Working directory` 드롭다운에서 폴더를 고르는 것**으로 결정합니다. (Deploy 버튼 URL 은 working directory 를 미리 지정할 수 없어, 세 방식이 같은 zip 을 공유합니다.)

| | **옵션 A — HTTP** (인증서 불필요, 간편) | **옵션 B — HTTPS** (Load Balancer + 인증서) | **옵션 C — HTTPS + 기존 VM** (LB 만) |
|---|---|---|---|
| Working directory | **`deploy/http`** 선택 | **`deploy/https`** 선택 | **`deploy/https-existing-vm`** 선택 |
| 입력 | 구획/네트워크만 | + **인증서 OCID** 등 | 기존 **인스턴스 OCID** + **인증서 OCID** |
| 동작 | LB 없이 인스턴스 공인 IP 직접 접속 | 새 VM 생성 + 공용 LB 가 TLS 종단 → 인스턴스 `:8000` 전달 | **컴퓨트 미생성** — **기존 VM 에 SSH 로 소스 설치** + 공용 LB 가 TLS 종단 → 기존 VM `:8000` 전달 |
| 접속 URL | `app_url` = `http://<공인IP>:8000` | `https_url` = `https://<LB IP>` | `https_url` = `https://<LB IP>` |
| 사전 준비 | 서브넷 보안 목록에 **앱 포트(기본 8000) 인바운드**만 | 서브넷에 443(및 80) 인바운드 + LB 가 인증서 읽도록 **IAM 정책** 1회 (배포 상세는 [Guide_Deploy_OCI.md](Guide_Deploy_OCI.md)) | 좌측 + LB→VM **app_port** 인바운드 + 기존 VM **공인 IP·SSH(22)·SSH 개인키**(소스 설치용) |
| 권장 | 빠른 데모/내부 PoC (평문 HTTP) | 외부 노출/TLS 필요 시 | 앱 없는(또는 재설치할) 기존 VM 에 소스+TLS 를 한 번에 |

배포가 끝나면 스택 Outputs 의 `app_url`(HTTP) 또는 `https_url`(HTTPS) 로 접속 → **[Database 관리]** 메뉴에서 ADB Wallet 을 업로드해 첫 DB 를 등록합니다. 자세한 배포 절차·트러블슈팅은 별도 문서 **[Guide_Deploy_OCI.md](Guide_Deploy_OCI.md)** 를 참조하세요.

---

## 1. 주요 기능

좌측 메뉴 순서대로 각 화면의 역할을 정리합니다.

### 1. AI Profile Object Meta
- SELECT AI 답변 품질을 좌우하는 **스키마 메타데이터(Comment·Annotation)** 를 관리하는 화면.
- Profile 의 `object_list` (JSON 배열) 을 파싱해 등록 테이블 목록을 보여주고, 테이블 클릭 시 `ALL_TAB_COMMENTS` / `ALL_COL_COMMENTS` / `USER_ANNOTATIONS_USAGE` 기반 테이블·컬럼 메타데이터 그리드를 조회.
- **테이블 레벨**: Comment 수정 + Annotation(1:N) 관리 모달 (`ALTER TABLE ... ANNOTATIONS (ADD OR REPLACE / DROP ...)`, 23ai).
- **컬럼 레벨**: 컬럼별 Comment 인라인 편집 → `Comment 일괄 저장`, Annotation 개별 추가/삭제.
- 식별자(owner/table/column/annotation)는 `^[A-Z][A-Z0-9_$#]*$` 화이트리스트 검증 후 보간, 값은 single-quote 이스케이프. **23ai 미만이거나 `USER_ANNOTATIONS_USAGE` 가 없으면 Annotation 영역 비활성.**
- 용도: LLM 이 테이블·컬럼 의미를 더 잘 이해하도록 메타데이터를 다듬어 생성 SQL 품질을 개선.

### 2. AI Profile Test
- SELECT AI 의 기본 단위인 **AI Profile** 을 조회·측정·관리하는 화면. `USER_CLOUD_AI_PROFILES` / `USER_CLOUD_AI_PROFILE_ATTRIBUTES` 로 목록·속성 조회.
- **Tab 1 — Profile 목록 / 속성**
  - 각 Profile 행의 `AI Test` 버튼으로 즉시 단일 호출 테스트(프롬프트 + Action 선택 → 응답·소요시간).
  - 속성 그리드의 Value 를 직접 편집 후 `저장` → `DBMS_CLOUD_AI.SET_ATTRIBUTE`.
  - `AI Profile 구문 생성` → 현재 속성으로 `dbms_cloud_ai.create_profile(...)` PL/SQL 블록 자동 생성·복사.
- **Tab 2 — 속도 측정 및 비교**
  - 동일 프롬프트로 여러 Profile × 반복 횟수만큼 `DBMS_CLOUD_AI.GENERATE` 호출.
  - 회차별 응답시간 / 평균 / 최소 / 최대를 표 + Chart.js 막대그래프로 시각화(캐시 회피용 `.` 자동 부가).
  - `runsql` / `narrate` / `showsql` 은 `object_list` 가 설정된 Profile 만 자동 필터.

### 3. AI Agent Team Test
- 여러 에이전트가 협업하는 **AI Agent Team** 을 조회·실행·분석하는 화면. `USER_AI_AGENT_TEAMS` / `_AGENTS` / `_TASKS` / `_TOOLS` + 각 `*_ATTRIBUTES` 를 batch 로 조회.
- **Tab 1 — Team / Agent / Task / Tool 트리**: 4 레벨 계층 트리 + type 배지·role/instruction 요약, 노드 선택 시 속성 편집 → `DBMS_CLOUD_AI_AGENT.SET_ATTRIBUTE`.
- **Tab 2 — Team 실행 및 단계별 속도 추적**: `CREATE_CONVERSATION` + `RUN_TEAM` 실행 → CLOB 결과·`conversation_id`, `USER_AI_AGENT_*_HISTORY` 의 `START/END_DATE` 로 단계 타임라인·thinking 과정 재구성, Raw 로그 접이식 표.

### 4. Select AI Test - Table list
- **질문 + 조회할 컬럼**을 지정해 NL2SQL 생성을 테스트하고 결과를 표로 보는 실습 화면(전체 결과 CSV 다운로드).
- **질문관리방식**(local storage / DB) 전환 — DB 방식은 질문·조회컬럼을 `T_NL2SQL_QUESTION` / `T_NL2SQL_COLUMN` 에 저장·검색·선택(빌더·검색·컬럼선택 팝업).
- 선택 컬럼의 **관련성 AI 평가**, 직전 생성 SQL·목표 SQL 을 비교한 **Comment/Annotation 개선안 추천**, 결과표에 대한 **페르소나 기반 AI 분석**.
- 관련 DB 객체: `DBMS_CLOUD_AI.GENERATE`, `T_NL2SQL_QUESTION` / `T_NL2SQL_COLUMN`(자동 생성).

### 5. Select AI Test - AI Chat for Table list
- **AI Chat 과 유사한 대화형 UI** 이지만, Agent Team 이 자연어 답 대신 **SQL(JSON: `{answers:[{title,sql}]}`)** 을 반환하면 **앱이 그 SQL 을 실행해 표로** 답하는 화면.
- 결과는 **5행 미리보기 + 전체 CSV 다운로드**. 처리 중 "…" 옆에 **🧠 Thinking 링크**로 진행 상황(thinking 과정)을 popup 으로 확인.
- 복잡한 질문은 하위질문으로 나눠 여러 SQL 을 생성 → 각각 별도 결과표로 표시.

### 6. Select AI Test - AI Chat
- **Multi-Turn 대화형** 인터페이스로 Agent Team(`RUN_TEAM`)을 호출하는 화면.
- Chat설정(Team / 변수 / User Prompt)으로 메시지 전송, **Multi Turn ON 시 `conversation_id` 로 대화 맥락 유지**(되묻기/HITL 응답 이어가기), 단계별 thinking/timeline 조회, 설정 팝업에서 **실행 스크립트(RUN_TEAM 익명블록) 미리보기**.
- 처리 중 "…" 옆 **🧠 Thinking 링크**로 진행 중 thinking 조회.

### 7. Select AI Test - Agent History
- `USER_AI_AGENT_TEAM_HISTORY` 실행 내역을 **읽기전용으로 조회**하고, 행 클릭 시 상세 popup 을 띄우는 화면.
- 상세 popup 은 AI Agent Team Test 의 "2. Team 실행" 탭과 동일하게 **① Thinking 과정 · ② 단계별 타임라인 · ③ 최종결과 & 로그** 를 보여주며, Thinking 헤더에서 **[AI 추천]·[Thinking과정분석]·[복사]** 를 제공.

### 8. Select AI Test - Predefined Query
- 미리 정의해 둔 **질의 세트를 실행**하는 화면(데모·회귀 확인용).
- 사전정의 case(`T_PREDEFINED_QUERY`)의 기준 SQL 에서 **LLM 이 WHERE 만 완성**(`f_predefined_query` → `{"sql":"..."}`)하고, **앱이 그 SQL 을 실행**해 Table list 로 렌더.

### 9. Select AI Security - VPD
- 행 수준 보안(**Virtual Private Database**)을 설정·검증하는 화면.
- 공통 파라미터(`{NAME}` / `{SCHEMA}` / `{TABLE}`)로 1·2·3단계 **VPD 스크립트 생성·편집·DB 적용**, 정책/정책함수·Application Context/Package **삭제**, 설정 후 **Application Context 자동 재조회**, `DBA_CONTEXT` 뷰어, 정책 사용중지.
- 관련 DB 객체: `DBMS_RLS`, Application Context(`CREATE CONTEXT` / `DBMS_SESSION`), `DBA_CONTEXT`.

### 10. Database 관리
- 테스트 대상 ADB 를 **화면에서 직접 등록·수정·삭제**(config.yaml 을 손으로 편집하지 않아도 됨).
- **Wallet zip 업로드** → `wallets/<이름>/` 자동 압축 해제, `tnsnames.ora` 를 파싱해 **DSN 드롭다운**(`_high`/`_medium`/`_low`) 자동 채움.
- `연결 테스트` 로 풀 재초기화·접속 확인(성공/ORA 오류 표시). 저장 시 `config.yaml` 갱신 + 해당 풀만 재기동 → 헤더 드롭다운 즉시 반영(서버 재시작 불필요).
- 비밀번호 / Wallet 비밀번호는 응답에 노출하지 않으며, 수정 시 비워두면 기존 값 유지. **접속 가능한 DB 가 없어도 진입 가능**(복구 경로).

### 11. Tool관리
- 도구 자체의 접근·구성을 관리하는 **관리자 화면**.
- **접근 키** 설정·회전(+SMTP 키분실 복구), **메뉴 노출 관리**(브라우저별 토글), **Local Storage 관리**(선택 DB 의 저장 설정·프롬프트를 JSON 으로 내보내기/가져오기 — 다른 DB·사용자에게 이식).
- 고객별 좌측 메뉴 프리셋(URL `?customer=<key>`)은 별도 문서 **[Guide_menu.md](Guide_menu.md)** 참조. 접근 키 운영 세부는 내부 문서 `Guide_Security_info.md`(저장소 미포함).

> `Database 관리` · `Tool관리` 는 **관리용** 화면이라 선택된 DB 가 없어도 진입 가능합니다(복구·DB무관 경로). 좌측 메뉴에는 위 목록 외에 `질문관리` / `AI Chat2` / `History` / `History2` / `페르소나분석` / `API관리` 등 보조 화면도 있습니다.

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

> **전제**: 이 소스 폴더(리포 루트 = `pyproject.toml` · `app/` · `static/` 이 있는 곳)를 이미 로컬에 복사해 둔 상태에서 시작합니다. 아래 명령은 모두 **그 폴더 안**에서 실행합니다.

### 3.1 사전 준비
- **Python 3.11+** — `python3 --version` 으로 확인.
- **uv** (패키지·가상환경 관리) — `curl -LsSf https://astral.sh/uv/install.sh | sh` 또는 `brew install uv`.
- **Oracle ADB Wallet(zip)** — OCI 콘솔 › Autonomous Database › *DB Connection* › **Download Wallet (Instance Wallet)** + 다운로드 시 지정한 **Wallet 비밀번호**, 그리고 접속할 **DB 사용자/비밀번호**.
- **DB 사용자 사전 권한** — SELECT AI / Agent 를 쓰려면 접속 DB 사용자에게 `DBMS_CLOUD_AI` 등 실행 권한이 미리 부여돼 있어야 합니다. 상세는 **[Prerequisites.md](Prerequisites.md)** 참조. *(단순 조회·화면 확인만이면 없어도 기동은 됩니다.)*

### 3.2 의존성 설치
```bash
cd <소스 폴더>          # pyproject.toml 이 있는 리포 루트
uv sync                 # .venv 생성 + 의존성 설치 (fastapi, oracledb(Thin), uvicorn 등)
```
> `oracledb` 는 **Thin 모드**라 Oracle Instant Client 설치가 필요 없습니다.

### 3.3 서버 먼저 실행
`config.yaml` 이 없어도 앱은 **빈 설정으로 기동**됩니다. DB 는 뒤에서 화면으로 등록하므로, **서버부터 띄웁니다.**
```bash
uv run uvicorn app.main:app --reload --port 8000
```
브라우저: <http://localhost:8000>
- `--reload` 로 **백엔드(`app/*.py`) 변경은 자동 반영**됩니다.
- **정적 프런트(`static/` 의 JS/HTML/CSS)** 는 빌드 없이 그대로 서빙되므로 **브라우저 새로고침**만으로 반영됩니다.
- 편의 스크립트: `bash scripts/run.sh`(기동) · `bash scripts/stop.sh`(종료) · `bash scripts/install.sh`(초기 설치·점검).

### 3.4 DB 연결 설정 — 화면 메뉴에서 등록
서버가 뜨면(등록된 DB 가 없으면 "접속 가능한 DB가 없습니다" 안내가 보임), **`config.yaml` 을 직접 편집하지 말고** 좌측 **[Database 관리]** 메뉴에서 등록합니다.
1. **[Database 관리]** → **+ 새 데이터베이스**.
2. **Wallet zip 업로드** — OCI 콘솔에서 받은 Instance Wallet zip 을 그대로 올리면 `wallets/<이름>/` 에 자동 압축 해제되고, `tnsnames.ora` 를 파싱해 **DSN 드롭다운**(`_high` / `_medium` / `_low`)이 자동으로 채워집니다.
3. **DB 사용자 / 비밀번호 / DSN / Wallet 비밀번호** 입력 → **저장**.
4. **연결 테스트** 로 접속 가능 여부 확인(성공 또는 ORA 오류 메시지 표시).
5. 저장 시 `config.yaml` 이 **자동 생성/갱신**되고 해당 DB 풀이 재기동되어 **헤더 우측 상단 드롭다운에 즉시 반영**됩니다(서버 재시작 불필요).

- 여러 ADB 는 2~5 를 반복해 등록하면 드롭다운으로 전환하며 비교할 수 있습니다.
- 등록·수정·삭제·연결 테스트 모두 이 화면에서 하며, 비밀번호·Wallet 비밀번호는 저장 후 화면에 다시 노출되지 않습니다.
- `config.yaml` · `wallets/` 는 `.gitignore` 대상(비밀)이라 저장소에 올라가지 않습니다.

> ℹ️ config 파일을 손으로 작성해 기동하는 방식도 가능하지만(형식은 `config.yaml.example` 참조), 이 도구는 **화면 등록을 기본 경로로 권장**합니다.

### 3.5 화면 확인 & 테스트
헤더 드롭다운에 등록한 DB 가 나타나면 화면별 **스모크 테스트**:
- **AI Profile Test** — 프로필 하나로 `AI Test`(showsql / chat) 실행 → 응답·소요시간 확인.
- **AI Agent Team Test** — Team 하나 `RUN_TEAM` → 단계 타임라인·최종결과 확인.
- 여러 ADB 등록 시 드롭다운 전환으로 동일 프롬프트/팀을 **DB 별로 비교**.

> **테스트 프레임워크·린터는 없습니다(PoC).** 검증은 앱을 띄워 브라우저로 확인하는 방식입니다. 한 DB 의 Wallet 초기화가 실패해도 다른 DB 는 정상 동작하고, 실패 항목만 드롭다운에서 비활성화됩니다.

### 3.6 포트 점유 시
```bash
lsof -i :8000
kill -9 <PID>          # 또는 bash scripts/stop.sh
```

---

## 4. 다중 ADB 사용

`config.yaml` 의 `databases:` 리스트에 ADB 여러 개를 등록하면 화면 우측 상단에 드롭다운이 생깁니다.
- 선택값은 `localStorage` 에 저장 → 새로고침 후에도 유지
- 모든 API 호출에 `X-Database: <db-name>` 헤더 자동 첨부
- 한 ADB 의 Wallet 초기화가 실패해도 다른 ADB 는 정상 동작 (실패 항목만 드롭다운에서 비활성화)
- 드롭다운 변경 시 현재 메뉴의 뷰가 새 DB 기준으로 즉시 재조회

---

## 5. 프로젝트 구조

```
project/   (= GitHub 리포 select-ai-test 루트)
├─ README.md                  # 본 문서 (상단에 Deploy to Oracle Cloud 버튼)
├─ Prerequisites.md           # DB 사전 권한 + 도구가 쓰는 함수/프로시저, 배포 사전 준비
├─ LICENSE · NOTICE           # Apache License 2.0
├─ pyproject.toml             # uv 의존성 (fastapi, oracledb(Thin), uvicorn, pyyaml, python-multipart)
├─ config.yaml.example        # 설정 샘플 (실제 config.yaml 은 [Database 관리] 화면에서 자동 생성)
├─ models.txt.example         # 모델 목록 샘플
├─ config.yaml                # 실제 설정 (git ignored — 비밀 포함)
├─ wallets/<db-name>/         # ADB Wallet (git ignored) — tnsnames.ora, cwallet.sso, ewallet.pem 등
│
├─ app/                       # ── 백엔드 (FastAPI, async) ──
│  ├─ main.py                 #   엔트리: lifespan 으로 모든 DB 풀 병렬 초기화 + 정적 서빙 + 접근키 인증 미들웨어
│  ├─ config.py               #   config.yaml 로더 (다중 ADB)
│  ├─ db.py                   #   DB별 비동기 풀 dict + fetch_all/one/execute (Thin, fetch_lobs=False)
│  ├─ deps.py                 #   current_db (X-Database 헤더 검증, 풀 status 가 ok 아니면 503)
│  ├─ auth.py                 #   접근 키 토큰 서명/검증
│  ├─ ratelimit.py            #   로그인 rate limit
│  ├─ mailer.py               #   접근 키 분실 복구 메일 (SMTP)
│  ├─ plsql.py                #   RUN_TEAM 익명블록 빌더 + first_line/read_clob
│  └─ routers/                #   메뉴별 API 라우터
│     ├─ objects.py           #     AI Profile Object Meta (Comment/Annotation DDL)
│     ├─ profiles.py          #     AI Profile Test (Profile/Attributes/GENERATE/Benchmark)
│     ├─ agents.py            #     AI Agent Team Test + Agent History (트리/실행/타임라인)
│     ├─ nl2sql.py            #     Table list + 질문관리 (질문·컬럼 CRUD, 관련성평가, comment추천)
│     ├─ chat_tl.py           #     AI Chat for Table list (RUN_TEAM → SQL 실행 → 표)
│     ├─ chat.py / chat2.py   #     AI Chat / AI Chat2(narrate)
│     ├─ history.py / history2.py  # History(v$mapped_sql) / History2(대화 이력)
│     ├─ predefined.py        #     Predefined Query (f_predefined_query)
│     ├─ personas.py / persona_analysis.py  # 페르소나 CRUD / 결과표 AI 분석
│     ├─ vpd.py               #     VPD 보안 (정책·컨텍스트 스크립트/적용)
│     ├─ databases.py         #     Database 관리 (등록/Wallet 업로드/연결테스트)
│     ├─ auth.py              #     Tool관리 (접근 키·복구)
│     └─ _mock.py             #     mock 폴백 (현재 미사용)
│
├─ static/                    # ── 프런트 (Vanilla HTML/CSS/JS, 빌드 없음) ──
│  ├─ index.html              #   좌측 nav + 헤더 DB 드롭다운
│  ├─ css/                    #   redwood.css (Redwood 톤) · layout.css
│  ├─ mock/                   #   일부 드롭다운 폴백 JSON
│  └─ js/
│     ├─ app.js               #   해시 라우터 (route → view), 선택 DB 없으면 안내 화면
│     ├─ api.js               #   fetch 래퍼 (X-Database 자동 첨부)
│     ├─ db_selector.js       #   헤더 DB 드롭다운 (localStorage: oai.db) + db:changed 이벤트
│     ├─ store.js             #   DB별 localStorage 네임스페이스 (base::<db>)
│     ├─ auth.js / util.js    #   인증 · 공용 유틸
│     ├─ components/          #   공용 위젯 — tabs · table · tree · toast
│     └─ views/               #   화면 1개 = 파일 1개 (object_meta, profile_test, agent_test,
│                             #     agent_history, nl2sql, nl2sql_admin, ai_chat, ai_chat_tl,
│                             #     ai_chat_v2, history, history2, predefined_query,
│                             #     persona_analysis, vpd_security, database_admin,
│                             #     access_admin, api_admin)
│
├─ deploy/                    # ── OCI RM 스택 (방식별 폴더 — RM Working directory 로 선택) ──
│  ├─ http/                   #   HTTP (LB/인증서 없음) — main.tf/variables.tf/outputs.tf/schema.yaml/cloud-init.tftpl
│  ├─ https/                  #   HTTPS (공용 LB + 인증서) — 위 5개 파일
│  └─ https-existing-vm/      #   기존 VM 재사용 (컴퓨트 미생성, SSH 설치) — cloud-init 대신 install.sh.tftpl 포함
│
└─ scripts/
   ├─ install.sh              # 초기 설치 (uv + uv sync + 점검)
   ├─ run.sh / stop.sh        # 서버 기동 / 종료
   ├─ deploy.sh               # 로컬 → VM rsync (비밀 제외)
   └─ oracle-ai-tool.service  # systemd unit 샘플
```

---

## 6. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| 화면에 **"접속 가능한 DB가 없습니다"** | 등록된 DB 가 없거나 모든 DB 풀 초기화 실패. **[Database 관리]** 에서 DB 를 등록/수정하고 **연결 테스트**. (Database 관리·Tool관리·API관리 화면은 DB 없이도 진입 가능) |
| **DB 연결 실패 / 연결 테스트 오류** (`ORA-12154`(DSN alias 불일치)·`ORA-01017`(사용자·비밀번호)·Wallet 비밀번호 오류) | [Database 관리] 에서 **DSN(`_high` 등)·DB 사용자·비밀번호·Wallet 비밀번호** 를 재확인하고 Wallet zip 을 다시 업로드. 로그의 ORA 메시지로 원인 확인. |
| `/api/...` 호출이 **`{"error":"unauthorized"}` (401)** | 접근 키가 설정된 배포에서는 `/api/*` 가 로그인 쿠키로 보호됨 — 첫 진입 시 **접근 키로 로그인** 필요(키 분실 시 [Tool관리] 에서 복구). 접근 키 미설정 배포는 해당 없음. |
| **SELECT AI 생성 시 인가 오류** (`ORA-20401`·`NotAuthorizedOrNotFound`·`...my$cloud_domain...`) | ADB 가 OCI Generative AI 를 호출할 **IAM 정책 / Principal Auth 미비**. **[Prerequisites.md](Prerequisites.md)** 의 GenAI 정책·`ENABLE_PRINCIPAL_AUTH` 설정. (간헐적 OCI 측 오류면 잠시 후 재시도) |
| **`ORA-20000: Data access is disabled for SELECT AI.`** | `DISABLE_DATA_ACCESS()` 로 실데이터 접근이 꺼져 `runsql`/`narrate` 가 차단(`showsql`/`explainsql` 은 동작). 필요 시 `DBMS_CLOUD_AI.ENABLE_DATA_ACCESS()` — [Prerequisites.md](Prerequisites.md). |
| `Annotations: 미지원` 배지 | DB 가 23ai 미만이거나 `USER_ANNOTATIONS_USAGE` 뷰 없음 → Annotation 영역만 비활성(Comment 는 정상). |
| `RUN_TEAM` 응답이 즉시 오류 | Team / Task / Tool 구성의 참조 무결성 문제 (`ORA-20051: Task X does not exist` 등). 해당 `*_ATTRIBUTES` 의 JSON(`tools`/`agents` 등) 값 확인. |
| **HTTPS(LB) 배포에서 오래 걸리는 요청이 HTTP 504** | SELECT AI / RUN_TEAM 등 백엔드 처리시간이 **Load Balancer 리스너의 유휴 제한 시간(idle timeout)** 을 초과. **OCI 콘솔 → Load Balancer → Listeners → (해당 리스너) Edit → Connection Configuration → 유휴 제한 시간(초)** 을 넉넉히 상향(예: 60초 → 300초 이상, 예상 최장 응답보다 크게). LLM 호출은 수 초~수십 초 걸릴 수 있음. (HTTP 직접 배포는 LB 가 없어 해당 없음) |
| **OCI 배포 후 URL 접속이 안 됨** | 부팅 후 `git clone`+`uv sync` 에 1~3분 소요 — 잠시 후 재시도, 또는 SSH 로 `sudo tail -f /var/log/select-ai-deploy.log` · `systemctl status select-ai-test` · `journalctl -u select-ai-test -f` 확인. HTTPS 는 **LB Backend health(OK)** 와 서브넷 인바운드(443 / 앱 포트)도 점검. |
| 로컬 **포트 점유** | `bash scripts/stop.sh` 또는 `lsof -i :8000` 후 `kill <PID>`. |

---

## 7. 제한 사항

PoC 전용으로 잠시 사용하는 용도로, 보안이나 운영을 고려한 구현이 되어 있지 않습니다.

---

## 8. 라이선스

**Apache License 2.0** — 전문은 [LICENSE](LICENSE), 저작권/고지는 [NOTICE](NOTICE) 참조.

자유롭게 사용·수정·재배포할 수 있으며, 재배포 시 LICENSE/NOTICE 와 저작권 고지를 유지하면 됩니다. 본 도구는 **PoC/데모 목적**으로 "있는 그대로(AS IS)" 제공되며, 사용으로 발생하는 어떤 손해에 대해서도 저작자는 책임지지 않습니다 (라이선스 §7 무보증 · §8 책임 제한).
