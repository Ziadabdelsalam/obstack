"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import {
  MAX_DASHBOARDS,
  MAX_NAME_CHARS,
  MAX_WIDGETS_PER_DASHBOARD,
  type Dashboard,
  type DashboardActionResult,
  type WidgetLoad,
} from "@/lib/dashboard-types";
import type { MetricCatalogEntry } from "@/lib/metrics-types";
import { AddWidgetLive } from "./AddWidgetLive";
import { WidgetLive } from "./WidgetLive";
import {
  createDashboard,
  deleteDashboard,
  moveWidget,
  removeWidget,
  renameDashboard,
  setWidgetPinned,
} from "./actions";

/**
 * The client controls of the live dashboards surface (D428) — the create form
 * the list page shows, and the per-dashboard editor the detail page shows. They
 * share one file because they share one runner: every mutation is a server
 * action next door, and its answer is either the store's own sentence (D430,
 * printed VERBATIM — this file authors none of them) or the fresh row, after
 * which `router.refresh()` re-reads the page so what the screen shows is what
 * the store holds and not a second copy of it.
 *
 * No `@/mock/`, no `workspace-store`: the mock dashboards keep their in-memory
 * store, this one keeps Postgres, and neither knows about the other (D391).
 */

/** The two answers that are not the store's sentence: no workspace, and no answer at all. */
const NO_WORKSPACE = "dashboards belong to a workspace, and this session has none";
const UNREACHABLE = "that change could not be confirmed — reload to see what the store holds";

const FIELD =
  "rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none";
const BUTTON =
  "flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12px] text-ink hover:bg-overlay disabled:opacity-40 disabled:hover:bg-raised";
const QUIET =
  "rounded-md border border-line px-3 py-1.5 font-mono text-[12px] text-faint hover:text-ink disabled:opacity-40";
const ICON_BUTTON =
  "rounded border border-line p-1 text-faint hover:border-line-strong hover:text-ink disabled:opacity-40 disabled:hover:border-line disabled:hover:text-faint";

/** One runner for every action: the store's sentence, or the fresh row (D429). */
function useDashboardMutation() {
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const call = (
    work: () => Promise<DashboardActionResult>,
    accepted?: (dashboard: Dashboard) => void,
  ) =>
    run(async () => {
      try {
        const result = await work();
        if (result === null) return setNotice(NO_WORKSPACE);
        // A refusal is the store's sentence and nothing else — this component
        // never rewords it, and never dresses a real failure up as one.
        if ("refused" in result) return setNotice(result.refused);
        setNotice(null);
        accepted?.(result.dashboard);
      } catch (failure) {
        console.error("[dashboards] mutation", failure);
        setNotice(UNREACHABLE);
      }
    });

  return { notice, setNotice, pending, run, call };
}

function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="font-mono text-[11px] text-warn">{text}</p>;
}

/** Create a dashboard and go straight to it — an empty one is only useful open. */
export function CreateDashboardForm({ full }: { full: boolean }) {
  const router = useRouter();
  const { notice, pending, call } = useDashboardMutation();
  const [name, setName] = useState("");

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    call(
      () => createDashboard(name),
      (dashboard) => {
        setName("");
        router.push(`/app/dashboards/${dashboard.id}`);
      },
    );
  };

  return (
    <form onSubmit={create} className="mb-4 flex flex-wrap items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name a new dashboard"
        aria-label="Name for the new dashboard"
        maxLength={MAX_NAME_CHARS}
        className={`${FIELD} w-56`}
      />
      <button type="submit" disabled={pending || full || !name.trim()} className={BUTTON}>
        <Plus className="h-3.5 w-3.5" />
        New dashboard
      </button>
      {/* D402/D430: the cap speaks in the sentence the store would refuse with. */}
      {full && (
        <p className="font-mono text-[11px] text-warn">
          workspace limit reached ({MAX_DASHBOARDS} dashboards)
        </p>
      )}
      <Notice text={notice} />
    </form>
  );
}

