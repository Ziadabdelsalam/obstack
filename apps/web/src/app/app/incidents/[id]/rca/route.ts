import type {
  IncidentRow,
  IncidentSubject,
  IncidentTimelineEntry,
  IncidentTimelineRow,
} from "@/lib/incident-types";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import {
  NO_EVIDENCE_DETAIL,
  explainResponse,
  explainSubject,
  getExplain,
  oneEvent,
  overQuotaDetail,
} from "@/server/explain";
import { spendExplainRun } from "@/server/explain/quota";
import { readIncidentTimeline, type StitchedIncidentTimeline } from "@/server/incident-timeline";
import { getIncident } from "@/server/incidents";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { getUsage } from "@/server/usage";

/**
 * One root-cause analysis (S7.4 packet D551/D558): the Explain rail's second
 * subject, on the same counter, in the same frame. POST for the same reason
 * the traces route is — a run is a SPEND (D189), and must not sit behind a URL
 * a prefetch or a back button can replay.
 *
 * This is a SIBLING of `app/app/traces/[id]/explain/route.ts`, not a reuse of
 * it: that route resolves its id through `getTrace` and 404s on a miss, so an
 * incident id there is a 404 by construction, and making it not-404 means a
 * `?kind=` discriminator on a metered POST — two resources behind one spend.
 * Six lines are COPIED from it on purpose (the mock guard, the 401, the scoped
 * resource read, the `unavailable()` check, the spend, the over-quota log) and
 * NOT lifted into a `withExplainRun()` helper: the order below is the artifact
 * being proven, and a helper that owned it would make "does this route check
 * config before it spends" a question about a file the reviewer is not in.
 * What IS shared is what has one writer by contract — the frame
 * (`explainResponse`) and the over-quota sentence (`overQuotaDetail`).
 *
 * THE ORDER OF RECORD (D558), and each step is where it is because of what the
 * one after it costs:
 *
 *   1. mock guard — 404 plus the tripwire, above every await; `params` is
 *      never awaited.
 *   2. session — the workspace comes from the cookie, never the URL.
 *   3. the incident — read through the workspace-scoped store; a bogus id and
 *      another tenant's id are the same 404 through the same one statement.
 *   4. THE STITCH — the same three-store read the incident page renders
 *      (D539), with the same `forWorkspace` facade and the plan row's
 *      `retentionDays`/`planName`. BEFORE the config check and BEFORE the
 *      spend: everything upstream of the increment is free to fail, and
 *      everything downstream is billed on a counter with no refund. A stitch
 *      failure is knowable before the commit; charging for a read we could have
 *      completed first is a worse trade than the one the refund-free counter
 *      already accepted. Its cost to us on a request that ends up refusing is
 *      a bounded window join (the incident's own window, three legs of
 *      `TIMELINE_LEG_CAP`), which is the abuse ceiling.
 *   5. config check — a deployment with no model refuses BEFORE it takes
 *      anyone's run.
 *   6. empty timeline — `no-evidence`, refused free. "Empty" means no READ row:
 *      the synthesized `resolved` entry is the window's closing column, not
 *      evidence. Running a model over nothing is asking it to invent a cause
 *      and billing for the invention. The detail page hides the control when
 *      the timeline is empty, so this is the direct-POST backstop.
 *   7. the atomic increment-or-refuse (`spendExplainRun`), against the SAME
 *      `explain_runs` row a trace's Explain spends (D555): one allowance, one
 *      counter line, one meter, and no migration.
 *   8. the provider, through the one generator both subjects share.
 *
 * A PROVIDER ERROR AFTER STEP 7 IS A COUNTED RUN, exactly as on the traces
 * route, and for the same reason.
 *
 * The order is proven by COUNTER READINGS against a real Postgres
 * (`server/explain/rca.integration.test.ts`), never by a grep on this file —
 * a grep proves the order was typed, not that it holds.
 *
 * Nothing here logs the incident, the timeline, the model's answer or any
 * credential: the only lines this file writes name the workspace and the
 * refusal.
 */

/** The product-internal route a trace entry's link points at (`incident-timeline.ts`). */
const TRACE_ROUTE = "/app/traces/";

