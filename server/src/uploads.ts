import express, { type Request, type Response } from "express";
import { type DB, getProject, newId, now } from "./db.ts";
import { HttpError, appUserFromRequest } from "./runtime.ts";

/**
 * File uploads for generated apps (BuildIt.files.upload):
 *   POST   /api/apps/:appId/files?name=photo.jpg   raw request body, Content-Type = the file's type
 *   GET    /api/apps/:appId/files/:fileId[/:name]  download / embed
 *   DELETE /api/apps/:appId/files/:fileId          only the uploader (if signed in) may delete
 * Mounted ahead of the JSON body parser so any content type, including application/json, arrives raw.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_APP_BYTES = 500 * 1024 * 1024;

/** Types safe to render inline. Everything else (HTML, SVG, XML, scripts...) is forced to download. */
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain|text\/csv)$/;
const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

export interface UploadInfo {
  id: string;
  name: string;
  content_type: string;
  size: number;
  created_by: string | null;
  created_at: string;
}

export function cleanFileName(raw: unknown): string {
  const name = String(raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 200);
  return name || "file";
}

export function fileUrl(origin: string, projectId: string, f: Pick<UploadInfo, "id" | "name">) {
  return `${origin}/api/apps/${projectId}/files/${f.id}/${encodeURIComponent(f.name)}`;
}

export function listUploads(db: DB, projectId: string): UploadInfo[] {
  return db
    .prepare("SELECT id, name, content_type, size, created_by, created_at FROM uploads WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as unknown as UploadInfo[];
}

export function uploadsRouter(db: DB) {
  const router = express.Router({ mergeParams: true });
  const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;

  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  const loadProject = (req: Request) => {
    const project = getProject(db, String(req.params.appId));
    if (!project) throw new HttpError(404, "App not found");
    return project;
  };

  router.post("/", express.raw({ type: () => true, limit: MAX_FILE_BYTES }), (req, res) => {
    const project = loadProject(req);
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, "Send the file as the request body");
    const type = (req.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const contentType = CONTENT_TYPE.test(type) ? type : "application/octet-stream";
    const { used } = db.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM uploads WHERE project_id = ?").get(project.id) as {
      used: number;
    };
    if (used + data.length > MAX_APP_BYTES) throw new HttpError(413, "This app has used all of its file storage");
    const user = appUserFromRequest(db, req, project.id);
    const info: UploadInfo = {
      id: newId(),
      name: cleanFileName(req.query.name),
      content_type: contentType,
      size: data.length,
      created_by: user?.id ?? null,
      created_at: now(),
    };
    db.prepare(
      "INSERT INTO uploads (id, project_id, name, content_type, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(info.id, project.id, info.name, info.content_type, info.size, data, info.created_by, info.created_at);
    res.status(201).json({ ...info, url: fileUrl(origin(req), project.id, info) });
  });

  const serve = (req: Request, res: Response) => {
    const row = db
      .prepare("SELECT name, content_type, data FROM uploads WHERE id = ? AND project_id = ?")
      .get(String(req.params.fileId), String(req.params.appId)) as
      | { name: string; content_type: string; data: Uint8Array }
      | undefined;
    if (!row) return void res.status(404).type("text/plain").send("File not found");
    const inline = INLINE.test(row.content_type);
    res.set("Content-Type", row.content_type);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    // Even if a browser ignored Content-Disposition, uploaded content gets an opaque, script-less origin.
    res.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.set(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    );
    res.send(Buffer.from(row.data));
  };
  router.get("/:fileId", serve);
  router.get("/:fileId/:name", serve);

  router.delete("/:fileId", (req, res) => {
    const project = loadProject(req);
    const row = db.prepare("SELECT id, created_by FROM uploads WHERE id = ? AND project_id = ?").get(
      String(req.params.fileId),
      project.id,
    ) as { id: string; created_by: string | null } | undefined;
    if (!row) throw new HttpError(404, "File not found");
    if (row.created_by && appUserFromRequest(db, req, project.id)?.id !== row.created_by)
      throw new HttpError(403, "Only the user who uploaded this file can delete it");
    db.prepare("DELETE FROM uploads WHERE id = ?").run(row.id);
    res.json({ ok: true });
  });

  return router;
}
