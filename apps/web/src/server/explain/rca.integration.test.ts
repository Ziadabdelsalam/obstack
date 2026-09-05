import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module, { createRequire } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@clickhouse/client";
import type { IncidentRow, IncidentSubject, IncidentTimelineEntry } from "@/lib/incident-types";
import type { Trace } from "@/lib/types";
import type { ExplainEvent } from "./contract";
import type { ExplainPrompt, ExplainProvider } from "./types";
import type { StitchedIncidentTimeline } from "@/server/incident-timeline";
import type { SessionContext } from "@/server/session";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// THE D225/D558 ORDER, AS COUNTER READINGS (S7.4 packet D557). The RCA route
// says it checks config before it spends, refuses an empty timeline before it
// spends, and stitches before it spends. A grep on the route source would
// prove those lines were TYPED in that order; this file proves the order
// HOLDS, by driving the real `POST` export against a real Postgres and reading
// `explain_runs` raw after each outcome. The claims:
//
//   (i)   an over-quota run answers a 200 carrying the refusal, and `used`
//         does not move — content-aware: the row is proven present and
//         unchanged, not merely "not obviously wrong".
//   (ii)  a not-configured deployment refuses with NO `explain_runs` row —
//         RED if the config check and the spend swap — and the stitch was
//         asked for THIS workspace before the refusal (step 4 before step 5).
//   (iii) an empty timeline refuses `no-evidence` with no row — RED if the
//         emptiness check sits after the spend. "Empty" is proven against a
//         timeline that holds the synthesized `resolved` entry and nothing
//         else, so the column is shown not to count as evidence.
//   (iv)  a stitch that THROWS leaves no row — the ordering ruling in one
//         assertion: a read that fails before the commit costs the customer
//         nothing.
//   (v)   a trace Explain and an incident RCA on a plan with `explain_quota =
//         2` read `{ used: 2, quota: 2 }`, and a third run OF EITHER KIND is
//         refused — the shared counter stated as one number (D555).
//   (vi)  THE REAL STITCH over the REAL stores, and what the provider is then
//         handed (D554's four withholdings at the route, not at the builder):
//         both Postgres legs and the ClickHouse leg are seeded with sentinels
//         placed in every column that could carry a withheld thing — the
//         channel's `target`, the change's `key_id`, the span's `prompt` /
//         `completion` / `attributes['llm.prompt']` / `status_message`, a
//         log's `body`, another workspace's alert, the alert's product link
//         — and a 200-span error trace; the prompt is captured at the
//         provider seam and grepped. This is the only case that dials
//         ClickHouse, and it does so with the route's own `forWorkspace`.
//
// HOW THE ROUTE IS DRIVEN. `POST` reads its session from the request cookie,
// its stitch from three stores and its provider from the process env, and the
// order under proof is exactly the code between those seams — so the seams are
// what this file replaces, and NOTHING else: `@/server/session` answers a
// fixture session, `@/server/incident-timeline` answers a fixture timeline (or
// throws, or — in (vi) — the REAL stitcher), `@/server/explain`'s `getExplain`
// answers the provider each case names, and `@/server/data`'s facade answers a
// fixture trace for the traces route. Postgres, `getIncident`, `getUsage`,
// `spendExplainRun`, the engine and the fake provider are all REAL. The
// replacement is at the `require` seam (the `ExplainPanel.test.tsx` idiom), so
// every app module below is loaded through ONE CommonJS instance — including
// `@/server/postgres`, whose pool is the one ended at the bottom.
//
// D130's skip class, deliberately NARROW: this file self-skips only when
// `OBSTACK_TEST_POSTGRES_DSN` is UNSET. A DSN naming a dead port or a database
// without `0013_incidents` FAILS here, loudly. Case (vi) additionally skips
// when no ClickHouse answers, the `incident-errors.integration.test.ts`
// precedent — and `web.yml`'s D36 skip trap fails the job on that skip, so it
// executes on every PR.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;
const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;
// Both routes are LIVE-mode code: `dataMode` is resolved once at module load
// and the mock arm answers 404 above every await (D556 — proven in
// `app/signup/mock-mode.test.ts`). Live requires CLICKHOUSE_URL to be NAMED;
// cases (i)–(v) never dial it, because the stitch is the injected seam; (vi)
// dials it as the readonly web user, which is what the route does.
process.env.OBSTACK_DATA_MODE = "live";
process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
process.env.CLICKHOUSE_USER ??= "obstack_web";
process.env.CLICKHOUSE_PASSWORD ??= "obstack_web_dev";
// No credential may reach the Anthropic provider from this process: (ii) builds
// the real `anthropic` provider and asserts it refuses BEFORE it is driven, and
// deleting these is what makes that structural rather than lucky (U6: a test
// never spends).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OBSTACK_EXPLAIN_API_KEY;
delete process.env.OBSTACK_EXPLAIN_BASE_URL;
delete process.env.OBSTACK_EXPLAIN_MODEL;

