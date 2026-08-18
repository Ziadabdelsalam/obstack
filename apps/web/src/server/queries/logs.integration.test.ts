import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { forWorkspace } from "@/server/clickhouse";
// The mock pod list this surface used to offer in BOTH modes (D51(d)). Imported
// here, in a server-side test, purely so the "no mock pod ever reaches a live
// option list" probe names the real list instead of a copied literal.
import { podOptions } from "@/mock/logstream";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse ingest
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The live half of `/app/logs` (T3, D44 sub-ruling / D48 / D50 / D51): the
// severity / pod / on-trace / free-text / time-range filters as real SQL, the
// D42 content-carrier exclusion, the pod option list drawn from the data, and
// the cap+1 truncation fact. A pure unit test cannot exercise any of it — the
// WHERE clause is the product here. The mock half lives in `../data.test.ts`;
// the parity subtest at the bottom pins the two to the same verdicts.
//
// Skips only when no ClickHouse answers, and `web.yml`'s D36 skip trap fails
// the job on an unexpected skip, so this file executes on every PR.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = WEB_USER;
process.env.CLICKHOUSE_PASSWORD = WEB_PASSWORD;

const seed = createClient({
  url: CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: INGEST_PASSWORD,
  database: "obstack",
});

async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seed.ping()).success;
  } catch {
    return false;
  }
}

