"use client";

import { useState } from "react";
import { Check, Copy, FileCode2, X } from "lucide-react";

/** Observability-as-code: export alerts/SLOs as Terraform. */
export function TerraformExport({ kind }: { kind: "alerts" | "slos" }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const hcl =
    kind === "alerts"
      ? `resource "obstack_alert_rule" "error_rate" {
  name      = "Error rate"
  condition = "error_rate > 0.05"
  window    = "10m"
  scope     = { route = "*" }
  channel   = obstack_channel.incidents.id
  runbook   = "runbooks/error-rate.md"

  action "throttle_batch_importer" {
    pipeline = obstack_pipeline.zendesk_migration.id
    rate     = "50/min"
    approval = "one-click"   # audit-logged
  }
}

resource "obstack_alert_rule" "pod_crash_loop" {
  name      = "Pod crash loop"
  condition = "k8s_restarts >= 3"
  window    = "1h"
  channel   = obstack_channel.incidents.id
  runbook   = "runbooks/crashloop.md"
}`
      : `resource "obstack_slo" "chat_latency" {
  name      = "Chat latency"
  objective = 99.0
  window    = "30d"
  sli {
    good  = "route = 'POST /v1/chat' AND duration < 2s"
    total = "route = 'POST /v1/chat'"
  }
  alert_on_burn_rate = [14.4, 6]   # fast + slow burn
}

resource "obstack_slo" "api_availability" {
  name      = "API availability"
  objective = 99.9
  window    = "30d"
  sli {
    good  = "status_code < 500"
    total = "*"
  }
}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-mid hover:border-line-strong hover:text-ink"
      >
        <FileCode2 className="h-3.5 w-3.5" />
        export as terraform
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Terraform export"
        >
          <div
            className="w-full max-w-xl rounded-xl border border-line-strong bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-faint">
                <FileCode2 className="h-3.5 w-3.5" />
                {kind}.tf — provider obstack/obstack
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(hcl).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  aria-label="Copy HCL"
                  className="rounded-md border border-line bg-raised p-1.5 text-faint hover:text-ink"
                >
                  {copied ? <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1.5 text-faint hover:bg-overlay hover:text-ink">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <pre className="max-h-[60vh] overflow-auto p-4 font-mono text-[11.5px] leading-relaxed text-mid">
              {hcl}
            </pre>
            <p className="border-t border-line px-4 py-2 font-mono text-[10px] leading-relaxed text-faint">
              round-trippable: rules edited in the UI show a drift diff against your repo — config
              stays the source of truth
            </p>
          </div>
        </div>
      )}
    </>
  );
}