// ---- the seams -----------------------------------------------------------------

type Stitch = (...args: Parameters<typeof import("@/server/incident-timeline").readIncidentTimeline>) => Promise<StitchedIncidentTimeline>;

const seam: {
  session: SessionContext | null;
  stitch: Stitch | null;
  provider: ExplainProvider | null;
  trace: Trace | null;
} = { session: null, stitch: null, provider: null, trace: null };

/** The REAL stitcher, captured as the seam is installed, for case (vi). */
let realStitch: Stitch | null = null;

const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  const real = origLoad.call(this, request, ...rest) as Record<string, unknown>;
  if (request === "@/server/session") {
    return { ...real, getSessionContext: async () => seam.session };
  }
  if (request === "@/server/incident-timeline") {
    realStitch = real.readIncidentTimeline as Stitch;
    return {
      ...real,
      readIncidentTimeline: (...args: Parameters<Stitch>) => {
        if (!seam.stitch) throw new Error("this case injected no stitch");
        return seam.stitch(...args);
      },
    };
  }
  if (request === "@/server/explain") {
    return {
      ...real,
      getExplain: () => {
        if (!seam.provider) throw new Error("this case injected no provider");
        return seam.provider;
      },
    };
  }
  if (request === "@/server/data") {
    return { ...real, dataForSessionContext: () => ({ getTrace: async () => seam.trace }) };
  }
  return real;
};

const req = createRequire(fileURLToPath(import.meta.url));
const { getPool, queryRows, withTransaction } = req("@/server/postgres") as typeof import("@/server/postgres");
const { createIncident } = req("@/server/incidents") as typeof import("@/server/incidents");
const { createExplainProvider } = req("@/server/explain") as typeof import("@/server/explain");
const { getExplainQuota, spendExplainRun } = req("./quota") as typeof import("./quota");
const { readExplainStream } = req("./contract") as typeof import("./contract");
const { oomTrace } = req("@/mock/stories") as typeof import("@/mock/stories");
const rca = req("@/app/app/incidents/[id]/rca/route") as typeof import("@/app/app/incidents/[id]/rca/route");
const traces = req("@/app/app/traces/[id]/explain/route") as typeof import("@/app/app/traces/[id]/explain/route");

after(async () => {
  if (DSN) await getPool().end();
});

// ---- fixtures ------------------------------------------------------------------

const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`;

/** This month's counter row, read raw — `undefined` when no run was ever counted. */
async function counterRow(workspaceId: string): Promise<{ used: number } | undefined> {
  const [row] = await queryRows<{ used: number }>(
    `SELECT used FROM explain_runs WHERE workspace_id = $1 AND period_start = ${MONTH_START}`,
    [workspaceId],
  );
  return row;
}

/** A fresh workspace with one incident, on a plan of the given quota, dropped afterwards. */
async function withIncident(
  quota: number,
  run: (ws: string, incident: IncidentRow) => Promise<void>,
): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const ws = `ws_rca_${tag}`;
  const planId = `test_rca_${tag}`;
  await queryRows(
    `INSERT INTO plans (id, name, event_quota, retention_days, price_usd_month, explain_quota)
          VALUES ($1, 'RCA (test)', 1000, 7, 0, $2)`,
    [planId, quota],
  );
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [ws, `org_rca_${tag}`]);
  await queryRows(`INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ($1, $2)`, [ws, planId]);
  try {
    const incident = await withTransaction((q) =>
      createIncident(
        ws,
        {
          title: "Checkout latency",
          severity: "warning",
          summary: "",
          impact: "",
          startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        },
        q,
      ),
    );
    seam.session = { userId: `usr_rca_${tag}`, orgId: `org_rca_${tag}`, workspaceId: ws };
    await run(ws, incident);
  } finally {
    seam.session = null;
    seam.stitch = null;
    seam.provider = null;
    seam.trace = null;
    await queryRows(`DELETE FROM workspaces WHERE id = $1`, [ws]);
    await queryRows(`DELETE FROM plans WHERE id = $1`, [planId]);
  }
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** Three read rows — one per leg — in the shape the stitcher emits. */
const readEntries: IncidentTimelineEntry[] = [
  {
    kind: "change",
    at: at(19),
    until: null,
    title: "deploy api v2.3.1",
    detail: "rolled out by CI",
    link: { label: "github", href: "https://example.com/r/1", external: true },
    key: "chg_0123456789abcdef",
  },
  {
    kind: "alert",
    at: at(15),
    until: null,
    title: "checkout p95 over 2s",
    detail: "p95 latency crossed the threshold",
    link: null,
    key: "evt_0123456789abcdef",
  },
  {
    kind: "trace",
    at: at(14),
    until: at(12),
    title: "POST /checkout on api",
    detail: "3 errors · grouped by service and span",
    link: { label: "example trace", href: "/app/traces/a3f8c1d92b6e407f", external: false },
    key: "trace:api:POST%20%2Fcheckout",
  },
];

const resolvedEntry: IncidentTimelineEntry = {
  kind: "resolved",
  at: at(1),
  until: null,
  title: "resolved",
  detail: "",
  link: null,
  key: "resolved",
};

function stitched(entries: IncidentTimelineEntry[], incident: IncidentRow): StitchedIncidentTimeline {
  return {
    entries,
    // D577: the real stitcher projects rows from the capped legs; this double
    // projects them from its entries, which is enough for the order proof —
    // these cases assert on the counter, not on severity/service.
    rows: entries
      .filter((e) => e.kind !== "resolved")
      .map((e) => ({
        kind: e.kind as Exclude<IncidentTimelineEntry["kind"], "resolved">,
        id: e.kind === "trace" ? (e.link?.href.split("/").pop() ?? null) : e.key,
        at: e.at,
        title: e.title,
        detail: e.detail,
        service: null,
        severity: null,
      })),
    omissions: [],
    retentionDays: 7,
    planName: "RCA (test)",
    outsideRetention: false,
    windowStartIso: incident.startedAt,
    windowEndIso: at(0),
    inputClipped: false,
  };
}

/** A stitch that answers the given entries and records what it was asked for. */
function stitchOf(entries: IncidentTimelineEntry[]): { calls: Parameters<Stitch>[]; stitch: Stitch } {
  const calls: Parameters<Stitch>[] = [];
  return {
    calls,
    stitch: async (...args) => {
      calls.push(args);
      return stitched(entries, args[1] as IncidentRow);
    },
  };
}

const postRca = (id: string) =>
  rca.POST(new Request(`https://obstack.dev/app/incidents/${id}/rca`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