/**
 * Two workspaces of this run's own — the seeding user has no mutation grant, so
 * nothing here can be cleaned up afterwards (traces.integration.test.ts
 * precedent). Every read names one of them explicitly through `forWorkspace`;
 * there is no environment default left to inherit (D96/D113), and `WORKSPACE_B`
 * is the second tenant the disjointness probe at the bottom needs.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;

// `@/server/data` resolves OBSTACK_DATA_MODE at module load (S2.4 L4: an
// import-time-ordering API, stated as such), so the mode is set before the
// dynamic imports inside the tests below.
process.env.OBSTACK_DATA_MODE = "live";

const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'`. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

function logRow(overrides: {
  timestamp: string;
  body: string;
  k8s_pod: string;
  trace_id?: string;
  severity_number?: number;
  severity_text?: string;
  prompt?: string;
  completion?: string;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    trace_id: "",
    span_id: "",
    severity_number: 9,
    severity_text: "INFO",
    service: "demo-agent-it",
    k8s_namespace: "it-ns",
    k8s_container: "app",
    prompt: "",
    completion: "",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

test("logs search (D48/D51) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(
      `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`,
    );
    return;
  }

  const { LOG_SEARCH_CAP, queryLogSearch } = await import("./logs");
  const ch = forWorkspace(WORKSPACE_ID);
  const { mockLogMatches } = await import("@/server/data");

  const suffix = randomBytes(6).toString("hex");
  const HOUR_MS = 3_600_000;
  const nowMs = Date.now();
  const at = (msAgo: number) => chTimestamp(BigInt(nowMs - msAgo) * NS_PER_MS);

  // Every probe row carries TOKEN in its body, so `q: TOKEN` scopes a probe to
  // exactly this set and a control row re-appearing means the clause under test
  // was dropped.
  const TOKEN = `logprobe${suffix}`;
  const ONLYBODY = `zqonlybody${suffix}`; // one row's body, nowhere else
  const PODTOKEN = `zqpodname${suffix}`; // a POD NAME only — never a body
  const CARRIERTOK = `zqcarrier${suffix}`; // a carrier row's prompt only
  const PROMPTTOK = `zqprompt${suffix}`; // a RENDERED row's prompt only
  const COMPLTOK = `zqcompletion${suffix}`; // a RENDERED row's completion only
  const ACCENT_SEEDED = `CAFÉ-${suffix}`; // D56: the same word, case-differing
  const ACCENT_QUERY = `café-${suffix}`; //      on its non-ASCII letter

  const POD = `it-logpod-${suffix}`;
  const OTHER_POD = `it-otherpod-${suffix}`;
  const PODNAME_POD = `it-pod-${PODTOKEN}`;
  const CARRIER_POD = `it-carrieronly-${suffix}`;
  const OLD_POD = `it-oldpod-${suffix}`;
  const CAP_POD = `it-cappod-${suffix}`;
  const EXACT_POD = `it-exactpod-${suffix}`;
  const TRACE_ID = `it_logtrace_${suffix}`;

  // Distinct timestamps, newest first in this literal order, so the baseline
  // assertion is an ORDER assertion too.
  const bodyA = `baseline ${TOKEN} alpha ${ONLYBODY}`;
  const bodyB = `baseline ${TOKEN} beta`;
  const bodyC = `baseline ${TOKEN} gamma`;
  const bodyD = `baseline ${TOKEN} delta`;
  const bodyE = `baseline ${TOKEN} epsilon`;
  const bodyG = `baseline ${TOKEN} zeta`;
  const bodyH = `baseline ${TOKEN} eta ${ACCENT_SEEDED}`;
  const bodyI = `baseline ${TOKEN} theta`;
  const bodyJ = `baseline ${TOKEN} iota`;
  const bodyK = `baseline ${TOKEN} kappa`;
  const bodyL = `baseline ${TOKEN} lambda`;

  await seed.insert({
    table: "logs",
    format: "JSONEachRow",
    values: [
      logRow({ timestamp: at(1_000), body: bodyA, k8s_pod: POD }),
      logRow({ timestamp: at(2_000), body: bodyB, k8s_pod: OTHER_POD }),
      logRow({ timestamp: at(3_000), body: bodyC, k8s_pod: POD, severity_number: 17, severity_text: "ERROR" }),
      logRow({ timestamp: at(4_000), body: bodyD, k8s_pod: POD, trace_id: TRACE_ID }),
      // outside the 6h default window — the time-range filter's control row
      logRow({ timestamp: at(7 * HOUR_MS), body: bodyE, k8s_pod: POD }),
      // D42 content carrier: non-empty prompt, EMPTY body. Must not render, must
      // not be counted, must not match — and its pod must not be offered.
      logRow({ timestamp: at(5_000), body: "", k8s_pod: CARRIER_POD, prompt: `carrier ${TOKEN} ${CARRIERTOK}` }),
      // severity by TEXT only: ingest never invents a number (mapping/logs.go),
      // so this is the shape the SQL's severity_text arm exists for.
      logRow({ timestamp: at(6_000), body: bodyG, k8s_pod: POD, severity_number: 0, severity_text: "ERROR" }),
      logRow({ timestamp: at(7_000), body: bodyH, k8s_pod: POD }),
      // the token lives in this row's POD NAME, never in a body
      logRow({ timestamp: at(8_000), body: bodyI, k8s_pod: PODNAME_POD }),
      // pod-less, the shape every non-k8s sender produces: renders, but an empty
      // pod is not an option
      logRow({ timestamp: at(9_000), body: bodyJ, k8s_pod: "" }),
      logRow({ timestamp: at(10_000), body: bodyK, k8s_pod: POD, severity_number: 5, severity_text: "DEBUG" }),
      // NOT a carrier: a real log line that ALSO carries GenAI content. Ingest
      // fills `body` from the record and `prompt`/`completion` from the GenAI
      // attributes independently (`mapping/logs.go:66,73-74`), so this shape is
      // reachable through the product. It RENDERS — and D51(e) still says free
      // text on this surface reads `body` only, which the carrier row cannot
      // prove (the carrier rule removes it whatever the reach is).
      logRow({
        timestamp: at(11_000),
        body: bodyL,
        k8s_pod: POD,
        prompt: `genai in ${PROMPTTOK}`,
        completion: `genai out ${COMPLTOK}`,
      }),
      // Only this pod's rows sit outside the default window, so it is the pod
      // option list's time-bound control row.
      logRow({ timestamp: at(7 * HOUR_MS + 60_000), body: `stale ${suffix}`, k8s_pod: OLD_POD }),
      // cap fixtures: one pod with exactly the cap, one with cap+1
      ...Array.from({ length: LOG_SEARCH_CAP }, (_, i) =>
        logRow({ timestamp: at(20_000 + i), body: `exact ${suffix} ${i}`, k8s_pod: EXACT_POD }),
      ),
      ...Array.from({ length: LOG_SEARCH_CAP + 1 }, (_, i) =>
        logRow({ timestamp: at(20_000 + i), body: `capped ${suffix} ${i}`, k8s_pod: CAP_POD }),
      ),
    ],
  });

  const bodies = async (filter: Parameters<typeof queryLogSearch>[1]) =>
    (await queryLogSearch(ch, filter)).logs.map((l) => l.body);

  await t.test("baseline: the window renders newest-first, carriers and out-of-window rows absent", async () => {
    assert.deepEqual(await bodies({ q: TOKEN }), [
      bodyA,
      bodyB,
      bodyC,
      bodyD,
      bodyG,
      bodyH,
      bodyI,
      bodyJ,
      bodyK,
      bodyL,
    ]);
  });

  await t.test("each filter narrows with a control row that would otherwise pass", async () => {
    // severity — controls: every info row, plus the debug row
    assert.deepEqual(await bodies({ q: TOKEN, minSeverity: "error" }), [bodyC, bodyG]);
    assert.deepEqual(await bodies({ q: TOKEN, minSeverity: "info" }), [
      bodyA,
      bodyB,
      bodyC,
      bodyD,
      bodyG,
      bodyH,
      bodyI,
      bodyJ,
      bodyL,
    ]);
    // pod — controls: bodyB (other pod), bodyI (pod-name pod), bodyJ (pod-less)
    assert.deepEqual(await bodies({ q: TOKEN, pod: POD }), [
      bodyA,
      bodyC,
      bodyD,
      bodyG,
      bodyH,
      bodyK,
      bodyL,
    ]);
    // on-trace only — control: every trace-less row above
    assert.deepEqual(await bodies({ q: TOKEN, onTraceOnly: true }), [bodyD]);
    // free text — control: every other row carrying TOKEN
    assert.deepEqual(await bodies({ q: `${TOKEN} ${ONLYBODY}` }), [bodyA]);
    // time range — control: bodyE, 7h old and absent from every assertion above
    assert.ok(
      !(await bodies({ q: TOKEN })).includes(bodyE),
      "a 7h-old row leaked past the 6h default window",
    );
    assert.ok(
      (await bodies({ q: TOKEN, rangeMs: 8 * HOUR_MS })).includes(bodyE),
      "rangeMs did not widen the window",
    );
  });

  await t.test("severity by TEXT alone is ranked, not silently dropped to info", async () => {
    // bodyG carries severity_number = 0 and severity_text = 'ERROR'. Under a
    // number-only rank it ranks `info` and vanishes from the error+ set above;
    // the label it renders with comes from the same expression, so this also
    // pins "filtered as error" to "displayed as error".
    const errors = (await queryLogSearch(ch, { q: TOKEN, minSeverity: "error" })).logs;
    assert.deepEqual(
      errors.map((l) => [l.body, l.severity]),
      [
        [bodyC, "error"],
        [bodyG, "error"],
      ],
    );
    const debugRow = (await queryLogSearch(ch, { q: TOKEN })).logs.find((l) => l.body === bodyK);
    assert.equal(debugRow?.severity, "debug");
  });

  await t.test("free text reaches the BODY and nothing else (D51(e))", async () => {
    // The token is a real, findable pod name — proven by the pod filter — but
    // free text must not see it: this surface searches bodies.
    assert.deepEqual(await bodies({ pod: PODNAME_POD }), [bodyI]);
    assert.deepEqual(await bodies({ q: PODTOKEN }), []);
    // GenAI content on a RENDERED row is the reach's other falsifier, and the
    // only single-mutation one: bodyL is in the result set (proved right here,
    // so a lost fixture cannot make the two absences below hollow) and carries
    // prompt/completion text that free text must not reach. Widen the reach to
    // `prompt` or `completion` and exactly these two lines go red — the carrier
    // row cannot do that job, because the carrier rule removes it either way.
    assert.deepEqual(await bodies({ q: `${TOKEN} lambda` }), [bodyL]);
    assert.deepEqual(await bodies({ q: PROMPTTOK }), []);
    assert.deepEqual(await bodies({ q: COMPLTOK }), []);
    // ...and it must not see carrier content either (D51(e): carriers are out of
    // render, count AND match). Evidence note, S2.0 L1: THIS assertion is held
    // up by TWO independent mechanisms — the body-only reach and the carrier row
    // exclusion — so removing either ALONE leaves it green (measured). Its
    // falsifier is the pair: reach widened to `prompt` AND the row exclusion
    // dropped turns it red. Belt-and-braces, stated rather than overclaimed —
    // and neither mechanism rests on it: the reach has the bodyL pair above and
    // the PODTOKEN line, the row exclusion has the carrier subtest below.
    assert.deepEqual(await bodies({ q: CARRIERTOK }), []);
  });

  await t.test("D56 Unicode case folding: a query case-differing on a non-ASCII letter matches", async () => {
    assert.deepEqual(
      await bodies({ q: ACCENT_QUERY }),
      [bodyH],
      "café did not find CAFÉ — the body predicate is folding ASCII (positionCaseInsensitive) instead of Unicode (positionCaseInsensitiveUTF8)",
    );
  });

  await t.test("a content carrier does not render, is not counted, and its pod is not offered", async () => {
    const carrierPodOnly = await queryLogSearch(ch, { pod: CARRIER_POD });
    assert.deepEqual(carrierPodOnly.logs, [], "a bodyless content carrier rendered as a blank row");
    assert.equal(carrierPodOnly.logs.length, 0, "the carrier row moved the count");
    assert.ok(
      !carrierPodOnly.pods.includes(CARRIER_POD),
      "a pod whose only rows are carriers was offered as a filter option",
    );
    // The exclusion probes above are only falsifiable if the row is really in
    // the table — read it back through the SEEDING client, which no product
    // rule filters, so this can never go hollow through a lost fixture.
    const seeded = await seed.query({
      query:
        "SELECT count() AS n FROM obstack.logs WHERE workspace_id = {ws:String} AND prompt LIKE {p:String}",
      query_params: { ws: WORKSPACE_ID, p: `%${CARRIERTOK}%` },
      format: "JSONEachRow",
    });
    const [{ n }] = await seeded.json<{ n: string | number }>();
    assert.equal(
      Number(n),
      1,
      "the carrier fixture is missing — the exclusion probes above would be green by construction",
    );
  });

  await t.test("pod options come from the data, in the window, and never from the mock list", async () => {
    const { pods } = await queryLogSearch(ch, {});
    assert.deepEqual(pods, [CAP_POD, EXACT_POD, PODNAME_POD, POD, OTHER_POD].sort());
    assert.ok(!pods.includes(""), "the pod-less rows' empty pod was offered as an option");
    // The option list is bound by the WINDOW, not just by the carrier rule:
    // OLD_POD's only row is 7h old, so it is absent by default and returns when
    // the range widens. Drop `since_ms` from POD_OPTIONS_SQL and this goes red —
    // without it, no fixture distinguishes the two reads' windows.
    assert.ok(!pods.includes(OLD_POD), "a pod with no row inside the window was offered");
    assert.ok(
      (await queryLogSearch(ch, { rangeMs: 8 * HOUR_MS })).pods.includes(OLD_POD),
      "widening the range did not widen the pod option list",
    );
    const leaked = pods.filter((p) => podOptions.includes(p));
    assert.deepEqual(
      leaked,
      [],
      "a mock pod name reached the live option list — `@/mock/logstream`'s podOptions is still the source",
    );
  });

  await t.test("the cap is a fact: cap+1 fetch, one slice, truncation only when proven", async () => {
    const capped = await queryLogSearch(ch, { pod: CAP_POD });
    assert.equal(capped.logs.length, LOG_SEARCH_CAP);
    assert.equal(
      capped.truncated,
      true,
      `${LOG_SEARCH_CAP + 1} matching rows did not report truncation — the query is not fetching one past the cap`,
    );
    const exact = await queryLogSearch(ch, { pod: EXACT_POD });
    assert.equal(exact.logs.length, LOG_SEARCH_CAP);
    assert.equal(
      exact.truncated,
      false,
      "exactly the cap reported as truncated — the flag is a count comparison, not the cap+1 fact",
    );
  });

  await t.test("no match is an empty result, and the clock is the request's own (D13/D48)", async () => {
    const empty = await queryLogSearch(ch, { q: `zqnothing${suffix}` });
    assert.deepEqual(empty.logs, []);
    assert.equal(empty.truncated, false);
    assert.ok(
      Math.abs(empty.nowMs - Date.now()) < 60_000,
      "live mode's reference clock is not the request's server time",
    );
  });

  // D13: one rule, two implementations. Free text on this surface is the body
  // and only the body, so an equivalent mock fixture is just the same string.
  await t.test("live and mock return the same free-text verdicts over an equivalent fixture", async () => {
    const line = (body: string) => ({ id: body, ts: nowMs, severity: "info" as const, body, pod: POD });
    const cases: [string, boolean, boolean][] = [
      [ONLYBODY, true, false],
      [ACCENT_QUERY, false, true],
      [TOKEN, true, true],
      [`${TOKEN} ${ONLYBODY}`, true, false],
      [ONLYBODY.toUpperCase(), true, false],
      [PODTOKEN, false, false],
      [CARRIERTOK, false, false],
      [`${ONLYBODY} ${ACCENT_QUERY}`, false, false],
    ];
    for (const [q, expectA, expectH] of cases) {
      const live = await bodies({ q });
      assert.equal(live.includes(bodyA), expectA, `live verdict for ${JSON.stringify(q)} on row A`);
      assert.equal(live.includes(bodyH), expectH, `live verdict for ${JSON.stringify(q)} on row H`);
      assert.equal(mockLogMatches(line(bodyA), q), expectA, `mock verdict for ${JSON.stringify(q)} on row A`);
      assert.equal(mockLogMatches(line(bodyH), q), expectH, `mock verdict for ${JSON.stringify(q)} on row H`);
    }
  });
});

// T4 (D96/D113): the `/app/logs` half of the cross-tenant probe. This surface
// reads `obstack.logs` directly and answers TWO statements per request — the
// row window and the pod option list — so it can leak in two places, and the
// option list is the one no row-level assertion would catch: a pod name is
// another tenant's infrastructure.
test("cross-tenant disjointness (D96) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(
      `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`,
    );
    return;
  }

  const { dataForWorkspace } = await import("@/server/data");

  const suffix = randomBytes(6).toString("hex");
  const TOKEN = `zqtenant${suffix}`; // seeded in BOTH workspaces, nowhere else
  const aBody = `tenant a line ${TOKEN}`;
  const bBody = `tenant b line ${TOKEN}`;
  const aPod = `it-wsa-pod-${suffix}`;
  const bPod = `it-wsb-pod-${suffix}`;
  const at0 = chTimestamp(BigInt(Date.now()) * NS_PER_MS);

  await seed.insert({
    table: "logs",
    format: "JSONEachRow",
    values: [
      logRow({ timestamp: at0, body: aBody, k8s_pod: aPod }),
      { ...logRow({ timestamp: at0, body: bBody, k8s_pod: bPod }), workspace_id: WORKSPACE_B },
    ],
  });

  const a = dataForWorkspace(WORKSPACE_ID);
  const b = dataForWorkspace(WORKSPACE_B);

  await t.test("a window that matches both tenants' rows renders only the asking tenant's", async () => {
    const fromA = await a.searchLogs({ q: TOKEN });
    assert.deepEqual(
      fromA.logs.map((l) => l.body),
      [aBody],
      "workspace A's log window included another workspace's line",
    );
    const fromB = await b.searchLogs({ q: TOKEN });
    assert.deepEqual(fromB.logs.map((l) => l.body), [bBody]);
  });

  await t.test("the pod option list is scoped too — one tenant is never offered another's pods", async () => {
    const podsA = (await a.searchLogs({})).pods;
    const podsB = (await b.searchLogs({})).pods;
    assert.ok(podsA.includes(aPod), "workspace A is not offered its own pod — the fixture is missing");
    assert.ok(podsB.includes(bPod), "workspace B is not offered its own pod — the fixture is missing");
    assert.ok(!podsA.includes(bPod), "workspace A was offered a pod that only exists in workspace B");
    assert.ok(!podsB.includes(aPod), "workspace B was offered a pod that only exists in workspace A");
  });
});
