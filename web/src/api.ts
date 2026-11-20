export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: "idle" | "generating" | "error";
  statusDetail: string | null;
  versionNumber: number | null;
  previewUrl: string;
  liveUrl: string | null;
  liveVersionNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppFile {
  path: string;
  content: string;
}

export interface EntityField {
  type: string;
  required?: boolean;
  enum?: string[];
}

export interface EntitySchema {
  name: string;
  description?: string;
  fields: Record<string, EntityField>;
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

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  version_id: string | null;
  created_at: string;
}

export interface ProjectDetail extends ProjectSummary {
  generatorMode: "ai" | "template";
  version: Version | null;
  messages: Message[];
}

export interface VersionInfo {
  id: string;
  number: number;
  summary: string | null;
  source: string;
  created_at: string;
  current: boolean;
  live: boolean;
}

export type DataRecord = { id: string; created_at: string; updated_at: string; created_by: string | null } & Record<string, unknown>;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  me: () => call<{ user: User | null }>("GET", "/auth/me"),
  login: (email: string, password: string) => call<{ user: User }>("POST", "/auth/login", { email, password }),
  register: (email: string, password: string, name: string) =>
    call<{ user: User }>("POST", "/auth/register", { email, password, name }),
  logout: () => call("POST", "/auth/logout"),

  projects: () => call<ProjectSummary[]>("GET", "/projects"),
  createProject: (prompt: string) => call<ProjectSummary>("POST", "/projects", { prompt }),
  project: (id: string) => call<ProjectDetail>("GET", `/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; slug?: string }) => call<ProjectSummary>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: string) => call("DELETE", `/projects/${id}`),
  sendMessage: (id: string, content: string) => call<ProjectSummary>("POST", `/projects/${id}/messages`, { content }),
  saveFiles: (id: string, files: AppFile[], entities?: EntitySchema[]) =>
    call<Version>("PUT", `/projects/${id}/files`, { files, entities }),
  versions: (id: string) => call<VersionInfo[]>("GET", `/projects/${id}/versions`),
  restore: (id: string, versionId: string) => call<Version>("POST", `/projects/${id}/versions/${versionId}/restore`),
  deploy: (id: string, versionId?: string) => call<ProjectSummary>("POST", `/projects/${id}/deploy`, { versionId }),
  unpublish: (id: string) => call<ProjectSummary>("POST", `/projects/${id}/unpublish`),
  data: (id: string) => call<{ entities: (EntitySchema & { count: number })[]; userCount: number }>("GET", `/projects/${id}/data`),
  records: (id: string, entity: string) => call<DataRecord[]>("GET", `/projects/${id}/data/${entity}`),
  deleteRecord: (id: string, entity: string, recordId: string) => call("DELETE", `/projects/${id}/data/${entity}/${recordId}`),
};

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
