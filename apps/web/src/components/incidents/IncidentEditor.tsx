"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import {
  INCIDENT_SEVERITIES,
  formatIncidentClock,
  type IncidentRow,
  type IncidentSeverity,
  type PromotableAlertEvent,
} from "@/lib/incident-types";
import {
  createIncident,
  deleteIncident,
  promoteAlertEvent,
  reopenIncident,
  resolveIncident,
  updateIncident,
} from "./actions";

/**
 * The client controls of the live incidents surface (S7.4 T6, D546 — the
 * `SlosEditor.tsx` shape): the new-incident form in its two modes (blank, or
 * promoted from one of this workspace's own alert events), the per-card delete
 * on the list (D529 — a capped workspace must be able to get under the cap
 * without opening 500 details), and the detail's controls: edit, resolve,
 * reopen, delete. Every mutation is a server action next door, and its answer
 * is either the store's own sentence (D430, printed VERBATIM — this file
 * authors none of them) or the fresh row, after which `router.refresh()`
 * re-reads the page.
 *
 * No `@/mock/` import (D391) and nothing from `@/server/*` — the prop types
 * come from `@/lib/incident-types`, which is why `PromotableAlertEvent` lives
 * there (D541).
 *
 * INSTANTS. The store bounds every instant against the SERVER clock and stamps
 * a blank end itself (D527); this form's only job is to say which zone the
 * text it accepts is read in, and to never send an instant whose zone it did
 * not state. Every instant field is labelled UTC, is prefilled through the
 * shipped `formatIncidentClock` (no hand-rolled clock), and is parsed by
 * `isoFromField` below, which reads `YYYY-MM-DD HH:MM[:SS][ UTC]` as UTC.
 */
const NO_WORKSPACE = "incidents belong to a workspace, and this session has none";
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

/** One runner for every action: the store's sentence, or a refresh (D429). */
function useIncidentMutation() {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const call = (work: () => Promise<{ refused: string } | object | null | undefined>, accepted?: () => void) =>
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
        console.error("[incidents] mutation", failure);
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

// ---- instants: the zone is stated, and an unstated one is never sent ---------

/** `YYYY-MM-DD HH:MM`, optionally `:SS`, optionally the ` UTC` suffix the
 *  prefill carries (or a `Z`). Read as UTC — the zone every label states. */
const FIELD_INSTANT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\s*UTC|Z)?$/i;
/** Text that carries its OWN zone designator is read in that zone. */
const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The field's text → the ISO instant the action sends, or `""` when the text
 * names none.
 *
 * Anything that is neither the stated shape nor explicitly zoned is sent EMPTY
 * rather than raw, on purpose: `Date.parse` reads a zone-less date-time in the
 * parser's LOCAL zone (the ES spec's rule), and the store parses on the
 * SERVER — so a raw `2026-09-04T13:04` handed through would silently become
 * the server's 13:04, which is the D179 confusion the UTC label exists to
 * prevent. The store refuses the empty string with its own sentence (`the
 * start time must be an ISO instant`), which this file prints verbatim.
 *
 * Exported so the rule can be proven without a browser.
 */