const postTrace = (id: string) =>
  traces.POST(new Request(`https://obstack.dev/app/traces/${id}/explain`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

/** The frame, drained, with the route's own warn line captured rather than printed. */
async function drain(response: Response): Promise<ExplainEvent[]> {
  assert.equal(response.status, 200, "a product outcome travels as a 200 carrying a terminal event (D241)");
  assert.ok(response.body, "a streamed response with no body");
  const out: ExplainEvent[] = [];
  for await (const event of readExplainStream(response.body)) out.push(event);
  return out;
}

async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; warned: string[] }> {
  const warned: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    return { value: await run(), warned };
  } finally {
    console.warn = real;
  }
}

const terminal = (events: ExplainEvent[]) => events[events.length - 1];

// ---- the proofs ----------------------------------------------------------------

test("the DSN this run was given answers, and it holds 0013_incidents", { skip }, async () => {
  try {
    assert.deepEqual(
      await queryRows(`SELECT id FROM incidents WHERE workspace_id = $1`, [`ws_rca_absent_${randomBytes(4).toString("hex")}`]),
      [],
    );
  } catch (error) {
    assert.fail(
      `OBSTACK_TEST_POSTGRES_DSN is set but the database did not answer a read of incidents — ` +
        `an integration test with a DSN never degrades to a pass; apply services/ingest/pgmigrations ` +
        `in filename order (0013_incidents among them) and check the port: ${String(error)}`,
    );
  }
});

test("(i) an over-quota run is a 200 carrying the refusal, and `used` does not move", { skip }, async () => {
  await withIncident(1, async (ws, incident) => {
    // The one run this plan includes, spent by the product's own statement.
    assert.deepEqual(await spendExplainRun(ws, queryRows), { allowed: true, quota: 1, used: 1 });
    seam.stitch = stitchOf(readEntries).stitch;
    seam.provider = createExplainProvider("fake");

    const { value: events, warned } = await quietly(async () => drain(await postRca(incident.id)));
    assert.deepEqual(terminal(events), {
      type: "refusal",
      reason: "over-quota",
      detail: "This workspace has used all 1 Explain runs its plan includes this month, so no run was made. The allowance resets at the start of next month; a larger plan raises it.",
    });
    assert.equal(events.length, 1, "a refusal is the whole stream — no delta was streamed before it");
    // Content-aware: the row is present at 1 and STILL 1, not absent and not 2.
    assert.deepEqual(await counterRow(ws), { used: 1 });
    assert.match(warned[0] ?? "", /\[rca\] run refused for workspace ws_rca_/);
  });
});

