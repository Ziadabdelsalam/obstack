/**
 * The frozen changes contract (S7.2 packet §0 + D499).
 *
 * CLIENT-SAFE by the `metrics-types.ts` rule (D366): the timeline and the
 * services deploys panel type their props from here, and a client component
 * cannot import a `server-only` module for a type alone (S1.5/D10). This file
 * carries no imports and one plain data constant.
 *
 * `ChangeKind` is the ONE TypeScript definition of the six kinds. The Go side
 * (`services/ingest/internal/changes/document.go`, the validator that writes
 * the rows) and the docs field table carry the same six; the D499
 * source-parsing test (`lib/change-types.test.ts`) pins all three to each
 * other so none can drift.
 */

/** The six kinds, verbatim from the mock (`mock/changes.ts`). */
export type ChangeKind = "deploy" | "config" | "scale" | "secret" | "flag" | "infra";

/** The kinds as a value, for the style table and the pin test. */
export const CHANGE_KINDS: readonly ChangeKind[] = ["deploy", "config", "scale", "secret", "flag", "infra"];

/** An outbound reference into the source system — a workflow run, a commit.
 *  Never a product-internal route: the endpoint refuses anything but an
 *  absolute http(s) URL (D499), and the timeline renders it as an external
 *  anchor. */
export interface ChangeLink {
  label: string;
  href: string;
}

/** `listChangeEvents(ws, limit)` row, newest-first by the event's own time. */
export interface ChangeEventRow {
  id: string;
  kind: ChangeKind;
  /** ISO UTC — the event's own time (`at`), not receipt. */
  at: string;
  title: string;
  /** "" when the source sent none. */
  detail: string;
  /** "" when the source sent none. */
  who: string;
  /** The trace-derived service name this event is about, or null. */
  service: string | null;
  /** A sha, tag or version, or null. */
  ref: string | null;
  /** Where the event came from (`github-actions`), or null. */
  source: string | null;
  link: ChangeLink | null;
}

/** `listServiceDeploys(ws, service, limit)` row — the services deploys panel
 *  (D503): this service's `deploy` events, newest-first. */
export interface ServiceDeployRow {
  id: string;
  ref: string | null;
  /** ISO UTC. */
  at: string;
  who: string;
  title: string;
  link: ChangeLink | null;
}