export function isoFromField(text: string): string {
  const trimmed = text.trim();
  const stated = FIELD_INSTANT.exec(trimmed);
  const ms = stated
    ? Date.parse(`${stated[1]}T${stated[2]}:${stated[3] ?? "00"}Z`)
    : EXPLICIT_ZONE.test(trimmed)
      ? Date.parse(trimmed)
      : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

// ---- the form (create and edit are the one form) ----------------------------------

type Draft = {
  title: string;
  severity: IncidentSeverity;
  summary: string;
  impact: string;
  /** The field's text — prefilled through `formatIncidentClock` on an edit. */
  startedAt: string;
  /**
   * Whether the operator touched the start field. An UNTOUCHED edit re-sends
   * the row's own `startedAt` byte for byte: the prefill renders whole
   * seconds, and a promoted incident's start is the event's `created_at` with
   * its sub-second part — re-deriving it from the field would move the start
   * by up to 999 ms on every title edit, which is a write the operator never
   * made.
   */
  startedAtTouched: boolean;
};

/** The middle grade is pre-selected: the column carries no DEFAULT, so a manual
 *  create must send one (D525). A blank start means "now" — the submit's own
 *  clock, bounded by the store's skew check — and the label says so. */
const EMPTY_DRAFT: Draft = {
  title: "",
  severity: "warning",
  summary: "",
  impact: "",
  startedAt: "",
  startedAtTouched: false,
};

function draftFrom(incident: IncidentRow): Draft {
  return {
    title: incident.title,
    severity: incident.severity,
    summary: incident.summary,
    impact: incident.impact,
    startedAt: formatIncidentClock(incident.startedAt),
    startedAtTouched: false,
  };
}

/** The start the action sends. The clock is sampled in the submit handler and
 *  nowhere in render: a blank start on a NEW incident is the moment the
 *  operator pressed the button. */
function startedAtFrom(draft: Draft, incident: IncidentRow | null): string {
  if (incident !== null && !draft.startedAtTouched) return incident.startedAt;
  if (incident === null && draft.startedAt.trim() === "") return new Date().toISOString();
  return isoFromField(draft.startedAt);
}

function IncidentForm({ incident, onDone }: { incident: IncidentRow | null; onDone: () => void }) {
  const { notice, pending, call } = useIncidentMutation();
  const [draft, setDraft] = useState<Draft>(incident ? draftFrom(incident) : EMPTY_DRAFT);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = {
      title: draft.title,
      severity: draft.severity,
      summary: draft.summary,
      impact: draft.impact,
      startedAt: startedAtFrom(draft, incident),
    };
    call(() => (incident ? updateIncident(incident.id, input) : createIncident(input)), onDone);
  };

  return (
    <form onSubmit={submit} className="mt-2 rounded-lg border border-line bg-raised p-3.5">
      <div className="grid gap-2.5 sm:grid-cols-3">
        <label className={`${LABEL} sm:col-span-2`}>
          title
          <input
            className={FIELD}
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="what is broken, in one line"
            required
          />
        </label>
        <label className={LABEL}>
          severity
          <select
            className={FIELD}
            value={draft.severity}
            onChange={(e) => set("severity", e.target.value as IncidentSeverity)}
          >
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={`${LABEL} sm:col-span-3`}>
          summary (optional)
          <textarea
            className={`${FIELD} min-h-[64px]`}
            value={draft.summary}
            onChange={(e) => set("summary", e.target.value)}
            placeholder="what happened, as far as is known"
          />
        </label>
        <label className={`${LABEL} sm:col-span-2`}>
          impact (optional — only what was measured)
          <input
            className={FIELD}
            value={draft.impact}
            onChange={(e) => set("impact", e.target.value)}
            placeholder="who or what was affected, and how much"
          />
        </label>
        <label className={LABEL}>
          {incident ? "started at (UTC)" : "started at (UTC, blank = now)"}
          <input
            className={FIELD}
            value={draft.startedAt}
            onChange={(e) => setDraft((d) => ({ ...d, startedAt: e.target.value, startedAtTouched: true }))}
            placeholder="YYYY-MM-DD HH:MM"
            required={incident !== null}
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={pending}>
          {incident ? "save incident" : "declare incident"}
        </button>
        <button type="button" className={QUIET} onClick={onDone} disabled={pending}>
          cancel
        </button>
      </div>
      <Notice text={notice} />
    </form>
  );
}

// ---- promotion: an incident FROM one of this workspace's alert events --------

