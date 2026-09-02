"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import type { NotificationChannelRow } from "@/lib/alert-types";
import {
  SLO_INDICATOR_KINDS,
  SLO_WINDOWS,
  sloBudget,
  type SloIndicatorKind,
  type SloRow,
  type SloWindow,
} from "@/lib/slo-types";
import { createSlo, deleteSlo, setSloEnabled, updateSlo } from "./actions";

/**
 * The client controls of the live SLOs surface (the `AlertsEditor.tsx`
 * shape): the new/edit form, the enabled toggle, delete. Every mutation is a
 * server action next door, and its answer is either the store's own sentence
 * (D430, printed VERBATIM — this file authors none of them) or the fresh
 * row, after which `router.refresh()` re-reads the page.
 *
 * No `@/mock/` import (D391). The form writes the STRUCTURED indicator
 * (D517) — the objective sentence is the formatter's render and is never
 * composed or parsed here. `sloBudget` is used for ONE thing: a preview line
 * under the target field ("at 99.9% over 10,000 traces, 10 bad is the whole
 * budget") so an author can feel the number — it decides nothing the card
 * shows (D509: the evaluator is the writer).
 */
const NO_WORKSPACE = "SLOs belong to a workspace, and this session has none";
const UNREACHABLE = "that change could not be confirmed — reload to see what the store holds";

const FIELD =
  "rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none";
const BUTTON =
  "flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12px] text-ink hover:bg-overlay disabled:opacity-40 disabled:hover:bg-raised";
const QUIET =
  "rounded-md border border-line px-3 py-1.5 font-mono text-[12px] text-faint hover:text-ink disabled:opacity-40";
const ICON_BUTTON =
  "rounded border border-line p-1 text-faint hover:border-line-strong hover:text-ink disabled:opacity-40";
const LABEL = "flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint";

/** The option value for "no channel" — never sent: the draft maps it to null. */
const NO_CHANNEL = "";

/** One runner for every action: the store's sentence, or a refresh (D429). */
function useSloMutation() {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const call = (work: () => Promise<{ refused: string } | object | null>, accepted?: () => void) =>
    run(async () => {
      try {
        const result = await work();
        if (result === null) return setNotice(NO_WORKSPACE);
        if (typeof result === "object" && "refused" in result) {
          return setNotice((result as { refused: string }).refused);
        }
        setNotice(null);
        accepted?.();
        router.refresh();
      } catch (failure) {
        console.error("[slos] mutation", failure);
        setNotice(UNREACHABLE);
      }
    });

  return { notice, pending, call };
}

function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-2 font-mono text-[11px]" style={{ color: "var(--color-warn)" }} role="status">
      {text}
    </p>
  );
}

// ---- the form (create and edit are the one form) ----------------------------------

type Draft = {
  name: string;
  kind: SloIndicatorKind;
  service: string;
  thresholdMs: string;
  target: string;
  window: SloWindow;
  channelId: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  kind: "availability",
  service: "",
  thresholdMs: "",
  target: "99.9",
  window: "30d",
  channelId: NO_CHANNEL,
};

function draftFrom(slo: SloRow): Draft {
  return {
    name: slo.name,
    kind: slo.indicator.kind,
    service: slo.indicator.service ?? "",
    thresholdMs: slo.indicator.kind === "latency" ? String(slo.indicator.thresholdMs) : "",
    target: String(slo.target),
    window: slo.window,
    channelId: slo.channelId ?? NO_CHANNEL,
  };
}

/** The structured indicator the draft states. The store re-validates (D517's
 *  web half) — this builds, it never judges. */
function indicatorFrom(draft: Draft): unknown {
  const service = draft.service.trim() === "" ? null : draft.service.trim();
  if (draft.kind === "availability") return { kind: "availability", service };
  return { kind: "latency", service, thresholdMs: Number(draft.thresholdMs) };
}

/** The preview line: what one bad trace in ten thousand means at this target. */
function budgetPreview(target: string): string | null {
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0 || t >= 100) return null;
  const total = 10_000;
  const allowed = Math.floor((total * (100 - t)) / 100);
  const one = sloBudget(total - 1, total, t);
  return `at ${t}% over ${total.toLocaleString("en-US")} traces, ${allowed.toLocaleString("en-US")} bad is the whole budget — one bad trace is ${one.budgetBurnedPct === null ? "—" : `${Number(one.budgetBurnedPct.toFixed(1))}%`} of it`;
}

