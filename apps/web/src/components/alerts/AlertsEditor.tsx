"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Send, Trash2, X } from "lucide-react";
import {
  ALERT_OPS,
  ALERT_WINDOWS,
  METRIC_TYPES,
  TRACE_SIGNALS,
  type AlertCondition,
  type AlertRuleRow,
  type AlertSeverity,
  type NotificationChannelKind,
  type NotificationChannelRow,
} from "@/lib/alert-types";
import { VALID_AGGS, type MetricCatalogEntry } from "@/lib/metrics-types";
import {
  createAlertRule,
  createNotificationChannel,
  deleteAlertRule,
  deleteNotificationChannel,
  sendTestNotification,
  setAlertRuleEnabled,
  setNotificationChannelEnabled,
  updateAlertRule,
} from "./actions";

/**
 * The client controls of the live alerts surface (the `DashboardEditor.tsx`
 * shape): the new-rule / edit-rule form, the enabled toggles, channel
 * management and the test-notification button. Every mutation is a server
 * action next door, and its answer is either the store's own sentence (D430,
 * printed VERBATIM — this file authors none of them) or the fresh row, after
 * which `router.refresh()` re-reads the page.
 *
 * No `@/mock/` import (D391). The condition form writes the STRUCTURED shape
 * (D481) — the human-readable string is `formatAlertCondition`'s render and is
 * never composed or parsed here. No filters editor in v1: the form always
 * submits `filters: {}` — a narrower input, not a narrower truth (the store
 * accepts filters; a later run gives them a UI).
 */
const NO_WORKSPACE = "alerts belong to a workspace, and this session has none";
const UNREACHABLE = "that change could not be confirmed — reload to see what the store holds";

const FIELD =
  "rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none";
const BUTTON =
  "flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12px] text-ink hover:bg-overlay disabled:opacity-40 disabled:hover:bg-raised";
const QUIET =
  "rounded-md border border-line px-3 py-1.5 font-mono text-[12px] text-faint hover:text-ink disabled:opacity-40";
const ICON_BUTTON =
  "rounded border border-line p-1 text-faint hover:border-line-strong hover:text-ink disabled:opacity-40";

const SEVERITIES: readonly AlertSeverity[] = ["critical", "warning", "info"];
const CHANNEL_KINDS: readonly NotificationChannelKind[] = ["webhook", "slack_webhook"];

/** One runner for every action: the store's sentence, or a refresh (D429). */
function useAlertMutation() {
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
        console.error("[alerts] mutation", failure);
        setNotice(UNREACHABLE);
      }
    });

  return { notice, setNotice, pending, call };
}

function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-2 font-mono text-[11px]" style={{ color: "var(--color-warn)" }} role="status">
      {text}
    </p>
  );
}

// ---- the rule form (create and edit are the one form, D481) -----------------

type ConditionDraft = {
  source: "metric" | "trace";
  metric: string;
  metricType: MetricCatalogEntry["type"];
  agg: string;
  signal: (typeof TRACE_SIGNALS)[number];
  service: string;
  window: (typeof ALERT_WINDOWS)[number];
  op: (typeof ALERT_OPS)[number];
  threshold: string;
};

const EMPTY_DRAFT: ConditionDraft = {
  source: "metric",
  metric: "",
  metricType: "gauge",
  agg: VALID_AGGS.gauge[0],
  signal: "error_rate_pct",
  service: "",
  window: "5m",
  op: ">",
  threshold: "",
};

function draftFrom(condition: AlertCondition): ConditionDraft {
  if (condition.source === "metric") {
    return {
      ...EMPTY_DRAFT,
      source: "metric",
      metric: condition.metric,
      metricType: condition.type,
      agg: condition.agg,
      window: condition.window,
      op: condition.op,
      threshold: String(condition.threshold),
    };
  }
  return {
    ...EMPTY_DRAFT,
    source: "trace",
    signal: condition.signal,
    service: condition.service ?? "",
    window: condition.window,
    op: condition.op,
    threshold: String(condition.threshold),
  };
}

/** The structured condition the draft states. The store re-validates (D483's
 *  web half) — this builds, it never judges. */
