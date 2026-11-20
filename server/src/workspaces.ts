import type { Request, RequestHandler, Router } from "express";
import { type DB, type Role, atLeast, ensurePersonalWorkspace, memberRole, newId, now } from "./db.ts";
import { HttpError } from "./runtime.ts";

/**
 * Team workspaces. Roles:
 *   owner  - everything, including deleting the workspace (exactly one per workspace)
 *   admin  - invite/remove members, change roles, rename, delete or move apps, manage domains
 *   member - build, edit and publish the workspace's apps
 * Invitations are addressed to an email; the invited user sees them after signing in with it.
 */

interface WorkspaceRow {
  id: string;
  name: string;
  personal: number;
  created_at: string;
}

const ROLES = new Set(["admin", "member"]);
const EMAIL = /^\S+@\S+\.\S+$/;

export function workspaceRoutes(router: Router, db: DB, requireUser: RequestHandler) {
  const load = (req: Request, min: Role = "member") => {
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(String(req.params.wid)) as WorkspaceRow | undefined;
    const role = ws ? memberRole(db, ws.id, req.user!.id) : null;
    if (!ws || !role) throw new HttpError(404, "Workspace not found");
    if (!atLeast(role, min)) throw new HttpError(403, `Only workspace ${min}s can do that`);
    return { ws, role };
  };

  const view = (ws: WorkspaceRow, role: Role) => {
    const { members } = db.prepare("SELECT COUNT(*) AS members FROM workspace_members WHERE workspace_id = ?").get(ws.id) as {
      members: number;
    };
    const { projects } = db.prepare("SELECT COUNT(*) AS projects FROM projects WHERE workspace_id = ?").get(ws.id) as {
      projects: number;
    };
    return { id: ws.id, name: ws.name, personal: !!ws.personal, role, memberCount: members, projectCount: projects, createdAt: ws.created_at };
  };

  router.get("/workspaces", requireUser, (req, res) => {
    ensurePersonalWorkspace(db, req.user!.id);
    const rows = db
      .prepare(
        `SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = ? ORDER BY w.personal DESC, w.name COLLATE NOCASE`,
      )
      .all(req.user!.id) as unknown as (WorkspaceRow & { role: Role })[];
    res.json(rows.map((r) => view(r, r.role)));
  });

  router.post("/workspaces", requireUser, (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    if (!name) throw new HttpError(400, "Give the workspace a name");
    const id = newId();
    const ts = now();
    db.prepare("INSERT INTO workspaces (id, name, personal, created_by, created_at) VALUES (?, ?, 0, ?, ?)").run(id, name, req.user!.id, ts);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, req.user!.id, ts);
    res.status(201).json(view(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as unknown as WorkspaceRow, "owner"));
  });

  router.patch("/workspaces/:wid", requireUser, (req, res) => {
    const { ws, role } = load(req, "admin");
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    if (!name) throw new HttpError(400, "Give the workspace a name");
    if (ws.personal) throw new HttpError(400, "Your personal workspace can't be renamed");
    db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, ws.id);
    res.json(view({ ...ws, name }, role));
  });

  router.delete("/workspaces/:wid", requireUser, (req, res) => {
    const { ws } = load(req, "owner");
    if (ws.personal) throw new HttpError(400, "Your personal workspace can't be deleted");
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?").get(ws.id) as { n: number };
    if (n) throw new HttpError(409, "Move or delete this workspace's apps first");
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
    res.json({ ok: true });
  });

  router.get("/workspaces/:wid/members", requireUser, (req, res) => {
    const { ws, role } = load(req);
    const members = db
      .prepare(
        `SELECT u.id, u.email, u.name, m.role, m.created_at AS joinedAt FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`,
      )
      .all(ws.id);
    const invites = atLeast(role, "admin")
      ? db.prepare("SELECT id, email, role, created_at AS createdAt FROM workspace_invites WHERE workspace_id = ? ORDER BY created_at").all(ws.id)
      : [];
    res.json({ workspace: view(ws, role), members, invites });
  });

  router.post("/workspaces/:wid/invites", requireUser, (req, res) => {
    const { ws } = load(req, "admin");
    if (ws.personal) throw new HttpError(400, "Create a team workspace to invite people");
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = req.body?.role ?? "member";
    if (!EMAIL.test(email)) throw new HttpError(400, "A valid email is required");
    if (!ROLES.has(role)) throw new HttpError(400, "Role must be admin or member");
    if (db.prepare("SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?").get(ws.id, email))
      throw new HttpError(409, "That person is already a member");
    if (db.prepare("SELECT 1 FROM workspace_invites WHERE workspace_id = ? AND email = ?").get(ws.id, email))
      throw new HttpError(409, "That person has already been invited");
    const id = newId();
    const ts = now();
    db.prepare("INSERT INTO workspace_invites (id, workspace_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      ws.id,
      email,
      role,
      req.user!.id,
      ts,
    );
    res.status(201).json({ id, email, role, createdAt: ts });
  });

  router.delete("/workspaces/:wid/invites/:inviteId", requireUser, (req, res) => {
    const { ws } = load(req, "admin");
    db.prepare("DELETE FROM workspace_invites WHERE id = ? AND workspace_id = ?").run(String(req.params.inviteId), ws.id);
    res.json({ ok: true });
  });

  router.patch("/workspaces/:wid/members/:userId", requireUser, (req, res) => {
    const { ws } = load(req, "admin");
    const target = memberRole(db, ws.id, String(req.params.userId));
    if (!target) throw new HttpError(404, "Member not found");
    if (target === "owner") throw new HttpError(400, "The owner's role can't be changed");
    const role = req.body?.role;
    if (!ROLES.has(role)) throw new HttpError(400, "Role must be admin or member");
    db.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").run(role, ws.id, String(req.params.userId));
    res.json({ ok: true });
  });

  // Remove a member (admins), or leave (anyone but the owner, using their own id).
  router.delete("/workspaces/:wid/members/:userId", requireUser, (req, res) => {
    const self = String(req.params.userId) === req.user!.id;
    const { ws } = load(req, self ? "member" : "admin");
    const target = memberRole(db, ws.id, String(req.params.userId));
    if (!target) throw new HttpError(404, "Member not found");
    if (target === "owner") throw new HttpError(400, self ? "The owner can't leave; delete the workspace instead" : "The owner can't be removed");
    db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(ws.id, String(req.params.userId));
    res.json({ ok: true });
  });

  // ---- the signed-in user's own invitations ----
  router.get("/invites", requireUser, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT i.id, i.role, i.created_at AS createdAt, w.id AS workspaceId, w.name AS workspaceName, u.name AS invitedBy, u.email AS invitedByEmail
           FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
           WHERE i.email = ? ORDER BY i.created_at`,
        )
        .all(req.user!.email),
    );
  });

  const myInvite = (req: Request) => {
    const invite = db.prepare("SELECT * FROM workspace_invites WHERE id = ? AND email = ?").get(String(req.params.inviteId), req.user!.email) as
      | { id: string; workspace_id: string; role: Role }
      | undefined;
    if (!invite) throw new HttpError(404, "Invitation not found");
    return invite;
  };

  router.post("/invites/:inviteId/accept", requireUser, (req, res) => {
    const invite = myInvite(req);
    if (!memberRole(db, invite.workspace_id, req.user!.id))
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(
        invite.workspace_id,
        req.user!.id,
        invite.role,
        now(),
      );
    db.prepare("DELETE FROM workspace_invites WHERE id = ?").run(invite.id);
    res.json({ workspaceId: invite.workspace_id });
  });

  router.post("/invites/:inviteId/decline", requireUser, (req, res) => {
    db.prepare("DELETE FROM workspace_invites WHERE id = ?").run(myInvite(req).id);
    res.json({ ok: true });
  });
}
