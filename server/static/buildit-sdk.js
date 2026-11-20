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

  window.BuildIt = { appId: cfg.appId, mode: cfg.mode, entities: entities, auth: auth };
})();
