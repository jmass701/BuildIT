import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { TemplateGenerator } from "../src/generator/template.ts";

/** Starts a server and returns a tiny client with its own cookie jar per "browser". */
async function start(opts: { resolveTxt?: (h: string) => Promise<string[][]>; appsDomain?: string } = {}) {
  const db = openDb(":memory:");
  const app = createApp({ db, generator: new TemplateGenerator(), publicUrl: "http://buildit.test", webDist: "/nonexistent", ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = () => {
    let cookie = "";
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const raw = body instanceof Uint8Array || typeof body === "string";
      const res = await fetch(base + path, {
        method,
        headers: { ...(raw ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
        redirect: "manual",
      });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      const buf = Buffer.from(await res.arrayBuffer());
      let json: any = null;
      try {
        json = JSON.parse(buf.toString());
      } catch {}
      return { status: res.status, json, buf, headers: res.headers };
    };
  };

  const hostGet = (host: string, path = "/") =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .get(`${base}${path}`, { headers: { Host: host } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        })
        .on("error", reject);
    });

  return { db, base, client, hostGet, close: () => server.close() };
}

async function waitIdle(call: ReturnType<Awaited<ReturnType<typeof start>>["client"]>, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call("GET", `/api/projects/${id}`);
    if (r.json.status !== "generating") return r.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("generation did not finish");
}

test("file uploads: upload, serve safely, list, delete permissions", async () => {
  const s = await start();
  try {
    const builder = s.client();
    await builder("POST", "/api/auth/register", { email: "b@x.io", password: "password1" });
    const p = await waitIdle(builder, (await builder("POST", "/api/projects", { prompt: "photo log" })).json.id);
    const rt = `/api/apps/${p.id}/files`;
    const anon = s.client();

    // Anonymous upload of an image.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const up = await anon("POST", `${rt}?name=${encodeURIComponent("../../cat pic.png")}`, png, { "Content-Type": "image/png" });
    assert.equal(up.status, 201);
    assert.equal(up.json.name, "cat pic.png", "path components stripped");
    assert.equal(up.json.size, 7);
    assert.equal(up.json.url, `${s.base}/api/apps/${p.id}/files/${up.json.id}/cat%20pic.png`);

    const got = await anon("GET", new URL(up.json.url).pathname);
    assert.equal(got.status, 200);
    assert.deepEqual([...got.buf], [...png]);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.match(got.headers.get("content-disposition")!, /^inline/);
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.match(got.headers.get("content-security-policy")!, /^sandbox/);
    assert.equal(got.headers.get("access-control-allow-origin"), "*");

    // JSON bodies arrive raw (not parsed by the JSON middleware); HTML is forced to download.
    const json = await anon("POST", `${rt}?name=data.json`, '{"a":1}', { "Content-Type": "application/json" });
    assert.equal(json.status, 201);
    assert.equal((await anon("GET", `${rt}/${json.json.id}`)).buf.toString(), '{"a":1}');
    const html = await anon("POST", `${rt}?name=x.html`, "<script>alert(1)</script>", { "Content-Type": "text/html" });
    assert.match((await anon("GET", `${rt}/${html.json.id}`)).headers.get("content-disposition")!, /^attachment/);

    assert.equal((await anon("POST", rt, new Uint8Array(0), { "Content-Type": "image/png" })).status, 400, "empty");
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    assert.equal((await anon("POST", rt, big, { "Content-Type": "application/octet-stream" })).status, 413, "too large");
    assert.equal((await anon("POST", `/api/apps/nope/files`, png, { "Content-Type": "image/png" })).status, 404);

    // Files uploaded by a signed-in app user can only be deleted by that user.
    const reg = await anon("POST", `/api/apps/${p.id}/auth/register`, { email: "u@x.io", password: "password1" });
    const bearer = { Authorization: `Bearer ${reg.json.token}` };
    const mine = await anon("POST", `${rt}?name=a.txt`, "hi", { "Content-Type": "text/plain", ...bearer });
    assert.equal(mine.json.created_by, reg.json.user.id);
    assert.equal((await anon("DELETE", `${rt}/${mine.json.id}`)).status, 403);
    assert.equal((await anon("DELETE", `${rt}/${mine.json.id}`, undefined, bearer)).status, 200);
    assert.equal((await anon("DELETE", `${rt}/${up.json.id}`)).status, 200, "anonymous uploads are deletable");

    // Builder view of the files.
    const list = await builder("GET", `/api/projects/${p.id}/files`);
    assert.deepEqual(list.json.map((f: any) => f.name).sort(), ["data.json", "x.html"]);
    const data = await builder("GET", `/api/projects/${p.id}/data`);
    assert.equal(data.json.fileCount, 2);
    assert.equal((await builder("DELETE", `/api/projects/${p.id}/files/${json.json.id}`)).status, 200);
    assert.equal((await builder("GET", `/api/projects/${p.id}/files`)).json.length, 1);
    assert.equal((await s.client()("GET", `/api/projects/${p.id}/files`)).status, 401);
  } finally {
    s.close();
  }
});

test("custom domains: add, verify via DNS TXT, serve live app on the domain", async () => {
  const txt = new Map<string, string[][]>();
  const s = await start({
    appsDomain: "apps.buildit.test",
    resolveTxt: async (h) => {
      const r = txt.get(h);
      if (!r) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return r;
    },
  });
  try {
    const owner = s.client();
    await owner("POST", "/api/auth/register", { email: "o@x.io", password: "password1" });
    const p = await waitIdle(owner, (await owner("POST", "/api/projects", { prompt: "shop", name: "Shop" })).json.id);
    const d = `/api/projects/${p.id}/domains`;

    assert.equal((await owner("GET", "/api/config")).json.domainTarget, "buildit.test");
    assert.equal((await owner("POST", d, { hostname: "not a domain" })).status, 400);
    assert.equal((await owner("POST", d, { hostname: "buildit.test" })).status, 400, "platform host reserved");
    assert.equal((await owner("POST", d, { hostname: "x.apps.buildit.test" })).status, 400, "apps domain reserved");

    const added = await owner("POST", d, { hostname: "https://Shop.Example.com/path" });
    assert.equal(added.status, 201);
    assert.equal(added.json.hostname, "shop.example.com");
    assert.equal(added.json.verified, false);
    const [cname, challenge] = added.json.dns;
    assert.deepEqual(cname, { type: "CNAME", name: "shop.example.com", value: "buildit.test" });
    assert.equal(challenge.name, "_buildit-challenge.shop.example.com");
    assert.equal((await owner("POST", d, { hostname: "shop.example.com" })).status, 409, "duplicate");

    // Not served until verified.
    await owner("POST", `/api/projects/${p.id}/deploy`, {});
    assert.notEqual((await s.hostGet("shop.example.com")).status, 200);
    assert.equal((await owner("GET", "/api/domains/check?domain=shop.example.com")).status, 404);

    // Another builder may *claim* the same hostname but can't verify it without the matching TXT record.
    const rival = s.client();
    await rival("POST", "/api/auth/register", { email: "r@x.io", password: "password1" });
    const rp = await waitIdle(rival, (await rival("POST", "/api/projects", { prompt: "rival", name: "Rival" })).json.id);
    const rivalClaim = await rival("POST", `/api/projects/${rp.id}/domains`, { hostname: "shop.example.com" });
    assert.equal(rivalClaim.status, 201);

    const verifyUrl = `${d}/${added.json.id}/verify`;
    const fail = await owner("POST", verifyUrl);
    assert.equal(fail.status, 422);
    assert.match(fail.json.error, /_buildit-challenge\.shop\.example\.com/);
    txt.set(challenge.name, [["something-else"], [challenge.value.slice(0, 10), challenge.value.slice(10)]]); // chunked TXT
    const ok = await owner("POST", verifyUrl);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.verified, true);

    // The rival's stale claim was cleared and can't be re-added.
    assert.equal((await rival("GET", `/api/projects/${rp.id}/domains`)).json.length, 0);
    assert.equal((await rival("POST", `/api/projects/${rp.id}/domains`, { hostname: "shop.example.com" })).status, 409);

    const live = await s.hostGet("shop.example.com");
    assert.equal(live.status, 200);
    assert.equal(live.headers["content-security-policy"], undefined, "own origin, unsandboxed");
    assert.match(live.body, /"mode":"production"/);
    assert.equal((await s.hostGet("shop.example.com:443", "/sdk/buildit.js")).status, 200);
    assert.equal((await owner("GET", "/api/domains/check?domain=shop.example.com")).status, 200);
    assert.equal((await owner("GET", `/api/domains/check?domain=${p.slug}.apps.buildit.test`)).status, 200);
    assert.equal((await owner("GET", "/api/domains/check?domain=evil.example.com")).status, 404);

    // Unpublished -> 404 on the domain; removing the domain stops serving it.
    await owner("POST", `/api/projects/${p.id}/unpublish`);
    assert.equal((await s.hostGet("shop.example.com")).status, 404);
    await owner("POST", `/api/projects/${p.id}/deploy`, {});
    assert.equal((await owner("DELETE", `${d}/${added.json.id}`)).status, 200);
    assert.notEqual((await s.hostGet("shop.example.com")).status, 200);
  } finally {
    s.close();
  }
});

