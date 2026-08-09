"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CornerDownLeft } from "lucide-react";
import { askExchanges, askSuggestions } from "@/mock/intelligence";
import type { AskExchange } from "@/mock/intelligence";
import { layerOrder, layerColor } from "@/lib/layers";

interface Message {
  role: "user" | "assistant";
  text: string;
  evidence?: AskExchange["evidence"];
  streaming?: boolean;
}

export function ObstackGlyph({ size = 16, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <span className="flex items-center gap-[2.5px]" aria-hidden style={{ height: size }}>
      {layerOrder.map((l, i) => (
        <span
          key={l}
          className={animated ? "eq-bar" : undefined}
          style={{
            width: Math.max(2, size / 6),
            height: size * 0.85,
            borderRadius: 1,
            background: layerColor[l],
            animationDelay: animated ? `${i * 0.12}s` : undefined,
          }}
        />
      ))}
    </span>
  );
}

/** The scripted Ask conversation — shared by the Ask page and the floating agent. */
export function AskChat({ compact = false }: { compact?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const nextAnswer = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const ask = (question: string) => {
    if (!question.trim() || busy) return;
    const matched =
      askExchanges.find((e) => e.question === question) ??
      askExchanges[nextAnswer.current % askExchanges.length];
    nextAnswer.current += 1;
    setBusy(true);
    setInput("");
    setMessages((m) => [
      ...m,
      { role: "user", text: question },
      { role: "assistant", text: "", evidence: matched.evidence, streaming: true },
    ]);

    const full = matched.answer;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let i = 0;
    const step = () => {
      i = reduced ? full.length : Math.min(full.length, i + 14);
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, text: full.slice(0, i), streaming: i < full.length };
        return copy;
      });
      if (i < full.length) setTimeout(step, 16);
      else setBusy(false);
    };
    setTimeout(step, reduced ? 0 : 350);
  };

  const textSize = compact ? "text-[12.5px]" : "text-[13px]";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* bottom-anchored thread: newest message sits at the bottom, grows upward */}
      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto">
        <div className={`mt-auto space-y-3 ${compact ? "p-3" : "px-6 py-5"}`}>
        {messages.length === 0 && (
          <div className={compact ? "" : "rounded-lg border border-line bg-surface p-4"} data-tour="ask">
            <div className="mb-3 flex items-start gap-2.5">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-raised">
                <ObstackGlyph size={13} animated />
              </span>
              <p className={`${textSize} leading-relaxed text-mid`}>
                Hi — I answer questions from your traces, logs and metrics, with evidence linked.
                Try one of these, or ask anything:
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {askSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-left text-[12px] text-mid transition-colors hover:border-line-strong hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex items-start justify-end gap-2.5">
              <p
                className={`${compact ? "max-w-[85%]" : "max-w-[60%]"} rounded-2xl rounded-br-md border px-3.5 py-2 ${textSize} text-ink`}
                style={{
                  borderColor: "color-mix(in srgb, var(--color-api) 35%, var(--color-line))",
                  background: "color-mix(in srgb, var(--color-api) 10%, var(--color-overlay))",
                }}
              >
                {m.text}
              </p>
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold"
                aria-label="You"
                style={{
                  color: "var(--color-api)",
                  borderColor: "color-mix(in srgb, var(--color-api) 40%, var(--color-line))",
                  background: "color-mix(in srgb, var(--color-api) 12%, var(--color-raised))",
                }}
              >
                Z
              </span>
            </div>
          ) : (
            <div key={i} className="flex items-start gap-2.5">
              <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-raised">
                <ObstackGlyph size={13} animated />
              </span>
              <div className={`min-w-0 ${compact ? "max-w-[92%]" : "max-w-[820px]"} rounded-2xl rounded-tl-md border border-line bg-surface`}>
                <div className="px-3.5 py-2.5">
                  {m.text.length === 0 && m.streaming && (
                    <p className={`${textSize} pulse-dot text-faint`}>reading traces & logs…</p>
                  )}
                  {m.text.split("\n\n").map((para, j) => (
                    <p key={j} className={`mb-2 ${textSize} leading-relaxed text-mid last:mb-0`}>
                      {para}
                      {m.streaming && j === m.text.split("\n\n").length - 1 && (
                        <span
                          className="ml-px inline-block h-3 w-[6px] animate-pulse align-middle"
                          style={{ background: "var(--color-llm)" }}
                        />
                      )}
                    </p>
                  ))}
                </div>
                {!m.streaming && m.evidence && (
                  <div className="flex flex-wrap gap-1.5 border-t border-line px-3.5 py-2">
                    {m.evidence.map((e) => (
                      <Link
                        key={e.label}
                        href={e.href}
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 font-mono text-[10px] text-mid hover:border-line-strong hover:text-ink"
                      >
                        {e.label} <ArrowUpRight className="h-2.5 w-2.5" />
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className={`flex items-center gap-2 border-t border-line bg-surface ${compact ? "px-3 py-2.5" : "px-6 py-3"}`}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about any incident, cost, or behavior…"
          className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          aria-label="Ask"
          className="rounded-md border border-line bg-raised p-1.5 text-mid hover:text-ink disabled:opacity-50"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}
