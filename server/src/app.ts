import express from "express";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "./db.ts";
import type { Generator } from "./generator/index.ts";
import { builderRouter } from "./builder.ts";
import { errorHandler, runtimeRouter } from "./runtime.ts";
import { appHost, hostingRouter } from "./hosting.ts";
import { uploadsRouter } from "./uploads.ts";
import type { TxtResolver } from "./domains.ts";

export interface AppOptions {
  db: DB;
  generator: Generator;
  publicUrl: string;
  appsDomain?: string;
  /** Directory with the built builder UI (web/dist); served when present. */
  webDist?: string;
  /** DNS TXT lookup used to verify custom domains (injectable for tests). */
  resolveTxt?: TxtResolver;
}

export function createApp(opts: AppOptions) {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(appHost(opts.db, { appsDomain: opts.appsDomain, publicUrl: opts.publicUrl }));
  // Uploads take raw bodies, so they are mounted before the JSON parser.
  app.use("/api/apps/:appId/files", uploadsRouter(opts.db));
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());

  app.use("/api/apps/:appId", runtimeRouter(opts.db));
  app.use(
    "/api",
    builderRouter(opts.db, {
      generator: opts.generator,
      publicUrl: opts.publicUrl,
      appsDomain: opts.appsDomain,
      secureCookies: opts.publicUrl.startsWith("https://"),
      resolveTxt: opts.resolveTxt,
    }),
  );
  app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found" }));
  app.use(hostingRouter(opts.db, { appsDomain: opts.appsDomain }));

  const webDist = opts.webDist ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false }));
    app.get("/{*path}", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
