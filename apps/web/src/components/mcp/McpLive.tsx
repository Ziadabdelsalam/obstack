"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Lock } from "lucide-react";
import {
  API_KEY_SCOPE_LABELS,
  MCP_API_KEY_PLACEHOLDER,
  MCP_NO_CALL_LOG_SENTENCE,
  MCP_RATE_LIMIT,
  MCP_SETUP_COMMAND,
  MCP_TOOLS,
  mcpClientSetups,
  type ApiKeyScope,
} from "@/lib/mcp-types";

/** A key the endpoint admits, as the page lists it — never the secret (D98). */
export interface McpLiveKey {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  revoked: string | null;
}

/**
 * The live MCP page (S8.1 D654): four sections and no fifth — the real
 * endpoint (D653), the three client setups generated from it, this workspace's
 * admitted keys, the fifteen tools from THE registry — and the one sentence
 * about what is not kept (D655). The token is never printed: the header line
 * carries the placeholder, and the keys list carries names, prefixes and
 * scopes. The copy button is on the ENDPOINT, which is not a credential; the
 * mock page (`McpPage.tsx`, byte-pinned) has none, and stays as it is.
 */
export function McpLive({ endpoint, keys }: { endpoint: string; keys: McpLiveKey[] }) {
  const setups = mcpClientSetups(endpoint);
  const [tab, setTab] = useState(setups[0].id);
  const [copied, setCopied] = useState(false);
  const active = setups.find((s) => s.id === tab) ?? setups[0];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <div className="flex items-center gap-2.5">
        <h1 className="font-display text-[19px] font-semibold text-ink">MCP server</h1>
        <span
          className="flex items-center gap-1 rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide text-faint"
          style={{ background: "color-mix(in srgb, var(--color-line) 60%, transparent)" }}
        >
          <Lock className="h-3 w-3" /> READ-ONLY
        </span>
      </div>
      <p className="mt-1 text-[13.5px] leading-relaxed text-mid">
        Your coding agent reads this workspace through the endpoint below — traces, logs, incidents,
        SLOs and the rest — with a key from Settings → API keys. It never writes, except the one
        setup step a <code className="font-mono text-[12.5px]">setup</code>-scoped key unlocks:
        minting an ingest key for the app being set up.
      </p>

      {/* endpoint */}
      <section className="mt-5 rounded-lg border border-line bg-surface" data-tour="mcp">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">endpoint</h2>
        </div>
        <div className="space-y-3 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <code className="block min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink">
              {endpoint}
            </code>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy the endpoint"
              className="flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1.5 font-mono text-[10.5px] text-mid hover:border-line-strong"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "copied" : "copy"}
            </button>
          </div>
          <code className="block overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] text-mid">
            Authorization: Bearer {MCP_API_KEY_PLACEHOLDER}
          </code>
          <p className="font-mono text-[10.5px] leading-relaxed text-faint">
            {MCP_RATE_LIMIT.max} calls per {MCP_RATE_LIMIT.windowMs / 1000} s per key · {MCP_NO_CALL_LOG_SENTENCE}
          </p>
        </div>
      </section>

      {/* setup */}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-1 border-b border-line px-2 pt-1.5">
          {setups.map((s) => (
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
          <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
            then, inside a repository: <code className="text-ink">{MCP_SETUP_COMMAND}</code> — the agent picks
            the target, gets the recipe, obtains a key, applies it and confirms the first trace arrived.
          </p>
        </div>
      </section>

      {/* keys */}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">keys this endpoint admits · {keys.length}</h2>
        </div>
        <div>
          {keys.length === 0 && (
            <p className="px-4 py-2.5 text-[12.5px] text-faint">
              No read or setup keys yet — issue one in{" "}
              <Link href="/app/settings" className="underline decoration-line underline-offset-2 hover:text-mid">
                Settings → API keys
              </Link>
              . It is shown once, there.
            </p>
          )}
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/50 px-4 py-2 last:border-0">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{k.name}</span>
              <code className="font-mono text-[11px] text-faint">{k.prefix}…</code>
              <span className="font-mono text-[10.5px] text-faint" title={API_KEY_SCOPE_LABELS[k.scope]}>
                {k.scope}
              </span>
              {k.revoked && <span className="font-mono text-[10.5px] text-faint">revoked {k.revoked}</span>}
            </div>
          ))}
        </div>
        {keys.length > 0 && (
          <p className="border-t border-line px-4 py-2 font-mono text-[10px] leading-relaxed text-faint">
            issue and revoke in{" "}
            <Link href="/app/settings" className="underline decoration-line underline-offset-2 hover:text-mid">
              Settings → API keys
            </Link>
          </p>
        )}
      </section>

      {/* tools */}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">tools · {MCP_TOOLS.length}</h2>
        </div>
        <div>
          {MCP_TOOLS.map((t) => (
            <div key={t.name} className="border-b border-line/50 px-4 py-2.5 last:border-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <code className="font-mono text-[12.5px] font-medium text-ink">{t.name}</code>
                <span className="font-mono text-[9.5px] uppercase tracking-wide text-faint">{t.kind}</span>
                <span className="text-[12px] text-mid">{t.description}</span>
              </div>
              <code className="mt-1 block truncate font-mono text-[10.5px] text-faint">{t.example}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
