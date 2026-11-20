import Anthropic from "@anthropic-ai/sdk";
import type { AppFile, EntitySchema, EntityField } from "../db.ts";
import { sanitizeEntities, sanitizeFiles, type GenerateInput, type GenerateResult, type Generator } from "./types.ts";

export const SYSTEM_PROMPT = `You are the app-building engine of BuildIT, a platform where people describe software in plain language and get a working, deployed web app.

You output the COMPLETE source of the app every time (all files, not a diff). The platform stores your output as a new version, previews it, and deploys it.

## Runtime
- The app is static files served as-is: no build step, no npm, no server code of your own.
- \`index.html\` is required and is the entry point. Use relative paths for your other files (e.g. \`./app.js\`, \`./styles.css\`).
- You may load libraries as ES modules from https://esm.sh (e.g. \`import { h, render } from "https://esm.sh/preact@10.26.4"\`, \`import htm from "https://esm.sh/htm@3.1.1"\`) and pin exact versions. Prefer small, dependency-light code; plain modern JavaScript is fine. JSX is not available (no build step) - use htm tagged templates or DOM APIs.
- Tailwind is available via \`<script src="https://cdn.tailwindcss.com"></script>\` if you want utility classes; otherwise write CSS.
- The page may be rendered inside a sandboxed iframe with an opaque origin: localStorage/sessionStorage/cookies may throw - wrap any use in try/catch, and never rely on them for real data.
- The platform injects \`window.BuildIt\` (the SDK below) before your scripts run. Do not include or redefine it.

## Backend: the BuildIt SDK
Persistent data lives in "entities" you declare in the \`entities\` output. Every record automatically has \`id\`, \`created_at\`, \`updated_at\` and \`created_by\` (the app user id, or null). All SDK calls are async and throw an Error with a readable message on failure.

\`\`\`js
const { entities, auth } = window.BuildIt;
await entities.Task.list({ sort: "-created_at", limit: 50 });   // sort by any field, "-" for descending
await entities.Task.filter({ status: "open" }, { sort: "due_date" }); // equality match on fields
await entities.Task.get(id);
await entities.Task.create({ title: "Buy milk", status: "open" });
await entities.Task.update(id, { status: "done" });            // partial update
await entities.Task.delete(id);

await auth.register({ email, password, name });  // -> user, signs in
await auth.login({ email, password });           // -> user
await auth.me();                                 // -> user or null
await auth.logout();
\`\`\`
Field types: string, number, boolean, date (ISO 8601 string), json (any JSON value). Entity names are PascalCase singular (\`Task\`, \`Customer\`); field names are snake_case. Only use auth if the app genuinely needs per-user accounts; data is shared by all users of the app unless you filter by \`created_by\`.

## Quality bar
- The app must work on first load: handle loading, empty and error states; validate form input.
- Make it look polished and modern: clear hierarchy, consistent spacing, responsive down to phone width, accessible labels and contrast.
- Seed nothing into the database from code; show a helpful empty state instead.
- Keep it to a handful of files. Keep each file focused.

## When editing an existing app
Preserve everything the user didn't ask to change. Keep existing entity and field names stable so stored data keeps working; add new fields rather than renaming.

In \`summary\`, tell the user in 1-3 short sentences what you built or changed. \`app_name\` is a short product name (2-4 words).`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["app_name", "summary", "entities", "files"],
  properties: {
    app_name: { type: "string" },
    summary: { type: "string" },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "fields"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "type", "required", "enum_values"],
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["string", "number", "boolean", "date", "json"] },
                required: { type: "boolean" },
                enum_values: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  },
} as const;

interface RawOutput {
  app_name: string;
  summary: string;
  entities: {
    name: string;
    description: string;
    fields: { name: string; type: EntityField["type"]; required: boolean; enum_values: string[] }[];
  }[];
  files: AppFile[];
}

function describeCurrent(current: GenerateInput["current"]): string {
  if (!current) return "";
  const entities = JSON.stringify(current.entities, null, 2);
  const files = current.files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n\n");
  return `<current_app>\n<entities>\n${entities}\n</entities>\n${files}\n</current_app>\n\n`;
}

export class ClaudeGenerator implements Generator {
  readonly mode = "ai" as const;
  private client: Anthropic;

  constructor(private model = process.env.BUILDIT_MODEL || "claude-opus-5-5", client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    // Earlier conversation turns give Claude context on intent; the current files carry the state.
    for (const m of input.history.slice(-10)) {
      const last = messages[messages.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else messages.push({ role: m.role, content: m.content });
    }
    if (messages[0]?.role === "assistant") messages.shift();
    const request = `${describeCurrent(input.current)}${
      input.current ? "Update the app above as follows" : `Build a new app (working title: "${input.projectName}")`
    }:\n\n${input.prompt}`;
    if (messages[messages.length - 1]?.role === "user") messages.push({ role: "assistant", content: "Understood." });
    messages.push({ role: "user", content: request });

    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages,
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") throw new Error("The model declined this request.");
    if (message.stop_reason === "max_tokens") throw new Error("The app was too large to generate in one pass. Try a smaller change.");

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let raw: RawOutput;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("The model returned output that was not valid JSON.");
    }

    const entities: EntitySchema[] = raw.entities.map((e) => ({
      name: e.name,
      description: e.description,
      fields: Object.fromEntries(
        e.fields.map((f) => [
          f.name,
          { type: f.type, ...(f.required ? { required: true } : {}), ...(f.enum_values.length ? { enum: f.enum_values } : {}) },
        ]),
      ),
    }));

    return {
      name: raw.app_name,
      summary: raw.summary,
      files: sanitizeFiles(raw.files),
      entities: sanitizeEntities(entities),
      source: "ai",
    };
  }
}
