export interface User {
  id: string;
  email: string;
  name: string | null;
}

export type Role = "owner" | "admin" | "member";

export interface Workspace {
  id: string;
  name: string;
  personal: boolean;
  role: Role;
  memberCount: number;
  projectCount: number;
  createdAt: string;
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: string;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface MyInvite {
  id: string;
  role: Role;
  createdAt: string;
  workspaceId: string;
  workspaceName: string;
  invitedBy: string | null;
  invitedByEmail: string | null;
}

export interface Domain {
  id: string;
  hostname: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
  url: string;
  dns: { type: string; name: string; value: string }[];
}

export interface UploadedFile {
  id: string;
  name: string;
  content_type: string;
  size: number;
  created_by: string | null;
  created_at: string;
  url: string;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
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
  role: Role;
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

  projects: (workspaceId?: string) =>
    call<ProjectSummary[]>("GET", `/projects${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
  createProject: (prompt: string, workspaceId?: string) => call<ProjectSummary>("POST", "/projects", { prompt, workspaceId }),
  project: (id: string) => call<ProjectDetail>("GET", `/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; slug?: string; workspaceId?: string }) => call<ProjectSummary>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: string) => call("DELETE", `/projects/${id}`),
  sendMessage: (id: string, content: string) => call<ProjectSummary>("POST", `/projects/${id}/messages`, { content }),
  saveFiles: (id: string, files: AppFile[], entities?: EntitySchema[]) =>
    call<Version>("PUT", `/projects/${id}/files`, { files, entities }),
  versions: (id: string) => call<VersionInfo[]>("GET", `/projects/${id}/versions`),
  restore: (id: string, versionId: string) => call<Version>("POST", `/projects/${id}/versions/${versionId}/restore`),
  deploy: (id: string, versionId?: string) => call<ProjectSummary>("POST", `/projects/${id}/deploy`, { versionId }),
  unpublish: (id: string) => call<ProjectSummary>("POST", `/projects/${id}/unpublish`),
  data: (id: string) =>
    call<{ entities: (EntitySchema & { count: number })[]; userCount: number; fileCount: number; fileBytes: number }>(
      "GET",
      `/projects/${id}/data`,
    ),
  files: (id: string) => call<UploadedFile[]>("GET", `/projects/${id}/files`),
  deleteFile: (id: string, fileId: string) => call("DELETE", `/projects/${id}/files/${fileId}`),

  domains: (id: string) => call<Domain[]>("GET", `/projects/${id}/domains`),
  addDomain: (id: string, hostname: string) => call<Domain>("POST", `/projects/${id}/domains`, { hostname }),
  verifyDomain: (id: string, domainId: string) => call<Domain>("POST", `/projects/${id}/domains/${domainId}/verify`),
  removeDomain: (id: string, domainId: string) => call("DELETE", `/projects/${id}/domains/${domainId}`),

  workspaces: () => call<Workspace[]>("GET", "/workspaces"),
  createWorkspace: (name: string) => call<Workspace>("POST", "/workspaces", { name }),
  renameWorkspace: (wid: string, name: string) => call<Workspace>("PATCH", `/workspaces/${wid}`, { name }),
  deleteWorkspace: (wid: string) => call("DELETE", `/workspaces/${wid}`),
  members: (wid: string) =>
    call<{ workspace: Workspace; members: Member[]; invites: WorkspaceInvite[] }>("GET", `/workspaces/${wid}/members`),
  invite: (wid: string, email: string, role: Role) => call<WorkspaceInvite>("POST", `/workspaces/${wid}/invites`, { email, role }),
  revokeInvite: (wid: string, inviteId: string) => call("DELETE", `/workspaces/${wid}/invites/${inviteId}`),
  setRole: (wid: string, userId: string, role: Role) => call("PATCH", `/workspaces/${wid}/members/${userId}`, { role }),
  removeMember: (wid: string, userId: string) => call("DELETE", `/workspaces/${wid}/members/${userId}`),
  myInvites: () => call<MyInvite[]>("GET", "/invites"),
  acceptInvite: (inviteId: string) => call<{ workspaceId: string }>("POST", `/invites/${inviteId}/accept`),
  declineInvite: (inviteId: string) => call("POST", `/invites/${inviteId}/decline`),
  records: (id: string, entity: string) => call<DataRecord[]>("GET", `/projects/${id}/data/${entity}`),
  deleteRecord: (id: string, entity: string, recordId: string) => call("DELETE", `/projects/${id}/data/${entity}/${recordId}`),
};

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const WS_KEY = "buildit.workspace";
export const savedWorkspace = {
  get: () => {
    try {
      return localStorage.getItem(WS_KEY);
    } catch {
      return null;
    }
  },
  set: (id: string) => {
    try {
      localStorage.setItem(WS_KEY, id);
    } catch {
      /* storage unavailable */
    }
  },
};

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
