/**
 * db_selector.js — 헤더 DB 드롭다운.
 *   - /api/databases 를 호출해 옵션 채움
 *   - status === "unavailable" 인 항목은 disabled
 *   - 선택값은 localStorage("oai.db") 에 저장
 *   - 변경 시 'db:changed' CustomEvent dispatch
 */
(function () {
  const KEY = "oai.db";
  const selectEl = document.getElementById("db-select");

  function getStored() {
    return localStorage.getItem(KEY) || "";
  }
  function setStored(name) {
    localStorage.setItem(KEY, name);
  }

  async function init() {
    // selectEl 비어있는 동안에도 api.js 가 current() 호출하므로, 우선 stored 값을 노출.
    window.DBSelector = {
      current: () => selectEl.value || getStored(),
    };

    // 직접 fetch (API 래퍼가 자기 자신을 의존하지 않도록 raw fetch)
    let dbs = [];
    try {
      const res = await fetch("/api/databases", {
        headers: { "X-Database": getStored() || "" },
      });
      dbs = await res.json();
    } catch (e) {
      console.error("Failed to load /api/databases", e);
      dbs = [];
    }

    selectEl.innerHTML = "";
    for (const db of dbs) {
      const opt = document.createElement("option");
      opt.value = db.name;
      opt.textContent = `${db.label || db.name}${db.status === "unavailable" ? " (unavailable)" : ""}`;
      if (db.status === "unavailable") opt.disabled = true;
      selectEl.appendChild(opt);
    }

    // 복원 우선순위: localStorage → 첫 번째 활성 항목
    const stored = getStored();
    const isValid = dbs.some((d) => d.name === stored && d.status !== "unavailable");
    if (isValid) {
      selectEl.value = stored;
    } else {
      const firstOk = dbs.find((d) => d.status !== "unavailable");
      if (firstOk) {
        selectEl.value = firstOk.name;
        setStored(firstOk.name);
      }
    }

    selectEl.addEventListener("change", () => {
      setStored(selectEl.value);
      window.dispatchEvent(new CustomEvent("db:changed", { detail: { name: selectEl.value } }));
    });
  }

  window.addEventListener("DOMContentLoaded", init);
})();
