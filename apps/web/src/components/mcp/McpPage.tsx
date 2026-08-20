"use client";

import { useState } from "react";
import { Eye, Lock } from "lucide-react";
import {
  MCP_ENDPOINT_PLACEHOLDER,
  MCP_TOKEN_PLACEHOLDER,
  mcpActivity,
  mcpSetup,
  mcpTools,
} from "@/mock/mcp";

export function McpPage() {
  const [tab, setTab] = useState(mcpSetup[0].id);
  const active = mcpSetup.find((s) => s.id === tab)!;

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="flex items-center gap-2.5">
        <h1 className="font-display text-[19px] font-semibold text-ink">MCP server</h1>
        {/* The green "READ-ONLY" tag asserted a property of a running server.
            The tag that is true today is that there is no server. */}
        <span
          className="flex items-center gap-1 rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide text-faint"
          style={{ background: "color-mix(in srgb, var(--color-line) 60%, transparent)" }}
        >
          <Eye className="h-3 w-3" /> NOT BUILT YET
        </span>
      </div>
      {/* The whole page is a preview: no MCP endpoint exists in this product,
          in either mode. Saying so once, at the top, is what lets the demo
          content below stand as demo content (D208) instead of reading as a
          feature you could connect to this afternoon. */}
      <p className="mt-1 text-[13.5px] leading-relaxed text-mid">
        The plan: give your agents the same view you have — Claude Code, Cursor, or any MCP
        client querying traces, logs and the rest, debugging alongside you with real evidence
        instead of guesses.
      </p>
      <p className="mt-2 text-[13px] leading-relaxed text-faint">
        None of it runs yet. There is no MCP endpoint to point a client at, so the endpoint,
        token and activity below are a sketch of the shape, not something to copy.
      </p>

      {/* endpoint */}
      <section className="mt-5 rounded-lg border border-line bg-surface" data-tour="mcp">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">endpoint</h2>
        </div>
        <div className="space-y-3 px-4 py-3.5">
          {/* Placeholders, and no copy button on either: a copy affordance next
              to a credential says the credential is yours to use. The token
              button used to copy a whole fabricated key literal. */}
          <code className="block overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink">
            {MCP_ENDPOINT_PLACEHOLDER}
          </code>
          <code className="block overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] text-mid">
            Authorization: Bearer {MCP_TOKEN_PLACEHOLDER}
          </code>
          <p className="flex items-start gap-2 font-mono text-[10.5px] leading-relaxed text-faint">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
            read-only is the intended shape — the server would query, never mutate. Nothing is
            issued today: there is no MCP token class in settings.
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
        <div className="px-4 py-3.5">
          <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[11.5px] leading-relaxed text-mid">
            {active.snippet}
          </pre>
        </div>
      </section>

      {/* tools */}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
            planned tools · {mcpTools.length}
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
          sample rows · no agent has called anything — nothing is serving these tools yet
        </p>
      </section>
    </div>
  );
}
