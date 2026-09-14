import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MCP_PROMPTS, type McpPromptSpec } from "@/lib/mcp-types";

/**
 * The one prompt (S8.1 D668), registered from THE constant the docs page also
 * renders: the six steps become one user message, with the caller's `target`
 * and `service` — when given — stated on the first line so the agent does not
 * re-derive them. Claude Code exposes it as `/mcp__obstack__setup`.
 */
export function renderPrompt(spec: McpPromptSpec, args: { target?: string; service?: string }): string {
  const lines = [`Set obstack up in this repository.`];
  if (args.target) lines.push(`Target: ${args.target}.`);
  if (args.service) lines.push(`Service name: ${args.service}.`);
  lines.push("");
  spec.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  return lines.join("\n");
}

export function registerPrompts(server: McpServer): void {
  for (const spec of MCP_PROMPTS) {
    server.registerPrompt(
      spec.name,
      {
        description: spec.description,
        argsSchema: z.object({
          target: z.string().max(40).optional().describe(spec.arguments[0].description),
          service: z.string().max(200).optional().describe(spec.arguments[1].description),
        }),
      },
      ({ target, service }) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: renderPrompt(spec, { target, service }) } }],
      }),
    );
  }
}
