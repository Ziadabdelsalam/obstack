"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CornerDownLeft, Sparkles } from "lucide-react";
import { askExchanges, askSuggestions } from "@/mock/intelligence";
import type { AskExchange } from "@/mock/intelligence";

interface Message {
  role: "user" | "assistant";
  text: string;
  evidence?: AskExchange["evidence"];
  streaming?: boolean;
}

/** Scripted natural-language console. Any question maps to a canned analysis. */
export function AskConsole() {
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
      if (i < full.length) {
        setTimeout(step, 16);
      } else {
        setBusy(false);
      }
    };
    setTimeout(step, reduced ? 0 : 350);
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-0px)] max-w-3xl flex-col px-5 py-4">
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
      </div>
      <p className="text-[12.5px] text-mid">
        Questions are answered from your traces, logs and metrics — every claim links to evidence.
      </p>

      <div ref={scrollRef} className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="mb-2.5 font-mono text-[10.5px] uppercase tracking-widest text-faint">
              try asking
            </p>
            <div className="flex flex-wrap gap-2">
              {askSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-left text-[12.5px] text-mid transition-colors hover:border-line-strong hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] rounded-lg border border-line bg-overlay px-3.5 py-2 text-[13px] text-ink">
                {m.text}
              </p>
            </div>
          ) : (
            <div key={i} className="rounded-lg border border-line bg-surface">
              <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
                <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--color-llm)" }} />
                <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
                  {m.streaming ? "analyzing traces & logs…" : "answer · from your telemetry"}
                </span>
              </div>
              <div className="px-3.5 py-3">
                {m.text.split("\n\n").map((para, j) => (
                  <p key={j} className="mb-2.5 text-[13px] leading-relaxed text-mid last:mb-0">
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
                <div className="flex flex-wrap gap-2 border-t border-line px-3.5 py-2.5">
                  {m.evidence.map((e) => (
                    <Link
                      key={e.label}
                      href={e.href}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 font-mono text-[10.5px] text-mid hover:border-line-strong hover:text-ink"
                    >
                      {e.label} <ArrowUpRight className="h-2.5 w-2.5" />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-line-strong"
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
      <p className="mt-2 font-mono text-[10px] text-faint">
        demo: answers are scripted against the sample incident data
      </p>
    </div>
  );
}
