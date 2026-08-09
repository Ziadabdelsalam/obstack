"use client";

import { AskChat } from "./AskChat";

/** The full-page Ask experience — a full-bleed conversational chat window. */
export function AskConsole() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-6 py-3">
        <h1 className="font-display text-[17px] font-semibold text-ink">Ask</h1>
        <span
          className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
          style={{
            color: "var(--color-llm)",
            background: "color-mix(in srgb, var(--color-llm) 12%, transparent)",
          }}
        >
          AI ASSIST
        </span>
        <span className="ml-auto font-mono text-[10px] text-faint">
          demo: answers are scripted against the sample incident
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <AskChat />
      </div>
    </div>
  );
}
