"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { AskChat, ObstackGlyph } from "./AskChat";

/** The obstack agent, floating bottom-right on every app screen. */
export function FloatingAsk() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  if (pathname.startsWith("/app/ask")) return null;

  return (
    <>
      {open && (
        <div className="fixed right-4 bottom-20 z-50 flex h-[520px] max-h-[calc(100vh-7rem)] w-[390px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-line-strong bg-bg shadow-2xl fade-up">
          <div className="flex items-center justify-between border-b border-line bg-surface px-3.5 py-2.5">
            <span className="flex items-center gap-2.5">
              <ObstackGlyph size={14} />
              <span className="text-[13px] font-medium text-ink">ask obstack</span>
              <span
                className="rounded-[3px] px-1.5 py-px font-mono text-[9px] tracking-wide"
                style={{
                  color: "var(--color-llm)",
                  background: "color-mix(in srgb, var(--color-llm) 12%, transparent)",
                }}
              >
                AI ASSIST
              </span>
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close ask panel"
              className="rounded p-1 text-faint hover:bg-overlay hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AskChat compact />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close ask obstack" : "Ask obstack"}
        title="Ask obstack"
        className="fixed right-4 bottom-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border transition-transform hover:scale-105"
        style={{
          background: "var(--color-raised)",
          borderColor: "var(--color-line-strong)",
          boxShadow:
            "0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb, var(--color-api) 20%, transparent), 0 0 18px color-mix(in srgb, var(--color-llm) 18%, transparent)",
        }}
      >
        {open ? (
          <X className="h-4.5 w-4.5 text-mid" />
        ) : (
          <ObstackGlyph size={18} animated />
        )}
      </button>
    </>
  );
}
