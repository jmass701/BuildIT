import express, { type Request, type Response, type NextFunction } from "express";
import {
  type AppFile,
  type DB,
  type EntitySchema,
  type ProjectRow,
  type VersionRow,
  addMessage,
  createVersion,
  getProject,
  getVersion,
  hashPassword,
  newId,
  newToken,
  now,
  uniqueSlug,
  verifyPassword,
} from "./db.ts";
import { HttpError, listRecords, projectEntities } from "./runtime.ts";
import { type Generator, sanitizeEntities, sanitizeFiles } from "./generator/index.ts";
import { versionUrl } from "./hosting.ts";

const COOKIE = "bi_session";
const SESSION_DAYS = 14;

interface User {
  id: string;
  email: string;
  name: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export interface BuilderOptions {
  generator: Generator;
  publicUrl: string;
  appsDomain?: string;
  secureCookies: boolean;
}

export function builderRouter(db: DB, opts: BuilderOptions) {
  const router = express.Router();

  // ---------------- auth ----------------
  router.use((req, _res, next) => {
    const token = req.cookies?.[COOKIE];
    if (token) {
      const user = db
        .prepare(
          "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
        )
        .get(token, now()) as User | undefined;
      if (user) req.user = { ...user };
    }
    next();
  });

  const startSession = (res: Response, userId: string) => {
    const token = newToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expires.toISOString());
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: opts.secureCookies, expires, path: "/" });
  };

  router.post("/auth/register", (req, res) => {
    const { email, password, name } = req.body ?? {};
    if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "A valid email is required");
    if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
    const normalized = email.trim().toLowerCase();
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(normalized))
      throw new HttpError(409, "An account with this email already exists");
    const id = newId();
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      normalized,
      typeof name === "string" && name.trim() ? name.trim() : null,
      hashPassword(password),
      now(),
    );
    startSession(res, id);
    res.status(201).json({ user: { id, email: normalized, name: name ?? null } });
  });

  router.post("/auth/login", (req, res) => {
    const { email, password } = req.body ?? {};
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email ?? "").trim().toLowerCase()) as
      | (User & { password_hash: string })
      | undefined;
    if (!row || typeof password !== "string" || !verifyPassword(password, row.password_hash))
      throw new HttpError(401, "Invalid email or password");
    startSession(res, row.id);
    res.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  router.post("/auth/logout", (req, res) => {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  router.get("/auth/me", (req, res) => {
    res.json({ user: req.user ?? null });
  });

  router.get("/config", (_req, res) => {
    res.json({ generatorMode: opts.generator.mode, appsDomain: opts.appsDomain ?? null });
  });

  // ---------------- projects ----------------
  const requireUser = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, "Sign in required");
    next();
  };

  const ownProject = (req: Request): ProjectRow => {
    const project = getProject(db, String(req.params.id));
    if (!project || project.owner_id !== req.user!.id) throw new HttpError(404, "Project not found");
    return project;
  };

  const activeDeployment = (projectId: string) =>
    db
      .prepare(
        `SELECT d.id, d.version_id, d.created_at, v.number AS version_number
         FROM deployments d JOIN versions v ON v.id = d.version_id
         WHERE d.project_id = ? AND d.active = 1 ORDER BY d.created_at DESC LIMIT 1`,
      )
      .get(projectId) as { id: string; version_id: string; created_at: string; version_number: number } | undefined;

  const summarize = (p: ProjectRow) => {
    const version = p.current_version_id
      ? (db.prepare("SELECT number FROM versions WHERE id = ?").get(p.current_version_id) as { number: number } | undefined)
      : undefined;
    const live = activeDeployment(p.id);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      status: p.status,
      statusDetail: p.status_detail,
      versionNumber: version?.number ?? null,
      previewUrl: `/preview/${p.id}/`,
      liveUrl: live ? versionUrl(opts.publicUrl, opts.appsDomain, p.slug) : null,
      liveVersionNumber: live?.version_number ?? null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  };

  /** Runs generation in the background; the client polls the project status. */
  const runGeneration = (projectId: string, prompt: string, adoptName = false) => {
    const project = getProject(db, projectId)!;
    const current = getVersion(db, project.current_version_id);
    const history = (
      db
        .prepare("SELECT role, content FROM messages WHERE project_id = ? AND role IN ('user','assistant') ORDER BY created_at, rowid")
        .all(projectId) as { role: "user" | "assistant"; content: string }[]
    ).slice(0, -1); // the newest message is `prompt` itself
    db.prepare("UPDATE projects SET status = 'generating', status_detail = NULL, updated_at = ? WHERE id = ?").run(now(), projectId);

    void opts.generator
      .generate({
        prompt,
        history,
        current: current ? { files: current.files, entities: current.entities } : null,
        projectName: project.name,
      })
      .then((result) => {
        if (!getProject(db, projectId)) return; // deleted meanwhile
        const version = createVersion(db, projectId, {
          files: result.files,
          entities: result.entities,
          summary: result.summary,
          source: result.source,
        });
        addMessage(db, projectId, "assistant", result.summary, version.id);
        // First build: adopt the generator's product name and a matching URL slug.
        const latest = getProject(db, projectId)!;
        const firstBuild = adoptName && !current && result.name && latest.name === project.name;
        const name = firstBuild ? result.name!.slice(0, 80) : latest.name;
        const slug = firstBuild && latest.slug === project.slug ? uniqueSlug(db, name) : latest.slug;
        db.prepare("UPDATE projects SET status = 'idle', name = ?, slug = ?, updated_at = ? WHERE id = ?").run(name, slug, now(), projectId);
      })
      .catch((err: unknown) => {
        console.error(`generation failed for ${projectId}:`, err);
        if (!getProject(db, projectId)) return;
        const message = err instanceof Error ? err.message : String(err);
        addMessage(db, projectId, "system", `Generation failed: ${message}`);
        db.prepare("UPDATE projects SET status = 'error', status_detail = ?, updated_at = ? WHERE id = ?").run(message, now(), projectId);
      });
  };

  router.get("/projects", requireUser, (req, res) => {
    const rows = db
      .prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC")
      .all(req.user!.id) as unknown as ProjectRow[];
    res.json(rows.map(summarize));
  });

  router.post("/projects", requireUser, (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) throw new HttpError(400, "Describe the app you want to build");
    if (prompt.length > 20_000) throw new HttpError(400, "Prompt is too long");
    const explicitName = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : null;
    const name = explicitName ?? prompt.split(/\s+/).slice(0, 5).join(" ").slice(0, 60);
    const id = newId();
    const ts = now();
    db.prepare(
      "INSERT INTO projects (id, owner_id, name, slug, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)",
    ).run(id, req.user!.id, name, uniqueSlug(db, name), prompt.slice(0, 500), ts, ts);
    addMessage(db, id, "user", prompt);
    runGeneration(id, prompt, !explicitName);
    res.status(201).json(summarize(getProject(db, id)!));
  });

  router.get("/projects/:id", requireUser, (req, res) => {
    const project = ownProject(req);
    const version = getVersion(db, project.current_version_id);
    const messages = db
      .prepare("SELECT id, role, content, version_id, created_at FROM messages WHERE project_id = ? ORDER BY created_at, rowid")
      .all(project.id);
    res.json({
      ...summarize(project),
      generatorMode: opts.generator.mode,
      version,
      messages,
    });
  });

  router.patch("/projects/:id", requireUser, (req, res) => {
    const project = ownProject(req);
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : project.name;
    let slug = project.slug;
    if (typeof req.body?.slug === "string" && req.body.slug !== project.slug) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(req.body.slug))
        throw new HttpError(400, "Slug must be lowercase letters, numbers and dashes");
      if (db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(req.body.slug)) throw new HttpError(409, "That URL is taken");
      slug = req.body.slug;
    }
    db.prepare("UPDATE projects SET name = ?, slug = ?, updated_at = ? WHERE id = ?").run(name, slug, now(), project.id);
    res.json(summarize(getProject(db, project.id)!));
  });

  router.delete("/projects/:id", requireUser, (req, res) => {
    const project = ownProject(req);
    db.prepare("DELETE FROM app_sessions WHERE project_id = ?").run(project.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    res.json({ ok: true });
  });

  // Chat: ask the AI to change the app.
  router.post("/projects/:id/messages", requireUser, (req, res) => {
    const project = ownProject(req);
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) throw new HttpError(400, "Message is empty");
    if (project.status === "generating") throw new HttpError(409, "The app is still being generated");
    addMessage(db, project.id, "user", content);
    runGeneration(project.id, content);
    res.status(202).json(summarize(getProject(db, project.id)!));
  });

  // Manual code edits: saves a new version with the given files.
  router.put("/projects/:id/files", requireUser, (req, res) => {
    const project = ownProject(req);
    if (project.status === "generating") throw new HttpError(409, "The app is still being generated");
    const current = getVersion(db, project.current_version_id);
    const files = req.body?.files as AppFile[] | undefined;
    const entities = (req.body?.entities ?? current?.entities ?? []) as EntitySchema[];
    if (!Array.isArray(files) || files.some((f) => typeof f?.path !== "string" || typeof f?.content !== "string"))
      throw new HttpError(400, "files must be an array of {path, content}");
    let clean: AppFile[];
    let cleanEntities: EntitySchema[];
    try {
      clean = sanitizeFiles(files);
      cleanEntities = sanitizeEntities(entities);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const version = createVersion(db, project.id, {
      files: clean,
      entities: cleanEntities,
      summary: typeof req.body?.summary === "string" ? req.body.summary : "Manual edit",
      source: "manual",
    });
    res.json(version);
  });

  router.get("/projects/:id/versions", requireUser, (req, res) => {
    const project = ownProject(req);
    const rows = db
      .prepare("SELECT id, number, summary, source, created_at FROM versions WHERE project_id = ? ORDER BY number DESC")
      .all(project.id) as unknown as Pick<VersionRow, "id" | "number" | "summary" | "source" | "created_at">[];
    const live = activeDeployment(project.id);
    res.json(rows.map((r) => ({ ...r, current: r.id === project.current_version_id, live: r.id === live?.version_id })));
  });

  router.post("/projects/:id/versions/:versionId/restore", requireUser, (req, res) => {
    const project = ownProject(req);
    if (project.status === "generating") throw new HttpError(409, "The app is still being generated");
    const source = getVersion(db, String(req.params.versionId));
    const owned = source && db.prepare("SELECT 1 FROM versions WHERE id = ? AND project_id = ?").get(source.id, project.id);
    if (!source || !owned) throw new HttpError(404, "Version not found");
    const version = createVersion(db, project.id, {
      files: source.files,
      entities: source.entities,
      summary: `Restored version ${source.number}`,
      source: "restore",
    });
    addMessage(db, project.id, "system", `Restored version ${source.number} as version ${version.number}.`, version.id);
    res.json(version);
  });

  // ---------------- deployments ----------------
  router.post("/projects/:id/deploy", requireUser, (req, res) => {
    const project = ownProject(req);
    const versionId = typeof req.body?.versionId === "string" ? req.body.versionId : project.current_version_id;
    const owned = versionId && db.prepare("SELECT 1 FROM versions WHERE id = ? AND project_id = ?").get(versionId, project.id);
    if (!owned) throw new HttpError(400, "Nothing to deploy yet");
    db.prepare("UPDATE deployments SET active = 0 WHERE project_id = ?").run(project.id);
    db.prepare("INSERT INTO deployments (id, project_id, version_id, active, created_at) VALUES (?, ?, ?, 1, ?)").run(
      newId(),
      project.id,
      versionId,
      now(),
    );
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), project.id);
    res.json(summarize(getProject(db, project.id)!));
  });

  router.post("/projects/:id/unpublish", requireUser, (req, res) => {
    const project = ownProject(req);
    db.prepare("UPDATE deployments SET active = 0 WHERE project_id = ?").run(project.id);
    res.json(summarize(project));
  });

  router.get("/projects/:id/deployments", requireUser, (req, res) => {
    const project = ownProject(req);
    res.json(
      db
        .prepare(
          `SELECT d.id, d.active, d.created_at, v.number AS version_number, v.id AS version_id
           FROM deployments d JOIN versions v ON v.id = d.version_id WHERE d.project_id = ? ORDER BY d.created_at DESC`,
        )
        .all(project.id),
    );
  });

  // ---------------- data browser ----------------
  router.get("/projects/:id/data", requireUser, (req, res) => {
    const project = ownProject(req);
    const counts = new Map(
      (
        db.prepare("SELECT entity, COUNT(*) AS n FROM records WHERE project_id = ? GROUP BY entity").all(project.id) as {
          entity: string;
          n: number;
        }[]
      ).map((r) => [r.entity, r.n]),
    );
    const users = db.prepare("SELECT COUNT(*) AS n FROM app_users WHERE project_id = ?").get(project.id) as { n: number };
    res.json({
      entities: projectEntities(db, project).map((e) => ({ ...e, count: counts.get(e.name) ?? 0 })),
      userCount: users.n,
    });
  });

  router.get("/projects/:id/data/:entity", requireUser, (req, res) => {
    const project = ownProject(req);
    res.json(listRecords(db, project.id, String(req.params.entity), { limit: 500 }));
  });

  router.delete("/projects/:id/data/:entity/:recordId", requireUser, (req, res) => {
    const project = ownProject(req);
    db.prepare("DELETE FROM records WHERE id = ? AND project_id = ? AND entity = ?").run(
      String(req.params.recordId),
      project.id,
      String(req.params.entity),
    );
    res.json({ ok: true });
  });

  return router;
}
