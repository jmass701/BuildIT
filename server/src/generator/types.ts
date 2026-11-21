import type { AppFile, EntitySchema } from "../db.ts";

export interface GenerateInput {
  /** The latest instruction from the builder. */
  prompt: string;
  /** Earlier chat turns, oldest first (excluding `prompt`). */
  history: { role: "user" | "assistant"; content: string }[];
  /** The app as it currently stands, or null for a brand-new app. */
  current: { files: AppFile[]; entities: EntitySchema[] } | null;
  projectName: string;
}

export interface GenerateResult {
  name?: string;
  files: AppFile[];
  entities: EntitySchema[];
  summary: string;
  source: "ai" | "template";
}

export interface Generator {
  readonly mode: "ai" | "template";
  generate(input: GenerateInput): Promise<GenerateResult>;
}

const SAFE_PATH = /^[A-Za-z0-9_\-./]+$/;

/** Rejects path traversal / absolute paths and requires an index.html entry point. */
export function sanitizeFiles(files: AppFile[]): AppFile[] {
  const out = new Map<string, string>();
  for (const f of files) {
    const p = f.path.replace(/^\.?\/+/, "");
    if (!p || !SAFE_PATH.test(p) || p.split("/").some((seg) => seg === ".." || seg === "")) {
      throw new Error(`Invalid file path from generator: ${f.path}`);
    }
    out.set(p, f.content);
  }
  if (!out.has("index.html")) throw new Error("Generated app is missing index.html");
  return [...out].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
}

const ENTITY_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD_TYPES = new Set(["string", "number", "boolean", "date", "json"]);

export function sanitizeEntities(entities: EntitySchema[]): EntitySchema[] {
  const seen = new Set<string>();
  return entities.map((e) => {
    if (!ENTITY_NAME.test(e.name)) throw new Error(`Invalid entity name: ${e.name}`);
    if (seen.has(e.name)) throw new Error(`Duplicate entity: ${e.name}`);
    seen.add(e.name);
    for (const [k, f] of Object.entries(e.fields)) {
      if (!FIELD_NAME.test(k)) throw new Error(`Invalid field name ${e.name}.${k}`);
      if (!FIELD_TYPES.has(f.type)) throw new Error(`Invalid field type ${e.name}.${k}: ${f.type}`);
    }
    return e;
  });
}