function PromoteForm({ promotable, onDone }: { promotable: PromotableAlertEvent[]; onDone: () => void }) {
  const { notice, pending, call } = useIncidentMutation();
  const [eventId, setEventId] = useState(promotable[0]?.id ?? "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    call(() => promoteAlertEvent(eventId), onDone);
  };

  return (
    <form onSubmit={submit} className="mt-2 rounded-lg border border-line bg-raised p-3.5">
      {promotable.length === 0 ? (
        <p className="font-mono text-[11.5px] text-mid">no alert events to promote</p>
      ) : (
        <label className={LABEL}>
          alert event
          <select className={FIELD} value={eventId} onChange={(e) => setEventId(e.target.value)}>
            {promotable.map((e) => (
              <option key={e.id} value={e.id}>
                {formatIncidentClock(e.at)} · {e.severity} · {e.title}
                {e.producer ? ` · ${e.producer}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="mt-2 font-mono text-[10.5px] text-faint">
        the incident takes the event&apos;s title, severity, detail and time; impact stays empty until someone
        measures it
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={pending || promotable.length === 0}>
          promote to incident
        </button>
        <button type="button" className={QUIET} onClick={onDone} disabled={pending}>
          cancel
        </button>
      </div>
      <Notice text={notice} />
    </form>
  );
}

type NewMode = "blank" | "alert";

/** One form, two modes: a blank incident, or one promoted from an alert event. */
function NewIncidentForm({ promotable, onDone }: { promotable: PromotableAlertEvent[]; onDone: () => void }) {
  const [mode, setMode] = useState<NewMode>("blank");
  const tab = (value: NewMode, label: string) => (
    <button
      type="button"
      className={`rounded-md border px-2.5 py-1 font-mono text-[11px] ${
        mode === value ? "border-line-strong bg-raised text-ink" : "border-line text-faint hover:text-ink"
      }`}
      aria-pressed={mode === value}
      onClick={() => setMode(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        {tab("blank", "blank")}
        {tab("alert", "from an alert")}
      </div>
      {mode === "blank" ? (
        <IncidentForm incident={null} onDone={onDone} />
      ) : (
        <PromoteForm promotable={promotable} onDone={onDone} />
      )}
    </div>
  );
}

export function NewIncidentButton({ promotable }: { promotable: PromotableAlertEvent[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-right">
      <button type="button" className={BUTTON} onClick={() => setOpen((o) => !o)}>
        {open ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        {open ? "close" : "New incident"}
      </button>
      {open && (
        <div className="text-left">
          <NewIncidentForm promotable={promotable} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// ---- the controls ------------------------------------------------------------------

/** The consequence, named on the control: an incident's text is the only copy
 *  of something no machine regenerates (D528), and retention never sweeps it. */
const DELETE_TITLE = "delete incident — its title, summary and impact are the only copy";

/** The list card's one control (D529): delete, then the list read recomputes
 *  its own header. */
export function IncidentCardControls({ incident }: { incident: IncidentRow }) {
  const { notice, pending, call } = useIncidentMutation();
  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        className={ICON_BUTTON}
        title={DELETE_TITLE}
        onClick={() => call(() => deleteIncident(incident.id))}
        disabled={pending}
      >
        <Trash2 className="h-3 w-3" />
      </button>
      <Notice text={notice} />
    </div>
  );
}

/** The detail's controls: edit, resolve or reopen (whichever the state
 *  allows), delete — which leaves the page, since the row is gone (D543). */
export function IncidentControls({ incident }: { incident: IncidentRow }) {
  const router = useRouter();
  const { notice, pending, call } = useIncidentMutation();
  const [editing, setEditing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [endedAt, setEndedAt] = useState("");

  const resolve = (event: FormEvent) => {
    event.preventDefault();
    const text = endedAt.trim();
    // Blank is sent as NULL and the SERVER stamps the end (D527) — never this
    // browser's clock. Typed text goes through the one parser, zone stated.
    call(
      () => resolveIncident(incident.id, text === "" ? null : isoFromField(text)),
      () => setResolving(false),
    );
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={ICON_BUTTON}
          title="edit incident"
          onClick={() => setEditing((e) => !e)}
          disabled={pending}
        >
          <Pencil className="h-3 w-3" />
        </button>
        {incident.status === "ongoing" ? (
          <button type="button" className={BUTTON} onClick={() => setResolving((r) => !r)} disabled={pending}>
            <CircleCheck className="h-3.5 w-3.5" />
            {resolving ? "keep ongoing" : "resolve"}
          </button>
        ) : (
          <button type="button" className={BUTTON} onClick={() => call(() => reopenIncident(incident.id))} disabled={pending}>
            <RotateCcw className="h-3.5 w-3.5" />
            reopen
          </button>
        )}
        <button
          type="button"
          className={ICON_BUTTON}
          title={DELETE_TITLE}
          onClick={() => call(() => deleteIncident(incident.id), () => router.push("/app/incidents"))}
          disabled={pending}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {resolving && (
        <form onSubmit={resolve} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-raised p-3">
          <label className={LABEL}>
            ended at (UTC, blank = now, stamped by the server)
            <input
              className={FIELD}
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              placeholder="YYYY-MM-DD HH:MM"
            />
          </label>
          <button type="submit" className={BUTTON} disabled={pending}>
            mark resolved
          </button>
        </form>
      )}

      <Notice text={notice} />
      {editing && <IncidentForm incident={incident} onDone={() => setEditing(false)} />}
    </div>
  );
}
