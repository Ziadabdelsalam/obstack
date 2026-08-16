import type { Layer } from "./types";

export const layerColor: Record<Layer, string> = {
  api: "var(--color-api)",
  agent: "var(--color-agent)",
  tool: "var(--color-tool)",
  llm: "var(--color-llm)",
  infra: "var(--color-infra)",
  other: "var(--color-faint)",
};

export const layerLabel: Record<Layer, string> = {
  api: "API",
  agent: "AGENT",
  tool: "TOOL",
  llm: "LLM",
  infra: "INFRA",
  other: "OTHER",
};

export const layerOrder: Layer[] = ["api", "agent", "tool", "llm", "infra", "other"];
