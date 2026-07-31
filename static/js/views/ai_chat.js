/** views/ai_chat.js — 메뉴 [AI Chat].
 * Chat설정(변수 / Team / User Prompt)을 골라 메시지를 보내면 백엔드(/api/chat/send)가
 * DBMS_CLOUD_AI_AGENT.RUN_TEAM 을 호출해 응답한다. Multi Turn ON 시 conversation_id 유지.
 */
(function () {
  const GREETING = "안녕하세요! Oracle AI Chat 입니다. Chat설정을 선택하고 메시지를 입력하세요.";
  // Team 드롭다운(설정 팝업)용 폴백 — /api/agents/tree 실패 시 사용
  const MOCK_TEAMS = ["SALES_ANALYST_TEAM", "DATA_DISCOVERY_TEAM", "SUPPORT_TEAM"];
  // 새 Chat설정 추가 시 기본값 (이미지 예시 기준)
  const DEFAULT_VARIABLES = "l_base_date VARCHAR2(8) := TO_CHAR(SYSDATE, 'YYYYMMDD');";
  const DEFAULT_USER_PROMPT =
    "[INSTRUCTION]\n" +
    "기준일: ' || l_base_date || '\n" +
    "action: showsql\n" +
    "결과형식: 컬럼명 한글\n\n" +
    "[QUESTION]\n" +
    "##메시지##";

  // API 오류 메시지 추출
  function errMsg(err, fallback) {
    const p = err && err.payload;
    const d = p && (p.detail || p.error);
    if (d) {
      if (typeof d === "string") return d;
      return d.error || d.message || JSON.stringify(d);
    }
    return (err && err.message) || fallback || "요청 실패";
  }

  // User Prompt 위험 패턴 점검 (차단 아님, 저장 시 경고용).
  // variables 는 PL/SQL 선언이라 ;/-- 가 정상이므로 검사 대상이 아니다.
  function userPromptWarnings(text) {
    const t = text || "";
    const issues = [];
    // 작은따옴표가 홀수면 PL/SQL 문자열 리터럴이 깨질 수 있음
    if (((t.match(/'/g) || []).length) % 2 === 1) {
      issues.push("작은따옴표(') 개수가 홀수 — 문자열이 깨질 수 있습니다 (변수 연결은 ' || 변수 || ' 형태로)");
    }
    if (/;/.test(t)) issues.push("세미콜론(;) 포함 — 프롬프트 안에서는 보통 불필요합니다");
    if (/--/.test(t)) issues.push("주석(--) 포함");
    if (/execute\s+immediate/i.test(t)) issues.push("EXECUTE IMMEDIATE 포함 — 임의 PL/SQL 실행 위험");
    return issues;
  }

  // AI Chat 전송 시 백엔드가 실행하는 RUN_TEAM 익명블록을 재현(미리보기용).
  // app/plsql.py:build_run_team_block + app/routers/chat.py:_user_prompt_expr 와 동일 규칙:
  //   ##메시지## → ' || :msg || ' (메시지만 바인드), :team_name 바인드, 신규 conversation 기준.
  function buildChatScript(team, variables, userPrompt) {
    const MSG_PH = "##메시지##";
    const up = userPrompt || "";
    const useMsg = up.includes(MSG_PH);
    const src = useMsg ? up.split(MSG_PH).join("' || :msg || '") : up;
    const userPromptSql = "'" + src + "'";
    const decls = (variables || "").trim();
    const declLine = decls ? "\n  " + decls : "";
    return (
      "DECLARE\n" +
      "  l_conv_id     VARCHAR2(256);\n" +
      "  l_answer      CLOB;\n" +
      "  l_user_prompt CLOB;" + declLine + "\n" +
      "BEGIN\n" +
      "  l_conv_id := DBMS_CLOUD_AI.CREATE_CONVERSATION();  -- Multi Turn 재사용 시 :in_conv\n" +
      "  l_user_prompt := " + userPromptSql + ";\n" +
      "  l_answer := DBMS_CLOUD_AI_AGENT.RUN_TEAM(\n" +
      "    team_name   => :team_name,\n" +
      "    user_prompt => l_user_prompt,\n" +
      "    params      => '{\"conversation_id\":\"' || l_conv_id || '\"}'\n" +
      "  );\n" +
      "  :out_conv := l_conv_id;\n" +
      "  :out_answer := l_answer;\n" +
      "END;"
    );
  }

  // 스크립트 조회 팝업 — 실행 스크립트를 읽기전용으로 보여주고 복사 제공.
  function openScriptModal(title, team, script) {
    const esc = window.escapeHtml || ((v) => String(v == null ? "" : v));
    const bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = `
      <div class="modal" style="width:720px; max-width:94vw;">
        <div class="modal-header">
          <h2>${esc(title)}</h2>
          <button class="btn btn-ghost" id="sc-close" type="button">✕</button>
        </div>
        <div class="modal-body stack">
          <label class="muted" style="font-size:var(--fs-sm);">AI Chat 전송 시 실행되는 스크립트입니다. 바인드: <code>:team_name</code> = '${esc(team || "")}', <code>:msg</code> = 입력 메시지.</label>
          <textarea readonly rows="16" style="font-family:var(--font-mono); font-size:var(--fs-sm); width:100%;">${esc(script)}</textarea>
        </div>
        <div class="modal-footer row end" style="gap:var(--space-2);">
          <button class="btn" id="sc-copy" type="button">복사</button>
          <button class="btn btn-primary" id="sc-ok" type="button">닫기</button>
        </div>
      </div>`;
    const close = () => bd.remove();
    document.body.appendChild(bd);
    // 바깥(어두운 영역) 클릭 시 닫기 — 미리보기라 실수 닫힘 허용
    bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
    bd.querySelector("#sc-close").addEventListener("click", close);
    bd.querySelector("#sc-ok").addEventListener("click", close);
    bd.querySelector("#sc-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(script); window.Toast.show("스크립트를 복사했습니다", "success"); }
      catch (_) { window.Toast.show("복사 실패 — 텍스트를 직접 선택해 복사하세요", "error"); }
    });
  }

  // 현재 시각 HH:MM
  function nowLabel() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  const nf = (v) => (v == null || v === "") ? v : Number(v).toLocaleString();

  // ====================================================================
  // Thinking 과정 popup — AI Agent Team Test [2. Team 실행] 탭과 동일한 카드 UI.
  // conversation_id 로 /api/agents/conversations/{id}/timeline 를 조회해 thinking 을 얻는다.
  // ====================================================================

  const THINK_CARET =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

  // 단계별 타임라인과 동일한 태그 배지(TEAM/TASK) + 이름 텍스트
  function thinkBadge(kind, name) {
    const wrap = document.createElement("span");
    wrap.className = "think-tagline";
    const tag = document.createElement("span");
    tag.className = "tree-tag tag-" + kind;
    tag.textContent = kind.toUpperCase();
    const label = document.createElement("span");
    label.className = "think-tagname";
    label.textContent = name;
    wrap.appendChild(tag);
    wrap.appendChild(label);
    return wrap;
  }

  // thinking({rows,error}) 을 host 에 카드로 렌더 (agent_test.renderThinking 과 동일 동작).
  function renderThinkingInto(host, thinking) {
    host.innerHTML = "";
    thinking = thinking || {};
    if (thinking.error) {
      const ta = document.createElement("textarea");
      ta.readOnly = true;
      ta.rows = 3;
      ta.style.width = "100%";
      ta.style.fontFamily = "var(--font-mono)";
      ta.style.fontSize = "var(--fs-sm)";
      ta.style.color = "var(--danger)";
      ta.value = "Thinking 조회 실패:\n" + thinking.error;
      host.appendChild(ta);
      return;
    }
    const rows = thinking.rows || [];
    if (!rows.length) {
      host.innerHTML = '<div class="empty-state muted">표시할 thinking 단계가 없습니다.</div>';
      return;
    }
    const stack = document.createElement("div");
    stack.className = "stack";
    rows.forEach((r) => {
      const card = document.createElement("div");
      card.className = "think-card";

      const headRow = document.createElement("button");
      headRow.type = "button";
      headRow.className = "think-row title think-head";
      headRow.setAttribute("aria-expanded", "false");

      const caret = document.createElement("span");
      caret.className = "think-caret";
      caret.innerHTML = THINK_CARET;

      const headMain = document.createElement("div");
      headMain.className = "think-head-main";

      const titleLine = document.createElement("div");
      titleLine.className = "think-title";
      const no = r.step_no != null ? `${nf(r.step_no)}. ` : "";
      titleLine.textContent = no + (r.step_title || "");

      const pathLine = document.createElement("div");
      pathLine.className = "think-path";
      if (r.team_name) pathLine.appendChild(thinkBadge("team", r.team_name));
      if (r.task_name) pathLine.appendChild(thinkBadge("task", r.task_name));

      headMain.appendChild(titleLine);
      headMain.appendChild(pathLine);
      headRow.appendChild(caret);
      headRow.appendChild(headMain);

      const promptRow = document.createElement("div");
      promptRow.className = "think-row prompt";
      promptRow.hidden = true;
      promptRow.textContent = r.raw_prompt == null ? "" : String(r.raw_prompt);

      headRow.addEventListener("click", () => {
        const open = card.classList.toggle("open");
        promptRow.hidden = !open;
        headRow.setAttribute("aria-expanded", open ? "true" : "false");
      });

      card.appendChild(headRow);
      card.appendChild(promptRow);
      stack.appendChild(card);
    });
    host.appendChild(stack);
  }

  // thinking 단계들을 복사용 평문으로 직렬화 (agent_test.buildThinkingText 와 동일 형식).
  function buildThinkingText(rows) {
    const clean = (s) => (s == null ? "" : String(s).replace(/\r\n?/g, "\n").trim());
    return rows.map((r, i) => {
      const no = r.step_no != null ? r.step_no : i + 1;
      const title = clean(r.step_title);
      const path = [
        r.team_name ? `TEAM: ${r.team_name}` : "",
        r.task_name ? `TASK: ${r.task_name}` : "",
      ].filter(Boolean).join("  |  ");
      const body = clean(r.raw_prompt);
      return [`### Step ${no}. ${title}`.trim(), path, "", body]
        .filter((x, idx) => !(idx === 1 && !path)).join("\n");
    }).join("\n\n---\n\n");
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 폴백 */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // conversation_id 로 thinking 을 조회해 모달로 표시.
  // preThinking: 전송 응답에 동봉돼 이미 받은 thinking({rows,error}). 있으면 추가 왕복 없이 즉시 표시.
  async function openThinkingModal(convId, preThinking) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" style="width:820px; max-width:94vw;">
        <div class="modal-header">
          <h2>Thinking 과정 <span class="muted" style="font-weight:400; font-size:var(--fs-sm);">conv_id: ${window.escapeHtml(convId)}</span></h2>
          <div class="row" style="gap:var(--space-2);">
            <button class="btn btn-ghost" id="thk-refresh" type="button">↻ 새로고침</button>
            <button class="btn btn-ghost" id="thk-copy" type="button" disabled>복사</button>
            <button class="btn btn-ghost" id="thk-close" type="button">✕</button>
          </div>
        </div>
        <div class="modal-body" id="thk-body">
          <div class="empty-state"><span class="spinner"></span> 조회 중...</div>
        </div>
      </div>
    `;
    const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    // 바깥 클릭으로는 닫지 않음 — 닫기는 X 버튼으로만 (실수 닫힘 방지)
    backdrop.querySelector("#thk-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);

    const body = backdrop.querySelector("#thk-body");
    const copyBtn = backdrop.querySelector("#thk-copy");
    const refreshBtn = backdrop.querySelector("#thk-refresh");
    let thinking = { rows: [], error: null };

    // forceFetch=false 면 전송 응답 동봉 데이터(preThinking) 우선, true(새로고침)면 항상 서버 재조회.
    async function load(forceFetch) {
      body.innerHTML = '<div class="empty-state"><span class="spinner"></span> 조회 중...</div>';
      if (!forceFetch && preThinking && (preThinking.rows || preThinking.error)) {
        thinking = preThinking;  // 왕복 없이 즉시 사용
      } else {
        try {
          const data = await window.API.get(`/api/agents/conversations/${encodeURIComponent(convId)}/timeline`);
          thinking = data.thinking || { rows: [], error: null };
        } catch (e) {
          if (backdrop.isConnected) body.innerHTML = '<div class="empty-state muted">Thinking 조회 실패</div>';
          return;
        }
      }
      if (!backdrop.isConnected) return;
      renderThinkingInto(body, thinking);
      copyBtn.disabled = !(thinking.rows && thinking.rows.length);
    }

    copyBtn.addEventListener("click", async () => {
      const rows = thinking.rows || [];
      if (!rows.length) return;
      const ok = await copyToClipboard(buildThinkingText(rows));
      window.Toast.show(ok ? `Thinking ${rows.length}단계 복사됨` : "복사 실패", ok ? "success" : "error");
    });
    refreshBtn.addEventListener("click", () => load(true));  // 서버에서 최신 thinking 재조회

    await load(false);
  }

  async function render() {
    const main = document.getElementById("main");
    main.innerHTML = "";

    const title = document.createElement("div");
    title.className = "view-title";
    title.innerHTML = `<h1>AI Chat</h1>
      <span class="sub">Chat설정의 Team 으로 <strong>RUN_TEAM</strong> 호출 · Multi Turn 시 대화 컨텍스트 유지</span>`;
    main.appendChild(title);

    // Team 드롭다운(설정 팝업 안)용 목록 — /api/agents/tree 실패 시 목업으로 진행.
    let teams = MOCK_TEAMS.slice();
    try {
      const tree = await window.API.get("/api/agents/tree");
      const names = (tree.teams || []).map((t) => t.name).filter(Boolean);
      if (names.length) teams = names;
    } catch (e) {
      teams = MOCK_TEAMS.slice();
    }

    let multiTurn = true;   // Multi Turn 활성/비활성 상태 (기본 ON)
    let resetOnAnswer = true; // 정상답변 시 conversation id 초기화 여부 (기본 ON, 세션 기본값)
    let convId = "";        // Multi Turn ON 시 유지되는 conversation_id
    let lastConvId = "";    // 정상답변으로 방금 초기화된 직전 conversation_id (이어서 질문 시 복원용)
    let editable = true;    // 선택된 Chat설정의 'Chat화면에서 수정가능여부' (false 면 토글 잠금)

    const panel = document.createElement("div");
    panel.className = "panel chat-panel";
    panel.innerHTML = `
      <div class="panel-header chat-toolbar">
        <div class="row" style="gap:var(--space-3); align-items:center;">
          <label style="color:var(--text-muted); font-size:var(--fs-sm);">Chat설정</label>
          <select id="chat-config" style="min-width:200px;"></select>
          <button class="btn" id="chat-config-add" type="button">추가</button>
          <button class="btn" id="chat-config-update" type="button">수정</button>
        </div>
        <div class="row" style="gap:var(--space-3); align-items:center;">
          <button class="btn btn-ghost" id="chat-new">＋ 새 대화</button>
          <label style="color:var(--text-muted); font-size:var(--fs-sm);">정상답변시 대화초기화</label>
          <button class="switch" id="chat-reset-onanswer" type="button"
            role="switch" aria-checked="true" title="정상답변 후 대화 초기화(새 conversation). Multi Turn ON 일 때만 활성화됩니다.">
            <span class="switch-knob"></span>
          </button>
          <label style="color:var(--text-muted); font-size:var(--fs-sm);">Multi Turn</label>
          <button class="switch" id="chat-multiturn" type="button"
            role="switch" aria-checked="false" title="Multi Turn 대화 컨텍스트 유지 여부">
            <span class="switch-knob"></span>
          </button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-saved-row">
        <input type="text" id="chat-save-title" placeholder="저장할 제목" />
        <button class="btn" id="chat-save-add" type="button">추가</button>
        <button class="btn" id="chat-save-update" type="button">수정</button>
        <button class="btn" id="chat-save-delete" type="button">삭제</button>
        <select id="chat-saved"></select>
      </div>
      <div class="chat-input-row">
        <textarea id="chat-input" rows="1" placeholder="메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"></textarea>
        <button class="btn btn-primary" id="chat-send">전송</button>
      </div>
      <div class="chat-continue-row" id="chat-continue-row"
           style="display:none; justify-content:flex-end; align-items:center; gap:6px; padding:4px var(--space-4); font-size:var(--fs-sm); color:var(--text-muted);">
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
          이어서 질문하기
          <input type="checkbox" id="chat-continue" style="margin:0;" />
        </label>
      </div>
    `;
    main.appendChild(panel);

    // '이어서 질문하기' — 정상답변 초기화 직후 노출, 체크 시 직전 conversation 유지
    const continueRow = panel.querySelector("#chat-continue-row");
    const continueChk = panel.querySelector("#chat-continue");
    continueChk.addEventListener("change", () => { convId = continueChk.checked ? lastConvId : ""; });
    function hideContinue() { continueRow.style.display = "none"; continueChk.checked = false; }

    const messagesEl = panel.querySelector("#chat-messages");
    const inputEl = panel.querySelector("#chat-input");
    const sendBtn = panel.querySelector("#chat-send");

    let busy = false;

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // debug: 디버깅용 메타 정보 객체 (conv_id, elapsed_ms, team, multi_turn 등). 있으면 말풍선 아래 표시.
    function addMessage(role, text, debug) {
      const msg = document.createElement("div");
      msg.className = `chat-msg ${role}`;
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.textContent = text;  // 텍스트로만 삽입 (XSS 방지, 줄바꿈은 CSS pre-wrap)
      const meta = document.createElement("div");
      meta.className = "chat-meta";
      const metaText = document.createElement("span");
      metaText.textContent = `${role === "user" ? "나" : "AI"} · ${nowLabel()}`;
      meta.appendChild(metaText);
      // conversation_id 가 있으면 메타("AI · 시각") 옆에 Thinking 과정 popup 버튼 추가
      if (debug && debug.conversation_id) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-ghost btn-mini";
        btn.textContent = "🧠 Thinking";
        // 전송 응답에 동봉된 thinking 을 그대로 넘겨 추가 왕복 제거
        btn.addEventListener("click", () => openThinkingModal(debug.conversation_id, debug.thinking));
        meta.appendChild(btn);
      }
      msg.appendChild(bubble);
      msg.appendChild(meta);
      if (debug) msg.appendChild(buildDebug(debug));
      // 단계별 소요시간 인라인 (접이식) — timeline 이 있으면 답변 아래에 표시
      if (debug && debug.timeline && debug.timeline.length) {
        msg.appendChild(buildStepTimes(debug.timeline, debug.multi_turn));
      }
      // 정상 답변으로 conversation 이 초기화(다음 질문부터 새 conversation)된 경우 답변 밑에 안내
      if (debug && debug.conv_reset) {
        const info = document.createElement("div");
        info.className = "chat-debug";
        info.textContent = "🔄 정상 답변으로 대화가 초기화되었습니다 — 다음 질문은 새 conversation 으로 시작합니다";
        msg.appendChild(info);
      }
      messagesEl.appendChild(msg);
      scrollToBottom();
      return msg;
    }

    // 디버깅 정보 라인 — conversation_id / elapsed / team / multi turn.
    function buildDebug(d) {
      const el = document.createElement("div");
      el.className = "chat-debug";
      const parts = [];
      if (d.conversation_id) parts.push(`conv_id: ${d.conversation_id}`);
      if (d.elapsed_ms != null) parts.push(`elapsed: ${Number(d.elapsed_ms).toLocaleString()} ms`);
      if (d.team) parts.push(`team: ${d.team}`);
      parts.push(`multi turn: ${d.multi_turn ? "ON" : "OFF"}`);
      el.textContent = "🛠 " + parts.join("  ·  ");
      return el;
    }

    // 단계별 소요시간 — Agent Team Test 2탭과 동일한 timeline 데이터를 접이식 목록으로.
    // 트리 들여쓰기(level) + 타입 배지(TEAM/AGENT/TASK/TOOL) + 구간 ms.
    function buildStepTimes(timeline, multiTurnOn) {
      const details = document.createElement("details");
      details.className = "chat-steptimes";
      const total = Math.max(0, ...timeline.map((t) => t.end_ms || 0));
      const summary = document.createElement("summary");
      summary.textContent = `⏱ 단계별 시간 (${timeline.length}단계 · 총 ${nf(total)} ms)`
        + (multiTurnOn ? " · 이 대화 누적" : "");
      details.appendChild(summary);

      const list = document.createElement("div");
      list.className = "steptimes-list";
      timeline.forEach((seg) => {
        const level = seg.level || 0;
        const row = document.createElement("div");
        row.className = "steptimes-row";
        const label = document.createElement("span");
        label.className = "steptimes-label";
        label.style.paddingLeft = `${level * 16}px`;
        if (seg.type) {
          const tag = document.createElement("span");
          tag.className = "tree-tag tag-" + seg.type;
          tag.textContent = seg.type.toUpperCase();
          label.appendChild(tag);
          label.appendChild(document.createTextNode(" "));
        }
        label.appendChild(document.createTextNode(seg.label || ""));
        const dur = document.createElement("span");
        dur.className = "steptimes-dur";
        dur.textContent = `${nf((seg.end_ms || 0) - (seg.start_ms || 0))} ms`;
        row.appendChild(label);
        row.appendChild(dur);
        list.appendChild(row);
      });
      details.appendChild(list);
      return details;
    }

    function addTyping() {
      const msg = document.createElement("div");
      msg.className = "chat-msg bot";
      // 버블 + (선택) Thinking 링크가 한 줄에 나란히 보이도록 flex row 로 감싼다.
      msg.innerHTML = `<div style="display:flex; align-items:center; gap:var(--space-2);">
        <div class="chat-bubble chat-typing"><span></span><span></span><span></span></div>
      </div>`;
      messagesEl.appendChild(msg);
      scrollToBottom();
      return msg;
    }

    // "..." 처리 중 버블 옆에 🧠 Thinking 링크를 붙인다 — 클릭 시 진행 중 conversation 의
    // thinking 스냅샷을 popup(openThinkingModal)으로 조회(결과 후 링크와 동일 팝업).
    function attachTypingThinking(typingMsg, convId) {
      if (!typingMsg || !convId) return;
      const row = typingMsg.firstElementChild || typingMsg;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost btn-mini";
      btn.textContent = "🧠 Thinking";
      btn.addEventListener("click", () => openThinkingModal(convId, null));
      row.appendChild(btn);
      scrollToBottom();
    }

    function autoGrow() {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    }

    async function send() {
      const text = inputEl.value.trim();
      if (!text || busy) return;

      // 선택된 Chat설정 확보 (변수/Team/User Prompt 의 출처)
      const cfgName = configSel.value;
      const cfg = cfgName ? loadConfigs().find((c) => c.name === cfgName) : null;
      if (!cfg) {
        window.Toast.show("Chat설정을 선택하세요 (없으면 [추가])", "warn");
        return;
      }

      busy = true;
      sendBtn.disabled = true;

      addMessage("user", text);
      inputEl.value = "";
      autoGrow();
      hideContinue();  // 전송 시작 — 이전 '이어서 질문하기' 행 정리(convId 는 이미 확정됨)

      const typing = addTyping();
      try {
        // 대화 id 확보 — convId 가 있으면(멀티턴 연속 / HITL·무데이터 유지 / '이어서 질문하기' 체크로 복원) 재사용, 아니면 선생성.
        // 정상답변 초기화 시 convId 는 "" 가 되며, '이어서 질문하기' 를 체크해야만 직전 id 로 복원된다.
        // 선생성해 두면 "..." 처리 중에도 그 옆에 Thinking 링크를 붙일 수 있다(모든 메시지 대상).
        // 선생성 실패 시엔 "" 로 두어 백엔드가 내부 생성(기존 동작, 링크만 생략).
        let convForTurn = convId || "";
        if (!convForTurn) {
          try {
            const c = await window.API.post("/api/chat/conversation", {});
            convForTurn = c.conversation_id || "";
          } catch (e) { convForTurn = ""; }
        }
        if (convForTurn) attachTypingThinking(typing, convForTurn);

        const res = await window.API.post("/api/chat/send", {
          team: cfg.team,
          variables: cfg.variables,
          user_prompt: cfg.userPrompt,
          message: text,
          multi_turn: multiTurn,
          // 선생성/이어가기 id 를 그대로 전달(있으면 백엔드가 재사용). 없으면 기존 폴백.
          conversation_id: convForTurn || (multiTurn ? convId : ""),
        });
        typing.remove();
        if (multiTurn && res.conversation_id) convId = res.conversation_id;
        else if (!multiTurn) convId = "";
        const debug = {
          conversation_id: res.conversation_id,
          elapsed_ms: res.elapsed_ms,
          team: cfg.team,
          multi_turn: multiTurn,
          timeline: res.timeline || [],
          thinking: res.thinking || { rows: [], error: null },
        };
        // 답변 처리 (AI Chat for Table list 와 동일 취지):
        //  - HITL 추가정보 요청이거나, runsql 조회 결과가 0행("데이터가 조회되지 않았습니다")이면
        //    오류처럼 conversation 을 유지해 후속 답변/재질문이 같은 대화로 이어지게 한다(멀티턴 OFF 여도 유지).
        //  - 그 외 정상 최종답변이면 다음 질문이 이전 대화 누적에 오염되지 않도록 conversation 초기화(화면 메시지 유지).
        // HITL 되묻기·무데이터 감지 — instruction 상 HITL 메시지엔 "HITL", 조회 0행 답변엔 첫 줄 "데이터가 조회되지 않았습니다" 가 포함된다.
        // 정상답변 초기화는 '정상답변시 conversation id 초기화' 체크박스(resetOnAnswer)가 켜졌을 때만 적용한다.
        const isHitl = !!res.answer && res.answer.includes("HITL");
        const noData = !!res.answer && res.answer.includes("데이터가 조회되지 않았습니다");
        const keepConv = isHitl || noData;
        const answerOk = !!(res.answer && res.answer.trim()) && !keepConv;
        if (keepConv) {
          if (res.conversation_id) convId = res.conversation_id;
        } else if (answerOk && resetOnAnswer) {
          lastConvId = res.conversation_id || "";
          convId = "";
          debug.conv_reset = true;
          debug.show_continue = true;  // '새 대화로 시작합니다'(conv_reset)가 뜰 때만 '이어서 질문하기' 노출
        }
        addMessage("bot", res.answer || "(빈 응답)", debug);
        // 정상답변 초기화(새 대화 안내)가 뜬 경우에만 '이어서 질문하기' 체크박스 노출(해제 상태)
        if (debug.show_continue) { continueChk.checked = false; continueRow.style.display = "flex"; }
      } catch (e) {
        typing.remove();
        addMessage("bot", "오류: " + errMsg(e, "전송 실패"), {
          team: cfg.team,
          multi_turn: multiTurn,
        });
      } finally {
        busy = false;
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    function resetChat() {
      messagesEl.innerHTML = "";
      convId = "";  // 새 대화 → conversation 초기화
      hideContinue();
      addMessage("bot", GREETING);
    }

    sendBtn.addEventListener("click", send);
    inputEl.addEventListener("input", autoGrow);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    // Multi Turn 토글 — ON 이면 .on 클래스로 색상/노브 위치가 바뀐다.
    const multiTurnBtn = panel.querySelector("#chat-multiturn");
    // 정상답변시 대화초기화 토글 — Multi Turn 과 동일한 switch 형태. Multi Turn ON 일 때만 활성.
    const resetBtn = panel.querySelector("#chat-reset-onanswer");
    function setResetOnAnswer(val) {
      resetOnAnswer = !!val;
      resetBtn.setAttribute("aria-checked", resetOnAnswer ? "true" : "false");
      resetBtn.classList.toggle("on", resetOnAnswer);
    }
    function syncResetEnabled() {
      // 초기화 스위치는 Multi Turn ON 이고 '수정가능'일 때만 활성(회색 비활성 처리).
      const on = multiTurn && editable;
      resetBtn.disabled = !on;
      resetBtn.style.opacity = on ? "" : "0.4";
      resetBtn.style.pointerEvents = on ? "" : "none";
    }
    // 'Chat화면에서 수정가능여부'(editable) 에 따라 토글 잠금/해제
    function applyLocks() {
      multiTurnBtn.disabled = !editable;
      multiTurnBtn.style.opacity = editable ? "" : "0.4";
      multiTurnBtn.style.pointerEvents = editable ? "" : "none";
      syncResetEnabled();
    }
    resetBtn.addEventListener("click", () => {
      if (!resetBtn.disabled) setResetOnAnswer(!resetOnAnswer);
    });
    function setMultiTurn(val) {
      multiTurn = !!val;
      multiTurnBtn.setAttribute("aria-checked", multiTurn ? "true" : "false");
      multiTurnBtn.classList.toggle("on", multiTurn);
      syncResetEnabled();  // Multi Turn 상태에 따라 초기화 스위치 활성/비활성 동기화
    }
    multiTurnBtn.addEventListener("click", () => {
      setMultiTurn(!multiTurn);
      convId = "";  // 모드 전환 시 대화 컨텍스트 초기화 (다음 전송부터 새 conversation)
      hideContinue();
    });
    setResetOnAnswer(resetOnAnswer);  // 기본 ON — 스위치 초기 상태 동기화
    setMultiTurn(multiTurn);          // 기본 ON — 토글 UI + 초기화 스위치 활성 상태 동기화

    panel.querySelector("#chat-new").addEventListener("click", resetChat);

    // --- Chat설정 저장/불러오기 (서버 파일, DB별) ---
    // 메뉴별·DB별로 project/chat_configs/<db>/aiChat.json 에 저장. 읽기는 캐시(configs)로 동기 처리.
    const CONFIG_KEY = "aiChat.savedConfigs";  // 레거시 localStorage 키 (최초 1회 이관용)
    const MENU = "aiChat";
    let configs = [];  // 현재 DB 의 Chat설정 캐시 (initConfigs 로 서버에서 채움)
    const configSel = panel.querySelector("#chat-config");
    const configAddBtn = panel.querySelector("#chat-config-add");
    const configUpdateBtn = panel.querySelector("#chat-config-update");

    const loadConfigs = () => configs;  // 캐시 반환 (동기 리더용)
    async function fetchConfigs() {
      try { const l = await window.API.get(`/api/chat-configs/${MENU}`); return Array.isArray(l) ? l : []; }
      catch (e) { window.Toast && window.Toast.show("Chat설정 불러오기 실패", "error"); return []; }
    }
    async function persistConfigs(list) { await window.API.put(`/api/chat-configs/${MENU}`, list); }
    function readLegacy() { try { return JSON.parse(window.Store.get(CONFIG_KEY)) || []; } catch (e) { return []; } }
    // 서버 로드 + (서버 비어있고 localStorage 에 기존 설정 있으면) 최초 1회 파일 이관
    async function initConfigs() {
      let list = await fetchConfigs();
      if (!list.length) {
        const legacy = readLegacy();
        if (legacy.length) {
          try { await persistConfigs(legacy); list = legacy; window.Store.remove(CONFIG_KEY); } catch (e) { /* 이관 실패 시 무시 */ }
        }
      }
      configs = list;
      refreshConfigs();
    }
    const refreshConfigs = (selectName) => {
      const list = loadConfigs();
      configSel.innerHTML = "";
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = list.length ? "설정 선택…" : "(저장된 설정 없음)";
      configSel.appendChild(ph);
      list.forEach((c) => {
        const o = document.createElement("option");
        o.value = c.name;
        o.textContent = c.name;
        configSel.appendChild(o);
      });
      if (selectName != null) configSel.value = selectName;
    };
    initConfigs();  // 서버에서 Chat설정 로드(+최초 이관) 후 드롭다운 렌더

    // Chat설정 선택 시 그 설정의 초기값(정상답변초기화/Multi Turn/수정가능여부)을 화면 토글에 반영
    function applySelectedConfig() {
      const c = loadConfigs().find((x) => x.name === configSel.value);
      editable = c ? (c.editable !== false) : true;  // 미선택(placeholder)이면 편집 가능 기본
      if (c) {
        setMultiTurn(c.multiTurn !== false);
        setResetOnAnswer(c.resetOnAnswer !== false);
      }
      applyLocks();
    }
    configSel.addEventListener("change", applySelectedConfig);

    // 추가 — 빈 팝업을 열어 새 설정을 입력받아 저장
    configAddBtn.addEventListener("click", () => {
      openConfigModal("add", {
        name: "",
        team: teams[0] || "",
        variables: DEFAULT_VARIABLES,
        userPrompt: DEFAULT_USER_PROMPT,
      });
    });

    // 수정 — 드롭다운에서 선택한 설정을 팝업에 채워서 수정
    configUpdateBtn.addEventListener("click", () => {
      const name = configSel.value;
      if (!name) { window.Toast.show("수정할 설정을 선택하세요", "error"); return; }
      const found = loadConfigs().find((c) => c.name === name);
      if (!found) { window.Toast.show("저장된 설정을 찾을 수 없습니다", "error"); return; }
      openConfigModal("edit", found);
    });

    // 설정 입력/수정 팝업. mode='add'|'edit', cfg=초기값({name,team,variables,userPrompt})
    function openConfigModal(mode, cfg) {
      const origName = cfg.name || "";
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" style="width:640px; max-width:92vw;">
          <div class="modal-header">
            <h2>Chat설정 ${mode === "add" ? "추가" : "수정"}</h2>
            <button class="btn btn-ghost" id="cfg-close" type="button">✕</button>
          </div>
          <div class="modal-body stack">
            <div class="stack-sm">
              <label>Chat설정</label>
              <input type="text" id="cfg-name" placeholder="설정 이름" />
            </div>
            <div class="stack-sm">
              <label>conversation id 초기값설정</label>
              <div style="display:flex; gap:18px; align-items:center; flex-wrap:wrap;">
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-weight:400;"><input type="checkbox" id="cfg-reset" /> 정상답변시 대화초기화</label>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-weight:400;"><input type="checkbox" id="cfg-multiturn" /> Multi Turn</label>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-weight:400;"><input type="checkbox" id="cfg-editable" /> Chat화면에서 수정가능여부</label>
              </div>
            </div>
            <div class="stack-sm">
              <label>Team</label>
              <select id="cfg-team"></select>
            </div>
            <div class="stack-sm">
              <label>변수</label>
              <textarea id="cfg-variables" rows="3" style="font-family:var(--font-mono); font-size:var(--fs-sm);"></textarea>
            </div>
            <div class="stack-sm">
              <label>User Prompt</label>
              <textarea id="cfg-prompt" rows="8" style="font-family:var(--font-mono); font-size:var(--fs-sm);"></textarea>
            </div>
            <div class="row" style="justify-content:flex-start;">
              <a id="cfg-script" role="button" tabindex="0" style="color:#0066cc; text-decoration:underline; cursor:pointer; font-size:var(--fs-sm);">실행 스크립트 보기</a>
            </div>
          </div>
          <div class="modal-footer row end" style="gap:var(--space-2);">
            <button class="btn" id="cfg-cancel" type="button">취소</button>
            <button class="btn btn-primary" id="cfg-save" type="button">저장</button>
          </div>
        </div>
      `;
      const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      // 바깥 클릭으로는 닫지 않음 — 닫기는 X 버튼으로만 (실수 닫힘 방지)
      document.addEventListener("keydown", onKey);
      document.body.appendChild(backdrop);

      // Team 드롭다운 채우기 (현재 값이 목록에 없으면 보존)
      const teamSel = backdrop.querySelector("#cfg-team");
      const teamOpts = teams.slice();
      if (cfg.team && !teamOpts.includes(cfg.team)) teamOpts.unshift(cfg.team);
      teamOpts.forEach((t) => {
        const o = document.createElement("option");
        o.value = t; o.textContent = t;
        teamSel.appendChild(o);
      });

      const nameEl = backdrop.querySelector("#cfg-name");
      const varsEl = backdrop.querySelector("#cfg-variables");
      const promptEl = backdrop.querySelector("#cfg-prompt");
      const resetChkEl = backdrop.querySelector("#cfg-reset");
      const mtChkEl = backdrop.querySelector("#cfg-multiturn");
      const editChkEl = backdrop.querySelector("#cfg-editable");
      nameEl.value = cfg.name || "";
      teamSel.value = cfg.team || "";
      varsEl.value = cfg.variables || "";
      promptEl.value = cfg.userPrompt || "";
      // 초기값 3종 — 기존 설정에 필드가 없으면 기본 true (하위호환)
      resetChkEl.checked = cfg.resetOnAnswer !== false;
      mtChkEl.checked = cfg.multiTurn !== false;
      editChkEl.checked = cfg.editable !== false;

      backdrop.querySelector("#cfg-close").addEventListener("click", close);
      backdrop.querySelector("#cfg-cancel").addEventListener("click", close);
      // 하단 링크 — 현재 입력값(Team/변수/User Prompt) 기준 실행 스크립트를 팝업으로 조회
      const showScript = () => {
        const team = teamSel.value;
        if (!promptEl.value.trim()) { window.Toast.show("User Prompt 를 입력하면 스크립트를 볼 수 있습니다", "warn"); return; }
        openScriptModal("실행 스크립트 — RUN_TEAM", team, buildChatScript(team, varsEl.value, promptEl.value));
      };
      const scriptLink = backdrop.querySelector("#cfg-script");
      scriptLink.addEventListener("click", showScript);
      scriptLink.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showScript(); } });
      backdrop.querySelector("#cfg-save").addEventListener("click", async () => {
        const name = nameEl.value.trim();
        if (!name) { window.Toast.show("설정 이름을 입력하세요", "error"); nameEl.focus(); return; }
        const list = loadConfigs().slice();  // 캐시 복사 후 수정 (저장 성공 시 반영)
        // 중복 이름 검사 — 수정 시 자기 자신(원래 이름)은 제외
        if (list.some((c) => c.name === name && c.name !== origName)) {
          window.Toast.show("이미 있는 이름입니다", "error");
          return;
        }
        const entry = { name, team: teamSel.value, variables: varsEl.value, userPrompt: promptEl.value,
          resetOnAnswer: resetChkEl.checked, multiTurn: mtChkEl.checked, editable: editChkEl.checked };
        if (mode === "edit") {
          const idx = list.findIndex((c) => c.name === origName);
          if (idx >= 0) list[idx] = entry; else list.push(entry);
        } else {
          list.push(entry);
        }
        try { await persistConfigs(list); }
        catch (e) { window.Toast.show("Chat설정 저장 실패", "error"); return; }
        configs = list;
        refreshConfigs(name);
        applySelectedConfig();  // 방금 저장/선택된 설정의 초기값을 화면 토글에 반영
        // 위험 패턴은 차단하지 않고 경고만 (저장은 진행) — PoC, 작성자는 신뢰된 테스터
        const warns = userPromptWarnings(promptEl.value);
        if (warns.length) {
          window.Toast.show(`저장됨 (주의: ${warns[0]})`, "warn");
        } else {
          window.Toast.show(`'${name}' ${mode === "add" ? "저장" : "수정"}됨`, "success");
        }
        close();
      });

      setTimeout(() => nameEl.focus(), 50);
    }

    // --- 메시지 저장/불러오기 (localStorage, 세션 간 유지) ---
    const SAVED_KEY = "aiChat.savedMessages";
    const saveTitle = panel.querySelector("#chat-save-title");
    const saveAddBtn = panel.querySelector("#chat-save-add");
    const saveUpdateBtn = panel.querySelector("#chat-save-update");
    const saveDeleteBtn = panel.querySelector("#chat-save-delete");
    const savedSel = panel.querySelector("#chat-saved");

    const loadSaved = () => {
      try { return JSON.parse(window.Store.get(SAVED_KEY)) || []; }
      catch (e) { return []; }
    };
    const refreshSaved = (selectTitle) => {
      const list = loadSaved();
      savedSel.innerHTML = "";
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = list.length ? "저장된 메시지…" : "(저장된 메시지 없음)";
      savedSel.appendChild(ph);
      list.forEach((m) => {
        const o = document.createElement("option");
        o.value = m.title;
        o.textContent = m.title;
        savedSel.appendChild(o);
      });
      if (selectTitle != null) savedSel.value = selectTitle;
    };
    refreshSaved();

    // 추가 — 제목칸의 새 title 로 현재 입력 메시지를 신규 저장 (중복 title 거부)
    saveAddBtn.addEventListener("click", () => {
      const title = saveTitle.value.trim();
      const text = inputEl.value;
      if (!title) { window.Toast.show("추가할 제목을 입력하세요", "error"); saveTitle.focus(); return; }
      if (!text.trim()) { window.Toast.show("저장할 메시지가 비어 있습니다", "error"); return; }
      const list = loadSaved();
      if (list.some((m) => m.title === title)) {
        window.Toast.show("이미 있는 제목입니다. [수정]을 사용하세요", "error");
        return;
      }
      list.push({ title, text });
      window.Store.set(SAVED_KEY, JSON.stringify(list));
      refreshSaved(title);
      saveTitle.value = "";
      window.Toast.show(`'${title}' 저장됨`, "success");
    });

    // 수정 — 콤보에서 선택한 기존 title 의 메시지를 현재 입력 내용으로 갱신
    saveUpdateBtn.addEventListener("click", () => {
      const title = savedSel.value;
      if (!title) { window.Toast.show("수정할 항목을 콤보에서 선택하세요", "error"); return; }
      const text = inputEl.value;
      if (!text.trim()) { window.Toast.show("저장할 메시지가 비어 있습니다", "error"); return; }
      const list = loadSaved();
      const idx = list.findIndex((m) => m.title === title);
      if (idx < 0) { window.Toast.show("저장된 항목을 찾을 수 없습니다", "error"); return; }
      list[idx].text = text;
      window.Store.set(SAVED_KEY, JSON.stringify(list));
      window.Toast.show(`'${title}' 수정됨`, "success");
    });

    // 삭제 — 콤보에서 선택한 저장 메시지를 localStorage 에서 제거
    saveDeleteBtn.addEventListener("click", () => {
      const title = savedSel.value;
      if (!title) { window.Toast.show("삭제할 항목을 콤보에서 선택하세요", "error"); return; }
      if (!window.confirm(`저장된 메시지 '${title}' 을(를) 삭제할까요?`)) return;
      const list = loadSaved();
      const next = list.filter((m) => m.title !== title);
      if (next.length === list.length) { window.Toast.show("저장된 항목을 찾을 수 없습니다", "error"); return; }
      window.Store.set(SAVED_KEY, JSON.stringify(next));
      refreshSaved();
      window.Toast.show(`'${title}' 삭제됨`, "success");
    });

    // 선택 — 저장된 메시지를 입력창으로 불러오기
    savedSel.addEventListener("change", () => {
      const title = savedSel.value;
      if (!title) return;
      const found = loadSaved().find((m) => m.title === title);
      if (found) { inputEl.value = found.text; autoGrow(); inputEl.focus(); }
    });

    // 초기 인사
    addMessage("bot", GREETING);
    setTimeout(() => inputEl.focus(), 50);
  }

  window.Views = window.Views || {};
  window.Views.aiChat = render;
})();
