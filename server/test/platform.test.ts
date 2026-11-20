import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import http, { type Server } from "node:http";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { TemplateGenerator } from "../src/generator/template.ts";
import { ClaudeGenerator } from "../src/generator/claude.ts";

let server: Server;
let base: string;
let cookie = "";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function waitIdle(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await api("GET", `/api/projects/${id}`);
    if (r.json.status !== "generating") return r.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("generation did not finish");
}

before(async () => {
  const db = openDb(":memory:");
  const app = createApp({ db, generator: new TemplateGenerator(), publicUrl: "http://localhost", webDist: "/nonexistent" });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test("full build -> preview -> data -> deploy loop", async () => {
  assert.equal((await api("GET", "/api/projects")).status, 401);

  const reg = await api("POST", "/api/auth/register", { email: "dev@example.com", password: "hunter2hunter2", name: "Dev" });
  assert.equal(reg.status, 201);
  assert.equal((await api("GET", "/api/auth/me")).json.user.email, "dev@example.com");

  const created = await api("POST", "/api/projects", { prompt: "A todo list for my team" });
  assert.equal(created.status, 201);
  const project = await waitIdle(created.json.id);
  assert.equal(project.status, "idle");
  assert.equal(project.version.number, 1);
  assert.deepEqual(project.version.entities.map((e: any) => e.name), ["Task"]);
  assert.equal(project.name, "Task Tracker", "adopts the generated name");
  assert.equal(project.slug, "task-tracker");
  assert.equal(project.messages.at(-1).role, "assistant");

  // Preview: redirect to trailing slash, SDK injected, sandboxed.
  assert.equal((await api("GET", `/preview/${project.id}`)).status, 301);
  const preview = await api("GET", `/preview/${project.id}/`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /window\.__BUILDIT__=/);
  assert.match(preview.text, /\/sdk\/buildit\.js/);
  assert.match(preview.headers.get("content-security-policy")!, /^sandbox allow-scripts/);
  const js = await api("GET", `/preview/${project.id}/app.js`);
  assert.match(js.headers.get("content-type")!, /javascript/);
  assert.equal((await api("GET", "/sdk/buildit.js")).status, 200);

  // Runtime data API (what the generated app calls). No builder cookie needed.
  const saved = cookie;
  cookie = "";
  const rt = `/api/apps/${project.id}`;
  const t1 = await api("POST", `${rt}/entities/Task`, { title: "Write docs", status: "todo" });
  assert.equal(t1.status, 201);
  assert.ok(t1.json.id && t1.json.created_at);
  await api("POST", `${rt}/entities/Task`, { title: "Ship it", status: "done" });
  assert.equal((await api("POST", `${rt}/entities/Task`, { status: "todo" })).status, 400, "required field");
  assert.equal((await api("POST", `${rt}/entities/Task`, { title: "x", status: "nope" })).status, 400, "enum");
  assert.equal((await api("POST", `${rt}/entities/Task`, { title: "x", bogus: 1 })).status, 400, "unknown field");
  assert.equal((await api("GET", `${rt}/entities/Nope`)).status, 404);

  const done = await api("GET", `${rt}/entities/Task?where=${encodeURIComponent(JSON.stringify({ status: "done" }))}`);
  assert.deepEqual(done.json.map((t: any) => t.title), ["Ship it"]);
  const sorted = await api("GET", `${rt}/entities/Task?sort=title`);
  assert.deepEqual(sorted.json.map((t: any) => t.title), ["Ship it", "Write docs"]);
  const upd = await api("PATCH", `${rt}/entities/Task/${t1.json.id}`, { status: "done" });
  assert.equal(upd.json.status, "done");
  assert.equal(upd.json.title, "Write docs");
  assert.equal((await api("GET", `${rt}/entities/Task?sort=title;DROP`)).status, 400, "sort injection rejected");
  const opts = await fetch(`${base}${rt}/entities/Task`, { method: "OPTIONS" });
  assert.equal(opts.headers.get("access-control-allow-origin"), "*");

  // End-user auth for generated apps.
  const appReg = await api("POST", `${rt}/auth/register`, { email: "user@example.com", password: "password123" });
  assert.equal(appReg.status, 201);
  const bearer = { Authorization: `Bearer ${appReg.json.token}` };
  assert.equal((await api("GET", `${rt}/auth/me`, undefined, bearer)).json.user.email, "user@example.com");
  const mine = await api("POST", `${rt}/entities/Task`, { title: "Mine" }, bearer);
  assert.equal(mine.json.created_by, appReg.json.user.id);
  assert.equal((await api("POST", `${rt}/auth/login`, { email: "user@example.com", password: "wrong-pass" })).status, 401);
  cookie = saved;

  // Builder data browser.
  const data = await api("GET", `/api/projects/${project.id}/data`);
  assert.equal(data.json.entities[0].count, 3);
  assert.equal(data.json.userCount, 1);

  // Not published yet.
  assert.equal((await api("GET", `/apps/${project.slug}/`)).status, 404);

  // Manual edit -> v2, deploy v2, then restore v1 and check live stays on v2 until redeploy.
  const files = project.version.files.map((f: any) =>
    f.path === "index.html" ? { ...f, content: f.content.replace("</main>", "<p>v2 marker</p></main>") } : f,
  );
  const v2 = await api("PUT", `/api/projects/${project.id}/files`, { files });
  assert.equal(v2.json.number, 2);
  assert.equal((await api("PUT", `/api/projects/${project.id}/files`, { files: [{ path: "../evil", content: "" }] })).status, 400);

  const dep = await api("POST", `/api/projects/${project.id}/deploy`, {});
  assert.equal(dep.json.liveVersionNumber, 2);
  assert.equal(dep.json.liveUrl, `http://localhost/apps/${project.slug}/`);
  const live = await api("GET", `/apps/${project.slug}/`);
  assert.equal(live.status, 200);
  assert.match(live.text, /v2 marker/);
  assert.match(live.text, /"mode":"production"/);
  assert.equal((await api("GET", `/apps/${project.slug}/some/client/route`)).status, 200, "SPA fallback");

  const restored = await api("POST", `/api/projects/${project.id}/versions/${project.version.id}/restore`);
  assert.equal(restored.json.number, 3);
  assert.doesNotMatch((await api("GET", `/preview/${project.id}/`)).text, /v2 marker/);
  assert.match((await api("GET", `/apps/${project.slug}/`)).text, /v2 marker/);
  const versions = await api("GET", `/api/projects/${project.id}/versions`);
  assert.deepEqual(versions.json.map((v: any) => [v.number, v.current, v.live]), [
    [3, true, false],
    [2, false, true],
    [1, false, false],
  ]);

  // Chat edit in template mode keeps the app and explains why.
  const chat = await api("POST", `/api/projects/${project.id}/messages`, { content: "make it blue" });
  assert.equal(chat.status, 202);
  const after = await waitIdle(project.id);
  assert.match(after.messages.at(-1).content, /template mode/);

  // Isolation: another builder can't see the project.
  const other = cookie;
  cookie = "";
  await api("POST", "/api/auth/register", { email: "other@example.com", password: "hunter2hunter2" });
  assert.equal((await api("GET", `/api/projects/${project.id}`)).status, 404);
  cookie = other;

  await api("POST", `/api/projects/${project.id}/unpublish`);
  assert.equal((await api("GET", `/apps/${project.slug}/`)).status, 404);
  assert.equal((await api("DELETE", `/api/projects/${project.id}`)).status, 200);
  assert.equal((await api("GET", `/preview/${project.id}/`)).status, 404);
});

test("subdomain hosting serves deployed apps unsandboxed", async () => {
  const db = openDb(":memory:");
  const app = createApp({
    db,
    generator: new TemplateGenerator(),
    publicUrl: "http://localhost:3000",
    appsDomain: "apps.test",
    webDist: "/nonexistent",
  });
  const s = app.listen(0);
  await new Promise((r) => s.once("listening", r));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    let c = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(b + path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: c },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get("set-cookie");
      if (sc) c = sc.split(";")[0];
      return res;
    };
    await call("POST", "/api/auth/register", { email: "a@b.co", password: "12345678" });
    const p = await (await call("POST", "/api/projects", { prompt: "recipe box", name: "Recipe Box" })).json();
    await new Promise((r) => setTimeout(r, 50));
    const dep = await (await call("POST", `/api/projects/${p.id}/deploy`, {})).json();
    assert.equal(dep.liveUrl, "http://recipe-box.apps.test/");
    // fetch() won't let us override Host, so use node:http directly.
    const get = (host: string) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        http
          .get(`${b}/`, { headers: { Host: host } }, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
          })
          .on("error", reject);
      });
    const res = await get("recipe-box.apps.test");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-security-policy"], undefined);
    assert.match(res.body, /Recipe Tracker/);
    assert.equal((await get("missing.apps.test")).status, 404);
  } finally {
    s.close();
  }
});

