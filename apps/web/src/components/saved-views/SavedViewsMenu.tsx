"use client";

import { useState, type FormEvent } from "react";
import { Bookmark, ChevronDown, X } from "lucide-react";
import { deleteView, listViews, saveView } from "./actions";
import type { SavedView, SavedViewFilters, SavedViewSurface } from "@/server/saved-views";

/**
 * The create / delete / apply control for saved views, shared by the traces
 * filter bar and the logs explorer (D47(v)).
 *
 * Persistence lives entirely in `@/server/saved-views`, reached through the
 * server actions next door — this component holds no second copy and writes no
 * storage of its own. Views are workspace-scoped rows now (D30/D116), so what
 * this menu lists is what everyone signed into the workspace lists.
 *
 * The prop contract both consumers implement (D47(v)):
 * - `surface` — which surface's views these are; the only thing the client names.
 * - `filters` — the surface's current filter object, exactly the parameters it
 *   puts in the URL (string → string). The store drops the `page` key by that
 *   literal name, so a paginated surface must call its page parameter `page`.
 * - `onApply` — receives the view's WHOLE filter set. The surface owns the URL,
 *   this menu never navigates; applying REPLACES the surface's filter state
 *   (a key the view does not carry is a filter that ends up unset) and returns
 *   to the first page, because a view is a complete filter set and never a page.
 *
 * Views load when the menu opens, never during render: an open menu shows what
 * the workspace holds right now rather than what it held when the page was
 * rendered, and a closed menu costs no round trip.
 *
 * Three answers, three honest states — `views` is null until there is a list to
 * show, and `notice` says why when there is not. An empty list would otherwise
 * read as "this workspace has saved nothing yet" for a session that has no
 * workspace at all (mock mode) or for a store that refused the read.
 */
export function SavedViewsMenu({
  surface,
  filters,
  onApply,
}: {
  surface: SavedViewSurface;
  filters: SavedViewFilters;
  onApply: (filters: SavedViewFilters) => void;
}) {
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  /** A call that answered: the workspace's views, or null when it has none. */
  const accept = (listed: SavedView[] | null) => {
    setViews(listed);
    setNotice(listed === null ? "Saved views belong to a workspace, and this session has none." : null);
  };

  const load = async () => {
    setNotice(null);
    try {
      accept(await listViews(surface));
    } catch {
      // The reason stays in the server log; a failed read is one sentence here
      // rather than a menu that looks like an empty workspace (D21).
      setViews(null);
      setNotice("Saved views could not be loaded.");
    }
  };

  const toggle = () => {
    if (!open) void load();
    setOpen(!open);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setNotice(null);
    try {
      // Same name as an existing view replaces it — the name is the identity.
      accept(await saveView(surface, trimmed, filters));
      setName("");
    } catch {
      setNotice("That view could not be saved.");
    }
  };

  const remove = async (viewName: string) => {
    setNotice(null);
    try {
      accept(await deleteView(surface, viewName));
    } catch {
      setNotice("That view could not be deleted.");
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink"
      >
        <Bookmark className="h-3.5 w-3.5" />
        saved views
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-line bg-overlay py-1 shadow-xl">
          {views === null && notice === null && (
            <p className="px-3 py-1.5 text-[12px] text-faint">Loading saved views…</p>
          )}
          {notice && <p className="px-3 py-1.5 text-[12px] text-faint">{notice}</p>}
          {views?.length === 0 && (
            <p className="px-3 py-1.5 text-[12px] text-faint">
              No saved views in this workspace yet. Save the filters you are looking at.
            </p>
          )}
          {views?.map((v) => (
            <div key={v.name} className="group flex items-center hover:bg-raised">
              <button
                type="button"
                onClick={() => {
                  onApply(v.filters);
                  setOpen(false);
                }}
                className="min-w-0 flex-1 truncate px-3 py-1.5 text-left text-[12.5px] text-mid group-hover:text-ink"
              >
                {v.name}
              </button>
              <button
                type="button"
                onClick={() => void remove(v.name)}
                aria-label={`Delete view ${v.name}`}
                className="mr-1.5 rounded p-0.5 text-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

          {views !== null && (
            <form onSubmit={create} className="mt-1 border-t border-line px-2 pt-2 pb-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name this view"
                aria-label="Name for the current filters"
                className="w-full rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
              />
              <button
                type="submit"
                disabled={!name.trim()}
                className="mt-1.5 w-full rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] text-mid hover:border-line-strong hover:text-ink disabled:opacity-40 disabled:hover:border-line disabled:hover:text-mid"
              >
                save current filters
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
