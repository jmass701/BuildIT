import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  timeAgo,
  type AppFile,
  type DataRecord,
  type EntitySchema,
  type ProjectDetail,
  type VersionInfo,
} from "../api";
import { navigate } from "../App";
import { Empty, StatusBadge } from "../components";

type Tab = "preview" | "code" | "data" | "versions" | "settings";

export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("preview");
  const [deploying, setDeploying] = useState(false);

  const load = useCallback(async () => {
    try {
      setProject(await api.project(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while the AI is building.
  useEffect(() => {
    if (project?.status !== "generating") return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [project?.status, load]);

  if (error && !project) return <div className="center error">{error}</div>;
  if (!project) return <div className="center muted">Loading…</div>;

  const deploy = async () => {
    setDeploying(true);
    try {
      await api.deploy(project.id);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDeploying(false);
    }
  };

  const liveIsCurrent = project.liveVersionNumber !== null && project.liveVersionNumber === project.version?.number;

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="row gap">
          <button className="btn ghost" onClick={() => navigate("/")} aria-label="Back to apps">
            ← Apps
          </button>
          <strong className="title">{project.name}</strong>
          <StatusBadge p={project} />
          {project.version && <span className="muted small">v{project.version.number}</span>}
        </div>
        <div className="row gap">
          {project.liveUrl && (
            <a className="btn ghost" href={project.liveUrl} target="_blank" rel="noreferrer">
              Open live ↗
            </a>
          )}
          <button
            className="btn primary"
            onClick={deploy}
            disabled={deploying || !project.version || project.status === "generating" || liveIsCurrent}
            title={liveIsCurrent ? "The latest version is already live" : undefined}
          >
            {deploying ? "Publishing…" : liveIsCurrent ? "Published" : project.liveUrl ? "Publish update" : "Publish"}
          </button>
        </div>
      </header>

      <div className="split">
        <Chat project={project} onChange={load} />
        <section className="panel">
          <nav className="tabs" role="tablist">
            {(["preview", "code", "data", "versions", "settings"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "preview" && <Preview project={project} />}
            {tab === "code" && <Code project={project} onSaved={load} />}
            {tab === "data" && <Data project={project} />}
            {tab === "versions" && <Versions project={project} onChange={load} />}
            {tab === "settings" && <Settings project={project} onChange={load} />}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------- chat ----------------

function Chat({ project, onChange }: { project: ProjectDetail; onChange: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = project.status === "generating";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [project.messages.length, busy]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setError("");
    try {
      await api.sendMessage(project.id, text);
      setText("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <aside className="chat">
      {project.generatorMode === "template" && (
        <div className="notice small">
          Template mode: set <code>ANTHROPIC_API_KEY</code> on the server to build and edit apps with Claude.
        </div>
      )}
      <div className="messages">
        {project.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && (
          <div className="msg assistant pending">
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>{" "}
            Building your app… this can take a minute or two.
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={send}>
        <textarea
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          placeholder={busy ? "Wait for the current build to finish…" : "Ask for a change: “add a search bar”, “make it dark”…"}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {error && <p className="error small">{error}</p>}
        <button className="btn primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}

// ---------------- preview ----------------

function Preview({ project }: { project: ProjectDetail }) {
  const [reload, setReload] = useState(0);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  if (!project.version) {
    return <Empty>{project.status === "generating" ? "Your first build is on its way…" : "No build yet."}</Empty>;
  }
  return (
    <div className="preview">
      <div className="row between toolbar">
        <code className="small muted url">{location.origin + project.previewUrl}</code>
        <div className="row gap">
          <button className="btn ghost small" onClick={() => setDevice(device === "desktop" ? "mobile" : "desktop")}>
            {device === "desktop" ? "📱 Mobile" : "🖥 Desktop"}
          </button>
          <button className="btn ghost small" onClick={() => setReload((n) => n + 1)}>
            ↻ Reload
          </button>
          <a className="btn ghost small" href={project.previewUrl} target="_blank" rel="noreferrer">
            Open ↗
          </a>
        </div>
      </div>
      <div className={`frame-wrap ${device}`}>
        <iframe
          key={`${project.version.id}-${reload}`}
          title="App preview"
          src={project.previewUrl}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        />
      </div>
    </div>
  );
}

// ---------------- code ----------------

function Code({ project, onSaved }: { project: ProjectDetail; onSaved: () => void }) {
  const original = project.version;
  const [files, setFiles] = useState<AppFile[]>(original?.files ?? []);
  const [schema, setSchema] = useState(JSON.stringify(original?.entities ?? [], null, 2));
  const [active, setActive] = useState<string>("index.html");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setFiles(original?.files ?? []);
    setSchema(JSON.stringify(original?.entities ?? [], null, 2));
  }, [original?.id]);

  if (!original) return <Empty>No code yet.</Empty>;

  const SCHEMA = "⚙ entities.json";
  const dirty =
    JSON.stringify(files) !== JSON.stringify(original.files) || schema !== JSON.stringify(original.entities, null, 2);
  const current = active === SCHEMA ? null : files.find((f) => f.path === active);

  const save = async () => {
    setError("");
    let entities: EntitySchema[];
    try {
      entities = JSON.parse(schema);
    } catch {
      setError("entities.json is not valid JSON");
      return;
    }
    setSaving(true);
    try {
      await api.saveFiles(project.id, files, entities);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addFile = () => {
    const name = prompt("File path (e.g. components/list.js)");
    if (!name || files.some((f) => f.path === name)) return;
    setFiles([...files, { path: name, content: "" }]);
    setActive(name);
  };

  return (
    <div className="code">
      <div className="file-list">
        {files.map((f) => (
          <button key={f.path} className={active === f.path ? "on" : ""} onClick={() => setActive(f.path)}>
            {f.path}
          </button>
        ))}
        <button className={active === SCHEMA ? "on" : ""} onClick={() => setActive(SCHEMA)}>
          {SCHEMA}
        </button>
        <button className="muted" onClick={addFile}>
          + New file
        </button>
      </div>
      <div className="editor">
        <textarea
          spellCheck={false}
          value={active === SCHEMA ? schema : current?.content ?? ""}
          onChange={(e) =>
            active === SCHEMA
              ? setSchema(e.target.value)
              : setFiles(files.map((f) => (f.path === active ? { ...f, content: e.target.value } : f)))
          }
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              if (dirty) save();
            }
          }}
        />
        <div className="row between toolbar">
          <span className="error small">{error}</span>
          <div className="row gap">
            {active !== SCHEMA && active !== "index.html" && (
              <button
                className="btn ghost small danger"
                onClick={() => {
                  setFiles(files.filter((f) => f.path !== active));
                  setActive("index.html");
                }}
              >
                Delete file
              </button>
            )}
            <button
              className="btn ghost small"
              disabled={!dirty}
              onClick={() => {
                setFiles(original.files);
                setSchema(JSON.stringify(original.entities, null, 2));
              }}
            >
              Discard
            </button>
            <button className="btn primary small" disabled={!dirty || saving || project.status === "generating"} onClick={save}>
              {saving ? "Saving…" : "Save as new version"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- data ----------------

function Data({ project }: { project: ProjectDetail }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.data>> | null>(null);
  const [entity, setEntity] = useState<string | null>(null);
  const [rows, setRows] = useState<DataRecord[] | null>(null);

  useEffect(() => {
    api.data(project.id).then((d) => {
      setInfo(d);
      setEntity((cur) => cur ?? d.entities[0]?.name ?? null);
    });
  }, [project.id, project.version?.id]);

  const loadRows = useCallback(() => {
    if (!entity) return;
    setRows(null);
    api.records(project.id, entity).then(setRows);
  }, [project.id, entity]);

  useEffect(loadRows, [loadRows]);

  if (!info) return <p className="muted pad">Loading…</p>;
  if (!info.entities.length) return <Empty>This app doesn't store any data yet.</Empty>;

  const schema = info.entities.find((e) => e.name === entity);
  const cols = schema ? Object.keys(schema.fields) : [];

  return (
    <div className="data">
      <div className="file-list">
        {info.entities.map((e) => (
          <button key={e.name} className={entity === e.name ? "on" : ""} onClick={() => setEntity(e.name)}>
            {e.name} <span className="muted">({e.count})</span>
          </button>
        ))}
        <p className="muted small pad">{info.userCount} app user(s)</p>
      </div>
      <div className="table-wrap">
        {schema && (
          <p className="muted small">
            {schema.description}{" "}
            {Object.entries(schema.fields)
              .map(([k, f]) => `${k}: ${f.type}${f.required ? "*" : ""}`)
              .join(" · ")}
          </p>
        )}
        {rows === null ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <Empty>No {entity} records yet. Use the app to add some.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th>created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {cols.map((c) => (
                    <td key={c}>{formatCell(r[c])}</td>
                  ))}
                  <td className="muted">{timeAgo(r.created_at)}</td>
                  <td>
                    <button
                      className="btn ghost small danger"
                      onClick={async () => {
                        if (!confirm("Delete this record?")) return;
                        await api.deleteRecord(project.id, entity!, r.id);
                        loadRows();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function formatCell(v: unknown) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  if (typeof v === "object") return <code>{JSON.stringify(v)}</code>;
  return String(v);
}

// ---------------- versions ----------------

function Versions({ project, onChange }: { project: ProjectDetail; onChange: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const load = useCallback(() => api.versions(project.id).then(setVersions), [project.id]);
  useEffect(() => {
    load();
  }, [load, project.version?.id, project.liveVersionNumber]);

  if (!versions) return <p className="muted pad">Loading…</p>;
  if (!versions.length) return <Empty>No versions yet.</Empty>;

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <ul className="versions">
      {versions.map((v) => (
        <li key={v.id} className="card">
          <div>
            <strong>v{v.number}</strong> {v.current && <span className="badge">Current</span>}{" "}
            {v.live && <span className="badge live">Live</span>}
            <p className="small">{v.summary}</p>
            <span className="muted small">
              {v.source} · {timeAgo(v.created_at)}
            </span>
          </div>
          <div className="row gap">
            {!v.current && (
              <button className="btn ghost small" onClick={() => act(() => api.restore(project.id, v.id))}>
                Restore
              </button>
            )}
            {!v.live && (
              <button className="btn ghost small" onClick={() => act(() => api.deploy(project.id, v.id))}>
                Publish this version
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------- settings ----------------

function Settings({ project, onChange }: { project: ProjectDetail; onChange: () => void }) {
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const [msg, setMsg] = useState("");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.updateProject(project.id, { name, slug });
      setMsg("Saved");
      onChange();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  return (
    <div className="settings pad">
      <form className="card stack" onSubmit={save}>
        <h3>General</h3>
        <label>
          App name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          URL slug
          <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} pattern="[a-z0-9-]+" />
        </label>
        <div className="row gap">
          <button className="btn primary small">Save</button>
          <span className="small muted">{msg}</span>
        </div>
      </form>

      <div className="card stack">
        <h3>Publishing</h3>
        {project.liveUrl ? (
          <>
            <p>
              Live at{" "}
              <a href={project.liveUrl} target="_blank" rel="noreferrer">
                {project.liveUrl}
              </a>{" "}
              (v{project.liveVersionNumber})
            </p>
            <div>
              <button
                className="btn ghost small danger"
                onClick={async () => {
                  if (!confirm("Take this app offline?")) return;
                  await api.unpublish(project.id);
                  onChange();
                }}
              >
                Unpublish
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Not published. Use “Publish” in the top bar to put the current version online.</p>
        )}
      </div>

      <div className="card stack">
        <h3>Danger zone</h3>
        <p className="muted small">Deletes the app, all versions, its data and its users. This can't be undone.</p>
        <div>
          <button
            className="btn small danger-solid"
            onClick={async () => {
              if (prompt(`Type "${project.slug}" to delete this app`) !== project.slug) return;
              await api.deleteProject(project.id);
              navigate("/");
            }}
          >
            Delete app
          </button>
        </div>
      </div>
    </div>
  );
}
