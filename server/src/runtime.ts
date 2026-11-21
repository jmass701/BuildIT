import express, { type Request, type Response, type NextFunction } from "express";
import {
  type DB,
  type EntitySchema,
  type ProjectRow,
  getProject,
  getVersion,
  hashPassword,
  newId,
  newToken,
  now,
  verifyPassword,
} from "./db.ts";

/**
 * Public API used by generated apps through the BuildIt SDK:
 *   /api/apps/:appId/entities/:entity[/:id]
 *   /api/apps/:appId/auth/{register,login,me,logout}
 * Requests come from sandboxed (opaque-origin) pages, so it uses bearer tokens and open CORS, never cookies.
 */

const SYSTEM_FIELDS = new Set(["id", "created_at", "updated_at", "created_by"]);
const MAX_LIMIT = 1000;
const APP_SESSION_DAYS = 30;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface RecordRow {
  id: string;
  data: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: RecordRow) => ({
  id: r.id,
  ...JSON.parse(r.data),
  created_at: r.created_at,
  updated_at: r.updated_at,
  created_by: r.created_by,
});

/** Entities declared by the current (preview) version and the live deployment. */
export function projectEntities(db: DB, project: ProjectRow): EntitySchema[] {
  const out = new Map<string, EntitySchema>();
  const deployed = db
    .prepare("SELECT version_id FROM deployments WHERE project_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1")
    .get(project.id) as { version_id: string } | undefined;
  for (const v of [getVersion(db, deployed?.version_id ?? null), getVersion(db, project.current_version_id)]) {
    for (const e of v?.entities ?? []) out.set(e.name, e); // current version wins
  }
  return [...out.values()];
}

export function validateData(schema: EntitySchema, input: unknown, partial: boolean): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Body must be a JSON object");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    const field = schema.fields[key];
    if (!field) throw new HttpError(400, `Unknown field "${key}" on ${schema.name}`);
    if (value === null || value === undefined || value === "") {
      if (field.required) throw new HttpError(400, `${schema.name}.${key} is required`);
      out[key] = null;
      continue;
    }
    const bad = () => new HttpError(400, `${schema.name}.${key} must be a ${field.type}`);
    switch (field.type) {
      case "string":
        if (typeof value !== "string") throw bad();
        if (field.enum && !field.enum.includes(value))
          throw new HttpError(400, `${schema.name}.${key} must be one of: ${field.enum.join(", ")}`);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
        break;
      case "boolean":
        if (typeof value !== "boolean") throw bad();
        break;
      case "date":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw bad();
        break;
      case "json":
        break;
    }
    out[key] = value;
  }
  if (!partial) {
    for (const [key, field] of Object.entries(schema.fields)) {
      if (field.required && (out[key] === undefined || out[key] === null))
        throw new HttpError(400, `${schema.name}.${key} is required`);
    }
  }
  return out;
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sqlField(field: string) {
  if (!FIELD_RE.test(field)) throw new HttpError(400, `Invalid field name "${field}"`);
  return SYSTEM_FIELDS.has(field) ? field : `json_extract(data, '$.${field}')`;
}

function sqlValue(v: unknown): string | number | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  throw new HttpError(400, "Filter values must be strings, numbers, booleans or null");
}

