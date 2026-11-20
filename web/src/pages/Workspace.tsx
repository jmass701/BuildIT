import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, savedWorkspace, timeAgo, type Member, type Role, type User, type Workspace, type WorkspaceInvite } from "../api";
import { navigate } from "../App";

const ROLE_HELP: Record<Role, string> = {
  owner: "Full control, including deleting the workspace",
  admin: "Invite people, manage roles, delete apps, connect domains",
  member: "Build, edit and publish the workspace's apps",
};

export function WorkspacePage({ id, user }: { id: string; user: User }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.members(id);
      setWs(r.workspace);
      setName(r.workspace.name);
      setMembers(r.members);
      setInvites(r.invites);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !ws) return <div className="center error">{error}</div>;
  if (!ws) return <div className="center muted">Loading…</div>;

  const isAdmin = ws.role === "owner" || ws.role === "admin";

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg("");
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    act(async () => {
      await api.invite(ws.id, email, role);
      setEmail("");
    }, `Invited ${email}. They'll see the invitation when they sign in with that email.`);
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="row gap">
          <button className="btn ghost" onClick={() => navigate("/")}>
            ← Apps
          </button>
          <strong className="title">{ws.name}</strong>
          <span className="badge">{ws.role}</span>
        </div>
        <span className="muted small">
          {ws.memberCount} member{ws.memberCount === 1 ? "" : "s"} · {ws.projectCount} app{ws.projectCount === 1 ? "" : "s"}
        </span>
      </header>

      <main className="dash narrow">
        {msg && <p className="notice small rounded">{msg}</p>}

        {isAdmin && (
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api.renameWorkspace(ws.id, name), "Saved");
            }}
          >
            <h3>Workspace name</h3>
            <div className="row gap">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Workspace name" />
              <button className="btn primary small" disabled={!name.trim() || name === ws.name}>
                Save
              </button>
            </div>
          </form>
        )}

        {isAdmin && (
          <form className="card stack" onSubmit={invite}>
            <h3>Invite people</h3>
            <div className="row gap wrap">
              <input
                type="email"
                required
                placeholder="teammate@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label="Email"
              />
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role" className="fit">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button className="btn primary small" disabled={!email}>
                Send invite
              </button>
            </div>
            <p className="muted small">{ROLE_HELP[role]}.</p>
          </form>
        )}

        <section className="card stack">
          <h3>Members</h3>
          <table>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.name || m.email}</strong>
                    {m.id === user.id && <span className="muted"> (you)</span>}
                    {m.name && <div className="muted small">{m.email}</div>}
                  </td>
                  <td className="fit-col">
                    {isAdmin && m.role !== "owner" ? (
                      <select
                        aria-label={`Role for ${m.email}`}
                        value={m.role}
                        onChange={(e) => act(() => api.setRole(ws.id, m.id, e.target.value as Role))}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className="badge" title={ROLE_HELP[m.role]}>
                        {m.role}
                      </span>
                    )}
                  </td>
                  <td className="fit-col muted small">joined {timeAgo(m.joinedAt)}</td>
                  <td className="fit-col">
                    {m.role !== "owner" && (isAdmin || m.id === user.id) && (
                      <button
                        className="btn ghost small danger"
                        onClick={() => {
                          const self = m.id === user.id;
                          if (!confirm(self ? `Leave ${ws.name}?` : `Remove ${m.email} from ${ws.name}?`)) return;
                          act(async () => {
                            await api.removeMember(ws.id, m.id);
                            if (self) navigate("/");
                          });
                        }}
                      >
                        {m.id === user.id ? "Leave" : "Remove"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {isAdmin && invites.length > 0 && (
          <section className="card stack">
            <h3>Pending invitations</h3>
            <table>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td className="fit-col">
                      <span className="badge">{i.role}</span>
                    </td>
                    <td className="fit-col muted small">sent {timeAgo(i.createdAt)}</td>
                    <td className="fit-col">
                      <button className="btn ghost small danger" onClick={() => act(() => api.revokeInvite(ws.id, i.id))}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {ws.role === "owner" && (
          <section className="card stack">
            <h3>Danger zone</h3>
            <p className="muted small">
              Deleting a workspace removes its member list. Move or delete its apps first (Settings tab of each app).
            </p>
            <div>
              <button
                className="btn small danger-solid"
                onClick={() => {
                  if (prompt(`Type "${ws.name}" to delete this workspace`) !== ws.name) return;
                  act(async () => {
                    await api.deleteWorkspace(ws.id);
                    savedWorkspace.set("");
                    navigate("/");
                  });
                }}
              >
                Delete workspace
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
