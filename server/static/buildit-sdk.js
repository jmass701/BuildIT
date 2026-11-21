/* BuildIt SDK - injected into every generated app. Exposes window.BuildIt. */
(function () {
  "use strict";
  var cfg = window.__BUILDIT__ || {};
  var base = cfg.api;
  var TOKEN_KEY = "buildit_token_" + cfg.appId;
  var memoryToken = null;

  // Apps may run in a sandboxed (opaque-origin) frame where storage throws.
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || memoryToken; } catch (e) { return memoryToken; }
  }
  function setToken(t) {
    memoryToken = t;
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  async function request(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    var token = getToken();
    if (token) headers.Authorization = "Bearer " + token;
    var res = await fetch(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw new Error((data && data.error) || "Request failed (" + res.status + ")");
    return data;
  }

  function entity(name) {
    var p = "/entities/" + encodeURIComponent(name);
    function query(opts, where) {
      var q = new URLSearchParams();
      if (opts && opts.sort) q.set("sort", opts.sort);
      if (opts && opts.limit != null) q.set("limit", String(opts.limit));
      if (opts && opts.offset != null) q.set("offset", String(opts.offset));
      if (where) q.set("where", JSON.stringify(where));
      var s = q.toString();
      return s ? "?" + s : "";
    }
    return {
      list: function (opts) { return request("GET", p + query(opts)); },
      filter: function (where, opts) { return request("GET", p + query(opts, where || {})); },
      get: function (id) { return request("GET", p + "/" + encodeURIComponent(id)); },
      create: function (data) { return request("POST", p, data); },
      update: function (id, data) { return request("PATCH", p + "/" + encodeURIComponent(id), data); },
      delete: function (id) { return request("DELETE", p + "/" + encodeURIComponent(id)); },
    };
  }

  var cache = {};
  var entities = new Proxy({}, {
    get: function (_, name) {
      if (typeof name !== "string") return undefined;
      return cache[name] || (cache[name] = entity(name));
    },
  });

  var auth = {
    register: async function (input) { var r = await request("POST", "/auth/register", input); setToken(r.token); return r.user; },
    login: async function (input) { var r = await request("POST", "/auth/login", input); setToken(r.token); return r.user; },
    me: async function () {
      if (!getToken()) return null;
      try { return (await request("GET", "/auth/me")).user; } catch (e) { setToken(null); return null; }
    },
    logout: async function () {
      try { await request("POST", "/auth/logout"); } finally { setToken(null); }
    },
  };

  var files = {
    /** Uploads a File or Blob (max 10 MB). Resolves to { id, url, name, size, content_type, created_at }. */
    upload: async function (file, opts) {
      if (!file || typeof file.size !== "number") throw new Error("files.upload expects a File or Blob");
      var name = (opts && opts.name) || file.name || "file";
      var headers = { "Content-Type": file.type || "application/octet-stream" };
      var token = getToken();
      if (token) headers.Authorization = "Bearer " + token;
      var res = await fetch(base + "/files?name=" + encodeURIComponent(name), { method: "POST", headers: headers, body: file });
      var data = null;
      try { data = await res.json(); } catch (e) { /* empty body */ }
      if (!res.ok) throw new Error((data && data.error) || "Upload failed (" + res.status + ")");
      return data;
    },
    delete: function (id) { return request("DELETE", "/files/" + encodeURIComponent(id)); },
  };

  window.BuildIt = { appId: cfg.appId, mode: cfg.mode, entities: entities, auth: auth, files: files };
})();
