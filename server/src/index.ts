import path from "node:path";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { parseSignupAllowlist } from "./builder.ts";
import { createGenerator } from "./generator/index.ts";

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, "..", "..", "data"));
const db = openDb(path.join(dataDir, "buildit.db"));

// Generations run in-process; any that were in flight when the server stopped are lost.
db.prepare("UPDATE projects SET status = 'error', status_detail = 'Generation was interrupted by a server restart' WHERE status = 'generating'").run();

const generator = createGenerator();
const allowedSignups = parseSignupAllowlist(process.env.ALLOWED_SIGNUP_EMAILS);
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const app = createApp({
  db,
  generator,
  publicUrl,
  appsDomain: process.env.APPS_DOMAIN || undefined,
  allowedSignups,
});

app.listen(port, () => {
  console.log(`BuildIT listening on http://localhost:${port}`);
  console.log(
    generator.mode === "ai"
      ? `App generation: Claude (${process.env.BUILDIT_MODEL || "claude-opus-5-5"})`
      : "App generation: template mode (set ANTHROPIC_API_KEY to generate apps with Claude)",
  );
  if (allowedSignups.length) console.log(`Sign-up restricted to: ${allowedSignups.join(", ")} (plus invited emails)`);
  else if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(publicUrl))
    console.warn("WARNING: anyone can create an account. Set ALLOWED_SIGNUP_EMAILS to restrict sign-up.");
});
