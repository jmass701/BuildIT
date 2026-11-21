import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { parseSignupAllowlist } from "../src/builder.ts";
import { TemplateGenerator } from "../src/generator/template.ts";

test("parseSignupAllowlist normalizes emails and domains", () => {
  assert.deepEqual(parseSignupAllowlist(" Ann@Acme.com, @Team.io  example.org,,"), ["ann@acme.com", "@team.io", "@example.org"]);
  assert.deepEqual(parseSignupAllowlist(undefined), []);
});

test("sign-up allowlist: listed emails, listed domains and invited people only", async () => {
  const db = openDb(":memory:");
  const app = createApp({
    db,
    generator: new TemplateGenerator(),
    publicUrl: "https://buildit.test",
    webDist: "/nonexistent",
    allowedSignups: parseSignupAllowlist("owner@acme.com, @team.io"),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const register = async (email: string, cookie = "") => {
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email, password: "password123" }),
    });
    return { status: res.status, json: await res.json(), cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
  };
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).signupRestricted, true);

    const blocked = await register("stranger@gmail.com");
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /invite-only/);
    assert.equal((await register("x@notteam.io")).status, 403, "domain match is exact");
    assert.equal((await register("x@team.io.evil.com")).status, 403);

    const owner = await register("Owner@Acme.com");
    assert.equal(owner.status, 201);
    assert.equal((await register("dev@team.io")).status, 201);

    // A workspace invitation lets someone outside the list join.
    const call = (method: string, path: string, body?: unknown) =>
      fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: owner.cookie },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json());
    const ws = await call("POST", "/api/workspaces", { name: "Acme" });
    await call("POST", `/api/workspaces/${ws.id}/invites`, { email: "friend@gmail.com" });
    assert.equal((await register("friend@gmail.com")).status, 201);
    assert.equal((await register("other@gmail.com")).status, 403);
  } finally {
    server.close();
  }
});

test("sign-up is open when no allowlist is configured", async () => {
  const app = createApp({ db: openDb(":memory:"), generator: new TemplateGenerator(), publicUrl: "http://localhost", webDist: "/nonexistent" });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).signupRestricted, false);
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "anyone@gmail.com", password: "password123" }),
    });
    assert.equal(res.status, 201);
  } finally {
    server.close();
  }
});
