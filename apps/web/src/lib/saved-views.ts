/**
 * Saved views, persisted per browser in `localStorage` (D30, user-signed).
 *
 * This is the ONE module that owns saved-view persistence: one key,
 * `obstack.saved-views`, holding one versioned envelope with a namespace per
 * surface (D47). Every consumer — `SavedViewsMenu`, the traces bar, the logs
 * explorer — goes through these functions; nothing else reads or writes the key.
 *
 * M3-GATE: M3 replaces this with workspace-scoped views in Postgres (PRD §6).
 * When it lands, this module and the `obstack.saved-views` key are DELETED
 * outright — no dual store, no migration layer. Until then a view lives in one
 * browser and no string here or in the UI may call it workspace-scoped.
 *
 * Pure functions outside `src/server/` — the `live-routes.ts` / `nearby-logs.ts`
 * precedent — so a client component imports them directly. SSR-safe: nothing
 * touches `localStorage` at import, and storage that is absent, denied, full or
 * holding a corrupt blob degrades to "no saved views" rather than throwing into
 * the page (a private-mode browser is a real user).
 */

/** The one key. M3 deletes it by this name. */
export const SAVED_VIEWS_STORAGE_KEY = "obstack.saved-views";

/** Envelope version. Anything else on disk reads as absent. */
const ENVELOPE_VERSION = 1;

/**
 * A view is a question, not a position in a result set — the page never
 * persists (D47(ii)). The strip is by LITERAL KEY, so this module is the one
 * definition of that name (D53): a surface that paginates imports `PAGE_PARAM`
 * for its URL parameter instead of writing "page" again. Hand-rolling the
 * literal and drifting from it persists the page into the view and reopens the
 * view on a stale page number.
 */
export const PAGE_PARAM = "page";

/** The surfaces that keep views; each is a namespace inside the one envelope. */
export type SavedViewSurface = "traces" | "logs";

/**
 * A view's filters are its surface's URL parameters — the same shape the URL
 * serializes (`Object.fromEntries(searchParams)`: one string value per key), so
 * applying a view is setting the URL: one state, not two. A view holds the
 * surface's WHOLE filter set, time range included, so applying one REPLACES the
 * surface's filter state rather than patching it — a key the view does not
 * carry is a filter the view does not set (D47(ii)).
 */
export type SavedViewFilters = Record<string, string>;

/** Name is the identity within a surface: saving over a name replaces that view. */
export interface SavedView {
  name: string;
  filters: SavedViewFilters;
}

interface SavedViewsEnvelope {
  version: number;
  traces: SavedView[];
  logs: SavedView[];
}

function emptyEnvelope(): SavedViewsEnvelope {
  return { version: ENVELOPE_VERSION, traces: [], logs: [] };
}

/**
 * The storage object, or null when there is none to use. The `typeof` guard
 * covers the server render; the catch covers browsers that throw on the access
 * itself when storage is denied.
 */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isSavedView(value: unknown): value is SavedView {
  if (typeof value !== "object" || value === null) return false;
  const view = value as { name?: unknown; filters?: unknown };
  if (typeof view.name !== "string" || view.name === "") return false;
  if (typeof view.filters !== "object" || view.filters === null || Array.isArray(view.filters)) {
    return false;
  }
  return Object.values(view.filters as Record<string, unknown>).every((v) => typeof v === "string");
}

function isViewList(value: unknown): value is SavedView[] {
  return Array.isArray(value) && value.every(isSavedView);
}

/** Anything this module did not write — bad JSON, unknown version, wrong shape — reads as absent. */
function readEnvelope(): SavedViewsEnvelope {
  const store = storage();
  if (!store) return emptyEnvelope();

  let raw: string | null;
  try {
    raw = store.getItem(SAVED_VIEWS_STORAGE_KEY);
  } catch {
    return emptyEnvelope();
  }
  if (!raw) return emptyEnvelope();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyEnvelope();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyEnvelope();

  const envelope = parsed as Partial<SavedViewsEnvelope>;
  if (envelope.version !== ENVELOPE_VERSION) return emptyEnvelope();
  if (!isViewList(envelope.traces) || !isViewList(envelope.logs)) return emptyEnvelope();
  return { version: ENVELOPE_VERSION, traces: envelope.traces, logs: envelope.logs };
}

/** True only when the browser actually took the write. */
function writeEnvelope(envelope: SavedViewsEnvelope): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    // Denied or over quota — nothing persisted, and the caller reports what did.
    return false;
  }
}

function withEnvelopeSurface(
  envelope: SavedViewsEnvelope,
  surface: SavedViewSurface,
  views: SavedView[],
): SavedViewsEnvelope {
  return surface === "traces" ? { ...envelope, traces: views } : { ...envelope, logs: views };
}

/** The surface's persisted views, oldest first. Empty when there is no usable storage. */
export function readSavedViews(surface: SavedViewSurface): SavedView[] {
  return readEnvelope()[surface];
}

/**
 * Create `name` on `surface`, or replace the view already holding that name.
 * `filters` is stored whole — every filter the surface has, time range included
 * — minus the `page` key, which is dropped (D47(ii); see `PAGE_PARAM`: the drop
 * is by that literal key, so a caller's page parameter must be named `page`).
 *
 * Returns the views that are actually persisted — on a refused write that is
 * the list from before the call, never the optimistic one (a menu must not
 * offer a view the browser dropped).
 */
export function saveView(
  surface: SavedViewSurface,
  name: string,
  filters: SavedViewFilters,
): SavedView[] {
  const envelope = readEnvelope();
  const current = envelope[surface];
  const trimmed = name.trim();
  if (!trimmed) return current;

  const stored = { ...filters };
  delete stored[PAGE_PARAM];
  const view: SavedView = { name: trimmed, filters: stored };
  const next = current.some((v) => v.name === trimmed)
    ? current.map((v) => (v.name === trimmed ? view : v))
    : [...current, view];

  return writeEnvelope(withEnvelopeSurface(envelope, surface, next)) ? next : current;
}

/** Drop `name` from `surface`. Returns the views that are actually persisted. */
export function deleteView(surface: SavedViewSurface, name: string): SavedView[] {
  const envelope = readEnvelope();
  const current = envelope[surface];
  const next = current.filter((v) => v.name !== name);
  if (next.length === current.length) return current;

  return writeEnvelope(withEnvelopeSurface(envelope, surface, next)) ? next : current;
}
