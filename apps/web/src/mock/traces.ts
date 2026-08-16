import { generateTraces } from "./generate";
import { storyTraces } from "./stories";
import type { Trace } from "@/lib/types";

const generated = generateTraces(60);

/** Story traces first (they're recent), then generated volume, newest first. */
export const allTraces: Trace[] = [...storyTraces, ...generated].sort(
  (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
);

const byId = new Map(allTraces.map((t) => [t.id, t]));

export function getTrace(id: string): Trace | undefined {
  return byId.get(id);
}