export function listRecords(
  db: DB,
  projectId: string,
  entity: string,
  opts: { where?: Record<string, unknown>; sort?: string; limit?: number; offset?: number },
) {
  const clauses = ["project_id = ?", "entity = ?"];
  const params: (string | number | null)[] = [projectId, entity];
  for (const [k, v] of Object.entries(opts.where ?? {})) {
    const col = sqlField(k);
    if (v === null) clauses.push(`${col} IS NULL`);
    else {
      clauses.push(`${col} = ?`);
      params.push(sqlValue(v));
    }
  }
  let order = "created_at DESC";
  if (opts.sort) {
    const desc = opts.sort.startsWith("-");
    order = `${sqlField(desc ? opts.sort.slice(1) : opts.sort)} ${desc ? "DESC" : "ASC"}, created_at DESC`;
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), MAX_LIMIT);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const rows = db
    .prepare(`SELECT * FROM records WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as RecordRow[];
  return rows.map(toRecord);
}

interface AppUserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  created_at: string;
}
/** The signed-in end user of a generated app, from its bearer token. */
export function appUserFromRequest(db: DB, req: Request, projectId: string): AppUserRow | null {
  const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
  if (!m) return null;
  return (
    (db
      .prepare(
        `SELECT u.* FROM app_sessions s JOIN app_users u ON u.id = s.app_user_id
         WHERE s.token = ? AND s.project_id = ? AND s.expires_at > ?`,
      )
      .get(m[1], projectId, now()) as AppUserRow | undefined) ?? null
  );
}

const publicUser = (u: AppUserRow) => ({ id: u.id, email: u.email, name: u.name, created_at: u.created_at });

export function runtimeRouter(db: DB) {
  const router = express.Router({ mergeParams: true });

  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  const loadProject = (req: Request): ProjectRow => {
    const project = getProject(db, String(req.params.appId));
    if (!project) throw new HttpError(404, "App not found");
    return project;
  };

  const appUser = (req: Request, projectId: string) => appUserFromRequest(db, req, projectId);

  const startSession = (userId: string, projectId: string) => {
    const token = newToken();
    const expires = new Date(Date.now() + APP_SESSION_DAYS * 86400_000).toISOString();
    db.prepare("INSERT INTO app_sessions (token, app_user_id, project_id, expires_at) VALUES (?, ?, ?, ?)").run(
      token,
      userId,
      projectId,
      expires,
    );
    return token;
  };

  const schemaFor = (project: ProjectRow, name: string) => {
    const schema = projectEntities(db, project).find((e) => e.name === name);
    if (!schema) throw new HttpError(404, `Entity "${name}" is not defined in this app`);
    return schema;
  };

  const getRecord = (projectId: string, entity: string, id: string) => {
    const row = db
      .prepare("SELECT * FROM records WHERE id = ? AND project_id = ? AND entity = ?")
      .get(id, projectId, entity) as RecordRow | undefined;
    if (!row) throw new HttpError(404, `${entity} ${id} not found`);
    return row;
  };

  // ---- entities ----
  router.get("/entities/:entity", (req, res) => {
    const project = loadProject(req);
    const entity = String(req.params.entity);
    schemaFor(project, entity);
    let where: Record<string, unknown> | undefined;
    if (typeof req.query.where === "string") {
      try {
        where = JSON.parse(req.query.where);
      } catch {
        throw new HttpError(400, "where must be JSON");
      }
      if (!where || typeof where !== "object" || Array.isArray(where)) throw new HttpError(400, "where must be an object");
    }
    res.json(
      listRecords(db, project.id, entity, {
        where,
        sort: typeof req.query.sort === "string" ? req.query.sort : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }),
    );
  });

  router.get("/entities/:entity/:id", (req, res) => {
    const project = loadProject(req);
    const entity = String(req.params.entity);
    schemaFor(project, entity);
    res.json(toRecord(getRecord(project.id, entity, String(req.params.id))));
  });

  router.post("/entities/:entity", (req, res) => {
    const project = loadProject(req);
    const entity = String(req.params.entity);
    const data = validateData(schemaFor(project, entity), req.body, false);
    const ts = now();
    const id = newId();
    const user = appUser(req, project.id);
    db.prepare(
      "INSERT INTO records (id, project_id, entity, data, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, project.id, entity, JSON.stringify(data), user?.id ?? null, ts, ts);
    res.status(201).json(toRecord(getRecord(project.id, entity, id)));
  });

  router.patch("/entities/:entity/:id", (req, res) => {
    const project = loadProject(req);
    const entity = String(req.params.entity);
    const patch = validateData(schemaFor(project, entity), req.body, true);
    const row = getRecord(project.id, entity, String(req.params.id));
    const merged = { ...JSON.parse(row.data), ...patch };
    db.prepare("UPDATE records SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), now(), row.id);
    res.json(toRecord(getRecord(project.id, entity, row.id)));
  });

  router.delete("/entities/:entity/:id", (req, res) => {
    const project = loadProject(req);
    const entity = String(req.params.entity);
    const row = getRecord(project.id, entity, String(req.params.id));
    db.prepare("DELETE FROM records WHERE id = ?").run(row.id);
    res.json({ ok: true });
  });

  // ---- end-user auth ----
  router.post("/auth/register", (req, res) => {
    const project = loadProject(req);
    const { email, password, name } = req.body ?? {};
    if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "A valid email is required");
    if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
    const normalized = email.trim().toLowerCase();
    if (db.prepare("SELECT 1 FROM app_users WHERE project_id = ? AND email = ?").get(project.id, normalized))
      throw new HttpError(409, "An account with this email already exists");
    const id = newId();
    db.prepare(
      "INSERT INTO app_users (id, project_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, project.id, normalized, typeof name === "string" ? name : null, hashPassword(password), now());
    const user = db.prepare("SELECT * FROM app_users WHERE id = ?").get(id) as unknown as AppUserRow;
    res.status(201).json({ user: publicUser(user), token: startSession(id, project.id) });
  });

  router.post("/auth/login", (req, res) => {
    const project = loadProject(req);
    const { email, password } = req.body ?? {};
    const user = db
      .prepare("SELECT * FROM app_users WHERE project_id = ? AND email = ?")
      .get(project.id, String(email ?? "").trim().toLowerCase()) as AppUserRow | undefined;
    if (!user || typeof password !== "string" || !verifyPassword(password, user.password_hash))
      throw new HttpError(401, "Invalid email or password");
    res.json({ user: publicUser(user), token: startSession(user.id, project.id) });
  });

  router.get("/auth/me", (req, res) => {
    const project = loadProject(req);
    const user = appUser(req, project.id);
    if (!user) throw new HttpError(401, "Not signed in");
    res.json({ user: publicUser(user) });
  });

  router.post("/auth/logout", (req, res) => {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    if (m) db.prepare("DELETE FROM app_sessions WHERE token = ?").run(m[1]);
    res.json({ ok: true });
  });

  return router;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.parse.failed")
    return void res.status(400).json({ error: "Invalid JSON body" });
  if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.too.large")
    return void res.status(413).json({ error: "File or request is too large" });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
