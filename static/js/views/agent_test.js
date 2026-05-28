/** views/agent_test.js — 메뉴 [3] AI Agent Team Test (2 탭, 상하구조). */
(function () {
  async function render() {
    const main = document.getElementById("main");
    main.innerHTML = "";

    const title = document.createElement("div");
    title.className = "view-title";
    title.innerHTML = `<h1>AI Agent Team Test</h1>
      <span class="sub">Team / Agent / Task / Tool 조회 + Team 실행 시 단계별 시간 추적.</span>`;
    main.appendChild(title);

    // 트리 데이터 한번 로드 후 두 탭에서 공유 (mock 기준)
    let teams = [];
    try {
      teams = await window.API.get("/api/agents/teams");
    } catch (e) {
      main.appendChild(divFromHTML('<div class="empty-state muted">Team 목록 로드 실패</div>'));
      return;
    }

    const tabs = window.Tabs.create([
      { id: "tree", label: "1. Team / Agent / Task / Tool",   render: (host) => renderTab1(host, teams) },
      { id: "run",  label: "2. Team 실행 및 단계별 속도",     render: (host) => renderTab2(host, teams) },
    ]);
    main.appendChild(tabs);
  }

  // --- Tab 1: 상단 트리 + 하단 상세 ---
  async function renderTab1(host, teams) {
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "split-vert";
    host.appendChild(wrap);

    const topPanel = document.createElement("div");
    topPanel.className = "panel scroll";
    topPanel.innerHTML = `
      <div class="panel-header"><h2>Team 트리</h2></div>
      <div class="panel-body" id="at-tree"><div class="empty-state"><span class="spinner"></span> 트리 구성 중...</div></div>
    `;
    wrap.appendChild(topPanel);

    const bottomPanel = document.createElement("div");
    bottomPanel.className = "panel";
    bottomPanel.innerHTML = `
      <div class="panel-header"><h2 id="at-detail-title">노드 선택 시 표시</h2></div>
      <div class="panel-body" id="at-detail">
        <div class="empty-state muted">상단 트리에서 노드를 선택하세요.</div>
      </div>
    `;
    wrap.appendChild(bottomPanel);

    // 트리 구성: /api/agents/tree 한 번에 모두 받음 (백엔드에서 5쿼리 병렬 실행)
    let treeData = { teams: [], tools_meta: {} };
    try {
      treeData = await window.API.get("/api/agents/tree");
    } catch (e) {
      document.getElementById("at-tree").innerHTML =
        '<div class="empty-state muted">트리 로드 실패</div>';
      return;
    }
    const toolsMeta = treeData.tools_meta || {};
    const treeNodes = (treeData.teams || []).map((t) => {
      const taskMap = new Map((t.tasks || []).map((tk) => [tk.name, tk]));
      const agentNodes = (t.agents || []).map((a) => {
        const taskNodes = (a.tasks || []).map((taskName) => {
          const tk = taskMap.get(taskName) || { name: taskName, tools: [] };
          return {
            id: `task:${t.name}:${a.name}:${tk.name}`,
            label: tk.name,
            tag: "Task",
            subtitle: summary("task", tk),
            type: "task",
            meta: { kind: "task", name: tk.name },
            children: (tk.tools || []).map((toolName) => ({
              id: `tool:${t.name}:${a.name}:${tk.name}:${toolName}`,
              label: toolName,
              tag: "Tool",
              subtitle: summary("tool", { name: toolName, ...(toolsMeta[toolName] || {}) }),
              type: "tool",
              meta: { kind: "tool", name: toolName },
            })),
          };
        });
        return {
          id: `agent:${t.name}:${a.name}`,
          label: a.name,
          tag: "Agent",
          subtitle: summary("agent", a),
          type: "agent",
          meta: { kind: "agent", name: a.name },
          children: taskNodes,
        };
      });
      return {
        id: `team:${t.name}`,
        label: t.name,
        tag: "Team",
        subtitle: summary("team", t),
        type: "team",
        meta: { kind: "team", name: t.name },
        children: agentNodes,
      };
    });

    document.getElementById("at-tree").innerHTML = "";
    const tree = window.Tree.create(treeNodes, {
      onSelect: async (node) => {
        if (!node.meta) return;
        const title = document.getElementById("at-detail-title");
        const body = document.getElementById("at-detail");
        title.textContent = `${node.meta.kind.toUpperCase()} — ${node.meta.name}`;
        body.innerHTML = '<div class="empty-state"><span class="spinner"></span> 조회 중...</div>';
        let detail = {};
        try {
          const path = pathFor(node.meta);
          detail = await window.API.get(path);
        } catch (e) {
          body.innerHTML = '<div class="empty-state muted">조회 실패</div>';
          return;
        }
        body.innerHTML = "";
        body.appendChild(renderAttributes(detail, node.meta));
      },
    });
    document.getElementById("at-tree").appendChild(tree);
  }

  // 트리 노드 subtitle 생성
  //   team  — 표시 안 함
  //   agent — role 전체
  //   task  — instruction 전체
  //   tool  — instruction 전체
  function summary(kind, obj) {
    const clean = (s) => (s ? String(s).replace(/\s+/g, " ").trim() : "");
    if (kind === "agent") return clean(obj.role);
    if (kind === "task")  return clean(obj.instruction);
    if (kind === "tool")  return clean(obj.instruction);
    return "";
  }

  function pathFor(meta) {
    if (meta.kind === "team")  return `/api/agents/teams/${encodeURIComponent(meta.name)}`;
    if (meta.kind === "agent") return `/api/agents/${encodeURIComponent(meta.name)}`;
    if (meta.kind === "task")  return `/api/agents/tasks/${encodeURIComponent(meta.name)}`;
    if (meta.kind === "tool")  return `/api/agents/tools/${encodeURIComponent(meta.name)}`;
    return "/api/agents/teams";
  }

  function renderAttributes(detail, meta) {
    const wrap = document.createElement("div");
    wrap.className = "stack";
    // 헤더 메타 라인
    const head = document.createElement("div");
    head.className = "muted";
    head.style.fontSize = "var(--fs-sm)";
    const keys = Object.keys(detail).filter((k) => k !== "attributes" && typeof detail[k] !== "object");
    head.textContent = keys.map((k) => `${k}: ${detail[k]}`).join("  ·  ") || "(메타 정보 없음)";
    wrap.appendChild(head);

    const attrs = detail.attributes || [];
    if (attrs.length) {
      wrap.appendChild(window.SimpleTable.create(
        [
          { key: "attribute_name", label: "Attribute" },
          {
            key: "attribute_value", label: "Value",
            format: (_v, attr) => buildAttrValueCell(meta, attr),
          },
        ],
        attrs
      ));
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-state muted";
      empty.textContent = "추가 속성이 없습니다";
      wrap.appendChild(empty);
    }
    return wrap;
  }

  // 속성 Value 셀 — textarea (auto-grow) + 저장 버튼.
  // 클릭 시 DBMS_CLOUD_AI_AGENT.SET_ATTRIBUTE 호출.
  function buildAttrValueCell(meta, attr) {
    const wrap = document.createElement("div");
    wrap.className = "row";
    wrap.style.gap = "6px";
    wrap.style.alignItems = "flex-start";

    const ta = document.createElement("textarea");
    ta.rows = 1;
    ta.className = "textarea-auto";
    ta.value = attr.attribute_value == null ? "" : String(attr.attribute_value);
    ta.style.flex = "1";
    ta.style.fontFamily = "var(--font-mono)";
    ta.style.fontSize = "var(--fs-sm)";

    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = "저장";
    btn.style.flexShrink = "0";

    btn.addEventListener("click", async () => {
      const newVal = ta.value;
      btn.disabled = true;
      const prev = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        await window.API.put(attrUrlFor(meta, attr.attribute_name), { value: newVal });
        attr.attribute_value = newVal;
        window.Toast.show(`${attr.attribute_name} 저장됨`, "success");
      } catch (err) {
        window.Toast.show(errMsg(err, "저장 실패"), "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = prev;
      }
    });

    wrap.appendChild(ta);
    wrap.appendChild(btn);
    return wrap;
  }

  function attrUrlFor(meta, attrName) {
    const an = encodeURIComponent(attrName);
    const n = encodeURIComponent(meta.name);
    if (meta.kind === "team")  return `/api/agents/teams/${n}/attributes/${an}`;
    if (meta.kind === "task")  return `/api/agents/tasks/${n}/attributes/${an}`;
    if (meta.kind === "tool")  return `/api/agents/tools/${n}/attributes/${an}`;
    return `/api/agents/${n}/attributes/${an}`;  // agent
  }

  function errMsg(err, fallback) {
    const p = err && err.payload;
    const d = p && (p.detail || p.error);
    if (d) {
      if (typeof d === "string") return d;
      const t = d.error || d.message || JSON.stringify(d);
      return d.database ? `${t} (${d.database})` : t;
    }
    return (err && err.message) || fallback || "요청 실패";
  }

  // --- Tab 2: 실행 + 단계별 Gantt ---
  function renderTab2(host, teams) {
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "split-vert";
    host.appendChild(wrap);

    const topPanel = document.createElement("div");
    topPanel.className = "panel";
    topPanel.innerHTML = `
      <div class="panel-header"><h2>Team 실행</h2></div>
      <div class="panel-body stack">
        <div class="row">
          <label style="width:90px">Team</label>
          <select id="at-team" style="min-width:240px;">
            ${teams.map((t) => `<option value="${t.name}">${t.name}</option>`).join("")}
          </select>
          <span id="at-status" class="status-pill"><span class="dot"></span> 대기</span>
        </div>
        <div class="stack-sm">
          <label>User Prompt</label>
          <textarea id="at-prompt" rows="3">배송 주소 관련 컬럼이 있는 테이블을 찾아줘</textarea>
        </div>
        <div class="row end">
          <button class="btn btn-primary" id="at-run">▶ 실행</button>
        </div>
      </div>
    `;
    wrap.appendChild(topPanel);

    const midPanel = document.createElement("div");
    midPanel.className = "panel";
    midPanel.innerHTML = `
      <div class="panel-header">
        <h2>단계별 타임라인</h2>
        <span id="at-conv-id" class="muted"></span>
      </div>
      <div class="panel-body" id="at-timeline">
        <div class="empty-state muted">[실행] 후 표시됩니다.</div>
      </div>
    `;
    wrap.appendChild(midPanel);

    const botPanel = document.createElement("div");
    botPanel.className = "panel";
    botPanel.innerHTML = `
      <div class="panel-header"><h2>최종 결과 & 로그</h2></div>
      <div class="panel-body stack" id="at-output">
        <div class="empty-state muted">[실행] 후 표시됩니다.</div>
      </div>
    `;
    wrap.appendChild(botPanel);

    document.getElementById("at-run").addEventListener("click", async () => {
      const team_name = document.getElementById("at-team").value;
      const user_prompt = document.getElementById("at-prompt").value;
      const status = document.getElementById("at-status");
      const btn = document.getElementById("at-run");
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 실행 중...';
      setStatus(status, "running", "실행 중");

      try {
        const data = await window.API.post("/api/agents/teams/run", { team_name, user_prompt });
        document.getElementById("at-conv-id").textContent = `conversation_id: ${data.conversation_id}  ·  total ${data.total_elapsed_ms} ms`;
        renderTimeline(data.timeline || [], data.total_elapsed_ms);
        renderOutput(data);
        setStatus(status, "done", "완료");
      } catch (e) {
        setStatus(status, "error", "오류");
        window.Toast.show("실행 실패", "error");
      } finally {
        btn.disabled = false; btn.innerHTML = "▶ 실행";
      }
    });
  }

  function setStatus(el, cls, text) {
    el.className = "status-pill " + cls;
    el.innerHTML = `<span class="dot"></span> ${text}`;
  }

  function renderTimeline(timeline, total) {
    const host = document.getElementById("at-timeline");
    host.innerHTML = "";
    if (!timeline.length) {
      host.innerHTML = '<div class="empty-state muted">timeline 정보가 없습니다 (DB 시간 컬럼 미존재)</div>';
      return;
    }
    const max = Math.max(total || 0, ...timeline.map((t) => t.end_ms || 0));
    const gantt = document.createElement("div");
    gantt.className = "gantt";
    timeline.forEach((seg) => {
      const row = document.createElement("div");
      row.className = "gantt-row";
      const label = document.createElement("div");
      label.className = "gantt-label";
      label.textContent = seg.step;
      const track = document.createElement("div");
      track.className = "gantt-track";
      const bar = document.createElement("div");
      bar.className = `gantt-bar ${seg.type}`;
      const left = (seg.start_ms / max) * 100;
      const width = ((seg.end_ms - seg.start_ms) / max) * 100;
      bar.style.left = `${left}%`;
      bar.style.width = `${Math.max(width, 0.5)}%`;
      track.appendChild(bar);
      const dur = document.createElement("div");
      dur.className = "gantt-duration";
      dur.textContent = `${seg.end_ms - seg.start_ms} ms`;
      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(dur);
      gantt.appendChild(row);
    });
    host.appendChild(gantt);
  }

  function renderOutput(data) {
    const host = document.getElementById("at-output");
    host.innerHTML = "";

    const result = document.createElement("div");
    result.className = "stack-sm";
    result.innerHTML = `
      <label>최종 결과 (CLOB)</label>
      <textarea readonly rows="5" style="font-family:var(--font-mono); font-size:var(--fs-sm);">${(data.result || "").replace(/</g, "&lt;")}</textarea>
    `;
    host.appendChild(result);

    const logs = data.raw_logs || {};
    const blocks = [
      { title: "Conversation Prompts", rows: logs.conversation_prompts || [],
        columns: [
          { key: "prompt_id", label: "ID" },
          { key: "role",      label: "Role" },
          { key: "content",   label: "Content" },
          { key: "ts",        label: "Timestamp" },
        ] },
      { title: "Task History", rows: logs.task_history || [],
        columns: [
          { key: "task_name",  label: "Task" },
          { key: "status",     label: "Status" },
          { key: "elapsed_ms", label: "Elapsed (ms)", className: "metric" },
        ] },
      { title: "Tool History", rows: logs.tool_history || [],
        columns: [
          { key: "tool_name",  label: "Tool" },
          { key: "calls",      label: "Calls",       className: "metric" },
          { key: "elapsed_ms", label: "Elapsed (ms)", className: "metric" },
        ] },
    ];
    blocks.forEach((b) => {
      const details = document.createElement("details");
      details.className = "log-block";
      const summary = document.createElement("summary");
      summary.textContent = `${b.title} (${b.rows.length})`;
      details.appendChild(summary);
      details.appendChild(window.SimpleTable.create(b.columns, b.rows));
      host.appendChild(details);
    });
  }

  function divFromHTML(html) { const d = document.createElement("div"); d.innerHTML = html; return d; }

  window.Views = window.Views || {};
  window.Views.agentTest = render;
})();
