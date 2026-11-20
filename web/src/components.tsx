import type { ReactNode } from "react";
import type { ProjectSummary } from "./api";

export function Logo() {
  return (
    <span className="logo">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <path d="M10 9h7a4 4 0 0 1 0 8h-7zm0 8h8a4 4 0 0 1 0 8h-8z" stroke="white" strokeWidth="2.4" fill="none" />
      </svg>
      BuildIT
    </span>
  );
}

export function StatusBadge({ p }: { p: Pick<ProjectSummary, "status" | "liveUrl"> }) {
  if (p.status === "generating") return <span className="badge busy">Building…</span>;
  if (p.status === "error") return <span className="badge err">Error</span>;
  if (p.liveUrl) return <span className="badge live">Live</span>;
  return <span className="badge">Draft</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
