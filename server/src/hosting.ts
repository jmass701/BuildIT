import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DB, type ProjectRow, type Version, getProject, getVersion } from "./db.ts";

const SDK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static", "buildit-sdk.js");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Generated code is untrusted. When it is served from the platform's own origin we put it in a
 * CSP sandbox (opaque origin) so it can't read the builder's session or call the builder API.
 * On a dedicated apps subdomain it already has its own origin and runs unsandboxed.
 */
const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

export function versionUrl(publicUrl: string, appsDomain: string | undefined, slug: string) {
  if (appsDomain) {
    const proto = new URL(publicUrl).protocol;
    return `${proto}//${slug}.${appsDomain}/`;
  }
  return `${publicUrl.replace(/\/$/, "")}/apps/${slug}/`;
}

function serveFile(
  req: Request,
  res: Response,
  project: ProjectRow,
  version: Version,
  filePath: string,
  opts: { mode: "preview" | "production"; sandbox: boolean },
) {
  let p = filePath.replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  let file = version.files.find((f) => f.path === p);
  // SPA fallback: extension-less paths get index.html so client-side routers work.
  if (!file && !path.extname(p)) file = version.files.find((f) => f.path === "index.html");
  if (!file) return void res.status(404).type("text/plain").send("Not found");

  const type = MIME[path.extname(file.path).toLowerCase()] ?? "application/octet-stream";
  res.set("Content-Type", type);
  res.set("Access-Control-Allow-Origin", "*"); // module scripts from an opaque origin need CORS
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", opts.mode === "preview" ? "no-store" : "public, max-age=0, must-revalidate");
  if (opts.sandbox) res.set("Content-Security-Policy", SANDBOX_CSP);

  let body = file.content;
  if (file.path.endsWith(".html")) {
    const origin = `${req.protocol}://${req.get("host")}`;
    const config = JSON.stringify({ appId: project.id, mode: opts.mode, api: `${origin}/api/apps/${project.id}` }).replace(
      /</g,
      "\\u003c",
    );
    const inject = `<script>window.__BUILDIT__=${config};</script><script src="${origin}/sdk/buildit.js"></script>`;
    body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => `${m}\n${inject}`) : inject + body;
  }
  res.send(body);
}

function activeDeployment(db: DB, projectId: string): Version | null {
  const row = db
    .prepare("SELECT version_id FROM deployments WHERE project_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1")
    .get(projectId) as { version_id: string } | undefined;
  return getVersion(db, row?.version_id ?? null);
}

const splat = (req: Request) => {
  const p = (req.params as { path?: string[] | string }).path;
  return Array.isArray(p) ? p.join("/") + (req.path.endsWith("/") && p.length ? "/" : "") : p ?? "";
};

export function hostingRouter(db: DB, opts: { appsDomain?: string }) {
  const router = express.Router();

  router.get("/sdk/buildit.js", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=300");
    res.type("text/javascript").sendFile(SDK_PATH);
  });

  // Live preview of the latest version (the project id is the capability).
  router.get("/preview/:projectId{/*path}", (req, res) => {
    const project = getProject(db, String(req.params.projectId));
    if (!project) return void res.status(404).type("text/plain").send("App not found");
    if (!req.params.path && !req.originalUrl.split("?")[0].endsWith("/"))
      return void res.redirect(301, `/preview/${project.id}/`);
    const version = getVersion(db, project.current_version_id);
    if (!version) return void res.status(404).type("text/plain").send("This app has no build yet");
    serveFile(req, res, project, version, splat(req), { mode: "preview", sandbox: true });
  });

  // Deployed apps served by path.
  router.get("/apps/:slug{/*path}", (req, res) => {
    const project = db.prepare("SELECT * FROM projects WHERE slug = ?").get(String(req.params.slug)) as ProjectRow | undefined;
    const version = project && activeDeployment(db, project.id);
    if (!project || !version) return void res.status(404).type("text/plain").send("App not found or not published");
    if (!req.params.path && !req.originalUrl.split("?")[0].endsWith("/"))
      return void res.redirect(301, `/apps/${project.slug}/`);
    serveFile(req, res, project, version, splat(req), { mode: "production", sandbox: true });
  });

  return router;
}

/** Serves deployed apps on <slug>.<appsDomain>, ahead of all other routes. */
export function subdomainHost(db: DB, appsDomain: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!appsDomain) return next();
    const host = (req.get("host") ?? "").toLowerCase();
    const suffix = `.${appsDomain.toLowerCase()}`;
    if (!host.endsWith(suffix)) return next();
    const slug = host.slice(0, -suffix.length);
    if (!slug || slug.includes(".")) return next();
    if (req.path.startsWith("/api/apps/") || req.path === "/sdk/buildit.js") return next();
    if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).end();
    const project = db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRow | undefined;
    const version = project && activeDeployment(db, project.id);
    if (!project || !version) return void res.status(404).type("text/plain").send("App not found or not published");
    serveFile(req, res, project, version, req.path, { mode: "production", sandbox: false });
  };
}
