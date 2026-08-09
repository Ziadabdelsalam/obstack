"use client";

import { AskChat } from "./AskChat";

/** The full-page Ask experience — a conversational chat window. */
export function AskConsole() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-5 pt-4 pb-0">
      <div className="mb-1 flex items-center gap-2">
        <h1 className="font-display text-[19px] font-semibold text-ink">Ask</h1>
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
      <div className="min-h-0 flex-1 overflow-hidden rounded-t-lg border border-b-0 border-line bg-bg">
        <AskChat />
      </div>
    </div>
  );
}
