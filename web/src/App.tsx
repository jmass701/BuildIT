import { useEffect, useState } from "react";
import { api, type User } from "./api";
import { AuthPage } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { ProjectPage } from "./pages/Project";
import { WorkspacePage } from "./pages/Workspace";

/** Tiny history-based router: "/", "/projects/:id" and "/workspaces/:id". */
export function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const path = usePath();

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (!user) return <AuthPage onAuth={setUser} />;

  const logout = async () => {
    await api.logout();
    setUser(null);
    navigate("/");
  };

  const m = /^\/projects\/([\w-]+)/.exec(path);
  if (m) return <ProjectPage key={m[1]} id={m[1]} />;
  const w = /^\/workspaces\/([\w-]+)/.exec(path);
  if (w) return <WorkspacePage key={w[1]} id={w[1]} user={user} />;
  return <Dashboard user={user} onLogout={logout} />;
}
