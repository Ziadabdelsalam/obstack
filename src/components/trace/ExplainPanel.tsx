"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import type { Explanation } from "@/mock/types";

/**
 * Scripted "Explain this trace" — streams the prepared explanation with a
 * typed-out effect so the demo feels live.
 */
export function ExplainPanel({
  explanation,
  onClose,
}: {
  explanation: Explanation;
  onClose: () => void;
}) {
  const sections = [
    { label: "", text: explanation.headline },
    { label: "WHAT FAILED", text: explanation.failedWhere },
    { label: "ROOT CAUSE", text: explanation.rootCause },
    ...explanation.evidence.map((e) => ({
      label: `EVIDENCE · ${e.label}`,
      text: e.detail,
    })),
    { label: "SUGGESTED FIX", text: explanation.suggestion },
  ];

  const totalChars = sections.reduce((s, x) => s + x.text.length, 0);
  const [chars, setChars] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setChars(totalChars);
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setChars((c) => {
        const next = c + dt * 1.1; // ~1100 chars/s
        return next >= totalChars ? totalChars : next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [totalChars]);

  const done = chars >= totalChars;

  let budget = Math.floor(chars);
  const rendered = sections.map((s) => {
    const take = Math.max(0, Math.min(s.text.length, budget));
    budget -= s.text.length;
    return { ...s, visible: s.text.slice(0, take), active: take > 0 && take < s.text.length };
  });

  return (
    <div
      className="rounded-lg border bg-raised"
      style={{ borderColor: "color-mix(in srgb, var(--color-llm) 35%, var(--color-line))" }}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-llm)" }}>
          <Sparkles className="h-3.5 w-3.5" />
          explain this trace
          {!done && <span className="pulse-dot text-faint">analyzing…</span>}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close explanation"
          className="rounded p-1 text-faint hover:bg-overlay hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        {rendered.map((s, i) =>
          s.visible.length === 0 ? null : (
            <div key={i}>
              {s.label && (
                <p className="mb-0.5 font-mono text-[9.5px] uppercase tracking-widest text-faint">
                  {s.label}
                </p>
              )}
              <p
                className={
                  i === 0
                    ? "text-[13.5px] font-medium leading-snug text-ink"
                    : "text-[12.5px] leading-relaxed text-mid"
                }
              >
                {s.visible}
                {s.active && (
                  <span className="ml-px inline-block h-3 w-[6px] animate-pulse bg-llm align-middle" style={{ background: "var(--color-llm)" }} />
                )}
              </p>
            </div>
          ),
        )}
      </div>
      {done && (
        <div className="border-t border-line px-3.5 py-2 font-mono text-[10px] text-faint">
          4 of 20 free Explain runs used this month
        </div>
      )}
    </div>
  );
}
