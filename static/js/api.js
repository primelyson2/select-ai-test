/**
 * api.js — fetch 래퍼. 모든 요청에 선택된 DB 를 X-Database 헤더로 자동 첨부.
 * 선택된 DB 는 window.DBSelector.current() 에서 가져온다.
 */
(function () {
  async function request(path, { method = "GET", body, headers = {} } = {}) {
    const dbName = window.DBSelector ? window.DBSelector.current() : "";
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Database": dbName || "",
        ...headers,
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(path, opts);
    let payload = null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      payload = await res.json();
    } else {
      payload = await res.text();
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  window.API = {
    get:    (path)       => request(path),
    post:   (path, body) => request(path, { method: "POST",   body }),
    put:    (path, body) => request(path, { method: "PUT",    body }),
    delete: (path)       => request(path, { method: "DELETE" }),
  };
})();
