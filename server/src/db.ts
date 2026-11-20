import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type DB = DatabaseSync;

export interface AppFile {
  path: string;
  content: string;
}

export interface EntityField {
  type: "string" | "number" | "boolean" | "date" | "json";
  required?: boolean;
  description?: string;
  enum?: string[];
}

export interface EntitySchema {
  name: string;
  description?: string;
  fields: Record<string, EntityField>;
}

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    -- Team workspaces. Every user has one personal workspace; projects belong to a workspace.
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      personal INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,                       -- owner | admin | member
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members(user_id);

    CREATE TABLE IF NOT EXISTS workspace_invites (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL,                       -- admin | member
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, email)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'idle',      -- idle | generating | error
      status_detail TEXT,
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      files TEXT NOT NULL,                      -- JSON AppFile[]
      entities TEXT NOT NULL,                   -- JSON EntitySchema[]
      summary TEXT,
      source TEXT NOT NULL,                     -- ai | template | manual | restore
      created_at TEXT NOT NULL,
      UNIQUE(project_id, number)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL,                       -- user | assistant | system
      content TEXT NOT NULL,
      version_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL REFERENCES versions(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    -- Data stored by generated apps through the BuildIT SDK
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity TEXT NOT NULL,
      data TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_entity ON records(project_id, entity, created_at);

    -- End users of generated apps (separate from builder accounts)
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, email)
    );

    CREATE TABLE IF NOT EXISTS app_sessions (
      token TEXT PRIMARY KEY,
      app_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- Files uploaded by generated apps through BuildIt.files.upload()
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS uploads_project ON uploads(project_id, created_at);

    -- Custom domains pointed at a project's live deployment
    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL,
      verification_token TEXT NOT NULL,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, hostname)
    );
    CREATE INDEX IF NOT EXISTS domains_hostname ON domains(hostname);
  `);
  migrate(db);
  return db;
}

/** Upgrades databases created before workspaces existed. Safe to run on every start. */
function migrate(db: DB) {
  const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "workspace_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE");
  }
  db.exec("CREATE INDEX IF NOT EXISTS projects_workspace ON projects(workspace_id, updated_at)");
  const orphans = db.prepare("SELECT DISTINCT owner_id FROM projects WHERE workspace_id IS NULL").all() as { owner_id: string }[];
  for (const { owner_id } of orphans) {
    const ws = ensurePersonalWorkspace(db, owner_id);
    db.prepare("UPDATE projects SET workspace_id = ? WHERE owner_id = ? AND workspace_id IS NULL").run(ws, owner_id);
  }
}

// ---------- workspaces ----------

export type Role = "owner" | "admin" | "member";
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];

/** Returns the id of the user's personal workspace, creating it if needed. */
export function ensurePersonalWorkspace(db: DB, userId: string): string {
  const row = db
    .prepare(
      "SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE w.personal = 1 AND m.user_id = ? AND m.role = 'owner'",
    )
    .get(userId) as { id: string } | undefined;
  if (row) return row.id;
  const id = newId();
  const ts = now();
  db.prepare("INSERT INTO workspaces (id, name, personal, created_by, created_at) VALUES (?, 'Personal', 1, ?, ?)").run(id, userId, ts);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, userId, ts);
  return id;
}

export function memberRole(db: DB, workspaceId: string | null, userId: string): Role | null {
  if (!workspaceId) return null;
  const row = db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as
    | { role: Role }
    | undefined;
  return row?.role ?? null;
}

// ---------- password + token helpers ----------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const newToken = () => crypto.randomBytes(32).toString("base64url");

// ---------- row types ----------

export interface ProjectRow {
  id: string;
  owner_id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  status_detail: string | null;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  project_id: string;
  number: number;
  files: string;
  entities: string;
  summary: string | null;
  source: string;
  created_at: string;
}

export interface Version {
  id: string;
  number: number;
  files: AppFile[];
  entities: EntitySchema[];
  summary: string | null;
  source: string;
  created_at: string;
}

export function parseVersion(row: VersionRow): Version {
  return {
    id: row.id,
    number: row.number,
    files: JSON.parse(row.files),
    entities: JSON.parse(row.entities),
    summary: row.summary,
    source: row.source,
    created_at: row.created_at,
  };
}

export function getVersion(db: DB, id: string | null): Version | null {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM versions WHERE id = ?").get(id) as VersionRow | undefined;
  return row ? parseVersion(row) : null;
}

export function getProject(db: DB, id: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

/** Saves a new version and makes it the project's current version. */
export function createVersion(
  db: DB,
  projectId: string,
  data: { files: AppFile[]; entities: EntitySchema[]; summary?: string; source: string },
): Version {
  const { n } = db
    .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE project_id = ?")
    .get(projectId) as { n: number };
  const id = newId();
  const created = now();
  db.prepare(
    "INSERT INTO versions (id, project_id, number, files, entities, summary, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, n, JSON.stringify(data.files), JSON.stringify(data.entities), data.summary ?? null, data.source, created);
  db.prepare("UPDATE projects SET current_version_id = ?, updated_at = ? WHERE id = ?").run(id, created, projectId);
  return { id, number: n, files: data.files, entities: data.entities, summary: data.summary ?? null, source: data.source, created_at: created };
}

export function addMessage(db: DB, projectId: string, role: string, content: string, versionId?: string) {
  db.prepare("INSERT INTO messages (id, project_id, role, content, version_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId(),
    projectId,
    role,
    content,
    versionId ?? null,
    now(),
  );
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "app";
}

export function uniqueSlug(db: DB, name: string): string {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug); i++) slug = `${base}-${i}`;
  return slug;
}
