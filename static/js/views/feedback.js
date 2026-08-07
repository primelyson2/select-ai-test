/** views/feedback.js — 메뉴 [Select AI Test - Feedback]
 *
 * Select AI 의 DBMS_CLOUD_AI.FEEDBACK(NL2SQL 학습 피드백)을 관리한다.
 * 기존 AI Profile Test 의 '4. Feedback 관리' 탭을 별도 화면으로 분리한 것.
 *   - GET  /api/profiles/{name}/feedback/vectab : <PROFILE>_FEEDBACK_VECINDEX$VECTAB (display only)
 *   - GET  /api/profiles/feedback/mapped-sql    : v$mapped_sql (NL2SQL 실행 내역 + sql_id)
 *   - POST /api/profiles/{name}/feedback        : DBMS_CLOUD_AI.FEEDBACK 실행
 *
 * (앱 레벨 답변 피드백 T_AICHAT_FEEDBACK / feedback.py 라우터와는 무관 — 이름만 유사.)
 */
(function () {
  function errMsg(err, fallback) {
    const p = err && err.payload;
    const d = p && (p.detail || p.error);
    if (d) {
      if (typeof d === "string") return d;
      const txt = d.error || d.message || JSON.stringify(d);
      return d.database ? `${txt} (${d.database})` : txt;
    }
    return (err && err.message) || fallback || "요청 실패";
  }

  function divFromHtml(html) { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild || d; }

  // --- Tab 4: Feedback 관리 (서버 연동) ---
  //   - GET  /api/profiles/{name}/feedback/vectab : <PROFILE>_FEEDBACK_VECINDEX$VECTAB (display only)
  //   - GET  /api/profiles/feedback/mapped-sql    : v$mapped_sql (NL2SQL 실행 내역 + sql_id)
  //   - POST /api/profiles/{name}/feedback        : DBMS_CLOUD_AI.FEEDBACK 실행
  // ====================================================================

  // 현재 선택된 Profile 명 — 셀 안의 버튼들이 클릭 시점에 읽는다.
  function fbProfile() {
    const sel = document.getElementById("fb-profile");
    return sel ? sel.value : "";
  }

  // <PROFILE_NAME>_FEEDBACK_VECINDEX$VECTAB — feedback 사용 시 자동 생성되는 Vector Table 명
  function vectorTableName(profile) {
    return profile ? `${profile}_FEEDBACK_VECINDEX$VECTAB` : "<PROFILE_NAME>_FEEDBACK_VECINDEX$VECTAB";
  }

  // PL/SQL 문자열 리터럴용 single-quote 이스케이프
  function fbSqlLit(s) {
    return String(s == null ? "" : s).replace(/'/g, "''");
  }

  // sql_id 기반 — 기존 실행된 SQL 에 피드백 추가(=update). 미리보기/복사용 스크립트.
  function buildFeedbackAddByIdSql(profile, sqlId, feedbackType) {
    return `BEGIN
    DBMS_CLOUD_AI.FEEDBACK(
        profile_name  => '${fbSqlLit(profile)}',
        sql_id        => '${fbSqlLit(sqlId)}',
        feedback_type => '${fbSqlLit(feedbackType)}',
        operation     => 'add'  -- add(update) / delete
    );
END;
/`;
  }

  // sql_id 기반 — 저장된 피드백 삭제(operation=delete). 미리보기/복사용 스크립트.
  function buildFeedbackDeleteByIdSql(profile, sqlId, feedbackType) {
    return `BEGIN
    DBMS_CLOUD_AI.FEEDBACK(
        profile_name  => '${fbSqlLit(profile)}',
        sql_id        => '${fbSqlLit(sqlId)}',
        feedback_type => '${fbSqlLit(feedbackType)}',
        operation     => 'delete'
    );
END;
/`;
  }

  // sql_text 기반 — 저장된 피드백 삭제(operation=delete). sql_id 가 없는 행 삭제에 사용. 미리보기/복사용 스크립트.
  function buildFeedbackDeleteByTextSql(profile, sqlText, feedbackType, response) {
    return `BEGIN
    DBMS_CLOUD_AI.FEEDBACK(
        profile_name  => '${fbSqlLit(profile)}',
        sql_text      => '${fbSqlLit(sqlText)}',
        feedback_type => '${fbSqlLit(feedbackType)}',
        response      => '${fbSqlLit(response)}',
        operation     => 'delete'
    );
END;
/`;
  }

  // sql_text 기반 — 사전 실행 없이 프롬프트 + 기대 응답(SQL)으로 피드백 등록. 미리보기/복사용 스크립트.
  //   feedbackContent 는 선택 — 값이 있을 때만 feedback_content 줄을 추가한다.
  function buildFeedbackByTextSql(profile, sqlText, feedbackType, response, feedbackContent) {
    const fcLine = feedbackContent
      ? `,\n        feedback_content => '${fbSqlLit(feedbackContent)}'`
      : "";
    return `BEGIN
    DBMS_CLOUD_AI.FEEDBACK(
        profile_name  => '${fbSqlLit(profile)}',
        sql_text      => '${fbSqlLit(sqlText)}',
        feedback_type => '${fbSqlLit(feedbackType)}',
        response      => '${fbSqlLit(response)}'${fcLine}
    );
END;
/`;
  }

  // FEEDBACK 스크립트 확인 팝업 — 스크립트를 보여주고 [반영] 클릭 시 onApply() 실행.
  // onApply 가 throw 하면 모달을 유지해 사용자가 오류를 보고 재시도할 수 있게 한다.
  function showFeedbackConfirmModal(title, sql, onApply) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" style="width:760px;">
        <div class="modal-header">
          <h2>${window.escapeHtml(title)}</h2>
          <button class="btn btn-ghost" id="fbm-close">✕</button>
        </div>
        <div class="modal-body stack">
          <label class="muted" style="font-size:var(--fs-sm);">아래 스크립트를 실행합니다.</label>
          <pre id="fbm-pre" style="white-space:pre; margin:0; font-family:var(--font-mono); font-size:var(--fs-sm); background:var(--surface-alt); padding:var(--space-3); border-radius:var(--radius-md); overflow:auto;"></pre>
          <div class="row end" style="gap:8px;">
            <button class="btn btn-ghost" id="fbm-copy">복사</button>
            <button class="btn btn-primary" id="fbm-apply">반영</button>
          </div>
        </div>
      </div>
    `;
    backdrop.querySelector("#fbm-pre").textContent = sql;
    const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    // 바깥 클릭으로는 닫지 않음 — 닫기는 X 버튼으로만 (실수 닫힘 방지)
    backdrop.querySelector("#fbm-close").addEventListener("click", close);
    backdrop.querySelector("#fbm-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(sql); window.Toast.show("클립보드에 복사됨", "success"); }
      catch (_) { window.Toast.show("복사 실패", "error"); }
    });
    const applyBtn = backdrop.querySelector("#fbm-apply");
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      const prev = applyBtn.innerHTML;
      applyBtn.innerHTML = '<span class="spinner"></span> 반영 중...';
      try {
        await onApply();
        close();
      } catch (e) {
        // onApply 내부에서 토스트 처리 — 모달은 유지하고 버튼만 복구
        applyBtn.disabled = false;
        applyBtn.innerHTML = prev;
      }
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
  }

  function renderFeedback(host, profiles) {
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "split-vert";
    host.appendChild(wrap);

    // 사용 가능한 Profile (ENABLED 우선, 없으면 전체)
    const enabled = profiles.filter((p) => p.status === "ENABLED");
    const pool = enabled.length ? enabled : profiles;
    const profileOptions = pool.map((p) =>
      `<option value="${window.escapeAttr(p.profile_name)}">${window.escapeHtml(p.profile_name)}</option>`).join("");

    // ---- 상단: Profile 선택 + Vector Table ----
    const topPanel = document.createElement("div");
    topPanel.className = "panel";
    topPanel.innerHTML = `
      <div class="panel-header"><h2>피드백 대상 Profile</h2></div>
      <div class="panel-body stack-sm">
        <div class="row" style="gap:12px; align-items:center;">
          <label style="width:90px;">Profile</label>
          <select id="fb-profile" style="min-width:260px;">${profileOptions}</select>
        </div>
        <div class="row" style="gap:12px; align-items:center;">
          <label style="width:90px;">Vector Table</label>
          <input id="fb-vectab" readonly style="min-width:380px; font-family:var(--font-mono); font-size:var(--fs-sm);">
        </div>
        <div class="muted" style="font-size:var(--fs-sm);">
          · 같은 <b>sql_id</b> 에 대한 피드백은 <b>1건만 유지</b>됩니다 (<code>operation =&gt; 'add'</code> 가 곧 update).
        </div>
      </div>
    `;
    wrap.appendChild(topPanel);

    // ---- Vector Table 내용 (저장된 Feedback, display only) ----
    const vectabPanel = document.createElement("div");
    vectabPanel.className = "panel";
    vectabPanel.innerHTML = `
      <div class="panel-header">
        <h2>저장된 Feedback</h2>
        <div class="row" style="gap:8px;">
          <button class="btn btn-ghost" id="fb-vectab-reload">↻ 조회</button>
          <button class="btn btn-primary" id="fb-add-positive">Feedback 추가 - Positive</button>
          <button class="btn btn-primary" id="fb-add-negative">Feedback 추가 - Negative</button>
        </div>
      </div>
      <div class="panel-body" id="fb-vectab-list"></div>
    `;
    wrap.appendChild(vectabPanel);

    // ※ [Feedback 추가 — 실행된 내역에서 / 실행내역 없이] 두 섹션은 위 '저장된 Feedback' 헤더의
    //   [Feedback 추가 - Positive] / [Feedback 추가 - Negative] 버튼으로 여는 팝업으로 이동함
    //   (openMappedSqlModal / openDirectFeedbackModal).

    const vectabInput = document.getElementById("fb-vectab");

    // --- Vector Table 내용 조회 (display only) ---
    async function loadVectab() {
      const profile = fbProfile();
      const listHost = document.getElementById("fb-vectab-list");
      if (!profile) {
        listHost.innerHTML = '<div class="empty-state muted">Profile 을 선택하세요.</div>';
        return;
      }
      listHost.innerHTML = '<div class="empty-state"><span class="spinner"></span> 조회 중...</div>';
      let data;
      try {
        data = await window.API.get(`/api/profiles/${encodeURIComponent(profile)}/feedback/vectab`);
      } catch (e) {
        listHost.innerHTML = `<div class="empty-state muted">${errMsg(e, "Vector Table 조회 실패")}</div>`;
        return;
      }
      if (fbProfile() !== profile) return;  // 그 사이 Profile 변경 시 무시
      if (!data.exists) {
        listHost.innerHTML = '<div class="empty-state muted">vector table 없음</div>';
        return;
      }
      const cols = (data.columns || []).map((c) => ({ key: c, label: c }));
      listHost.innerHTML = "";
      if (!cols.length) {
        listHost.innerHTML = '<div class="empty-state muted">컬럼 정보가 없습니다.</div>';
        return;
      }
      // 행 끝에 액션(수정/삭제) 버튼 컬럼 추가.
      cols.push({ key: "_act", label: "", headerAlign: "center",
        format: (_v, row) => buildVectabActions(row, loadVectab) });
      listHost.appendChild(window.SimpleTable.create(cols, data.rows || [],
        { className: "keep-case", onRowClick: (row) => showVectabViewModal(row) }));
      if (!(data.rows || []).length) {
        listHost.appendChild(divFromHtml('<div class="empty-state muted">저장된 Feedback 이 없습니다.</div>'));
      }
    }

    // --- v$mapped_sql 실행 내역 조회 ---
    async function loadMappedSql() {
      const histHost = document.getElementById("fb-hist");
      histHost.innerHTML = '<div class="empty-state"><span class="spinner"></span> 조회 중...</div>';
      let rows;
      try {
        rows = await window.API.get("/api/profiles/feedback/mapped-sql");
      } catch (e) {
        histHost.innerHTML = `<div class="empty-state muted">${errMsg(e, "v$mapped_sql 조회 실패")}</div>`;
        return;
      }
      histHost.innerHTML = "";
      histHost.appendChild(window.SimpleTable.create(
        [
          { key: "sql_fulltext", label: "Sql_fulltext" },
          { key: "sql_id", label: "sql_id" },
          { key: "mapped_sql_text", label: "Mapped_sql_text" },
          { key: "translation_timestamp", label: "timestamp", headerAlign: "center" },
          { key: "use_count", label: "use_count", headerAlign: "center" },
          { key: "_add", label: "", headerAlign: "center",
            format: (_v, row) => buildMappedAddBtn(row, loadVectab) },
        ],
        rows || [],
        { className: "keep-case", onRowClick: (row) => showMappedViewModal(row) }
      ));
      if (!(rows || []).length) {
        histHost.appendChild(divFromHtml('<div class="empty-state muted">실행 내역이 없습니다 (v$mapped_sql 비어 있음).</div>'));
      }
    }

    // v$mapped_sql 행의 "추가" 버튼 — 스크립트 팝업을 띄우고 [반영] 클릭 시 실제 FEEDBACK 실행.
    function buildMappedAddBtn(row, onDone) {
      const btn = document.createElement("button");
      btn.className = "btn btn-primary";
      btn.textContent = "추가";
      btn.title = "feedback_type=positive, operation=add (같은 sql_id 는 1건만 유지되어 update 됨)";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();  // 행 클릭(상세 팝업)으로 전파 방지
        const profile = fbProfile();
        if (!profile) { window.Toast.show("Profile 을 선택하세요", "warn"); return; }
        if (!row.sql_id) { window.Toast.show("sql_id 가 없습니다", "warn"); return; }
        const sql = buildFeedbackAddByIdSql(profile, row.sql_id, "positive");
        showFeedbackConfirmModal(`FEEDBACK (add) — ${row.sql_id}`, sql, async () => {
          try {
            await window.API.post(`/api/profiles/${encodeURIComponent(profile)}/feedback`,
              { sql_id: row.sql_id, feedback_type: "positive", operation: "add" });
            window.Toast.show(`피드백 추가됨 (${row.sql_id})`, "success");
            if (typeof onDone === "function") onDone();
          } catch (e) {
            window.Toast.show(errMsg(e, "피드백 추가 실패"), "error");
            throw e;  // 모달 유지 (사용자가 오류 확인 후 재시도)
          }
        });
      });
      return btn;
    }

    // v$mapped_sql 행 클릭 → 읽기전용 상세 팝업 (모든 컬럼을 그대로 표시).
    function showMappedViewModal(row) {
      // 한 줄로 저장된 SQL 을 주요 절 앞에서 줄바꿈해 읽기 쉽게 만든다(표시용).
      const prettySql = (s) => s == null ? s : String(s).replace(
        /\s+(FROM|WHERE|AND|OR|GROUP\s+BY|ORDER\s+BY|HAVING|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|INNER\s+JOIN|JOIN|ON|UNION\s+ALL|UNION)\b/gi,
        "\n$1");

      // sql_fulltext 가 'select ai showsql' 이면 mapped_sql_text 는 SELECT '<실제 SQL>' <alias> 형태다.
      // 이때 첫 리터럴('') 안의 실제 SQL 만 추출해 보여준다('' 이스케이프는 ' 로 복원).
      const extractInnerSql = (mapped) => {
        const s = String(mapped || "");
        const start = s.indexOf("'");
        if (start < 0) return null;
        let out = "", i = start + 1;
        while (i < s.length) {
          if (s[i] === "'") {
            if (s[i + 1] === "'") { out += "'"; i += 2; continue; }  // '' → '
            return out;  // 닫는 따옴표
          }
          out += s[i++];
        }
        return out;  // 닫는 따옴표가 없으면 있는 데까지
      };
      let mappedText = row.mapped_sql_text;
      if (/^\s*select\s+ai\s+showsql\b/i.test(row.sql_fulltext || "")) {
        const inner = extractInnerSql(row.mapped_sql_text);
        if (inner) mappedText = inner;
      }

      const roField = (label, value) => `
        <div class="stack-sm">
          <label style="font-size:var(--fs-sm); color:var(--text-muted);">${label}</label>
          <pre style="white-space:pre-wrap; word-break:break-word; margin:0; font-family:var(--font-mono); font-size:var(--fs-sm); background:var(--surface-alt); padding:var(--space-2) var(--space-3); border-radius:var(--radius-md); max-height:240px; overflow:auto;">${window.escapeHtml(value != null && String(value).trim() !== "" ? String(value) : "—")}</pre>
        </div>`;

      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" style="width:900px; max-width:95vw;">
          <div class="modal-header">
            <h2>실행 내역 상세 <span class="muted" style="font-size:var(--fs-sm);">v$mapped_sql · 읽기전용</span></h2>
            <button class="btn btn-ghost" id="mv-close">✕</button>
          </div>
          <div class="modal-body stack">
            <div class="row" style="gap:12px;">
              <div style="flex:1; min-width:0;">${roField("sql_id", row.sql_id)}</div>
              <div style="flex:1; min-width:0;">${roField("use_count", row.use_count)}</div>
              <div style="flex:1; min-width:0;">${roField("timestamp", row.translation_timestamp)}</div>
            </div>
            ${roField("sql_fulltext", row.sql_fulltext)}
            ${roField("mapped_sql_text", prettySql(mappedText))}
            <div class="row end">
              <button class="btn btn-ghost" id="mv-close2">닫기</button>
            </div>
          </div>
        </div>
      `;
      const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      // 바깥 클릭으로는 닫지 않음 — 닫기는 X/닫기 버튼 또는 ESC 로만.
      backdrop.querySelector("#mv-close").addEventListener("click", close);
      backdrop.querySelector("#mv-close2").addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(backdrop);
    }

    // vectab 행의 액션 셀 — [수정](response 편집) + [삭제] 버튼을 한 칸에 배치.
    function buildVectabActions(row, onDone) {
      const sqlId = (row.sql_id || "").trim();
      const sqlText = (row.sql_text || "").trim();
      if (!sqlId && !sqlText) return divFromHtml('<span class="muted">—</span>');

      const box = document.createElement("div");
      box.className = "row";
      box.style.gap = "6px";
      box.style.justifyContent = "center";
      // 액션 셀 클릭은 행 클릭(조회 팝업)으로 전파되지 않도록 차단.
      box.addEventListener("click", (e) => e.stopPropagation());

      // 수정 — response 만 바꿔 재등록(operation=add). response 전달은 sql_text 모드만 가능하므로
      //        sql_text 가 있는 행에만 노출한다. 단 positive 는 response 가 시스템 파생값이고
      //        positive+response 조합을 Oracle 이 거부하므로 negative 행에만 노출한다.
      if (sqlText && (row.feedback_type || "").trim().toLowerCase() === "negative") {
        const editBtn = document.createElement("button");
        editBtn.className = "btn btn-ghost";
        editBtn.textContent = "수정";
        editBtn.title = "response 를 수정해 다시 저장 (operation=add)";
        editBtn.addEventListener("click", () => showVectabEditModal(row, onDone));
        box.appendChild(editBtn);
      }

      box.appendChild(buildVectabDeleteBtn(row, onDone));
      return box;
    }

    // vectab 행 클릭 → 읽기전용 조회 팝업 (모든 컬럼을 그대로 표시).
    function showVectabViewModal(row) {
      const roField = (label, value) => `
        <div class="stack-sm">
          <label style="font-size:var(--fs-sm); color:var(--text-muted);">${label}</label>
          <pre style="white-space:pre-wrap; word-break:break-word; margin:0; font-family:var(--font-mono); font-size:var(--fs-sm); background:var(--surface-alt); padding:var(--space-2) var(--space-3); border-radius:var(--radius-md); max-height:240px; overflow:auto;">${window.escapeHtml(value != null && String(value).trim() !== "" ? String(value) : "—")}</pre>
        </div>`;

      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" style="width:860px; max-width:95vw;">
          <div class="modal-header">
            <h2>Feedback 상세 <span class="muted" style="font-size:var(--fs-sm);">(읽기전용)</span></h2>
            <button class="btn btn-ghost" id="fbv-close">✕</button>
          </div>
          <div class="modal-body stack">
            ${roField("content", row.content)}
            <div class="row" style="gap:12px;">
              <div style="flex:1; min-width:0;">${roField("feedback_type", row.feedback_type)}</div>
              <div style="flex:1; min-width:0;">${roField("sql_id", row.sql_id)}</div>
            </div>
            ${roField("sql_text", row.sql_text)}
            ${roField("response", row.response)}
            ${roField("feedback_content", row.feedback_content)}
            <div class="row end">
              <button class="btn btn-ghost" id="fbv-close2">닫기</button>
            </div>
          </div>
        </div>
      `;
      const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      // 바깥 클릭으로는 닫지 않음 — 닫기는 X/닫기 버튼 또는 ESC 로만.
      backdrop.querySelector("#fbv-close").addEventListener("click", close);
      backdrop.querySelector("#fbv-close2").addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(backdrop);
    }

    // vectab 행의 "수정" 팝업 — content/feedback_type/sql_id/sql_text 는 읽기전용으로 보여주고
    //   response 만 편집한다. [저장] 시 sql_text 모드로 FEEDBACK(operation=add) 재등록(같은 항목은
    //   1건만 유지되어 response 가 갱신됨).
    function showVectabEditModal(row, onDone) {
      const profile = fbProfile();
      if (!profile) { window.Toast.show("Profile 을 선택하세요", "warn"); return; }

      const sqlText = (row.sql_text || "").trim();
      const ft = row.feedback_type || "positive";

      // 읽기전용 필드 한 칸을 만드는 헬퍼.
      const roField = (label, value) => `
        <div class="stack-sm">
          <label style="font-size:var(--fs-sm); color:var(--text-muted);">${label}</label>
          <pre style="white-space:pre-wrap; word-break:break-word; margin:0; font-family:var(--font-mono); font-size:var(--fs-sm); background:var(--surface-alt); padding:var(--space-2) var(--space-3); border-radius:var(--radius-md); max-height:120px; overflow:auto;">${window.escapeHtml(value || "—")}</pre>
        </div>`;

      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" style="width:760px;">
          <div class="modal-header">
            <h2>Feedback 수정 — response</h2>
            <button class="btn btn-ghost" id="fbe-close">✕</button>
          </div>
          <div class="modal-body stack">
            ${roField("content", row.content)}
            <div class="row" style="gap:12px;">
              <div style="flex:1; min-width:0;">${roField("feedback_type", row.feedback_type)}</div>
              <div style="flex:1; min-width:0;">${roField("sql_id", row.sql_id)}</div>
            </div>
            ${roField("sql_text", row.sql_text)}
            <div class="stack-sm">
              <label>response <span class="muted" style="font-size:var(--fs-sm);">— 수정 가능</span></label>
              <textarea id="fbe-response" rows="6" class="textarea-auto" style="font-family:var(--font-mono); font-size:var(--fs-sm);"></textarea>
            </div>
            <div class="stack-sm">
              <label>feedback_content <span class="muted" style="font-size:var(--fs-sm);">— 자연어 피드백(선택). 수정 가능</span></label>
              <textarea id="fbe-feedback-content" rows="2" class="textarea-auto"></textarea>
            </div>
            <div class="row end" style="gap:8px;">
              <button class="btn btn-ghost" id="fbe-cancel">닫기</button>
              <button class="btn btn-primary" id="fbe-save">저장</button>
            </div>
          </div>
        </div>
      `;
      const respEl = backdrop.querySelector("#fbe-response");
      respEl.value = row.response || "";
      const fcEl = backdrop.querySelector("#fbe-feedback-content");
      fcEl.value = row.feedback_content || "";

      const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      // 바깥 클릭으로는 닫지 않음 — 닫기는 X 버튼으로만 (실수 닫힘 방지)
      backdrop.querySelector("#fbe-close").addEventListener("click", close);
      backdrop.querySelector("#fbe-cancel").addEventListener("click", close);

      const saveBtn = backdrop.querySelector("#fbe-save");
      saveBtn.addEventListener("click", async () => {
        const response = respEl.value.trim();
        if (!response) { window.Toast.show("response 가 비어 있습니다", "warn"); return; }
        const feedbackContent = fcEl.value.trim();
        saveBtn.disabled = true;
        const prev = saveBtn.innerHTML;
        saveBtn.innerHTML = '<span class="spinner"></span> 저장 중...';
        try {
          await window.API.post(`/api/profiles/${encodeURIComponent(profile)}/feedback`,
            { sql_text: sqlText, feedback_type: ft, response, feedback_content: feedbackContent, operation: "add" });
          window.Toast.show("response 수정됨", "success");
          close();
          if (typeof onDone === "function") onDone();
        } catch (e) {
          // 실패 시 모달 유지 + 버튼 복구 (사용자가 오류 확인 후 재시도)
          window.Toast.show(errMsg(e, "수정 실패"), "error");
          saveBtn.disabled = false;
          saveBtn.innerHTML = prev;
        }
      });

      document.addEventListener("keydown", onKey);
      document.body.appendChild(backdrop);
    }

    // vectab 행의 "삭제" 버튼 — 스크립트 팝업을 띄우고 [반영] 클릭 시 FEEDBACK(operation=delete) 실행.
    //   - sql_id 가 있으면 sql_id 기반 삭제
    //   - sql_id 가 없으면 sql_text + feedback_type + response 기반 삭제
    function buildVectabDeleteBtn(row, onDone) {
      const sqlId = (row.sql_id || "").trim();
      const sqlText = (row.sql_text || "").trim();
      if (!sqlId && !sqlText) return divFromHtml('<span class="muted">—</span>');

      const btn = document.createElement("button");
      btn.className = "btn btn-primary";
      btn.textContent = "삭제";
      btn.title = "operation=delete (이 행의 저장된 피드백을 삭제)";
      btn.addEventListener("click", () => {
        const profile = fbProfile();
        if (!profile) { window.Toast.show("Profile 을 선택하세요", "warn"); return; }

        let sql, payload, label;
        if (sqlId) {
          sql = buildFeedbackDeleteByIdSql(profile, sqlId, row.feedback_type || "positive");
          payload = { sql_id: sqlId, operation: "delete" };
          label = sqlId;
        } else {
          const ft = row.feedback_type || "negative";
          sql = buildFeedbackDeleteByTextSql(profile, sqlText, ft, row.response || "");
          payload = { sql_text: sqlText, feedback_type: ft, response: row.response || "", operation: "delete" };
          label = sqlText;
        }

        showFeedbackConfirmModal(`FEEDBACK (delete) — ${label}`, sql, async () => {
          try {
            await window.API.post(`/api/profiles/${encodeURIComponent(profile)}/feedback`, payload);
            window.Toast.show("피드백 삭제됨", "success");
            if (typeof onDone === "function") onDone();
          } catch (e) {
            window.Toast.show(errMsg(e, "피드백 삭제 실패"), "error");
            throw e;  // 모달 유지 (사용자가 오류 확인 후 재시도)
          }
        });
      });
      return btn;
    }

    // Profile 변경 → Vector Table 명 갱신 + 내용 재조회
    document.getElementById("fb-profile").addEventListener("change", () => {
      vectabInput.value = vectorTableName(fbProfile());
      loadVectab();
    });

    document.getElementById("fb-vectab-reload").addEventListener("click", loadVectab);
    document.getElementById("fb-add-positive").addEventListener("click", openMappedSqlModal);
    document.getElementById("fb-add-negative").addEventListener("click", openDirectFeedbackModal);

    // [Feedback 추가 - Positive] 팝업 — 실행된 내역(v$mapped_sql)에서 positive 피드백 등록.
    function openMappedSqlModal() {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" style="width:1000px; max-width:95vw;">
          <div class="modal-header">
            <h2>Feedback 추가 - 실행된 내역(v$mapped_sql)에서</h2>
            <div class="row" style="gap:8px;">
              <button class="btn btn-ghost" id="fb-hist-reload">↻ 내역 조회</button>
              <button class="btn btn-ghost" id="fb-hist-close">✕</button>
            </div>
          </div>
          <div class="modal-body"><div id="fb-hist"></div></div>
        </div>
      `;
      const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      backdrop.querySelector("#fb-hist-close").addEventListener("click", close);
      backdrop.querySelector("#fb-hist-reload").addEventListener("click", loadMappedSql);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(backdrop);
      loadMappedSql();
    }

    // [Feedback 추가 - Negative] 팝업 — 실행내역 없이 sql_text + response + feedback_content 로 negative 등록.
    function openDirectFeedbackModal() {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" style="width:820px; max-width:95vw;">
          <div class="modal-header">
            <h2>Feedback 추가 - 실행내역 없이 직접</h2>
            <button class="btn btn-ghost" id="fb-direct-close">✕</button>
          </div>
          <div class="modal-body stack-sm">
            <div class="stack-sm">
              <label>SQL Text <span class="muted" style="font-size:var(--fs-sm);">— content 만 입력하면 앞에 <code>select ai showsql</code> 가 자동으로 붙습니다 (예: <code>이번주 가장 매출이 큰 상품을 알려줘</code>)</span></label>
              <textarea id="fb-sql-text" rows="2">이번주 가장 매출이 큰 상품을 알려줘</textarea>
            </div>
            <div class="row" style="gap:12px; align-items:center;">
              <label style="width:90px;">Feedback</label>
              <input type="hidden" id="fb-direct-type" value="negative">
              <span>negative</span>
              <span class="muted" style="font-size:var(--fs-sm);">— 고정</span>
            </div>
            <div class="stack-sm">
              <label>Response <span class="muted" style="font-size:var(--fs-sm);">— Predefined SQL 입력</span></label>
              <textarea id="fb-response" rows="3" style="font-family:var(--font-mono); font-size:var(--fs-sm);">SELECT SUM(1) FROM "ADB_USER"."MOVIES"</textarea>
            </div>
            <div class="stack-sm">
              <label>Feedback Content <span class="muted" style="font-size:var(--fs-sm);">— 추가feedback</span></label>
              <textarea id="fb-feedback-content" rows="2"></textarea>
            </div>
            <div class="row end" style="gap:8px;">
              <button class="btn btn-ghost" id="fb-direct-cancel">닫기</button>
              <button class="btn btn-primary" id="fb-gen-direct">추가</button>
            </div>
          </div>
        </div>
      `;
      const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      backdrop.querySelector("#fb-direct-close").addEventListener("click", close);
      backdrop.querySelector("#fb-direct-cancel").addEventListener("click", close);
      backdrop.querySelector("#fb-gen-direct").addEventListener("click", () => submitDirectFeedback(close));
      document.addEventListener("keydown", onKey);
      document.body.appendChild(backdrop);
    }

    // 직접 입력 → 스크립트 확인 팝업 → [반영] 시 FEEDBACK(sql_text) 실행. 성공 시 onSuccess 로 팝업 닫기.
    function submitDirectFeedback(onSuccess) {
      const profile = fbProfile();
      if (!profile) { window.Toast.show("Profile 을 선택하세요", "warn"); return; }
      let sqlText = document.getElementById("fb-sql-text").value.trim();
      if (!sqlText) { window.Toast.show("SQL Text 를 입력하세요", "warn"); return; }
      // content 만 입력하면 앞에 'select ai showsql ' 를 자동으로 붙인다 (이미 'select ai' 로 시작하면 그대로).
      if (!/^select\s+ai\b/i.test(sqlText)) sqlText = "select ai showsql " + sqlText;
      const type = document.getElementById("fb-direct-type").value;
      const response = document.getElementById("fb-response").value;
      const feedbackContent = document.getElementById("fb-feedback-content").value.trim();
      const sql = buildFeedbackByTextSql(profile, sqlText, type, response, feedbackContent);
      showFeedbackConfirmModal(`FEEDBACK (sql_text) — ${profile}`, sql, async () => {
        try {
          await window.API.post(`/api/profiles/${encodeURIComponent(profile)}/feedback`,
            { sql_text: sqlText, feedback_type: type, response, feedback_content: feedbackContent });
          window.Toast.show("피드백 등록됨", "success");
          loadVectab();
          if (typeof onSuccess === "function") onSuccess();
        } catch (e) {
          window.Toast.show(errMsg(e, "피드백 등록 실패"), "error");
          throw e;  // 모달 유지 (사용자가 오류 확인 후 재시도)
        }
      });
    }

    // 진입 시 초기화 — Vector Table 명 + 저장된 Feedback 조회
    vectabInput.value = vectorTableName(fbProfile());
    loadVectab();
  }

  async function render() {
    const main = document.getElementById("main");
    main.innerHTML = "";
    const title = document.createElement("div");
    title.className = "view-title";
    title.innerHTML = `<h1>Select AI Test - Feedback</h1>
      <span class="sub">Select AI(DBMS_CLOUD_AI.FEEDBACK) 기반 NL2SQL 학습 피드백을 관리합니다.</span>`;
    main.appendChild(title);

    // Profile 목록 로드 후 피드백 화면을 그린다 (기존 4번 탭 본체 = renderFeedback).
    let profiles = [];
    try {
      profiles = await window.API.get("/api/profiles");
    } catch (e) {
      const d = document.createElement("div");
      d.className = "empty-state muted";
      d.textContent = errMsg(e, "Profile 목록 로드 실패");
      main.appendChild(d);
      return;
    }
    const host = document.createElement("div");
    main.appendChild(host);
    renderFeedback(host, profiles);
  }

  window.Views = window.Views || {};
  window.Views.feedback = render;
})();
