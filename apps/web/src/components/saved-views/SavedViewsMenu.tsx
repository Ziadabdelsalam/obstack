"use client";

import { useState, type FormEvent } from "react";
import { Bookmark, ChevronDown, X } from "lucide-react";
import {
  deleteView,
  readSavedViews,
  saveView,
  type SavedView,
  type SavedViewFilters,
  type SavedViewSurface,
} from "@/lib/saved-views";

/**
 * The create / delete / apply control for saved views, shared by the traces
 * filter bar and the logs explorer (D47(v)).
 *
 * Persistence lives entirely in `lib/saved-views` — this component holds no
 * second copy and writes no storage of its own.
 *
 * The prop contract both consumers implement (D47(v)):
 * - `surface` — which namespace inside the one key the views come from.
 * - `filters` — the surface's current filter object, exactly the parameters it
 *   puts in the URL (string → string). Saving drops the `page` key by that
 *   literal name, so a paginated surface must call its page parameter `page`.
 * - `onApply` — receives the view's WHOLE filter set. The surface owns the URL,
 *   this menu never navigates; applying REPLACES the surface's filter state
 *   (a key the view does not carry is a filter that ends up unset) and returns
 *   to the first page, because a view is a complete filter set and never a page.
 *
 * Views load when the menu opens, never during render — the app server-renders
 * and there is no `localStorage` there — so an open menu also shows what the
 * browser holds right now, not what it held at mount.
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
  const [views, setViews] = useState<SavedView[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const toggle = () => {
    if (!open) setViews(readSavedViews(surface));
    setOpen(!open);
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Same name as an existing view replaces it — the name is the identity.
    setViews(saveView(surface, trimmed, filters));
    setName("");
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
          {views.length === 0 && (
            <p className="px-3 py-1.5 text-[12px] text-faint">
              No saved views yet. Save the filters you are looking at.
            </p>
          )}
          {views.map((v) => (
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
                onClick={() => setViews(deleteView(surface, v.name))}
                aria-label={`Delete view ${v.name}`}
                className="mr-1.5 rounded p-0.5 text-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

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
        </div>
      )}
    </div>
  );
}
