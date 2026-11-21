import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, savedWorkspace, timeAgo, type MyInvite, type ProjectSummary, type User, type Workspace } from "../api";
import { navigate } from "../App";
import { Empty, Logo, StatusBadge } from "../components";

const IDEAS = [
  "A CRM to track leads through stages, with notes and follow-up dates",
  "A team todo app with assignees, priorities and due dates",
  "A recipe box where I can save recipes, tag them and plan meals for the week",
  "An expense tracker with categories and a monthly summary chart",
];

export function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [wsId, setWsId] = useState<string | null>(null);
  const [invites, setInvites] = useState<MyInvite[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadWorkspaces = useCallback(async (select?: string) => {
    const [list, mine] = await Promise.all([api.workspaces(), api.myInvites()]);
    setWorkspaces(list);
    setInvites(mine);
    const want = select ?? savedWorkspace.get();
    setWsId(list.find((w) => w.id === want)?.id ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    loadWorkspaces().catch((e) => setError(e.message));
  }, [loadWorkspaces]);

  useEffect(() => {
    if (!wsId) return;
    savedWorkspace.set(wsId);
    setProjects(null);
    api.projects(wsId).then(setProjects).catch((e) => setError(e.message));
  }, [wsId]);

  const workspace = workspaces?.find((w) => w.id === wsId);

  const create = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const p = await api.createProject(prompt, wsId ?? undefined);
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const newWorkspace = async () => {
    const name = window.prompt("Name your team workspace (e.g. your company or team)");
    if (!name?.trim()) return;
    try {
      const w = await api.createWorkspace(name);
      await loadWorkspaces(w.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const answer = async (invite: MyInvite, accept: boolean) => {
    try {
      if (accept) await api.acceptInvite(invite.id);
      else await api.declineInvite(invite.id);
      await loadWorkspaces(accept ? invite.workspaceId : wsId ?? undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="row gap">
          <Logo />
          {workspaces && (
            <div className="row gap ws-switch">
              <select
                aria-label="Workspace"
                value={wsId ?? ""}
                onChange={(e) => (e.target.value === "__new" ? newWorkspace() : setWsId(e.target.value))}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.personal ? "Personal" : w.name}
                    {w.personal ? "" : ` · ${w.memberCount} member${w.memberCount === 1 ? "" : "s"}`}
                  </option>
                ))}
                <option value="__new">+ New team workspace…</option>
              </select>
              {workspace && !workspace.personal && (
                <button className="btn ghost small" onClick={() => navigate(`/workspaces/${workspace.id}`)}>
                  Team
                </button>
              )}
            </div>
          )}
        </div>
        <div className="row gap">
          <span className="muted small hide-sm">{user.name || user.email}</span>
          <button className="btn ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="dash">
        {invites.length > 0 && (
          <section className="stack">
            {invites.map((i) => (
              <div key={i.id} className="card invite row between">
                <span>
                  <strong>{i.invitedBy || i.invitedByEmail || "Someone"}</strong> invited you to join{" "}
                  <strong>{i.workspaceName}</strong> as {i.role === "admin" ? "an admin" : "a member"}.
                </span>
                <span className="row gap">
                  <button className="btn ghost small" onClick={() => answer(i, false)}>
                    Decline
                  </button>
                  <button className="btn primary small" onClick={() => answer(i, true)}>
                    Join workspace
                  </button>
                </span>
              </div>
            ))}
          </section>
        )}

        <section className="hero">
          <h1>What do you want to build?</h1>
          <form onSubmit={create} className="prompt-box">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe your app — who it's for, what it does, what data it keeps…"
              rows={4}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) create();
              }}
            />
            <div className="row between">
              <span className="muted small">
                {workspace && !workspace.personal ? `Builds in ${workspace.name} · ` : ""}⌘/Ctrl + Enter to build
              </span>
              <button className="btn primary" disabled={busy || !prompt.trim()}>
                {busy ? "Starting…" : "Build it"}
              </button>
            </div>
          </form>
          <div className="ideas">
            {IDEAS.map((idea) => (
              <button key={idea} className="chip" onClick={() => setPrompt(idea)}>
                {idea}
              </button>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
        </section>

        <section>
          <h2>{workspace && !workspace.personal ? `${workspace.name} apps` : "Your apps"}</h2>
          {projects === null ? (
            <p className="muted">Loading…</p>
          ) : projects.length === 0 ? (
            <Empty>No apps yet. Describe one above to get started.</Empty>
          ) : (
            <div className="grid">
              {projects.map((p) => (
                <a
                  key={p.id}
                  className="card project-card"
                  href={`/projects/${p.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/projects/${p.id}`);
                  }}
                >
                  <div className="row between">
                    <strong>{p.name}</strong>
                    <StatusBadge p={p} />
                  </div>
                  <p className="muted small clamp">{p.description}</p>
                  <span className="muted small">
                    {p.versionNumber ? `v${p.versionNumber}` : "no build yet"} · updated {timeAgo(p.updatedAt)}
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