test("(ii) a not-configured deployment refuses with NO row, after stitching for this workspace", { skip }, async () => {
  await withIncident(2, async (ws, incident) => {
    const { calls, stitch } = stitchOf(readEntries);
    seam.stitch = stitch;
    // The REAL anthropic provider with no credential in the process (deleted
    // above). Asserted to refuse before it is driven: if this line went red,
    // the run below would have reached a model.
    const provider = createExplainProvider("anthropic");
    assert.equal(provider.unavailable()?.reason, "not-configured", "a credential reached this process");
    seam.provider = provider;

    const events = await drain(await postRca(incident.id));
    assert.equal(terminal(events).type, "refusal");
    assert.equal((terminal(events) as Extract<ExplainEvent, { type: "refusal" }>).reason, "not-configured");
    // No row at all: the spend was never reached. Swap steps 5 and 7 in the
    // route and this reads `{ used: 1 }`.
    assert.equal(await counterRow(ws), undefined);
    assert.deepEqual(await getExplainQuota(ws, queryRows), { quota: 2, used: 0 });

    // Step 4 ran before step 5, for THIS workspace, with the row the route
    // read, the plan row's numbers, and the same injected read path — the
    // stitch is not a second tenancy.
    assert.equal(calls.length, 1, "the stitch ran once, before the config check");
    const [wsArg, windowArg, retentionDays, planName, ch, query] = calls[0];
    assert.equal(wsArg, ws);
    assert.equal((windowArg as IncidentRow).id, incident.id);
    assert.equal((windowArg as IncidentRow).startedAt, incident.startedAt);
    assert.equal(retentionDays, 7, "the plan row's retention_days");
    assert.equal(planName, "RCA (test)", "the plan row's name");
    assert.equal(typeof ch.queryRows, "function", "a scoped ClickHouse facade");
    assert.equal(query, queryRows, "the route's own read path, not a second one");
  });
});

test("(iii) an empty timeline refuses `no-evidence` with no row — the resolved column is not evidence", { skip }, async () => {
  await withIncident(2, async (ws, incident) => {
    // The synthesized `resolved` entry and nothing read: if the route counted
    // the column as a row, this would spend and stream a fake answer.
    seam.stitch = stitchOf([resolvedEntry]).stitch;
    seam.provider = createExplainProvider("fake");

    const { value: events, warned } = await quietly(async () => drain(await postRca(incident.id)));
    assert.deepEqual(terminal(events), {
      type: "refusal",
      reason: "no-evidence",
      detail: "This incident's window contains no alerts, changes or traces to read, so there was nothing to analyse and no run was made.",
    });
    assert.equal(events.length, 1);
    // No row: step 6 sits before step 7. Move it after and this reads `{ used: 1 }`.
    assert.equal(await counterRow(ws), undefined);
    assert.match(warned[0] ?? "", /\[rca\] run refused for workspace ws_rca_/);
  });
});

test("(vii) an id that cannot exist answers as one that does not: 404, no stitch, no row — never a 500", { skip }, async () => {
  await withIncident(2, async (ws) => {
    // A NUL byte in the path segment reached Postgres as a raw 22021 — a 500
    // where an unknown id gets a 404 (the T3 class, on the route). The one id
    // shape this product mints is `inc_` + 16 hex; anything else is refused
    // before the read, costing no statement (D440: an id that never existed and
    // one that cannot exist get the same answer).
    const { calls, stitch } = stitchOf(readEntries);
    seam.stitch = stitch;
    seam.provider = createExplainProvider("fake");
    for (const bad of ["inc_\u0000deadbeefdeadbee", "inc_XYZ", "../../etc", "", "inc_0123456789abcdef0"]) {
      const res = await postRca(bad);
      assert.equal(res.status, 404, `id ${JSON.stringify(bad)} did not 404`);
    }
    assert.equal(calls.length, 0, "a malformed id reached the stitch");
    assert.equal(await counterRow(ws), undefined, "a malformed id spent a run");
  });
});

test("(viii) a timeline whose ONLY rows are in the lead-in band is no evidence: refused free, not spent", { skip }, async () => {
  await withIncident(2, async (ws, incident) => {
    // The changes lane carries the hour BEFORE the window as context (D535). A
    // deploy thirty minutes before the incident, with nothing inside the
    // window, was being counted as evidence — the run was SPENT while
    // NO_EVIDENCE_DETAIL was literally true of the incident (caught by the
    // spend attack in review). Band rows are context; evidence is in-window.
    const bandOnly: IncidentTimelineEntry = {
      kind: "change",
      at: at(50), // the incident started at at(20): thirty minutes before it
      until: null,
      title: "deploy api v2.3.0",
      detail: "the release before the incident",
      link: null,
      key: "chg_00000000000000ba",
    };
    assert.ok(bandOnly.at < incident.startedAt, "the fixture's change must precede the window");
    seam.stitch = stitchOf([bandOnly, resolvedEntry]).stitch;
    seam.provider = createExplainProvider("fake");

    const { value: events } = await quietly(async () => drain(await postRca(incident.id)));
    assert.equal(terminal(events)?.type, "refusal");
    assert.equal((terminal(events) as { reason?: string }).reason, "no-evidence");
    assert.equal(await counterRow(ws), undefined, "a band-only timeline spent a run");
  });
});

