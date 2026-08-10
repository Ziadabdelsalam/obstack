"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { storyTraces } from "@/mock/stories";

interface Item {
  label: string;
  hint: string;
  href: string;
}

const pages: Item[] = [
  { label: "Overview", hint: "page", href: "/app" },
  { label: "Service map", hint: "page", href: "/app/map" },
  { label: "Traces", hint: "page", href: "/app/traces" },
  { label: "Trace diff", hint: "page", href: "/app/traces/diff" },
  { label: "Logs", hint: "page", href: "/app/logs" },
  { label: "Issues", hint: "page", href: "/app/issues" },
  { label: "Pipelines", hint: "page", href: "/app/pipelines" },
  { label: "Alerts", hint: "page", href: "/app/alerts" },
  { label: "Incidents", hint: "page", href: "/app/incidents" },
  { label: "Changes", hint: "page", href: "/app/changes" },
  { label: "Infrastructure", hint: "page", href: "/app/infra" },
  { label: "Security", hint: "page", href: "/app/security" },
  { label: "Status page", hint: "public", href: "/status" },
  { label: "SLOs", hint: "page", href: "/app/slos" },
  { label: "Costs", hint: "page", href: "/app/costs" },
  { label: "Users", hint: "page", href: "/app/users" },
  { label: "Connections", hint: "page", href: "/app/connections" },
  { label: "MCP server", hint: "page", href: "/app/mcp" },
  { label: "Ask", hint: "ai assist", href: "/app/ask" },
  { label: "Evals", hint: "ai assist", href: "/app/evals" },
  { label: "Quickstart", hint: "page", href: "/app/onboarding" },
  { label: "Settings", hint: "page", href: "/app/settings" },
  { label: "Errors only", hint: "saved view", href: "/app/traces?status=error" },
  { label: "Slow traces (>5s)", hint: "saved view", href: "/app/traces?minMs=5000" },
];

const traceItems: Item[] = storyTraces.map((t) => ({
  label: `${t.rootName} · ${t.id.slice(0, 8)}`,
  hint: t.status === "error" ? "trace · error" : "trace",
  href: `/app/traces/${t.id}`,
}));

const all = [...pages, ...traceItems];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(
    () =>
      all
        .filter((i) => i.label.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 9),
    [q],
  );

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[18vh]"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (results[0]) go(results[0].href);
          }}
          className="flex items-center gap-2.5 border-b border-line px-3.5 py-3"
        >
          <Search className="h-4 w-4 text-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to a page, trace, or view…"
            className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
          />
          <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] text-faint">
            esc
          </kbd>
        </form>
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {results.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-faint">Nothing matches “{q}”.</p>
          )}
          {results.map((r, i) => (
            <button
              key={r.href + r.label}
              type="button"
              onClick={() => go(r.href)}
              className={`flex w-full items-center justify-between px-4 py-2 text-left hover:bg-raised ${
                i === 0 ? "bg-raised/60" : ""
              }`}
            >
              <span className="truncate font-mono text-[12.5px] text-ink">{r.label}</span>
              <span className="ml-3 shrink-0 font-mono text-[10px] text-faint">{r.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
