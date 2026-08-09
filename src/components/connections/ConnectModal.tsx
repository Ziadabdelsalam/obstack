"use client";

import { useState } from "react";
import { X, Copy, Check, Bell } from "lucide-react";
import type { Connector } from "@/mock/types";

function Snippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="group relative mt-2 rounded-md border border-line bg-bg">
      <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-mid">
        {code}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy snippet"
        className="absolute top-2 right-2 rounded border border-line bg-raised p-1.5 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

export function ConnectModal({
  connector,
  onClose,
}: {
  connector: Connector;
  onClose: () => void;
}) {
  const [requested, setRequested] = useState(false);
  const available = connector.status === "available";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${connector.name}`}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-md border border-line bg-raised font-mono text-[12px] font-semibold"
              style={{ color: connector.markColor }}
            >
              {connector.mark}
            </span>
            <div>
              <h2 className="text-[14px] font-medium text-ink">{connector.name}</h2>
              <p className="font-mono text-[10px] uppercase tracking-widest text-faint">
                {connector.category}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1.5 text-faint hover:bg-overlay hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-4">
          <p className="text-[13px] leading-relaxed text-mid">{connector.blurb}</p>

          {available && connector.connectSteps ? (
            <ol className="mt-4 space-y-4">
              {connector.connectSteps.map((step, i) => (
                <li key={step.title} className="relative pl-7">
                  <span
                    className="absolute top-0 left-0 flex h-[18px] w-[18px] items-center justify-center rounded-full font-mono text-[10px]"
                    style={{
                      color: "var(--color-api)",
                      background: "color-mix(in srgb, var(--color-api) 14%, transparent)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <p className="text-[13px] font-medium text-ink">{step.title}</p>
                  {step.body && (
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-mid">{step.body}</p>
                  )}
                  {step.snippet && <Snippet code={step.snippet} />}
                </li>
              ))}
            </ol>
          ) : (
            <div className="mt-4 rounded-lg border border-line bg-raised p-4 text-center">
              <p className="text-[13px] text-mid">
                This connector is on the roadmap. Requests decide what ships next.
              </p>
              <button
                type="button"
                onClick={() => setRequested(true)}
                disabled={requested}
                className="mt-3 inline-flex items-center gap-2 rounded-md border border-line-strong bg-overlay px-3.5 py-2 text-[12.5px] font-medium text-ink transition-colors hover:border-faint disabled:opacity-80"
              >
                {requested ? (
                  <>
                    <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
                    Requested — we&apos;ll email you
                  </>
                ) : (
                  <>
                    <Bell className="h-3.5 w-3.5" />
                    Request this connector
                  </>
                )}
              </button>
            </div>
          )}

          {available && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-warn)" }} />
              <span className="font-mono text-[11px] text-mid">waiting for first event…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