test("(iv) a stitch that throws leaves NO row — the ordering ruling in one assertion", { skip }, async () => {
  await withIncident(2, async (ws, incident) => {
    seam.stitch = async () => {
      throw new Error("clickhouse: connection refused (simulated)");
    };
    seam.provider = createExplainProvider("fake");

    await assert.rejects(postRca(incident.id), /connection refused \(simulated\)/);
    // The whole of D558 in one reading: a read that fails before the commit
    // costs the customer nothing. Stitch after the spend and this is `{ used: 1 }`,
    // unrefundably, for a run nobody had.
    assert.equal(await counterRow(ws), undefined);
  });
});

test("(v) a trace Explain and an incident RCA are one counter: { used: 2, quota: 2 }, then either kind is refused", { skip }, async () => {
  await withIncident(2, async (ws, incident) => {
    seam.stitch = stitchOf(readEntries).stitch;
    seam.provider = createExplainProvider("fake");
    seam.trace = oomTrace as Trace;

    // One of each kind, both through their real routes and the real engine.
    const traceEvents = await drain(await postTrace(oomTrace.id));
    assert.equal(terminal(traceEvents).type, "result", "the trace Explain answered");
    assert.deepEqual(await counterRow(ws), { used: 1 });

    const rcaEvents = await drain(await postRca(incident.id));
    const answer = terminal(rcaEvents);
    assert.equal(answer.type, "result", "the incident RCA answered");
    assert.deepEqual(await counterRow(ws), { used: 2 });
    assert.deepEqual(await getExplainQuota(ws, queryRows), { quota: 2, used: 2 });

    // The RCA went through the real engine on the real fake, not a canned
    // string: its citations resolved against the ids the stitch handed the
    // route, as incident references (D553) — the change and alert as
    // `eventRef`, the example trace as `traceRef`, and nothing as a span.
    const evidence = answer.type === "result" ? answer.explanation.evidence : [];
    assert.ok(evidence.length >= 2, "the fake cites the timeline it was given");
    assert.ok(evidence.some((item) => item.eventRef === "chg_0123456789abcdef"), "the change is cited as an event");
    assert.ok(evidence.some((item) => item.eventRef === "evt_0123456789abcdef"), "the alert is cited as an event");
    assert.ok(evidence.some((item) => item.traceRef === "a3f8c1d92b6e407f"), "the trace is cited by its example id");
    assert.ok(!evidence.some((item) => item.spanId || item.logRef), "no trace-subject key on an incident");
    // ...and the deltas ARE the answer: the streamed text is the document the
    // result was parsed from, so a stub that only emitted a result would fail.
    const streamed = rcaEvents.filter((e): e is Extract<ExplainEvent, { type: "delta" }> => e.type === "delta");
    assert.ok(streamed.length > 1, "the answer arrived in more than one chunk");
    assert.ok(streamed.map((e) => e.text).join("").includes("HEADLINE: checkout p95 over 2s"));

    // A third run of EITHER kind is refused against the same pair.
    const { value: third } = await quietly(async () => ({
      trace: terminal(await drain(await postTrace(oomTrace.id))),
      rca: terminal(await drain(await postRca(incident.id))),
    }));
    for (const [kind, event] of Object.entries(third)) {
      assert.equal(event.type, "refusal", `${kind}: refused`);
      assert.equal((event as Extract<ExplainEvent, { type: "refusal" }>).reason, "over-quota", kind);
      assert.match(
        (event as Extract<ExplainEvent, { type: "refusal" }>).detail,
        /has used all 2 Explain runs/,
        `${kind}: the same sentence, the same number`,
      );
    }
    assert.deepEqual(await counterRow(ws), { used: 2 }, "the refusals moved nothing");
  });
});

// ---- (vi): the real stitch over the real stores ----------------------------------
//
// `incident-prompt.test.ts` proves the BUILDER reads seven named fields and
// nothing else — a projection proof on an object it is handed. This case proves
// the other half, the one that proof states it cannot: that nothing upstream of
// the builder puts a withheld thing INTO one of those seven fields. The data path
// is alert_events / change_events / obstack.spans → the three legs' SELECTs →
// `IncidentTimelineEntry` → `timelineRowOf` → `IncidentSubject` → the prompt,
// and every hop is real here. Each sentinel sits in the exact column D554 names
// (or the one a reviewer would reach for next), so an absence is a statement
// about a column and not about luck.

