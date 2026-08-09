"use client";

import { useState } from "react";
import { Check, Copy, Eye, Lock } from "lucide-react";
import { mcpActivity, mcpSetup, mcpTools } from "@/mock/mcp";

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={label ?? "Copy"}
      className="rounded-md border border-line bg-raised p-1.5 text-faint hover:text-ink"
    >
      {copied ? <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export function McpPage() {
  const [tab, setTab] = useState(mcpSetup[0].id);
  const active = mcpSetup.find((s) => s.id === tab)!;

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="flex items-center gap-2.5">
        <h1 className="font-display text-[19px] font-semibold text-ink">MCP server</h1>
        <span
          className="flex items-center gap-1 rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
          style={{
            color: "var(--color-ok)",
            background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
          }}
        >
          <Eye className="h-3 w-3" /> READ-ONLY
        </span>
      </div>
      <p className="mt-1 text-[13.5px] leading-relaxed text-mid">
        Give your agents the same view you have. Claude Code, Cursor, or any MCP client can query
        traces, logs, the service map, incidents and SLOs — debugging alongside you with real
        evidence instead of guesses.
      </p>

      {/* endpoint */}
      <section className="mt-5 rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">endpoint</h2>
        </div>
        <div className="space-y-3 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink">
              https://mcp.obstack.dev
            </code>
            <CopyBtn text="https://mcp.obstack.dev" label="Copy endpoint" />
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] text-mid">
              ob_mcp_read_7k2f…9d1c
            </code>
            <CopyBtn text="ob_mcp_read_7k2f9d1c" label="Copy token" />
          </div>
          <p className="flex items-start gap-2 font-mono text-[10.5px] leading-relaxed text-faint">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
            scoped to loopwork-prod · read-only — this token cannot mutate anything. Write scopes
            (silence alerts, trigger pipelines) ship later and stay off by default.
          </p>
        </div>
      </section>

      {/* setup */}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-1 border-b border-line px-2 pt-1.5">
          {mcpSetup.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setTab(s.id)}
              className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-[12.5px] transition-colors ${
                tab === s.id ? "border-current text-ink" : "border-transparent text-faint hover:text-mid"
              }`}
              style={tab === s.id ? { borderBottomColor: "var(--color-api)" } : undefined}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative px-4 py-3.5">
          <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[11.5px] leading-relaxed text-mid">
            {active.snippet}
          </pre>
          <div className="absolute top-6 right-6">
            <CopyBtn text={active.snippet} label="Copy setup snippet" />
          </div>
        </div>
      </section>

      {/* tools */}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
            exposed tools · {mcpTools.length}
          </h2>
        </div>
        <div>
          {mcpTools.map((t) => (
            <div key={t.name} className="border-b border-line/50 px-4 py-2.5 last:border-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <code className="font-mono text-[12.5px] font-medium text-ink">{t.name}</code>
                <span className="text-[12px] text-mid">{t.description}</span>
              </div>
              <code className="mt-1 block truncate font-mono text-[10.5px] text-faint">{t.example}</code>
            </div>
          ))}
        </div>
      </section>

      {/* recent activity */}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
            recent agent activity
          </h2>
        </div>
        <div>
          {mcpActivity.map((a, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/50 px-4 py-2 last:border-0">
              <span className="w-[150px] shrink-0 truncate font-mono text-[11px]" style={{ color: "var(--color-agent)" }}>
                {a.agent}
              </span>
              <code className="font-mono text-[11.5px] text-ink">{a.tool}</code>
              <code className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">{a.args}</code>
              <span className="font-mono text-[10px] text-faint">{a.time}</span>
            </div>
          ))}
        </div>
        <p className="border-t border-line px-4 py-2 font-mono text-[10px] leading-relaxed text-faint">
          every MCP call is audit-logged · try it: ask your agent “why did INC-42 happen?” and watch
          it pull the incident, traces and logs itself
        </p>
      </section>
    </div>
  );
}
