/**
 * app.js — 해시 라우터 + 메뉴 활성화 + DB 변경 시 현재 view 재렌더.
 */
(function () {
  const ROUTES = {
    objects:   { render: () => window.Views.objectMeta(),     label: "AI Profile Object Meta" },
    profiles:  { render: () => window.Views.profileTest(),    label: "AI Profile Test" },
    agents:    { render: () => window.Views.agentTest(),      label: "AI Agent Team Test" },
    databases: { render: () => window.Views.databaseAdmin(),  label: "Database 관리" },
  };
  const DEFAULT_ROUTE = "profiles";

  function currentRoute() {
    const hash = (window.location.hash || "").replace(/^#\/?/, "");
    return ROUTES[hash] ? hash : DEFAULT_ROUTE;
  }

  function setActiveNav(route) {
    document.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.route === route);
    });
  }

  async function render() {
    const route = currentRoute();
    setActiveNav(route);
    const main = document.getElementById("main");
    main.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';
    try {
      await ROUTES[route].render();
    } catch (err) {
      console.error(err);
      main.innerHTML = `<div class="empty-state">렌더링 실패: ${err.message}</div>`;
      window.Toast.show("뷰 렌더링 실패: " + err.message, "error");
    }
  }

  function init() {
    document.querySelectorAll(".nav-item").forEach((el) => {
      el.addEventListener("click", () => {
        window.location.hash = `#/${el.dataset.route}`;
      });
    });
    if (!window.location.hash) {
      window.location.hash = `#/${DEFAULT_ROUTE}`;
    }
    window.addEventListener("hashchange", render);
    window.addEventListener("db:changed", () => {
      // 현재 view 재렌더. (선택된 DB 가 모든 후속 API 호출에 자동 첨부됨)
      render();
    });

    // DBSelector init 이 끝나면 첫 렌더. 일단 가벼운 폴링.
    const waitDb = setInterval(() => {
      if (window.DBSelector && document.getElementById("db-select").options.length > 0) {
        clearInterval(waitDb);
        render();
      }
    }, 50);
    setTimeout(() => clearInterval(waitDb), 5000); // fail-safe
  }

  window.addEventListener("DOMContentLoaded", init);
})();