const { fakeIncidentDocument } = req("./fake") as typeof import("./fake");

const seedClickHouse = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev",
  database: "obstack",
});

async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seedClickHouse.ping()).success;
  } catch {
    return false;
  }
}

/** `DateTime64(9,'UTC')` wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'`. */
function chInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 19).replace("T", " ")}.${iso.slice(20, 23)}000000`;
}

/**
 * One string per withheld thing, each unique to the column it is seeded into,
 * so a hit names the leak. None of them is customer-shaped text that D554
 * SENDS — the customer's own pasted URL below is deliberately a different
 * string from the channel's `target`.
 */
const WITHHELD = {
  spanPrompt: "SPAN-PROMPT-COLUMN-SENTINEL",
  spanCompletion: "SPAN-COMPLETION-COLUMN-SENTINEL",
  spanAttrPrompt: "SPAN-ATTRIBUTES-LLM-PROMPT-SENTINEL",
  spanStatusMessage: "SPAN-STATUS-MESSAGE-SENTINEL",
  logBody: "LOG-BODY-COLUMN-SENTINEL",
  channelTarget: "https://hooks.slack.com/services/T0/B0/CHANNEL-TARGET-COLUMN-SENTINEL",
  alertLink: "/app/traces/ALERT-LINK-COLUMN-SENTINEL",
  otherWorkspaceAlert: "OTHER-WORKSPACE-ALERT-TITLE-SENTINEL",
  changeWho: "CHANGE-WHO-COLUMN-SENTINEL",
  changeRef: "CHANGE-REF-COLUMN-SENTINEL",
  changeLink: "https://example.com/CHANGE-LINK-HREF-SENTINEL",
} as const;

const CUSTOMER_PASTED_URL = "https://hooks.slack.com/services/CUSTOMER-PASTED-INTO-DETAIL";
const OTHER_INCIDENT_ID = "inc_0000000000000bad";

test("(vi) the real stitch over seeded stores: the seven fields reach the prompt and nothing else does", { skip }, async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${process.env.CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }
  assert.ok(realStitch, "the real stitcher was not captured at the require seam");

  await withIncident(2, async (ws, incident) => {
    const tag = ws.slice("ws_rca_".length);
    const other = `ws_rca_other_${tag}`;
    const channelId = `chan_${tag}00000000`.slice(0, 21);
    const keyId = `key_${tag}000000000000`.slice(0, 20);
    const alertId = `evt_${tag}0000`;
    const changeId = `chg_${tag}0000`;
    const leadInId = `chg_${tag}0001`;
    const otherAlertId = `evt_${tag}0002`;
    const traceId = `rcait${randomBytes(6).toString("hex")}`;
    const secondTraceId = `rcait${randomBytes(6).toString("hex")}`;
    const service = `rca-it-${tag}`;
    const startedMs = Date.parse(incident.startedAt);

    // ---- Postgres: the two event legs, with a withheld thing in every column that has one ----
    await queryRows(
      `INSERT INTO notification_channels (id, workspace_id, name, kind, target) VALUES ($1, $2, 'rca-it', 'slack_webhook', $3)`,
      [channelId, ws, WITHHELD.channelTarget],
    );
    await queryRows(
      `INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash) VALUES ($1, $2, 'rca-it', 'ok_rcait', $3)`,
      [keyId, ws, `rca-it-${tag}-${randomBytes(8).toString("hex")}`],
    );
    await queryRows(
      `INSERT INTO alert_events (id, workspace_id, channel_id, severity, title, detail, link, created_at)
            VALUES ($1, $2, $3, 'critical', 'checkout p95 over 2s', 'p95_ms for service checkout measured 2140ms against a threshold of 2000ms.', $4, $5::timestamptz)`,
      [alertId, ws, channelId, WITHHELD.alertLink, new Date(startedMs + 5 * 60_000).toISOString()],
    );
    await queryRows(
      `INSERT INTO change_events (id, workspace_id, key_id, kind, title, detail, who, service, ref, source, link_label, link_href, at)
            VALUES ($1, $2, $3, 'deploy', 'deploy checkout v2.14.0', $4, $5, 'checkout', $6, 'github-actions', 'run', $7, $8::timestamptz)`,
      [
        changeId,
        ws,
        keyId,
        // Customer text, sent verbatim (clipped at MAX_DETAIL): it names the
        // incident's own id, another incident's id, and a webhook URL the
        // customer pasted. None of these is a withholding — D554 withholds
        // columns obstack selects, not words the customer typed into a column
        // it sends.
        `rolled out by ci; see ${incident.id} and ${OTHER_INCIDENT_ID}; hook ${CUSTOMER_PASTED_URL}`,
        WITHHELD.changeWho,
        WITHHELD.changeRef,
        WITHHELD.changeLink,
        new Date(startedMs + 2 * 60_000).toISOString(),
      ],
    );
    // The lead-in band: a change forty minutes BEFORE the window opened.
    await queryRows(
      `INSERT INTO change_events (id, workspace_id, kind, title, detail, at)
            VALUES ($1, $2, 'config', 'raise checkout pool size', 'pool 20 -> 40', $3::timestamptz)`,
      [leadInId, ws, new Date(startedMs - 40 * 60_000).toISOString()],
    );
    // Another tenant's alert in the same minute.
    await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [other, `org_rca_other_${tag}`]);
    await queryRows(
      `INSERT INTO alert_events (id, workspace_id, severity, title, detail, created_at) VALUES ($1, $2, 'critical', $3, '', $4::timestamptz)`,
      [otherAlertId, other, WITHHELD.otherWorkspaceAlert, new Date(startedMs + 5 * 60_000).toISOString()],
    );

    try {
      // ---- ClickHouse: the trace leg. A 200-span error trace, every span carrying
      // the customer's LLM traffic in the four places it can live, and two logs. ----
      const spanAt = (i: number) => startedMs + 6 * 60_000 + i * 250;
      await seedClickHouse.insert({
        table: "spans",
        format: "JSONEachRow",
        values: [
          ...Array.from({ length: 200 }, (_, i) => ({
            workspace_id: ws,
            trace_id: traceId,
            span_id: `rcaitspan${String(i).padStart(7, "0")}`,
            parent_span_id: i === 0 ? "" : `rcaitspan${String(0).padStart(7, "0")}`,
            name: "POST /v1/chat",
            kind: "client",
            service,
            layer: "llm",
            start_time: chInstant(spanAt(i)),
            duration_ns: "250000000",
            status_code: "error",
            status_message: WITHHELD.spanStatusMessage,
            gen_ai_system: "anthropic",
            prompt: `${WITHHELD.spanPrompt} ${i}`,
            completion: `${WITHHELD.spanCompletion} ${i}`,
            attributes: { "llm.prompt": WITHHELD.spanAttrPrompt, "llm.completion": WITHHELD.spanCompletion },
          })),
          // A second group on the same service: the lane is one line per
          // (service, span name) group, so this is a second line and the 200
          // spans above are one.
          ...Array.from({ length: 2 }, (_, i) => ({
            workspace_id: ws,
            trace_id: secondTraceId,
            span_id: `rcaitspan2${String(i).padStart(6, "0")}`,
            parent_span_id: "",
            name: "GET /v1/models",
            kind: "server",
            service,
            layer: "api",
            start_time: chInstant(spanAt(300 + i)),
            duration_ns: "1000000",
            status_code: "error",
            status_message: WITHHELD.spanStatusMessage,
          })),
        ],
      });
      await seedClickHouse.insert({
        table: "logs",
        format: "JSONEachRow",
        values: Array.from({ length: 2 }, (_, i) => ({
          workspace_id: ws,
          timestamp: chInstant(spanAt(i)),
          trace_id: traceId,
          span_id: `rcaitspan${String(i).padStart(7, "0")}`,
          severity_number: 17,
          severity_text: "ERROR",
          body: `${WITHHELD.logBody} ${i}`,
          service,
          prompt: WITHHELD.spanPrompt,
          completion: WITHHELD.spanCompletion,
        })),
      });

      // ---- the run: the real stitch, and a provider that records what it was handed ----
      seam.stitch = realStitch!;
      let handed: { prompt: ExplainPrompt; subject: IncidentSubject } | null = null;
      seam.provider = {
        mode: "fake",
        unavailable: () => null,
        async *stream(prompt, subject) {
          assert.equal(subject.kind, "incident");
          if (subject.kind !== "incident") return;
          handed = { prompt, subject: subject.incident };
          yield fakeIncidentDocument(subject.incident);
        },
      };

      const events = await drain(await postRca(incident.id));
      assert.equal(terminal(events).type, "result", "the run answered");
      assert.deepEqual(await counterRow(ws), { used: 1 }, "a real run on a real stitch is one counted run");
      assert.ok(handed, "the provider was never handed a prompt");
      const { prompt, subject } = handed as { prompt: ExplainPrompt; subject: IncidentSubject };
      const sent = `${prompt.system}\n${prompt.user}`;

      // ---- what must NOT be there, by the column it was seeded into ----
      for (const [column, sentinel] of Object.entries(WITHHELD)) {
        assert.equal(sent.includes(sentinel), false, `${column} reached the prompt: ${sentinel}`);
      }
      assert.equal(sent.includes(keyId), false, "change_events.key_id reached the prompt");
      assert.equal(sent.includes(channelId), false, "alert_events.channel_id reached the prompt");
      assert.equal(sent.includes("rcaitspan"), false, "a span id reached the prompt");
      assert.equal(sent.includes(ws), false, "the workspace id reached the prompt");
      assert.equal(sent.includes(other), false, "another workspace's id reached the prompt");
      assert.equal(sent.includes(otherAlertId), false, "another workspace's alert id reached the prompt");
      assert.equal(/\bnull\b|\bundefined\b/.test(prompt.user), false, "an absent field rendered as a word");

      // ---- what IS there: the seven fields of each read row, in one line each ----
      const lines = prompt.user.split("\n");
      const rowLine = (id: string) => lines.find((line) => line.startsWith(`  ${id} `));
      const alertLine = rowLine(alertId);
      assert.ok(alertLine, `no line for the alert: ${prompt.user}`);
      assert.ok(alertLine.includes("checkout p95 over 2s") && alertLine.includes("against a threshold of 2000ms"));
      const changeLine = rowLine(changeId);
      assert.ok(changeLine, "no line for the change");
      assert.ok(changeLine.includes("deploy checkout v2.14.0") && changeLine.includes(CUSTOMER_PASTED_URL));
      assert.ok(rowLine(leadInId)?.includes("raise checkout pool size"), "the lead-in band's change is not a row");
      // The incident's own id is in the prompt EXACTLY where the customer typed
      // it and nowhere else (the subject's `id` is never printed), and it is
      // not citable: `incidentReferences` excludes it (D553), so a model that
      // cites it from the customer's sentence is dropped, never linked.
      assert.equal(prompt.user.split(incident.id).length - 1, 1, "the incident's own id appears outside the customer's text");
      assert.ok(changeLine.includes(incident.id));
      assert.equal(prompt.user.split(OTHER_INCIDENT_ID).length - 1, 1);

      // ---- the trace lane: a 200-span trace is ONE line, and the lane is one line per group ----
      const traceLane = lines.slice(lines.indexOf("traces (2):") + 1).filter((line) => /^ {2}\S/.test(line));
      assert.equal(traceLane.length, 2, `the trace lane is not two lines:\n${traceLane.join("\n")}`);
      const bigTraceLine = rowLine(traceId);
      assert.ok(bigTraceLine, `the 200-span trace has no line: ${traceLane.join("\n")}`);
      assert.ok(bigTraceLine.includes("200 errors") && bigTraceLine.includes(`POST /v1/chat on ${service}`), bigTraceLine);
      assert.ok(bigTraceLine.includes("grouped by service and span"), bigTraceLine);
      assert.ok(rowLine(secondTraceId)?.includes("2 errors"), "the second group's line");
      assert.equal(prompt.user.includes("POST /v1/chat"), true);
      assert.equal((prompt.user.match(/POST \/v1\/chat/g) ?? []).length, 1, "the span name appears once — one line, not 200");

      // ---- the subject as the route built it: D577 CLOSED — the stitcher projects
      // the rows from the same capped legs, so the two fields the entries never
      // carried now reach the model. This pin was written the other way round
      // (asserting the honest ABSENCE) so that the stitcher fix would flip a
      // test rather than arrive silently; it flipped.
      assert.equal(subject.rows.length, 5, "one alert, two changes, two trace groups");
      assert.equal(subject.rows.find((row) => row.id === alertId)?.severity, "critical", "D577: the alert's severity did not reach the subject — the model cannot tell critical from warning");
      // "checkout" is the change's OWN `service` column as the INSERT above seeds
      // it — the trace's service is `rca-it-<tag>`, a different row.
      assert.equal(subject.rows.find((row) => row.id === changeId)?.service, "checkout", "D577: the change's service did not reach the subject");
      assert.equal(subject.rows.find((row) => row.id === traceId)?.service, service, "the trace group's service comes from its key");

      // ---- the citations resolved against what was shown, as the two incident keys ----
      const evidence = (terminal(events) as Extract<ExplainEvent, { type: "result" }>).explanation.evidence;
      assert.ok(evidence.some((item) => item.eventRef === leadInId || item.eventRef === changeId), "no change cited");
      assert.ok(evidence.some((item) => item.eventRef === alertId), "the alert is not cited");
      assert.ok(evidence.some((item) => item.traceRef === traceId), "the 200-span trace is not cited by its id");
      assert.ok(!evidence.some((item) => item.detail.includes("is not in")), "a shown id was dropped");
    } finally {
      await queryRows(`DELETE FROM workspaces WHERE id = $1`, [other]);
    }
  });
});