function SloForm({ slo, channels, onDone }: { slo: SloRow | null; channels: NotificationChannelRow[]; onDone: () => void }) {
  const { notice, pending, call } = useSloMutation();
  const [draft, setDraft] = useState<Draft>(slo ? draftFrom(slo) : EMPTY_DRAFT);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = {
      name: draft.name,
      indicator: indicatorFrom(draft),
      target: Number(draft.target),
      window: draft.window,
      channelId: draft.channelId === NO_CHANNEL ? null : draft.channelId,
    };
    call(() => (slo ? updateSlo(slo.id, input) : createSlo(input)), onDone);
  };

  const select = (value: string, onChange: (v: string) => void, options: readonly string[], label: string): ReactNode => (
    <label className={LABEL}>
      {label}
      <select className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );

  const preview = budgetPreview(draft.target);

  return (
    <form onSubmit={submit} className="mt-2 rounded-lg border border-line bg-raised p-3.5">
      <div className="grid gap-2.5 sm:grid-cols-3">
        <label className={`${LABEL} sm:col-span-2`}>
          name
          <input className={FIELD} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="API availability" required />
        </label>
        {select(draft.kind, (v) => set("kind", v as SloIndicatorKind), SLO_INDICATOR_KINDS, "indicator")}
        <label className={LABEL}>
          service (blank = all)
          <input className={FIELD} value={draft.service} onChange={(e) => set("service", e.target.value)} placeholder="checkout" />
        </label>
        {draft.kind === "latency" && (
          <label className={LABEL}>
            good under (ms)
            <input className={FIELD} value={draft.thresholdMs} onChange={(e) => set("thresholdMs", e.target.value)} placeholder="2000" inputMode="numeric" required />
          </label>
        )}
        <label className={LABEL}>
          target (%)
          <input className={FIELD} value={draft.target} onChange={(e) => set("target", e.target.value)} placeholder="99.9" inputMode="decimal" required />
        </label>
        {select(draft.window, (v) => set("window", v as SloWindow), SLO_WINDOWS, "window")}
        <label className={LABEL}>
          notify (optional)
          <select className={FIELD} value={draft.channelId} onChange={(e) => set("channelId", e.target.value)}>
            <option value={NO_CHANNEL}>no channel — compute only</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {preview && <p className="mt-2 font-mono text-[10.5px] text-faint">{preview}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={pending}>
          {slo ? "save SLO" : "create SLO"}
        </button>
        <button type="button" className={QUIET} onClick={onDone} disabled={pending}>
          cancel
        </button>
        {slo && (
          <span className="font-mono text-[11px] text-faint">changing the objective resets its measurement</span>
        )}
      </div>
      <Notice text={notice} />
    </form>
  );
}

export function NewSloButton({ channels }: { channels: NotificationChannelRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-right">
      <button type="button" className={BUTTON} onClick={() => setOpen((o) => !o)}>
        {open ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        {open ? "close" : "New SLO"}
      </button>
      {open && (
        <div className="text-left">
          <SloForm slo={null} channels={channels} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** The per-card controls: edit, delete, the enabled toggle. */
export function SloControls({ slo, channels }: { slo: SloRow; channels: NotificationChannelRow[] }) {
  const { notice, pending, call } = useSloMutation();
  const [editing, setEditing] = useState(false);

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" className={ICON_BUTTON} title="edit SLO" onClick={() => setEditing((e) => !e)} disabled={pending}>
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          title="delete SLO — its events go with it"
          onClick={() => call(() => deleteSlo(slo.id))}
          disabled={pending}
        >
          <Trash2 className="h-3 w-3" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={slo.enabled}
          title={slo.enabled ? "disable" : "enable"}
          className="h-3.5 w-6 rounded-full p-px transition-colors"
          style={{
            background: slo.enabled ? "color-mix(in srgb, var(--color-ok) 45%, var(--color-line))" : "var(--color-line)",
          }}
          onClick={() => call(() => setSloEnabled(slo.id, !slo.enabled))}
          disabled={pending}
        >
          <span className="block h-3 w-3 rounded-full bg-ink transition-transform" style={{ transform: slo.enabled ? "translateX(10px)" : "none" }} />
        </button>
      </div>
      <Notice text={notice} />
      {editing && <SloForm slo={slo} channels={channels} onDone={() => setEditing(false)} />}
    </div>
  );
}