test("ClaudeGenerator sends a structured-output request and parses the result", async () => {
  let captured: any;
  const output = {
    app_name: "Habit Tracker",
    summary: "Built a habit tracker.",
    entities: [
      {
        name: "Habit",
        description: "A habit",
        fields: [
          { name: "title", type: "string", required: true, enum_values: [] },
          { name: "cadence", type: "string", required: false, enum_values: ["daily", "weekly"] },
        ],
      },
    ],
    files: [
      { path: "./index.html", content: "<!doctype html><html><head></head><body></body></html>" },
      { path: "app.js", content: "console.log(1)" },
    ],
  };
  const fakeClient = {
    beta: {
      messages: {
        stream: (params: any) => {
          captured = params;
          return {
            finalMessage: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(output) }] }),
          };
        },
      },
    },
  };
  const gen = new ClaudeGenerator("claude-opus-5-5", fakeClient as any);
  const result = await gen.generate({
    prompt: "add weekly habits",
    history: [
      { role: "user", content: "habit tracker" },
      { role: "assistant", content: "done" },
    ],
    current: { files: [{ path: "index.html", content: "<p>old</p>" }], entities: [] },
    projectName: "Habits",
  });
  assert.equal(captured.model, "claude-opus-5-5");
  assert.equal(captured.output_config.format.type, "json_schema");
  assert.equal(captured.messages.at(-1).role, "user");
  assert.match(captured.messages.at(-1).content, /<current_app>[\s\S]*<p>old<\/p>/);
  assert.deepEqual(result.files.map((f) => f.path), ["app.js", "index.html"]);
  assert.deepEqual(result.entities[0].fields.cadence, { type: "string", enum: ["daily", "weekly"] });
  assert.deepEqual(result.entities[0].fields.title, { type: "string", required: true });

  const bad = new ClaudeGenerator("m", {
    beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ...output, files: [{ path: "../x", content: "" }] }) }] }) }) } },
  } as any);
  await assert.rejects(bad.generate({ prompt: "x", history: [], current: null, projectName: "x" }), /Invalid file path/);
});
