import { useEffect, useState, type FormEvent } from "react";
import { api, timeAgo, type ProjectSummary, type User } from "../api";
import { navigate } from "../App";
import { Empty, Logo, StatusBadge } from "../components";

const IDEAS = [
  "A CRM to track leads through stages, with notes and follow-up dates",
  "A team todo app with assignees, priorities and due dates",
  "A recipe box where I can save recipes, tag them and plan meals for the week",
  "An expense tracker with categories and a monthly summary chart",
];

export function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects).catch((e) => setError(e.message));
  }, []);

  const create = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const p = await api.createProject(prompt);
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <Logo />
        <div className="row gap">
          <span className="muted small">{user.name || user.email}</span>
          <button className="btn ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="dash">
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
              <span className="muted small">⌘/Ctrl + Enter to build</span>
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
          <h2>Your apps</h2>
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