export function DashboardEditor({
  dashboard,
  catalog,
  loads,
}: {
  dashboard: Dashboard;
  catalog: MetricCatalogEntry[];
  loads: WidgetLoad[];
}) {
  const router = useRouter();
  const { notice, setNotice, pending, run, call } = useDashboardMutation();
  const [editing, setEditing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(dashboard.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const widgets = dashboard.widgets;
  const full = widgets.length >= MAX_WIDGETS_PER_DASHBOARD;

  /** The page's own read is the one definition of what this dashboard holds. */
  const change = (work: () => Promise<DashboardActionResult>) => call(work, () => router.refresh());

  const rename = (event: FormEvent) => {
    event.preventDefault();
    call(
      () => renameDashboard(dashboard.id, name),
      () => {
        setRenaming(false);
        router.refresh();
      },
    );
  };

  // Delete answers with the fresh LIST, not a row, so it does not share the
  // runner above — and it asks first, because a dashboard is not recoverable.
  const drop = () =>
    run(async () => {
      try {
        const list = await deleteDashboard(dashboard.id);
        if (list === null) return setNotice(NO_WORKSPACE);
        router.push("/app/dashboards");
      } catch (failure) {
        console.error("[dashboards] delete", failure);
        setNotice(UNREACHABLE);
      }
    });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {editing && (
          <button type="button" onClick={() => setShowAdd(true)} disabled={pending} className={BUTTON}>
            <Plus className="h-3.5 w-3.5" />
            Add widget
          </button>
        )}
        {editing && !renaming && (
          <button
            type="button"
            onClick={() => {
              setName(dashboard.name);
              setRenaming(true);
            }}
            disabled={pending}
            className={QUIET}
          >
            Rename
          </button>
        )}
        {editing && renaming && (
          <form onSubmit={rename} className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="New name for this dashboard"
              maxLength={MAX_NAME_CHARS}
              className={`${FIELD} w-56`}
            />
            <button type="submit" disabled={pending} className={BUTTON}>
              Save name
            </button>
            <button type="button" onClick={() => setRenaming(false)} className={QUIET}>
              Cancel
            </button>
          </form>
        )}
        {editing && !confirmDelete && (
          <button type="button" onClick={() => setConfirmDelete(true)} disabled={pending} className={QUIET}>
            <span className="flex items-center gap-1.5">
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </span>
          </button>
        )}
        {editing && confirmDelete && (
          <span className="flex items-center gap-2 font-mono text-[11.5px] text-mid">
            delete {dashboard.name} and its {widgets.length} widget
            {widgets.length === 1 ? "" : "s"}?
            <button type="button" onClick={drop} disabled={pending} className={QUIET}>
              yes, delete
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={QUIET}>
              keep it
            </button>
          </span>
        )}

        <button
          type="button"
          onClick={() => {
            setEditing((e) => !e);
            setRenaming(false);
            setConfirmDelete(false);
          }}
          className={`${QUIET} ml-auto`}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>

      <div className="mb-3">
        <Notice text={notice} />
      </div>

      {widgets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-8 text-center">
          <p className="font-mono text-[12.5px] text-faint">no widgets yet — add one</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {widgets.map((w, i) => (
            <div key={w.id}>
              <WidgetLive widget={w} load={loads[i]} />
              {editing && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => change(() => moveWidget(dashboard.id, w.id, "up"))}
                    disabled={pending || i === 0}
                    aria-label={`Move ${w.title} up`}
                    className={ICON_BUTTON}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => change(() => moveWidget(dashboard.id, w.id, "down"))}
                    disabled={pending || i === widgets.length - 1}
                    aria-label={`Move ${w.title} down`}
                    className={ICON_BUTTON}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  {/* D425: the overview is a view over this flag, per widget. */}
                  <button
                    type="button"
                    onClick={() => change(() => setWidgetPinned(dashboard.id, w.id, !w.pinned))}
                    disabled={pending}
                    className={`${QUIET} flex items-center gap-1.5 px-2 py-1 text-[11px]`}
                  >
                    {w.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    {w.pinned ? "unpin from overview" : "pin to overview"}
                  </button>
                  <button
                    type="button"
                    onClick={() => change(() => removeWidget(dashboard.id, w.id))}
                    disabled={pending}
                    aria-label={`Remove ${w.title}`}
                    className={`${ICON_BUTTON} ml-auto`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddWidgetLive
          dashboardId={dashboard.id}
          catalog={catalog}
          full={full}
          onAdded={() => {
            setShowAdd(false);
            router.refresh();
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
    </>
  );
}
