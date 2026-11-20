import dns from "node:dns/promises";
import type { DB, ProjectRow } from "./db.ts";
import { newId, newToken, now } from "./db.ts";
import { HttpError } from "./runtime.ts";

/**
 * Custom domains. A builder adds e.g. "app.example.com" to a project, creates two DNS records:
 *   CNAME  app.example.com                    -> <platform host>
 *   TXT    _buildit-challenge.app.example.com -> buildit-verify=<token>
 * and clicks Verify. Once verified, requests whose Host is that domain serve the project's live
 * deployment on its own origin (unsandboxed, like APPS_DOMAIN subdomains).
 */

export type TxtResolver = (hostname: string) => Promise<string[][]>;
export const defaultResolveTxt: TxtResolver = (h) => dns.resolveTxt(h);

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const MAX_DOMAINS_PER_PROJECT = 10;

export interface DomainRow {
  id: string;
  project_id: string;
  hostname: string;
  verification_token: string;
  verified_at: string | null;
  created_at: string;
}

export const challengeName = (hostname: string) => `_buildit-challenge.${hostname}`;
export const challengeValue = (token: string) => `buildit-verify=${token}`;

export function normalizeHostname(input: unknown): string {
  let h = String(input ?? "").trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (!HOSTNAME.test(h)) throw new HttpError(400, "Enter a domain like app.example.com");
  return h;
}

/** Verified domain -> project, used by the hosting middleware on every request. */
export function projectForDomain(db: DB, hostname: string): ProjectRow | undefined {
  return db
    .prepare(
      "SELECT p.* FROM domains d JOIN projects p ON p.id = d.project_id WHERE d.hostname = ? AND d.verified_at IS NOT NULL LIMIT 1",
    )
    .get(hostname) as ProjectRow | undefined;
}

export function domainView(d: DomainRow, opts: { target: string; publicUrl: string }) {
  const proto = new URL(opts.publicUrl).protocol;
  return {
    id: d.id,
    hostname: d.hostname,
    verified: !!d.verified_at,
    verifiedAt: d.verified_at,
    createdAt: d.created_at,
    url: `${proto}//${d.hostname}/`,
    dns: [
      { type: "CNAME", name: d.hostname, value: opts.target },
      { type: "TXT", name: challengeName(d.hostname), value: challengeValue(d.verification_token) },
    ],
  };
}

export function listDomains(db: DB, projectId: string): DomainRow[] {
  return db.prepare("SELECT * FROM domains WHERE project_id = ? ORDER BY created_at").all(projectId) as unknown as DomainRow[];
}

export function addDomain(
  db: DB,
  project: ProjectRow,
  input: unknown,
  reserved: { platformHost: string; appsDomain?: string },
): DomainRow {
  const hostname = normalizeHostname(input);
  const platform = reserved.platformHost.toLowerCase();
  const apps = reserved.appsDomain?.toLowerCase().replace(/:\d+$/, "");
  if (hostname === platform || (apps && (hostname === apps || hostname.endsWith(`.${apps}`))))
    throw new HttpError(400, "That domain belongs to BuildIT itself");
  if (db.prepare("SELECT 1 FROM domains WHERE project_id = ? AND hostname = ?").get(project.id, hostname))
    throw new HttpError(409, "This domain is already added to this app");
  if (db.prepare("SELECT 1 FROM domains WHERE hostname = ? AND verified_at IS NOT NULL").get(hostname))
    throw new HttpError(409, "This domain is already connected to another app");
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM domains WHERE project_id = ?").get(project.id) as { n: number };
  if (n >= MAX_DOMAINS_PER_PROJECT) throw new HttpError(400, `An app can have at most ${MAX_DOMAINS_PER_PROJECT} domains`);
  const row: DomainRow = {
    id: newId(),
    project_id: project.id,
    hostname,
    verification_token: newToken().slice(0, 32),
    verified_at: null,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO domains (id, project_id, hostname, verification_token, verified_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
  ).run(row.id, row.project_id, row.hostname, row.verification_token, row.created_at);
  return row;
}

/** Looks up the TXT challenge; marks the domain verified when it matches. */
export async function verifyDomain(db: DB, domain: DomainRow, resolveTxt: TxtResolver): Promise<DomainRow> {
  if (domain.verified_at) return domain;
  let records: string[][] = [];
  try {
    records = await resolveTxt(challengeName(domain.hostname));
  } catch {
    records = [];
  }
  const expected = challengeValue(domain.verification_token);
  if (!records.some((chunks) => chunks.join("").trim() === expected))
    throw new HttpError(
      422,
      `Couldn't find the TXT record ${challengeName(domain.hostname)} = ${expected} yet. DNS changes can take a few minutes to appear.`,
    );
  if (db.prepare("SELECT 1 FROM domains WHERE hostname = ? AND verified_at IS NOT NULL AND id != ?").get(domain.hostname, domain.id))
    throw new HttpError(409, "This domain is already connected to another app");
  const ts = now();
  db.prepare("UPDATE domains SET verified_at = ? WHERE id = ?").run(ts, domain.id);
  // Other projects' unverified claims on this hostname are now moot.
  db.prepare("DELETE FROM domains WHERE hostname = ? AND verified_at IS NULL AND id != ?").run(domain.hostname, domain.id);
  return { ...domain, verified_at: ts };
}
