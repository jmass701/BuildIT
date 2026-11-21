import { ClaudeGenerator } from "./claude.ts";
import { TemplateGenerator } from "./template.ts";
import type { Generator } from "./types.ts";

export * from "./types.ts";

export function createGenerator(): Generator {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return new ClaudeGenerator();
  return new TemplateGenerator();
}