/** `decodeURIComponent` that answers null instead of throwing on a segment this route did not author. */
function decoded(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * One stitched entry as the prompt reads it (`IncidentTimelineRow`, D554), or
 * null for the `resolved` entry, which is not a read row.
 *
 * `id` is DERIVED from what the entry exposes, and exactly how is stated here
 * because it is what makes a citation a working link (D553):
 *   - alert and change entries: `key` IS the source row's id (`evt_…`/`chg_…`)
 *     — `incident-timeline.ts` sets `key: row.id` for both — and the detail
 *     page anchors each row on its key, so `eventRef` → `#<id>` lands on it.
 *   - trace entries: the entry's `key` is a synthesized group key
 *     (`trace:<service>:<span>`), not a trace id, so the citable id is the
 *     example trace id the entry's link carries (`/app/traces/<id>`), or null
 *     when the stitch found no example (an empty `trace_id`, which it refuses
 *     to link). `service` is the key's first segment, URL-decoded.
 *
 * ⟨S7.4 T5 PLAN CORRECTION, D577 — D551 says to build the subject "from the
 * stitched timeline's entries", and D554 says `severity` and `service` are
 * SENT; both cannot hold, because `IncidentTimelineEntry` carries neither.
 * `incident-timeline.ts`'s own `alertEntry` comment records the choice: the
 * alert's severity is "deliberately NOT composed into the detail" because the
 * RCA row "has both as separate fields" — but the stitch returns only entries,
 * so the RCA row's two fields are never populated from the read that had them
 * (`AlertEventRow.severity`, `ChangeEventRow.service`). This route cannot
 * re-read them: a second window read is a second clock (D534), and a read of
 * the same statement twice is the D171 divergence. So `severity` is null on
 * every row and `service` is set only where the entry exposes it (the trace
 * group key) — an honest absence (the row type allows both nulls and the
 * prompt omits an absent field), never a guess. The fix belongs to the
 * stitcher: `StitchedIncidentTimeline` should carry `rows: IncidentTimelineRow[]`
 * projected from the SAME capped legs, so the prompt and the page read one
 * set. Recorded, not smoothed; this function is the one place to delete when
 * that lands.⟩
 */
export function timelineRowOf(entry: IncidentTimelineEntry): IncidentTimelineRow | null {
  switch (entry.kind) {
    case "alert":
    case "change":
      return {
        kind: entry.kind,
        id: entry.key,
        at: entry.at,
        title: entry.title,
        detail: entry.detail,
        service: null,
        severity: null,
      };
    case "trace": {
      const href = entry.link?.href ?? "";
      const [, service = ""] = entry.key.split(":");
      return {
        kind: "trace",
        id: href.startsWith(TRACE_ROUTE) ? decoded(href.slice(TRACE_ROUTE.length)) : null,
        at: entry.at,
        title: entry.title,
        detail: entry.detail,
        service: decoded(service),
        severity: null,
      };
    }
    case "resolved":
      return null;
  }
}

/**
 * The incident as the rail's subject (D550), built from the row the route read
 * and the timeline it stitched — and nothing else: no workspace name, no
 * account, no other incident, no channel target, no `key_id` (D554's four
 * withholdings hold by projection; `incident-prompt.test.ts` proves it with
 * sentinels). `startedAt` is the window the stitch actually READ, already
 * clipped to the plan's retention floor, which is why it comes from the
 * timeline and not from the incident row.
 */
/** The one id shape `server/incidents.ts` mints: `inc_` + 16 hex. */
const INCIDENT_ID = /^inc_[0-9a-f]{16}$/;

export function incidentSubjectOf(
  incident: IncidentRow,
  timeline: Pick<StitchedIncidentTimeline, "rows" | "windowStartIso" | "windowEndIso">,
): IncidentSubject {
  // D577 closed: the stitcher projects the rows from the SAME capped legs the
  // entries came from, carrying the severity and service the entries do not.
  const rows: IncidentTimelineRow[] = timeline.rows;
  return {
    id: incident.id,
    title: incident.title,
    summary: incident.summary,
    startedAt: timeline.windowStartIso,
    windowEndIso: timeline.windowEndIso,
    rows,
  };
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // 1. Mock mode has no workspace, no Postgres to meter against and no live RCA
  // anywhere (the demo's `IncidentRca` types out a fixture, D556), so a request
  // here came from somewhere no visitor can be — 404 plus the tripwire at error
  // level. A 404 rather than a 401 is what proves neither the auth stack nor
  // the pool was touched: remove this guard and the request reaches
  // `getSessionContext`, which throws on the missing secret.
  if (dataMode === "mock") {
    console.error("[rca] run posted in mock mode — this deployment explains nothing");
    return new Response(null, { status: 404 });
  }

  // 2.
  const session = await getSessionContext();
  if (!session) return new Response(null, { status: 401 });

  // 3.
  const { id } = await params;
  // An id that cannot exist answers exactly as one that does not (D440), and
  // costs no statement: `inc_` + 16 hex is the only shape this product mints.
  // Without this, a NUL byte in the segment reached Postgres as a raw 22021 —
  // a 500 where an unknown id gets a 404 (the T3 class, on the route).
  if (!INCIDENT_ID.test(id)) return new Response(null, { status: 404 });
  const incident = await getIncident(session.workspaceId, id, queryRows);
  if (!incident) return new Response(null, { status: 404 });

  // 4. THE STITCH — before the config check, before the spend.
  const usage = await getUsage(session.workspaceId, queryRows);
  const timeline = await readIncidentTimeline(
    session.workspaceId,
    incident,
    usage.retentionDays,
    usage.planName,
    forWorkspace(session.workspaceId),
    queryRows,
  );
  const subject = incidentSubjectOf(incident, timeline);

  // 5.
  const provider = getExplain();
  const unavailable = provider.unavailable();
  if (unavailable) return explainResponse(oneEvent(unavailable));

  // 6.
  // "Empty" means no row INSIDE the window. The changes lane carries the
  // lead-in band (D535) — the hour BEFORE the window, as context — and a
  // band-only timeline was being counted as evidence, so a run was SPENT on an
  // incident whose window held nothing while `NO_EVIDENCE_DETAIL` was
  // literally true of it (caught by the spend attack in review).
  const evidence = subject.rows.filter((row) => row.at >= subject.startedAt);
  if (evidence.length === 0) {
    // The direct-POST backstop (the page hides the control): a fact worth a
    // line, worded so the e2e drive's log check does not read a product
    // outcome on an authenticated path as a failure (D206).
    console.warn(`[rca] run refused for workspace ${session.workspaceId}: the incident's window holds nothing to read`);
    return explainResponse(oneEvent({ type: "refusal", reason: "no-evidence", detail: NO_EVIDENCE_DETAIL }));
  }

  // 7.
  const run = await spendExplainRun(session.workspaceId, queryRows);
  if (!run.allowed) {
    console.warn(`[rca] run refused for workspace ${session.workspaceId}: plan allowance spent for this month`);
    return explainResponse(
      oneEvent({ type: "refusal", reason: "over-quota", detail: overQuotaDetail(run.quota) }),
    );
  }

  // 8.
  return explainResponse(explainSubject({ kind: "incident", incident: subject }, provider));
}