function conditionFrom(draft: ConditionDraft): unknown {
  const threshold = Number(draft.threshold);
  if (draft.source === "metric") {
    return {
      source: "metric",
      metric: draft.metric.trim(),
      type: draft.metricType,
      agg: draft.agg,
      window: draft.window,
      op: draft.op,
      threshold,
      filters: {},
    };
  }
  return {
    source: "trace",
    signal: draft.signal,
    service: draft.service.trim() === "" ? null : draft.service.trim(),
    window: draft.window,
    op: draft.op,
    threshold,
  };
}

function RuleForm({
  rule,
  channels,
  onDone,
}: {
  rule: AlertRuleRow | null;
  channels: NotificationChannelRow[];
  onDone: () => void;
}) {
  const { notice, pending, call } = useAlertMutation();
  const [name, setName] = useState(rule?.name ?? "");
  const [severity, setSeverity] = useState<AlertSeverity>(rule?.severity ?? "warning");
  const [channelId, setChannelId] = useState(rule?.channelId ?? channels[0]?.id ?? "");
  const [runbook, setRunbook] = useState(rule?.runbook ?? "");
  const [draft, setDraft] = useState<ConditionDraft>(
    rule ? draftFrom(rule.condition) : EMPTY_DRAFT,
  );

  const set = <K extends keyof ConditionDraft>(key: K, value: ConditionDraft[K]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // A type change re-anchors the agg to that type's own vocabulary — the
      // form can never offer what VALID_AGGS refuses (the D390 discipline).
      if (key === "metricType") next.agg = VALID_AGGS[value as MetricCatalogEntry["type"]][0];
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = {
      name,
      condition: conditionFrom(draft),
      severity,
      channelId,
      runbook: runbook.trim() === "" ? null : runbook.trim(),
    };
    call(() => (rule ? updateAlertRule(rule.id, input) : createAlertRule(input)), onDone);
  };

  const select = (
    value: string,
    onChange: (v: string) => void,
    options: readonly string[],
    label: string,
  ): ReactNode => (
    <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
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

  return (
    <form onSubmit={submit} className="mt-2 rounded-lg border border-line bg-raised p-3.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
          name
          <input
            className={FIELD}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="p95 checkout latency"
            required
          />
        </label>
        {select(severity, (v) => setSeverity(v as AlertSeverity), SEVERITIES, "severity")}
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
          channel
          <select className={FIELD} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
          runbook url (optional)
          <input
            className={FIELD}
            value={runbook}
            onChange={(e) => setRunbook(e.target.value)}
            placeholder="runbooks/latency.md"
          />
        </label>
      </div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
        {select(draft.source, (v) => set("source", v as "metric" | "trace"), ["metric", "trace"], "source")}
        {draft.source === "metric" ? (
          <>
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint sm:col-span-2">
              metric name
              <input
                className={FIELD}
                value={draft.metric}
                onChange={(e) => set("metric", e.target.value)}
                placeholder="http.server.duration"
                required
              />
            </label>
            {select(draft.metricType, (v) => set("metricType", v as MetricCatalogEntry["type"]), METRIC_TYPES, "type")}
            {select(draft.agg, (v) => set("agg", v), VALID_AGGS[draft.metricType], "agg")}
          </>
        ) : (
          <>
            {select(draft.signal, (v) => set("signal", v as ConditionDraft["signal"]), TRACE_SIGNALS, "signal")}
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
              service (blank = all)
              <input
                className={FIELD}
                value={draft.service}
                onChange={(e) => set("service", e.target.value)}
                placeholder="checkout"
              />
            </label>
          </>
        )}
        {select(draft.window, (v) => set("window", v as ConditionDraft["window"]), ALERT_WINDOWS, "window")}
        {select(draft.op, (v) => set("op", v as ConditionDraft["op"]), ALERT_OPS, "op")}
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
          threshold
          <input
            className={FIELD}
            value={draft.threshold}
            onChange={(e) => set("threshold", e.target.value)}
            placeholder="8000"
            inputMode="decimal"
            required
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={pending || channels.length === 0}>
          {rule ? "save rule" : "create rule"}
        </button>
        <button type="button" className={QUIET} onClick={onDone} disabled={pending}>
          cancel
        </button>
        {channels.length === 0 && (
          <span className="font-mono text-[11px] text-faint">
            a rule needs a channel — create one below first
          </span>
        )}
      </div>
      <Notice text={notice} />
    </form>
  );
}

export function NewRuleButton({ channels }: { channels: NotificationChannelRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-right">
      <button type="button" className={BUTTON} onClick={() => setOpen((o) => !o)}>
        {open ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        {open ? "close" : "New rule"}
      </button>
      {open && (
        <div className="text-left">
          <RuleForm rule={null} channels={channels} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** The per-rule row header: name, firing/enabled truth, edit and delete. */
export function RuleControls({
  rule,
  channels,
}: {
  rule: AlertRuleRow;
  channels: NotificationChannelRow[];
}) {
  const { notice, pending, call } = useAlertMutation();
  const [editing, setEditing] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ink">{rule.name}</p>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            className={ICON_BUTTON}
            title="edit rule"
            onClick={() => setEditing((e) => !e)}
            disabled={pending}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            title="delete rule — its events go with it"
            onClick={() => call(() => deleteAlertRule(rule.id))}
            disabled={pending}
          >
            <Trash2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={rule.enabled}
            title={rule.enabled ? "disable" : "enable"}
            className="h-3.5 w-6 rounded-full p-px transition-colors"
            style={{
              background: rule.enabled
                ? "color-mix(in srgb, var(--color-ok) 45%, var(--color-line))"
                : "var(--color-line)",
            }}
            onClick={() => call(() => setAlertRuleEnabled(rule.id, !rule.enabled))}
            disabled={pending}
          >
            <span
              className="block h-3 w-3 rounded-full bg-ink transition-transform"
              style={{ transform: rule.enabled ? "translateX(10px)" : "none" }}
            />
          </button>
        </span>
      </div>
      <Notice text={notice} />
      {editing && <RuleForm rule={rule} channels={channels} onDone={() => setEditing(false)} />}
    </div>
  );
}

// ---- channels ---------------------------------------------------------------

export function ChannelManager({ channels }: { channels: NotificationChannelRow[] }) {
  const { notice, pending, call } = useAlertMutation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NotificationChannelKind>("slack_webhook");
  const [target, setTarget] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    call(
      () => createNotificationChannel({ name, kind, target }),
      () => {
        setOpen(false);
        setName("");
        setTarget("");
      },
    );
  };

  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">channels</h2>
        <button type="button" className={QUIET} onClick={() => setOpen((o) => !o)}>
          {open ? "close" : "add channel"}
        </button>
      </div>

      {open && (
        <form onSubmit={submit} className="mb-2 rounded-lg border border-line bg-raised p-3.5">
          <div className="grid gap-2.5 sm:grid-cols-3">
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
              name
              <input
                className={FIELD}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="#incidents"
                required
              />
            </label>
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
              kind
              <select
                className={FIELD}
                value={kind}
                onChange={(e) => setKind(e.target.value as NotificationChannelKind)}
              >
                {CHANNEL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-faint">
              target url
              <input
                className={FIELD}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="https://hooks.slack.com/services/…"
                required
              />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button type="submit" className={BUTTON} disabled={pending}>
              create channel
            </button>
          </div>
        </form>
      )}

      {channels.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface p-5 text-center">
          <p className="font-mono text-[12.5px] text-mid">
            no channels yet — a rule needs somewhere to deliver
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {channels.map((c) => (
            <div key={c.id} className="border-b border-line/50 px-3.5 py-2.5 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-ink">{c.name}</p>
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    title="send a test notification through the real deliverer"
                    onClick={() => call(() => sendTestNotification(c.id))}
                    disabled={pending}
                  >
                    <Send className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    title="delete channel — refused while a rule uses it"
                    onClick={() => call(() => deleteNotificationChannel(c.id))}
                    disabled={pending}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={c.enabled}
                    title={c.enabled ? "disable" : "enable"}
                    className="h-3.5 w-6 rounded-full p-px transition-colors"
                    style={{
                      background: c.enabled
                        ? "color-mix(in srgb, var(--color-ok) 45%, var(--color-line))"
                        : "var(--color-line)",
                    }}
                    onClick={() => call(() => setNotificationChannelEnabled(c.id, !c.enabled))}
                    disabled={pending}
                  >
                    <span
                      className="block h-3 w-3 rounded-full bg-ink transition-transform"
                      style={{ transform: c.enabled ? "translateX(10px)" : "none" }}
                    />
                  </button>
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[10.5px] text-faint">
                {c.kind} · {c.targetMasked}
              </p>
            </div>
          ))}
        </div>
      )}
      <Notice text={notice} />
    </section>
  );
}