test("team workspaces: invites, roles, shared projects, isolation", async () => {
  const s = await start();
  try {
    const alice = s.client();
    const bob = s.client();
    const carol = s.client();
    await alice("POST", "/api/auth/register", { email: "alice@x.io", password: "password1", name: "Alice" });
    await bob("POST", "/api/auth/register", { email: "bob@x.io", password: "password1", name: "Bob" });
    await carol("POST", "/api/auth/register", { email: "carol@x.io", password: "password1" });

    const personal = (await alice("GET", "/api/workspaces")).json;
    assert.deepEqual(personal.map((w: any) => [w.name, w.personal, w.role]), [["Personal", true, "owner"]]);
    assert.equal((await alice("POST", `/api/workspaces/${personal[0].id}/invites`, { email: "bob@x.io" })).status, 400);

    const team = await alice("POST", "/api/workspaces", { name: "Acme" });
    assert.equal(team.status, 201);
    const w = `/api/workspaces/${team.json.id}`;

    // Personal projects stay personal; team projects are created with workspaceId.
    const mine = await alice("POST", "/api/projects", { prompt: "private notes", name: "Private" });
    const shared = await alice("POST", "/api/projects", { prompt: "team wiki", name: "Wiki", workspaceId: team.json.id });
    assert.equal(shared.json.workspaceId, team.json.id);
    await waitIdle(alice, shared.json.id);
    await waitIdle(alice, mine.json.id);
    assert.deepEqual((await alice("GET", "/api/projects")).json.map((p: any) => p.name), ["Private"]);
    assert.deepEqual((await alice("GET", `/api/projects?workspaceId=${team.json.id}`)).json.map((p: any) => p.name), ["Wiki"]);

    // Bob can't see anything before joining.
    assert.equal((await bob("GET", `/api/projects?workspaceId=${team.json.id}`)).status, 404);
    assert.equal((await bob("GET", `/api/projects/${shared.json.id}`)).status, 404);
    assert.equal((await bob("POST", "/api/projects", { prompt: "x", workspaceId: team.json.id })).status, 404);

    // Invite Bob as member, Carol as admin.
    assert.equal((await alice("POST", `${w}/invites`, { email: "Bob@X.io" })).status, 201);
    assert.equal((await alice("POST", `${w}/invites`, { email: "bob@x.io" })).status, 409);
    assert.equal((await alice("POST", `${w}/invites`, { email: "carol@x.io", role: "owner" })).status, 400);
    await alice("POST", `${w}/invites`, { email: "carol@x.io", role: "admin" });
    assert.equal((await bob("GET", `${w}/members`)).status, 404, "invite alone grants nothing");

    const inv = (await bob("GET", "/api/invites")).json;
    assert.equal(inv.length, 1);
    assert.equal(inv[0].workspaceName, "Acme");
    assert.equal(inv[0].invitedBy, "Alice");
    assert.equal((await carol("POST", `/api/invites/${inv[0].id}/accept`)).status, 404, "can't accept someone else's invite");
    assert.equal((await bob("POST", `/api/invites/${inv[0].id}/accept`)).status, 200);
    const cInv = (await carol("GET", "/api/invites")).json[0];
    await carol("POST", `/api/invites/${cInv.id}/accept`);

    const members = (await alice("GET", `${w}/members`)).json;
    assert.deepEqual(members.members.map((m: any) => [m.email, m.role]), [
      ["alice@x.io", "owner"],
      ["carol@x.io", "admin"],
      ["bob@x.io", "member"],
    ]);
    assert.equal(members.invites.length, 0);
    assert.equal((await bob("GET", `${w}/members`)).json.invites.length, 0);

    // Members can build, edit and publish, but not delete apps, manage domains, or invite.
    const bp = `/api/projects/${shared.json.id}`;
    assert.equal((await bob("GET", bp)).json.role, "member");
    assert.equal((await bob("POST", `${bp}/deploy`, {})).status, 200);
    assert.equal((await bob("PATCH", bp, { name: "Team Wiki" })).json.name, "Team Wiki");
    assert.equal((await bob("DELETE", bp)).status, 403);
    assert.equal((await bob("POST", `${bp}/domains`, { hostname: "wiki.acme.com" })).status, 403);
    assert.equal((await bob("POST", `${w}/invites`, { email: "dave@x.io" })).status, 403);
    const bobsApp = await bob("POST", "/api/projects", { prompt: "standup bot", name: "Standup", workspaceId: team.json.id });
    assert.equal(bobsApp.status, 201);
    await waitIdle(bob, bobsApp.json.id);
    assert.equal((await alice("GET", `/api/projects/${bobsApp.json.id}`)).status, 200, "teammates see each other's apps");

    // Admins manage roles but can't touch the owner.
    const bobId = members.members.find((m: any) => m.email === "bob@x.io").id;
    const aliceId = members.members.find((m: any) => m.email === "alice@x.io").id;
    assert.equal((await carol("PATCH", `${w}/members/${bobId}`, { role: "admin" })).status, 200);
    assert.equal((await carol("PATCH", `${w}/members/${aliceId}`, { role: "member" })).status, 400);
    assert.equal((await carol("DELETE", `${w}/members/${aliceId}`)).status, 400);
    assert.equal((await bob("DELETE", bp)).status, 200, "bob is an admin now");

    // Moving an app between workspaces needs admin in the source and membership in the target.
    const carolPersonal = (await carol("GET", "/api/workspaces")).json.find((x: any) => x.personal).id;
    assert.equal((await alice("PATCH", `/api/projects/${bobsApp.json.id}`, { workspaceId: carolPersonal })).status, 404);
    const alicePersonal = personal[0].id;
    const moved = await alice("PATCH", `/api/projects/${bobsApp.json.id}`, { workspaceId: alicePersonal });
    assert.equal(moved.json.workspaceId, alicePersonal);
    assert.equal((await bob("GET", `/api/projects/${bobsApp.json.id}`)).status, 404, "bob lost access with the move");

    // Leaving and removal.
    assert.equal((await bob("DELETE", `${w}/members/${bobId}`)).status, 200, "bob leaves");
    assert.equal((await bob("GET", `/api/projects?workspaceId=${team.json.id}`)).status, 404);
    assert.equal((await alice("DELETE", `${w}/members/${aliceId}`)).status, 400, "owner can't leave");

    // Rename, delete rules.
    assert.equal((await carol("PATCH", w, { name: "Acme Inc" })).json.name, "Acme Inc");
    assert.equal((await alice("PATCH", `/api/workspaces/${alicePersonal}`, { name: "x" })).status, 400);
    assert.equal((await carol("DELETE", w)).status, 403, "only the owner deletes");
    assert.equal((await alice("DELETE", `/api/workspaces/${alicePersonal}`)).status, 400);
    assert.equal((await alice("DELETE", w)).status, 200, "empty now that its apps were moved/deleted");
    assert.equal((await carol("GET", "/api/workspaces")).json.length, 1);
  } finally {
    s.close();
  }
});

test("openDb migrates a pre-workspaces database file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildit-"));
  const file = path.join(dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE, description TEXT, status TEXT NOT NULL DEFAULT 'idle', status_detail TEXT, current_version_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO users VALUES ('u1', 'a@x.io', NULL, 'h', '2025-01-01');
    INSERT INTO projects (id, owner_id, name, slug, created_at, updated_at) VALUES ('p1', 'u1', 'Old', 'old', '2025-01-01', '2025-01-01');
  `);
  old.close();
  try {
    const db = openDb(file);
    const row = db.prepare("SELECT p.workspace_id, w.personal, m.role FROM projects p JOIN workspaces w ON w.id = p.workspace_id JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = 'u1'").get() as any;
    assert.equal(row.personal, 1);
    assert.equal(row.role, "owner");
    db.close();
    openDb(file).close(); // idempotent
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
