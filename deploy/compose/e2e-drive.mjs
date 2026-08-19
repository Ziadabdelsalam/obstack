/**
 * The `e2e` drive (S3.1 T8, D107) — two strangers, two workspaces, no crossing.
 *
 * This is the ratified U9 stranger protocol as an executable: two fresh browser
 * profiles sign up through the real form, each lands in the org+workspace its
 * own signup created (D117), each gets telemetry seeded for exactly the id the
 * product rendered for it, and neither ever sees the other's rows. One drive,
 * one definition (D111) — it replaces the S2.3 evidence pair, a shell harness
 * and the CDP half it drove, both deleted in the commit that added this file;
 * their still-live legs are carried below, and this grows one step per sprint.
 *
 *   node deploy/compose/e2e-drive.mjs
 *
 * Prerequisites: the compose stack up (`docker compose -f
 * deploy/compose/docker-compose.yml up -d --wait --wait-timeout 240`), `npm ci`
 * at the repo root, and Google Chrome. CI's `e2e` job runs this line verbatim,
 * after the smoke floor (D136) — the whole sequence is in
 * deploy/compose/README.md, "The e2e drive" (S2.1 L3).
 *
 * WHAT IT REFUSES, AND WHY (S2.3 L4, the exit-evidence lineage). It measures
 * only processes it started itself: a leftover server answers for the build IT
 * was started with, and a leftover browser carries somebody else's cookies —
 * which, in a drive whose entire subject is whose data you can see, is not a
 * detail. So it refuses loudly on a busy app port or a busy CDP port instead of
 * cleaning up after a run that is not this one. Each actor gets its own
 * throwaway `--user-data-dir`, because two strangers sharing a cookie jar are
 * one stranger.
 *
 * It builds with the same environment it serves with. The app layout decides
 * mode-dependent chrome at render time and a prerendered route bakes that at
 * BUILD time, so a mock-mode build served live would ship unwired pages — the
 * property every deployment has, stated here because this harness depends on it.
 *
 * THE ORIGIN IS `http://localhost:<port>`, never `127.0.0.1` (D119): the
 * production build sets `__Secure-better-auth.session_token`, and localhost is
 * the origin that contract is written against. `BETTER_AUTH_URL` is set
 * NOWHERE — setting it to an http:// origin downgrades that cookie name, so the
 * drive refuses to run with it in the environment rather than key on a name the
 * product does not use in production.
 *
 * THE NEGATIVE PROBE IS ORDERED, NOT ID-DISTINCT. `exit-seed.mjs` is the ONE
 * seeding definition (D115) and its ids are deliberately label-independent: both
 * workspaces end up holding the SAME trace ids, so "A asks for B's id" can only
 * be an honest 404 at a moment when the asker genuinely does not hold that id.
 * So the probe runs before the second workspace is seeded — the id is live in
 * ClickHouse under the other workspace, and the asker gets the same nothing an
 * id that never existed would give — and it is then re-run as a POSITIVE
 * CONTROL after seeding, where the very same URL renders. The pair is what
 * makes the 404 a fact about tenancy rather than about a broken route.
 *
 * AND IT IS CONTENT-AWARE ONCE BOTH ARE POPULATED (D135). Each stranger's rows
 * are seeded with their own content LABEL, woven into the words their surfaces
 * render, so the steady-state claims read what a page says and not only how many
 * rows it counted: each tenant's list, logs and trace detail carry their own
 * label and zero of the other's, and the product's own search finds the other
 * tenant's vocabulary nowhere while finding the asker's everywhere. This matters
 * because both workspaces hold the same 220 ids: a merge can leave every total
 * exactly where it was, and a guard that only counts shares that blind spot with
 * the scoping tripwire it is supposed to catch failing.
 *
 * THE S3.2 STEP IS WHAT A SIGNED-UP USER DOES NEXT. Once both strangers are
 * settled, alice opens /app/settings and does the three things this sprint made
 * real: she reads her own org's name off the General tab, issues an API key that
 * is shown exactly once, and invites bob with a link she copies out of the page
 * — the copy button IS the delivery mechanism, because no email is sent (D143's
 * U4). Bob accepts it, and the interesting half of that acceptance is what does
 * NOT happen: better-auth writes his session row's `activeOrganizationId` to
 * alice's org (measured at 1.7.1), so the drive asserts that it DID — the
 * re-home pressure is real — and then re-runs the same content-aware
 * disjointness against his surfaces. One definition of that assertion, used
 * twice, so "still his own" is the same claim as "his own" rather than a second,
 * weaker version of it.
 *
 * AND IT READS POSTGRES FOR THE HALVES A PAGE CANNOT SHOW. The token's SHA-256,
 * which is the whole of "shown once" being true rather than being a screen; the
 * `revoked_at` stamp, because the API keys tab carries a STANDING sentence about
 * revoked keys and a page containing the word therefore proves nothing about
 * THIS key; the member rows acceptance added; and the 0004 continuity seed —
 * exactly one `ws_demo` row with no member row pointing at its org, which is
 * what keeps it product-invisible now that Postgres is the one key authority
 * (D138 supersedes S3.1's "zero ws_demo rows" line).
 *
 * THE S3.3 STEP IS WHAT THAT WORKSPACE'S TELEMETRY COSTS. Metering has no
 * surface that can be reached from a page: an event is metered because ingest
 * accepted it, so the only honest way to make the meter move is to send events
 * — with a real key, over the real OTLP wire, into the real service. So alice's
 * own issued key carries four hundred events past a free plan whose quota the
 * seeder lowered to three hundred (D172), and then the step reads what that did
 * in three places that must agree: the Postgres ledger (the drive's own SQL),
 * the shell's banner and the Billing & usage meter (one function, D171). Past
 * the quota it sends the D165 pinned trace-id vectors and asserts each one whole
 * — one survives with every span and its correlated log record, two are absent
 * with none — because "a sampled-out trace drops WHOLE" is the property, and a
 * count of surviving spans would be satisfied by a trace cut in half.
 *
 * This is not S3.4's wire step (D115), which is about ATTRIBUTION — that a
 * token issued here lands its telemetry in its own workspace and no other — and
 * still belongs to that sprint. What is asserted below is what the events did to
 * the METER; the S3.2 exit bundle's runbook remains the attribution evidence of
 * record until the drive grows that step too.
 *
 * THE BILLING RAIL HERE IS THE FAKE, ALWAYS (D168). It is not a stub: a checkout
 * is created, the browser is redirected to OUR return path with a real id, the
 * settings page reads it back and writes the plan row, so the whole return
 * reconciliation the sandbox exercises is exercised here with no third party in
 * it. `polar-sandbox` is for the evidence run and the drive refuses to run under
 * it rather than quietly billing against someone's sandbox organisation.
 *
 * LEGS CARRIED FORWARD (L5) from the two deleted harnesses, whose covered logic
 * still exists on the wired surfaces: page-1/page-2 totals and page-2
 * disjointness, the three free-text reach legs (span prompt, log body, D42
 * carrier), the D42 carrier's invisibility to /app/logs, the honest empty
 * states, the SAMPLE-badge absence with its unwired-route positive control, the
 * adversarial URL matrix (D66/D68/D73), URL adoption on both bars (D69) and the
 * late-echo race (D72), and saved views surviving a reload — that last one now
 * a workspace-scoped Postgres row (D30/D116), so it is asserted as a tenancy
 * leg too. What died with its logic: the `obstack.saved-views` localStorage
 * assertion, whose store S3.1 deleted outright.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  CARRIER_TOKEN,
  CARRIER_TRACE,
  EVIDENCE_FREE_QUOTA,
  LOG_BODY_TOKEN,
  LOG_TRACE,
  PROMPT_TRACE,
  SPAN_PROMPT_TOKEN,
} from "./exit-seed.mjs";

// ---------------------------------------------------------- fixing values
// Every value this run is pinned to, printed at the top of the transcript so a
// reader never has to guess what "green" was green against (S2.2 L3).
const composeDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(composeDir, "../..");
const APP_PORT = Number(process.env.APP_PORT ?? 3210);
const BASE = `http://localhost:${APP_PORT}`;
const CDP_PORTS = { alice: Number(process.env.CDP_PORT_A ?? 9333), bob: Number(process.env.CDP_PORT_B ?? 9334) };
const CH = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const PG_DSN =
  process.env.OBSTACK_POSTGRES_DSN ?? "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack";
const INGEST_HEALTHZ = process.env.INGEST_HEALTHZ ?? "http://127.0.0.1:8080/healthz";
/** OTLP/HTTP, the wire contract a customer's exporter speaks (D6). */
const INGEST_OTLP = process.env.INGEST_OTLP ?? "http://127.0.0.1:4318";
/** The admin port's Prometheus surface — where a drop is visible to an operator. */
const INGEST_METRICS = process.env.INGEST_METRICS ?? "http://127.0.0.1:8080/metrics";
/** Required by `authConfig()`, plays no part in anything asserted here. */
const BETTER_AUTH_SECRET = "e2e-drive-dummy-secret-not-a-real-one";
/** The production cookie name at localhost with BETTER_AUTH_URL unset (D119). */
const SESSION_COOKIE = "__Secure-better-auth.session_token";
/** Injected latency for the D72 echo race — see the double-navigation leg. */
const ECHO_LATENCY_MS = 900;
/** An explicit CHROME is a decision, not a hint: falling through to another
 * browser when the named one is missing would drive something the caller did
 * not choose, and say nothing about it. */
const CHROME_CANDIDATES = process.env.CHROME
  ? [process.env.CHROME]
  : [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ];

const OUT = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), "obstack-e2e-"));
mkdirSync(OUT, { recursive: true });

/** Signups need addresses nobody used before: the Postgres volume outlives runs. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/**
 * Each stranger's CONTENT LABEL (D135): the word `exit-seed.mjs` weaves into the
 * text of every row it writes for them — root span names, log bodies, prompts.
 * It is what lets a disjointness claim be about what a page SAYS and not only
 * about how many rows it counted, which matters because counting is the
 * tripwire's own idiom: an outer guard built from the same assumption as the
 * thing it guards fails silently with it. `zz` is the fixture's convention for
 * a token that appears nowhere else in the corpus or the app's chrome.
 */
const ACTORS = {
  alice: { name: "Alice Stranger", email: `alice+${RUN}@e2e.invalid`, password: `alice-${RUN}-pw`, label: "zzalice" },
  bob: { name: "Bob Stranger", email: `bob+${RUN}@e2e.invalid`, password: `bob-${RUN}-pw`, label: "zzbob" },
};

// ------------------------------------------------ the S3.3 metering values
/**
 * The two intervals the metering story's staleness is made of (D166), named
 * here because the drive's ~35s wait is arithmetic over them and not a number
 * somebody tuned until the test passed: a crossing is honoured within one
 * metering flush (the ledger row appears) plus one workspace-state TTL (ingest
 * re-reads it). Both are constants in Go — `internal/metering` and
 * `internal/keystore` — and if either moves, this wait moves with it.
 */
const FLUSH_MS = 5_000;
const STATE_TTL_MS = 30_000;

/** Four hundred events over a three-hundred-event quota (D172), in eight exports. */
const FILL_BATCHES = 8;
const FILL_PER_BATCH = 50;
const FILL_EVENTS = FILL_BATCHES * FILL_PER_BATCH;

/** Spans per pinned-vector trace — more than one, because wholeness is the claim. */
const VECTOR_SPANS = 3;

/**
 * The D165 verdict's pinned trace ids, and this is the VECTOR SET OF RECORD
 * (D186(iii)): FNV-1a 64 over the sixteen raw trace-id bytes, kept iff the hash
 * is a multiple of ten. The Go suite asserts these three by hash and through its
 * own serving path (`receive_test.go`), and the drive re-derives the same hashes
 * here — in a third language, from the hex alone — before sending them over the
 * wire. That is the D139 pattern: a cross-language rule proven by independent
 * recomputation rather than by one language agreeing with itself. Amending the
 * verdict sweeps both suites in the same round.
 */
const PINNED_VECTORS = [
  { traceId: "00000000000000000000000000000001", fnv1a: 9808873769958073010n, keep: true },
  { traceId: "00000000000000000000000000000002", fnv1a: 9808872670446444799n, keep: false },
  { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", fnv1a: 12180425081350451581n, keep: false },
];

/** What the wire step should end up having cost the ledger, from what it sent. */
const KEPT_VECTORS = PINNED_VECTORS.filter((v) => v.keep).length;
const EXPECTED_ACCEPTED = FILL_EVENTS + KEPT_VECTORS * (VECTOR_SPANS + 1);
const EXPECTED_QUOTA_DROPS = (PINNED_VECTORS.length - KEPT_VECTORS) * (VECTOR_SPANS + 1);

/**
 * The content this step's telemetry says, so its rows are found by their WORDS
 * and not only by an id (D142) — the same discipline the seeded fixture keeps,
 * applied to the events that arrive over the wire.
 */
const QUOTA_TOKEN = `zzmeter${RUN}`;

/** The banner's own vocabulary — one string, so "raised" and "absent" are one claim. */
const BANNER_MARK = "-tier events used";

const appEnv = {
  ...process.env,
  OBSTACK_DATA_MODE: "live",
  CLICKHOUSE_URL: CH,
  CLICKHOUSE_USER: "obstack_web",
  CLICKHOUSE_PASSWORD: "obstack_web_dev",
  OBSTACK_POSTGRES_DSN: PG_DSN,
  BETTER_AUTH_SECRET,
};

// ------------------------------------------------------------- reporting
const startedAt = Date.now();
let failures = 0;
const transcript = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(title) {
  console.log(`\n== ${title}`);
  transcript.push({ step: title });
}
function check(claim, condition, detail) {
  if (condition) {
    console.log(`  ok   ${claim}`);
  } else {
    failures++;
    console.log(`  FAIL ${claim}${detail === undefined ? "" : ` — ${detail}`}`);
  }
  transcript.push({ claim, ok: Boolean(condition), detail });
}
/** A precondition, not a claim: everything after it would assert about nothing. */
function must(condition, message) {
  if (!condition) throw new Error(message);
}
function refuse(message) {
  console.error(`\ne2e-drive: FAIL — ${message}`);
  process.exit(1);
}

// --------------------------------------------------------------- process
/** Started detached so the whole group can be killed: `npx next start` runs the
 * server as a CHILD, and killing only the launcher leaves it listening — the
 * next run then binds nothing and asserts against the stale build. */
function launch(command, args, { cwd, logPath }) {
  // TRUNCATED, never appended: `OUT_DIR=...` is a documented override, so two
  // runs can name the same directory, and the D132 assertion below splits the
  // server log at a BYTE OFFSET taken during THIS run. Against an appended log
  // that offset points into the previous run's bytes, and the previous run's
  // allowlisted NoSessionError lines are then read as unallowed errors on an
  // authenticated path — a red about a run that already finished (measured).
  // Every other artifact here is written per run; the log is no different.
  const fd = openSync(logPath, "w");
  const child = spawn(command, args, { cwd, env: appEnv, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  return child;
}
const launched = [];
const sockets = [];
function stopAll() {
  // The Postgres pool holds sockets exactly like the CDP ones do, and the
  // verdict below is printed either way — so it is closed here rather than
  // awaited, with the same "already gone is fine" posture.
  pgPool.end().catch(() => undefined);
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  for (const child of launched) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function listening(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      done(true);
    });
    socket.setTimeout(1500);
    socket.on("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.on("error", () => done(false));
  });
}
async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

// ------------------------------------------------------------ clickhouse
/** The independent denominator (D71(b)): our own SQL, as the read-only web
 * user, so no "N of M" the app prints is checked against a number the app
 * produced. */
async function chCount(sql) {
  const res = await fetch(`${CH}/?user=obstack_web&password=obstack_web_dev`, { method: "POST", body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse: ${res.status} ${text}`);
  return Number(text.trim());
}
async function denominators(workspace) {
  return {
    workspace,
    total: await chCount(
      `SELECT countDistinct(trace_id) FROM obstack.trace_summaries WHERE workspace_id='${workspace}'`,
    ),
    phantoms: await chCount(
      `SELECT count() FROM obstack.trace_summaries WHERE workspace_id='${workspace}' AND trace_id=''`,
    ),
    // `services` and `error_count` are SimpleAggregateFunction columns, so plain
    // combinators under the mandatory GROUP BY (D7's query rule).
    serviceTotal: await chCount(
      `SELECT count() FROM (SELECT trace_id FROM obstack.trace_summaries WHERE workspace_id='${workspace}' ` +
        `GROUP BY workspace_id, trace_id HAVING has(groupUniqArrayArray(services), 'exit-agent'))`,
    ),
    errorTotal: await chCount(
      `SELECT count() FROM (SELECT trace_id FROM obstack.trace_summaries WHERE workspace_id='${workspace}' ` +
        `GROUP BY workspace_id, trace_id HAVING sum(error_count) > 0)`,
    ),
    dbPodErrorRows: await chCount(
      `SELECT count() FROM obstack.logs WHERE workspace_id='${workspace}' AND k8s_pod='exit-db-0' ` +
        `AND severity_number >= 17 AND body != ''`,
    ),
    renderableLogs: await chCount(
      `SELECT count() FROM obstack.logs WHERE workspace_id='${workspace}' AND body != ''`,
    ),
  };
}

// ----------------------------------------------------------- ingest wire
/**
 * OTLP/JSON over HTTP with a Bearer token — the published contract (D6), the
 * same endpoint, encoding and header a customer's exporter uses. Metering is
 * asserted through the front door or not at all: a row written into the ledger
 * by any other means would prove something about the ledger and nothing about
 * ingestion.
 */
async function otlp(signal, token, body) {
  const res = await fetch(`${INGEST_OTLP}/v1/${signal}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

/** OTLP timestamps as DIGITS: 1.7e21 nanoseconds is past what a JS number holds. */
const unixNano = (ms) => `${ms}000000`;

/** Unique within a run, which is all a span id has to be here. */
let spanSeq = 0;
const nextSpanId = () => (++spanSeq).toString(16).padStart(16, "0");

const spanOf = (traceId, name) => {
  const start = Date.now();
  return {
    traceId,
    spanId: nextSpanId(),
    name,
    kind: 2,
    startTimeUnixNano: unixNano(start),
    endTimeUnixNano: unixNano(start + 5),
    status: { code: 1 },
  };
};

/** A log record CARRYING A TRACE ID, so its sampling verdict is the trace's (D165). */
const recordOf = (traceId, body) => ({
  traceId,
  timeUnixNano: unixNano(Date.now()),
  observedTimeUnixNano: unixNano(Date.now()),
  severityNumber: 9,
  severityText: "INFO",
  body: { stringValue: body },
});

const SERVICE_ATTR = { key: "service.name", value: { stringValue: `${QUOTA_TOKEN}-svc` } };
const tracesExport = (spans) => ({
  resourceSpans: [{ resource: { attributes: [SERVICE_ATTR] }, scopeSpans: [{ spans }] }],
});
const logsExport = (records) => ({
  resourceLogs: [{ resource: { attributes: [SERVICE_ATTR] }, scopeLogs: [{ logRecords: records }] }],
});

/**
 * One Prometheus series' value, read off the exposition text by its labels
 * rather than by the order the client library happens to print them in.
 *
 * An ABSENT series is zero and is returned as zero — deliberately, and it is
 * what makes "nothing was dropped against bob" sayable: the per-workspace
 * series appear on a workspace's first event and never at boot (`metrics.go`),
 * so a workspace that shed nothing has no line at all.
 */
async function ingestMetric(name, labels) {
  const text = await (await fetch(INGEST_METRICS)).text();
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const got = Object.fromEntries([...line.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) {
      return Number(line.slice(line.lastIndexOf("}") + 1).trim());
    }
  }
  return 0;
}

/**
 * FNV-1a 64 over the raw bytes of a hex trace id — the D165 verdict function,
 * written out here so the drive DERIVES what Go derives instead of copying its
 * answer. BigInt because the hash is 64 bits and a JS number is not.
 */
const FNV64_OFFSET = 14695981039346656037n;
const FNV64_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;
function fnv1a64(hex) {
  let hash = FNV64_OFFSET;
  for (let i = 0; i < hex.length; i += 2) {
    hash = ((hash ^ BigInt(parseInt(hex.slice(i, i + 2), 16))) * FNV64_PRIME) & MASK64;
  }
  return hash;
}

// -------------------------------------------------------------- postgres
/**
 * The identity store, read with our own SQL for the reason the ClickHouse
 * denominators are (D71(b)): a claim about which rows exist must not be checked
 * against a number the app printed. Some of what this drive asserts is not
 * renderable at all — a token's hash, a `revoked_at` stamp, a session column the
 * product deliberately ignores — so those claims are made here or nowhere.
 *
 * There is no read-only Postgres role to borrow (the compose stack defines one
 * user, and the app already holds it), so the discipline is the scope instead:
 * every statement below is a SELECT.
 */
const pgPool = new pg.Pool({ connectionString: PG_DSN, max: 2 });
const pgRows = async (sql, params = []) => (await pgPool.query(sql, params)).rows;
const pgOne = async (sql, params = []) => (await pgRows(sql, params))[0] ?? null;

/**
 * This month's metered events, summed by the DRIVE — its own statement, for the
 * same reason the ClickHouse denominators are its own (D71(b)): "the banner and
 * the tab print the ledger" cannot be checked against a number the product
 * computed for itself. The month is cut the way both runtimes cut it (D179):
 * `date_trunc` there yields a naked timestamp, so it is re-anchored to UTC
 * rather than to whatever zone this connection's session happens to hold.
 */
const ledgerOf = async (workspace) => {
  const row = await pgOne(
    `SELECT coalesce(sum(spans + logs), 0) AS events, max(updated_at) AS as_of
       FROM usage_ledger
      WHERE workspace_id = $1
        AND period_start >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [workspace],
  );
  return { events: Number(row?.events ?? 0), asOf: row?.as_of ?? null };
};

// ------------------------------------------------------------------- CDP
/** One attached browser: its own process, its own profile, its own port. */
async function openBrowser(label, cdpPort) {
  const profile = join(OUT, `chrome-${label}`);
  const chrome = launch(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Neither flag changes what is rendered; both are what makes a headless
      // Chrome start reliably on a CI runner, and one flag set beats two.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { cwd: repoRoot, logPath: join(OUT, `chrome-${label}.log`) },
  );
  launched.push(chrome);
  must(
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 30_000),
    `chrome for ${label} never answered on CDP port ${cdpPort} — see ${OUT}/chrome-${label}.log`,
  );

  const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  sockets.push(ws);
  const inflight = new Map();
  let id = 0;
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && inflight.has(msg.id)) {
      const { resolve: ok, reject } = inflight.get(msg.id);
      inflight.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    }
  };
  const rawSend = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const mid = ++id;
      inflight.set(mid, { resolve: ok, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });

  const { targetId } = await rawSend("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rawSend("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => rawSend(method, params, sessionId);
  await send("Page.enable", {});
  await send("Network.enable", {});

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${label}: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  };
  const waitFor = async (expression, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await evaluate(`Boolean(${expression})`)) return true;
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
  };
  const goto = async (path, until = `document.readyState === "complete"`) => {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await sleep(200);
    const arrived = await waitFor(`document.readyState === "complete" && (${until})`);
    await sleep(350);
    return arrived;
  };
  const cookies = async () => (await send("Network.getCookies", { urls: [BASE] })).cookies;
  /** A headless page gets the clipboard only when the browser is told to give it
   * one — and the invite link is COPIED, so reading back what the button put
   * there is the only way to assert the affordance rather than around it. Browser
   * scope, not page scope, which is why it goes through `rawSend`. */
  const grantClipboard = () =>
    rawSend("Browser.grantPermissions", { origin: BASE, permissions: ["clipboardReadWrite"] });

  return { label, evaluate, waitFor, goto, send, cookies, grantClipboard };
}

/** Everything an assertion needs, read out of the rendered page (exit-browser's
 * reader, kept verbatim in behaviour and extended with the shell's workspace
 * line — the text a stranger sees IS the machine-read value, D115/U9). */
const STATE = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const controls = {};
  for (const el of document.querySelectorAll("input, select")) {
    const key = el.getAttribute("aria-label") || el.placeholder;
    if (key) controls[strip(key)] = el.value;
  }
  const spans = [...document.querySelectorAll("span")].map((s) => strip(s.textContent));
  const wsEl = document.querySelector("[data-workspace-id]");
  return {
    url: location.pathname + location.search,
    header: spans.find((t) => /of \\d+ traces$/.test(t)) || spans.find((t) => /shown.*last /.test(t)) || null,
    pager: spans.find((t) => /^page \\d+ of \\d+$/.test(t)) || null,
    controls,
    rows: document.querySelectorAll("tbody tr").length,
    firstRow: strip(document.querySelector("tbody tr")?.textContent || "").slice(0, 60),
    badge: document.body.textContent.includes("SAMPLE DATA"),
    workspaceAttr: wsEl?.getAttribute("data-workspace-id") ?? null,
    workspaceText: strip(wsEl?.textContent || "") || null,
    text: strip(document.body.textContent || ""),
  };
})()`;

/** Type into a control the way a user does — React listens for `input`. */
const type = (key, value) => `(() => {
  const el = [...document.querySelectorAll("input")]
    .find((i) => (i.getAttribute("aria-label") || i.placeholder || "").startsWith(${JSON.stringify(key)}));
  if (!el) return null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
})()`;

/** The signup fields carry neither placeholder nor aria-label — they are named
 * inputs behind real <label> elements, so they are addressed by their name. */
const fill = (field, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(`input[name="${field}"]`)});
  if (!el) return null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
})()`;

const clickText = (text) => `(() => {
  const el = [...document.querySelectorAll("button, a")]
    .find((b) => (b.textContent || "").replace(/\\s+/g, " ").trim() === ${JSON.stringify(text)});
  if (!el) return false;
  el.click();
  return true;
})()`;

const clickLabel = (label) => `(() => {
  const el = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
  if (!el) return false;
  el.click();
  return true;
})()`;

/** The saved-views menu's contents, once it has answered. */
const MENU = `(() => {
  const panel = [...document.querySelectorAll("div")]
    .find((d) => d.className.includes("absolute") && d.textContent.includes("save current filters"));
  const body = (panel || document.body).textContent.replace(/\\s+/g, " ").trim();
  return {
    open: Boolean(panel),
    names: [...document.querySelectorAll("[aria-label^='Delete view ']")]
      .map((b) => b.getAttribute("aria-label").replace("Delete view ", "")),
    text: body.slice(0, 400),
  };
})()`;

/**
 * The settings surface as its reader sees it. `main` IS the selected tab — the
 * shell's chrome (the account menu, the workspace line) lives outside it, so a
 * claim about what a tab says cannot be satisfied by the frame around it.
 */
const SETTINGS = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const main = document.querySelector("main");
  return {
    text: strip(main?.textContent || ""),
    // Two <code> elements can be on this tab: the shown-once banner's token and
    // the standing "Authorization: Bearer <token>" line under the list. The
    // token is what tells them apart.
    token: [...(main?.querySelectorAll("code") ?? [])]
      .map((c) => strip(c.textContent))
      .find((t) => t.startsWith("ok_live_")) ?? null,
  };
})()`;

/**
 * The two places a usage number is printed, read out of ONE rendered page.
 *
 * The banner lives in the app layout and the meter lives inside `main`, so this
 * finds the banner by the span that carries its wording and is NOT inside
 * `main` — which is what makes "banner equals tab" a claim about two surfaces
 * rather than about one string found twice. Both come from a single render of a
 * single request, which is where D171's one-definition rule is provable at all:
 * inside one request the layout's `getUsage` and the page's are literally the
 * same call (it is `cache()`-wrapped), so a difference here would mean two
 * definitions had grown, not that two queries disagreed.
 *
 * The whole BANNER is read, not that one span: the numbers and the sentence
 * about what is happening to telemetry right now are siblings inside it, and a
 * reader that stopped at the numbers could not tell a raised banner from one
 * that says sampling is active.
 */
const BILLING = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const main = document.querySelector("main");
  const marked = [...document.querySelectorAll("span")]
    .find((s) => (s.textContent || "").includes(${JSON.stringify(BANNER_MARK)}) && !main?.contains(s));
  return {
    banner: strip(marked?.parentElement?.textContent || "") || null,
    main: strip(main?.textContent || ""),
  };
})()`;

/**
 * `1,234 / 5,678` as two integers. The banner pins its grouping to en-US and
 * the meter does not, so the separators are stripped rather than matched: what
 * is being compared is the NUMBERS the two surfaces divide, and a run under a
 * different default locale must fail for a real reason or not at all.
 */
const pairIn = (text) => {
  const found = /([\d][\d.,\u00a0\u202f]*)\s*\/\s*([\d][\d.,\u00a0\u202f]*)/.exec(text ?? "");
  return found ? [Number(found[1].replace(/\D/g, "")), Number(found[2].replace(/\D/g, ""))] : null;
};

/** The figure a labelled stat renders — the label is its only stable anchor. */
const statAfter = (text, label) => {
  const at = text.indexOf(label);
  if (at === -1) return null;
  const digits = /^[\d][\d.,\u00a0\u202f]*/.exec(text.slice(at + label.length).trim());
  return digits ? Number(digits[0].replace(/\D/g, "")) : null;
};

/** The revoked stamp, matched as a DATE: the tab's standing copy says "a revoked
 * key stops being accepted within 30 seconds" whether or not anything is revoked,
 * so the word alone is not the claim (measured — it is on the page before the
 * click). */
const REVOKED_IN_LIST = String.raw`/revoked \d{4}-\d{2}-\d{2}/.test(document.querySelector("main")?.textContent ?? "")`;

// ------------------------------------------------------- server-rendered
/** The same GET the browser makes, carrying the actor's session cookie —
 * server-rendered HTML is where a count of rows is a count of rows. React
 * splits text nodes with `<!-- -->`; strip them so a human-readable string can
 * be matched the way a human reads it. */
async function pageFor(actor, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: actor.cookieHeader },
    redirect: "manual",
  });
  return { status: res.status, html: (await res.text()).replaceAll("<!-- -->", "") };
}
const rowsIn = (html) => (html.match(/href="\/app\/traces\/[a-z0-9]+"/g) ?? []).length;
const idsIn = (html) => [...html.matchAll(/href="\/app\/traces\/([a-z0-9]+)"/g)].map((m) => m[1]);
/** How many times a tenant's content label appears in what a page rendered. */
const labelHits = (html, label) => html.split(label).length - 1;

// ============================================================ the drive
step("fixing values");
console.log(`   app        ${BASE} (production build, OBSTACK_DATA_MODE=live)`);
console.log(`   clickhouse ${CH} as obstack_web`);
console.log(`   postgres   ${PG_DSN}`);
console.log(`   cdp        alice ${CDP_PORTS.alice} · bob ${CDP_PORTS.bob}`);
console.log(`   actors     ${ACTORS.alice.email} · ${ACTORS.bob.email}`);
console.log(`   labels     alice ${ACTORS.alice.label} · bob ${ACTORS.bob.label} (seeded into their rows' words)`);
console.log(`   ingest     ${INGEST_OTLP} (OTLP/JSON) · ${INGEST_METRICS}`);
console.log(
  `   metering   free quota lowered to ${EVIDENCE_FREE_QUOTA} · ${FILL_EVENTS} events sent · ` +
    `wait flush ${FLUSH_MS / 1000}s + state TTL ${STATE_TTL_MS / 1000}s · token ${QUOTA_TOKEN}`,
);
console.log(`   billing    fake (OBSTACK_BILLING_MODE unset — no Polar, no secret, D168)`);
console.log(`   artifacts  ${OUT}`);

step("refusals (this run measures only what it started)");
if (process.env.BETTER_AUTH_URL !== undefined) {
  refuse(
    `BETTER_AUTH_URL is set (${process.env.BETTER_AUTH_URL}) — D119 sets it nowhere, and an http:// value ` +
      `downgrades the session cookie away from ${SESSION_COOKIE}, which this drive keys on. Unset it.`,
  );
}
if (process.env.OBSTACK_BILLING_MODE !== undefined && process.env.OBSTACK_BILLING_MODE !== "fake") {
  refuse(
    `OBSTACK_BILLING_MODE is ${JSON.stringify(process.env.OBSTACK_BILLING_MODE)} — this drive asserts against ` +
      `the fake rail's semantics (a checkout succeeds at creation, D168), and running it against Polar's ` +
      `sandbox would create real checkouts in someone's organisation on every run. Unset it.`,
  );
}
if (await listening(APP_PORT)) {
  refuse(
    `something already answers on ${BASE} — it serves a build this run did not make. ` +
      `Stop it (kill $(lsof -ti tcp:${APP_PORT})) or set APP_PORT=...`,
  );
}
for (const [label, port] of Object.entries(CDP_PORTS)) {
  if (await listening(port)) {
    refuse(
      `a debuggable browser already answers on CDP port ${port} (${label}) — its profile and its cookies are ` +
        `not this run's. Stop it or set CDP_PORT_A=/CDP_PORT_B=...`,
    );
  }
}
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) refuse(`no Chrome found. Looked at:\n   ${CHROME_CANDIDATES.join("\n   ")}\n   Set CHROME=...`);
if (!(await waitForHttp(`${CH}/ping`, 5_000))) refuse(`ClickHouse does not answer at ${CH} — is the compose stack up?`);
// Ingest binds /healthz only after both migration sets are settled, so a healthy
// ingest is the compose stack's own statement that the Postgres schema this
// drive signs up against exists (K1: one schema path, the checked-in files).
if (!(await waitForHttp(INGEST_HEALTHZ, 5_000))) {
  refuse(
    `ingest does not answer at ${INGEST_HEALTHZ} — bring the stack up with ` +
      `docker compose -f deploy/compose/docker-compose.yml up -d --wait`,
  );
}
console.log(`   app port free · both CDP ports free · chrome ${CHROME}`);
console.log(`   clickhouse answers · ingest healthy (so both migration sets are applied)`);

const appLog = join(OUT, "app.log");
try {
  step("building and serving the production build (same env for both)");
  const build = spawnSync("npx", ["next", "build"], {
    cwd: join(repoRoot, "apps/web"),
    env: appEnv,
    encoding: "utf8",
  });
  writeFileSync(join(OUT, "build.log"), `${build.stdout ?? ""}${build.stderr ?? ""}`);
  must(build.status === 0, `next build failed — see ${OUT}/build.log`);
  launched.push(
    launch("npx", ["next", "start", "-p", String(APP_PORT)], {
      cwd: join(repoRoot, "apps/web"),
      logPath: appLog,
    }),
  );
  must(await waitForHttp(`${BASE}/login`), `the app never answered at ${BASE} — see ${appLog}`);
  console.log(`   ${BASE} serving (log: ${appLog})`);

  // ------------------------------------------------------------ actor A
  step("alice signs up — a stranger with no invitation and no workspace");
  const alice = await openBrowser("alice", CDP_PORTS.alice);
  alice.actor = ACTORS.alice;
  const bob = await openBrowser("bob", CDP_PORTS.bob);
  bob.actor = ACTORS.bob;

  async function signUp(browser) {
    const { name, email, password } = browser.actor;
    must(await browser.goto("/signup", `!!document.querySelector("form")`), "the signup page never rendered");
    must((await browser.evaluate(fill("name", name))) === name, "the signup form has no name field");
    must((await browser.evaluate(fill("email", email))) === email, "the signup form has no email field");
    must((await browser.evaluate(fill("password", password))) === password, "the signup form has no password field");
    must(await browser.evaluate(clickText("Create workspace")), "the signup form has no submit button");
    must(
      await browser.waitFor(`location.pathname === "/app" && !!document.querySelector("[data-workspace-id]")`, 30_000),
      `${browser.label}'s signup did not land in the app — see ${appLog}`,
    );
    const state = await browser.evaluate(STATE);
    const jar = await browser.cookies();
    browser.workspaceId = state.workspaceAttr;
    browser.cookieHeader = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    return { state, jar };
  }

  const aliceSignup = await signUp(alice);
  check(
    "signup lands in the app on one cookie, the production session cookie (D119)",
    aliceSignup.jar.length === 1 && aliceSignup.jar[0].name === SESSION_COOKIE,
    aliceSignup.jar.map((c) => c.name).join(", ") || "no cookies",
  );
  check(
    "the shell renders a real workspace id, and the machine reads the same text a stranger does",
    Boolean(alice.workspaceId) && aliceSignup.state.workspaceText === alice.workspaceId,
    `attr=${alice.workspaceId} text=${aliceSignup.state.workspaceText}`,
  );
  console.log(`   alice's workspace: ${alice.workspaceId}`);

  const aliceEmpty = await alice.goto("/app/traces", `!!document.querySelector("main")`).then(() => alice.evaluate(STATE));
  check(
    "a workspace nobody has sent telemetry to is honestly empty, not seeded with anything",
    aliceEmpty.header?.endsWith("0 of 0 traces") && aliceEmpty.text.includes("No traces match these filters"),
    aliceEmpty.header,
  );

  // ------------------------------------------------------------- seeding
  step("seeding alice's real workspace (the one seeding definition, D115)");
  /** Each actor's rows carry their own content label — same shape, different
   * words, one definition (D135). The artifact is named for the actor. */
  function seed(browser) {
    const { workspaceId } = browser;
    const { label } = browser.actor;
    const run = spawnSync(
      "node",
      [join(composeDir, "exit-seed.mjs"), "--workspace", workspaceId, "--label", label],
      { cwd: repoRoot, env: { ...process.env, CLICKHOUSE_URL: CH }, encoding: "utf8" },
    );
    writeFileSync(join(OUT, `seed-${browser.label}.json`), `${run.stdout ?? ""}${run.stderr ?? ""}`);
    must(run.status === 0, `exit-seed.mjs failed for ${workspaceId}: ${run.stderr}`);
    console.log(`   ${run.stdout.trim().split("\n").join("\n   ")}`);
  }
  seed(alice);
  const a = await denominators(alice.workspaceId);
  console.log(
    `   counted in clickhouse: traces=${a.total} phantom=${a.phantoms} service[exit-agent]=${a.serviceTotal} ` +
      `error=${a.errorTotal} renderable_logs=${a.renderableLogs} db-pod error rows=${a.dbPodErrorRows}`,
  );
  check("the seed holds more traces than one page (the total is about data, not the cap)", a.total > 200, a.total);
  check("no P13-class phantom summary exists in the seeded workspace (D71(b))", a.phantoms === 0, `${a.phantoms} found`);

  // --------------------------------------------- alice's surfaces (L5)
  step("alice's traces list: a real total, a real page 2, free text that reaches");
  const page1 = await pageFor(alice, "/app/traces");
  check("the header states the counted total", page1.html.includes(`200 of ${a.total} traces`), page1.status);
  check("page 1 renders exactly one page of rows", rowsIn(page1.html) === 200, `${rowsIn(page1.html)} rows`);
  check("no SAMPLE badge on /app/traces in live mode", !page1.html.includes("SAMPLE DATA"), "badge present");

  const page2 = await pageFor(alice, "/app/traces?page=2");
  check("a deep link to page 2 renders page 2 server-side", page2.html.includes("page 2 of 2"), "no pager");
  check(
    "page 2 carries the rest of the data, same total",
    page2.html.includes(`${a.total - 200} of ${a.total} traces`),
    page2.html.match(/[0-9]+ of [0-9]+ traces/)?.[0],
  );
  const shared = idsIn(page1.html).filter((id) => idsIn(page2.html).includes(id));
  check("page 2 is disjoint from page 1", shared.length === 0, `${shared.length} shared ids`);

  for (const [token, want, where] of [
    [SPAN_PROMPT_TOKEN, PROMPT_TRACE, "a span prompt"],
    [LOG_BODY_TOKEN, LOG_TRACE, "a log body"],
    [CARRIER_TOKEN, CARRIER_TRACE, "a D42 carrier row"],
  ]) {
    const found = await pageFor(alice, `/app/traces?q=${token}`);
    check(
      `free text finds the trace whose token exists only in ${where}`,
      rowsIn(found.html) === 1 && found.html.includes(want),
      `${rowsIn(found.html)} row(s)`,
    );
  }
  const nothing = await pageFor(alice, "/app/traces?q=zznosuchtokenanywhere");
  check(
    "a term that matches nothing is an empty result, not a fallback (D13)",
    nothing.html.includes("No traces match these filters") && nothing.html.includes("0 of 0 traces"),
    "not the empty state",
  );

  step("alice's /app/logs: filtered, truncated honestly, emptied to its real empty state");
  const logs = await pageFor(alice, "/app/logs");
  check(
    "the header states what rendered and that more match (cap+1, D44)",
    logs.html.includes("200 shown · more match · last 6h"),
    logs.html.match(/[0-9]+ shown[^<]*/)?.[0],
  );
  check("no SAMPLE badge on /app/logs in live mode", !logs.html.includes("SAMPLE DATA"), "badge present");
  check("the D42 carrier row does not render (empty body, D51(e))", !logs.html.includes(CARRIER_TOKEN), "carrier rendered");
  const carrierSearch = await pageFor(alice, `/app/logs?q=${CARRIER_TOKEN}`);
  check(
    "and it is not matchable here either — the reach is the body only",
    carrierSearch.html.includes("No log lines match"),
    "carrier matched on /app/logs",
  );
  const bodySearch = await pageFor(alice, `/app/logs?q=${LOG_BODY_TOKEN}`);
  check(
    "a body search narrows to exactly its row, and the count says so",
    bodySearch.html.includes("1 shown · last 6h"),
    bodySearch.html.match(/[0-9]+ shown[^<]*/)?.[0],
  );
  const emptyLogs = await pageFor(alice, "/app/logs?pod=no-such-pod-anywhere");
  check(
    "an impossible filter renders the REAL empty state",
    emptyLogs.html.includes("No log lines match") && emptyLogs.html.includes("0 shown"),
    "not the empty state",
  );
  check("and nothing from the mock stream appears in it", !emptyLogs.html.includes("kafka-broker-2"), "mock pods present");

  step("the SAMPLE badge still exists (positive control — an unwired route)");
  const unwired = await pageFor(alice, "/app/costs");
  check(
    "an unwired route still carries the badge, so its absence above is a fact",
    unwired.html.includes("SAMPLE DATA"),
    "the badge is gone everywhere — the checks above prove nothing",
  );

  step("adversarial URL matrix (D66/D68/D73), every request carrying a real session");
  // The APPLIED bound is read out of the HEADER, never from the words "last 6h"
  // — every range dropdown renders that as an option whatever was applied.
  const boundOf = (route, html) =>
    (route === "/app/traces" ? html.match(/last 6h[^<]*of [0-9]+ traces/) : html.match(/[0-9]+ shown[^<]*last 6h/))?.[0];
  let matrixN = 0;
  let matrixFail = 0;
  for (const route of ["/app/traces", "/app/logs"]) {
    const control = await pageFor(alice, route);
    check(
      `the matrix can read ${route}'s applied bound at all (positive control)`,
      Boolean(boundOf(route, control.html)),
      "pattern matches nothing on a clean page",
    );
    const params =
      route === "/app/traces"
        ? ["q", "status", "service", "model", "minMs", "minCost", "maxCost", "range", "page"]
        : ["q", "sev", "pod", "onTrace", "range"];
    for (const param of params) {
      for (const value of [
        "toString",
        "constructor",
        "valueOf",
        "hasOwnProperty",
        "__proto__",
        "1e21",
        "99999999999999999999",
        "-5",
        "NaN",
        "%00",
        "junk-value",
      ]) {
        matrixN++;
        const hostile = await pageFor(alice, `${route}?${param}=${value}`);
        const bound = boundOf(route, hostile.html);
        if (hostile.status !== 200 || !bound) {
          console.log(`     ${route}?${param}=${value} -> HTTP ${hostile.status} bound=${bound ?? "MISSING"}`);
          matrixFail++;
        }
      }
    }
  }
  check(`${matrixN} hostile URLs answer 200 with the default 6h bound`, matrixFail === 0, `${matrixFail} non-conforming`);

  step("alice's browser: pager, back, forward (carry-forward 2, D69)");
  await alice.goto("/app/traces", `!!document.querySelector("tbody tr")`);
  const t1 = await alice.evaluate(STATE);
  check(
    `page 1 renders 200 rows over the counted total ${a.total}`,
    t1.header?.endsWith(`200 of ${a.total} traces`) && t1.rows === 200,
    `${t1.header} | ${t1.rows} rows`,
  );

  await alice.goto(`/app/traces?service=exit-agent`, `!!document.querySelector("tbody tr")`);
  const t2 = await alice.evaluate(STATE);
  check("a deep link re-syncs the input", t2.controls["Service filter"] === "exit-agent", JSON.stringify(t2.controls));
  check(
    `and the total is the counted ${a.serviceTotal}, not the whole workspace`,
    t2.header?.endsWith(`of ${a.serviceTotal} traces`),
    t2.header,
  );

  // The history sequence D69 fixes runs over a FILTERED list: the pager is the
  // only control that pushes a history entry — every other control replaces —
  // so a typed filter would overwrite the pager's entry instead of stacking.
  await alice.goto("/app/traces?range=24h", `!!document.querySelector("tbody tr")`);
  const t3 = await alice.evaluate(STATE);
  check("the range control holds the URL's value", t3.controls["Time range filter"] === "24h", JSON.stringify(t3.controls));

  await alice.evaluate(clickText("next"));
  await alice.waitFor(`location.search.includes("page=2")`);
  await sleep(700);
  const t4 = await alice.evaluate(STATE);
  check("pager click lands page 2 in the URL", t4.url === "/app/traces?range=24h&page=2", t4.url);
  check(
    "header and URL agree on page 2",
    t4.header?.endsWith(`${a.total - 200} of ${a.total} traces`) && t4.pager === "page 2 of 2",
    `${t4.header} | ${t4.pager}`,
  );
  check("page 2 is disjoint from page 1 in the browser too", t4.firstRow !== t3.firstRow);

  await alice.evaluate("history.back()");
  await alice.waitFor(`location.search === "?range=24h"`);
  await sleep(700);
  const t5 = await alice.evaluate(STATE);
  check("back restores page 1", t5.url === "/app/traces?range=24h" && t5.pager === "page 1 of 2", `${t5.url} | ${t5.pager}`);
  check("with the page's own rows and total", t5.header?.endsWith(`200 of ${a.total} traces`), t5.header);
  check("and every input still matching the URL", t5.controls["Time range filter"] === "24h", JSON.stringify(t5.controls));

  await alice.evaluate("history.forward()");
  await alice.waitFor(`location.search.includes("page=2")`);
  await sleep(700);
  const t6 = await alice.evaluate(STATE);
  check(
    "forward restores the filtered state, inputs included",
    t6.url === "/app/traces?range=24h&page=2" &&
      t6.pager === "page 2 of 2" &&
      t6.controls["Time range filter"] === "24h",
    `${t6.url} | ${t6.pager} | ${JSON.stringify(t6.controls)}`,
  );

  await alice.evaluate(type("Service filter", "exit-agent"));
  await alice.waitFor(`location.search.includes("service=exit-agent")`);
  await sleep(900);
  const t7 = await alice.evaluate(STATE);
  check("a typed filter reaches the URL and drops the page", t7.url === "/app/traces?service=exit-agent&range=24h", t7.url);
  check("and the list narrows to the counted total", t7.header?.endsWith(`of ${a.serviceTotal} traces`), t7.header);

  step("alice's browser: /app/logs deep links, history, and the late echo (D72)");
  await alice.goto("/app/logs?sev=error&pod=exit-db-0", `!!document.querySelector("main")`);
  const l1 = await alice.evaluate(STATE);
  check(
    "a deep link re-syncs both controls",
    l1.controls["Minimum severity"] === "error" && l1.controls["Pod filter"] === "exit-db-0",
    JSON.stringify(l1.controls),
  );
  check("the filtered view renders exactly the counted rows", l1.rows === a.dbPodErrorRows, `${l1.rows} rows`);

  await alice.goto("/app/logs?q=checkpoint", `!!document.querySelector("main")`);
  const l2 = await alice.evaluate(STATE);
  check("the search box holds the URL's term", l2.controls["Search log bodies…"] === "checkpoint", JSON.stringify(l2.controls));

  await alice.evaluate("history.back()");
  await alice.waitFor(`location.search.includes("pod=exit-db-0")`);
  await sleep(700);
  const l3 = await alice.evaluate(STATE);
  check(
    "back returns to the previous filtered view with every control re-synced",
    l3.url === "/app/logs?sev=error&pod=exit-db-0" &&
      l3.controls["Search log bodies…"] === "" &&
      l3.controls["Minimum severity"] === "error" &&
      l3.controls["Pod filter"] === "exit-db-0",
    `${l3.url} | ${JSON.stringify(l3.controls)}`,
  );

  await alice.evaluate("history.forward()");
  await alice.waitFor(`location.search.includes("q=checkpoint")`);
  await sleep(700);
  const l4 = await alice.evaluate(STATE);
  check(
    "forward restores the search and clears the filters it moved away from",
    l4.controls["Search log bodies…"] === "checkpoint" &&
      l4.controls["Minimum severity"] === "debug" &&
      l4.controls["Pod filter"] === "",
    JSON.stringify(l4.controls),
  );

  // The echo race, with the network slowed so the window is real rather than
  // lucky: type "ab", let the 250 ms debounce push it, then type the third
  // character while that navigation is still in flight. The echo of "ab" lands
  // afterwards; with a single remembered URL it read as somebody else's
  // navigation and rewound the box (D72).
  await alice.goto("/app/logs", `!!document.querySelector("main")`);
  await alice.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: ECHO_LATENCY_MS,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await alice.evaluate(type("Search log bodies", "ab"));
  await sleep(400);
  await alice.evaluate(type("Search log bodies", "abc"));
  await sleep(ECHO_LATENCY_MS * 3 + 1500);
  const l5 = await alice.evaluate(STATE);
  check(
    "typed text survives the first echo",
    l5.controls["Search log bodies…"] === "abc",
    `the box reads ${JSON.stringify(l5.controls["Search log bodies…"])} — a late echo rewound it`,
  );
  check("and the URL settles on the later edit", l5.url === "/app/logs?q=abc", l5.url);
  await alice.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  step("alice saves a view: created, reloaded, listed, applied (now a Postgres row)");
  const VIEW = "e2e-drive-view";
  await alice.goto("/app/traces?status=error&range=24h", `!!document.querySelector("main")`);
  await alice.evaluate(clickText("saved views"));
  await alice.waitFor(`document.body.textContent.includes("save current filters")`);
  await alice.evaluate(type("Name for the current filters", VIEW));
  await sleep(150);
  check("the create form accepted a name", (await alice.evaluate(clickText("save current filters"))) === true);
  await sleep(900);

  await alice.goto("/app/traces", `!!document.querySelector("main")`);
  await alice.evaluate(clickText("saved views"));
  await alice.waitFor(`document.body.textContent.includes("save current filters")`);
  await sleep(600);
  const aliceMenu = await alice.evaluate(MENU);
  check(
    "after a reload onto a different URL, the view is still listed — it is a workspace row, not this browser's",
    aliceMenu.names.includes(VIEW),
    JSON.stringify(aliceMenu),
  );

  await alice.evaluate(clickText(VIEW));
  await alice.waitFor(`location.search.includes("status=error")`);
  await sleep(900);
  const v1 = await alice.evaluate(STATE);
  check("applying sets the URL", v1.url === "/app/traces?status=error&range=24h", v1.url);
  check(
    "applying sets the controls to the same thing",
    v1.controls["Status filter"] === "error" && v1.controls["Time range filter"] === "24h",
    JSON.stringify(v1.controls),
  );
  check("and the list is the filtered one", v1.header?.endsWith(`of ${a.errorTotal} traces`), v1.header);

  // ------------------------------------------------------------ actor B
  step("bob signs up in his own browser — a second stranger, a second workspace");
  const bobSignup = await signUp(bob);
  check(
    "bob's signup also lands on exactly the one production session cookie",
    bobSignup.jar.length === 1 && bobSignup.jar[0].name === SESSION_COOKIE,
    bobSignup.jar.map((c) => c.name).join(", ") || "no cookies",
  );
  check(
    "and in a workspace of his own — two signups, two tenants",
    Boolean(bob.workspaceId) && bob.workspaceId !== alice.workspaceId,
    `${alice.workspaceId} vs ${bob.workspaceId}`,
  );
  console.log(`   bob's workspace: ${bob.workspaceId}`);

  step(`disjointness: bob sees nothing while clickhouse holds ${a.total} traces for alice`);
  const bobTraces = await bob.goto("/app/traces", `!!document.querySelector("main")`).then(() => bob.evaluate(STATE));
  check(
    "bob's traces list is the honest empty state, not alice's data",
    bobTraces.header?.endsWith("0 of 0 traces") && bobTraces.text.includes("No traces match these filters"),
    bobTraces.header,
  );
  const bobLogs = await bob.goto("/app/logs", `!!document.querySelector("main")`).then(() => bob.evaluate(STATE));
  check(
    `bob's logs are empty too, though ${a.renderableLogs} renderable rows exist in the store`,
    bobLogs.header?.startsWith("0 shown") && bobLogs.text.includes("No log lines match"),
    bobLogs.header,
  );
  const bobSearch = await pageFor(bob, `/app/traces?q=${SPAN_PROMPT_TOKEN}`);
  check(
    "and a search for a token that exists in alice's workspace finds nothing in bob's",
    rowsIn(bobSearch.html) === 0 && bobSearch.html.includes("0 of 0 traces"),
    `${rowsIn(bobSearch.html)} row(s)`,
  );

  // On /app/traces, which is the surface alice's view was saved on — a menu on
  // the other surface would be empty for a reason that has nothing to do with
  // tenancy.
  await bob.goto("/app/traces", `!!document.querySelector("main")`);
  await bob.evaluate(clickText("saved views"));
  await bob.waitFor(`document.body.textContent.includes("save current filters")`);
  await sleep(600);
  const bobMenu = await bob.evaluate(MENU);
  check(
    "bob's saved-views menu answers, and alice's view is not in it (workspace-scoped rows, D30/D116)",
    bobMenu.names.length === 0 && bobMenu.text.includes("No saved views in this workspace yet"),
    JSON.stringify(bobMenu),
  );

  step("the negative probe: bob asks for a trace id that is live in alice's workspace");
  const probe = await pageFor(bob, `/app/traces/${PROMPT_TRACE}`);
  check("the answer is 404 — the same nothing an id that never existed gives", probe.status === 404, probe.status);
  const probeState = await bob
    .goto(`/app/traces/${PROMPT_TRACE}`, `document.body.textContent.length > 0`)
    .then(() => bob.evaluate(STATE));
  check(
    "and what bob's browser shows is the not-found surface, carrying none of alice's trace",
    probeState.text.includes("could not be found") &&
      !probeState.text.includes(SPAN_PROMPT_TOKEN) &&
      !probeState.text.includes(ACTORS.alice.label) &&
      !probeState.text.includes("chat.completion"),
    probeState.text.slice(0, 160),
  );

  // ------------------------------------------------------ both seeded
  step("seeding bob's workspace — same shape, same ids, different words");
  seed(bob);
  const b = await denominators(bob.workspaceId);
  const both = await chCount(
    `SELECT countDistinct(trace_id) FROM obstack.trace_summaries ` +
      `WHERE workspace_id IN ('${alice.workspaceId}','${bob.workspaceId}')`,
  );
  const bothRows = await chCount(
    `SELECT count() FROM obstack.trace_summaries ` +
      `WHERE workspace_id IN ('${alice.workspaceId}','${bob.workspaceId}')`,
  );
  console.log(`   counted in clickhouse: alice=${a.total} bob=${b.total} distinct ids across both=${both} rows=${bothRows}`);
  check(
    "the store really does hold both datasets — same ids, twice, under two workspaces",
    b.total === a.total && both === a.total && bothRows >= a.total * 2,
    `alice=${a.total} bob=${b.total} distinct=${both} rows=${bothRows}`,
  );

  const bobNow = await pageFor(bob, "/app/traces");
  check(
    `bob's list is his own ${b.total}, not the ${bothRows} summary rows the store holds`,
    bobNow.html.includes(`200 of ${b.total} traces`),
    bobNow.html.match(/[0-9]+ of [0-9]+ traces/)?.[0],
  );
  const aliceNow = await pageFor(alice, "/app/traces");
  check(
    "and alice's total did not move when a second tenant appeared",
    aliceNow.html.includes(`200 of ${a.total} traces`),
    aliceNow.html.match(/[0-9]+ of [0-9]+ traces/)?.[0],
  );
  const aliceToken = await pageFor(alice, `/app/traces?q=${SPAN_PROMPT_TOKEN}`);
  check(
    "a free-text search still reaches exactly one trace, though the token now exists in both workspaces",
    rowsIn(aliceToken.html) === 1,
    `${rowsIn(aliceToken.html)} row(s)`,
  );

  // The steady state is the interesting one, and counting is the WRONG
  // instrument for it: both workspaces hold 220 traces under the same ids, so a
  // merge that put one tenant's rows in the other's workspace can leave every
  // total exactly where it was. What cannot survive a merge is the WORDS — each
  // stranger's rows carry their own content label (D135), so these read what the
  // page says rather than how much of it there is. The guard and the tripwire it
  // guards no longer share an assumption.
  step("content-aware disjointness: each tenant's surfaces speak only their own words");
  /**
   * One tenant's surfaces, read for their own words and the total absence of the
   * other's. Declared rather than inlined because it is asserted TWICE: here, in
   * the steady state, and again after bob has accepted alice's invitation — and
   * "still his own" has to be the same claim as "his own" rather than a second,
   * weaker phrasing of it (D107: one definition).
   */
  async function contentAwareDisjointness(self, other, when = "") {
    const mine = self.actor.label;
    const theirs = other.actor.label;
    const traces = await pageFor(self, "/app/traces");
    check(
      `${self.label}'s traces list is written in ${mine} and carries no ${theirs}${when}`,
      labelHits(traces.html, mine) >= 200 && labelHits(traces.html, theirs) === 0,
      `${labelHits(traces.html, mine)}× ${mine}, ${labelHits(traces.html, theirs)}× ${theirs}`,
    );
    const logs = await pageFor(self, "/app/logs");
    check(
      `${self.label}'s log lines are written in ${mine} and carry no ${theirs}${when}`,
      labelHits(logs.html, mine) >= 200 && labelHits(logs.html, theirs) === 0,
      `${labelHits(logs.html, mine)}× ${mine}, ${labelHits(logs.html, theirs)}× ${theirs}`,
    );
    // The product's own search, pointed at the other tenant's vocabulary. The
    // positive control is the same search for the actor's OWN label, which must
    // reach the whole workspace — so "nothing found" is a fact about tenancy and
    // not about a term that matches nothing anywhere.
    const forTheirs = await pageFor(self, `/app/traces?q=${theirs}`);
    const forMine = await pageFor(self, `/app/traces?q=${mine}`);
    check(
      `searching ${self.label}'s workspace for ${theirs} finds nothing, while ${mine} finds all ${a.total}${when}`,
      rowsIn(forTheirs.html) === 0 &&
        forTheirs.html.includes("0 of 0 traces") &&
        forMine.html.includes(`200 of ${a.total} traces`),
      `${theirs}: ${rowsIn(forTheirs.html)} row(s) | ${mine}: ${forMine.html.match(/[0-9]+ of [0-9]+ traces/)?.[0]}`,
    );
  }
  await contentAwareDisjointness(alice, bob);
  await contentAwareDisjointness(bob, alice);

  step("the probe's positive control: the same URL renders once bob holds that trace himself");
  const control = await pageFor(bob, `/app/traces/${PROMPT_TRACE}`);
  check(
    "so the 404 above was about tenancy, not about a route that never works",
    control.status === 200 && control.html.includes("chat.completion"),
    control.status,
  );
  check(
    "and the trace it renders is bob's own — his words on the page, none of alice's",
    labelHits(control.html, ACTORS.bob.label) > 0 && labelHits(control.html, ACTORS.alice.label) === 0,
    `${labelHits(control.html, ACTORS.bob.label)}× ${ACTORS.bob.label}, ` +
      `${labelHits(control.html, ACTORS.alice.label)}× ${ACTORS.alice.label}`,
  );

  // ------------------------------------------------- settings (the S3.2 step)
  /**
   * The settings surface, opened at a named tab. The tab strip is client state
   * and starts at General after every navigation, so the tab a claim is about is
   * SELECTED here rather than assumed — the per-tab split is the whole shape of
   * this page (D106), and asserting against whichever tab happened to be showing
   * would be asserting against the frame.
   */
  async function openTab(browser, tab, until) {
    must(
      await browser.goto("/app/settings", `!!document.querySelector("main h1")`),
      `${browser.label}: /app/settings never rendered`,
    );
    must(await browser.evaluate(clickText(tab)), `${browser.label}: no "${tab}" tab in the settings strip`);
    must(await browser.waitFor(until), `${browser.label}: the "${tab}" tab never rendered — ${until}`);
  }

  step("alice's settings: her own org, named, and one key shown once");
  const aliceOrgId = (await pgOne(`SELECT org_id FROM workspaces WHERE id = $1`, [alice.workspaceId]))?.org_id;
  must(aliceOrgId, `alice's workspace ${alice.workspaceId} has no row in workspaces`);
  const aliceOrgName = (await pgOne(`SELECT name FROM "organization" WHERE id = $1`, [aliceOrgId]))?.name;
  const bobOrgId = (await pgOne(`SELECT org_id FROM workspaces WHERE id = $1`, [bob.workspaceId]))?.org_id;
  const bobOrgName = (await pgOne(`SELECT name FROM "organization" WHERE id = $1`, [bobOrgId]))?.name;

  await openTab(alice, "General", `document.querySelector("main")?.textContent.includes("workspace id")`);
  const general = await alice.evaluate(SETTINGS);
  check(
    "General names the org alice's own signup created, and the workspace the shell renders",
    aliceOrgName === ACTORS.alice.name &&
      general.text.includes(aliceOrgName) &&
      general.text.includes(alice.workspaceId) &&
      !general.text.includes(bobOrgName) &&
      !general.text.includes("Loopwork"),
    `${general.text.slice(0, 160)} | stored name ${aliceOrgName}`,
  );

  const KEY_NAME = `${ACTORS.alice.label}-ingest-key`;
  await openTab(alice, "API keys", `document.querySelector("main")?.textContent.includes("No keys yet")`);
  must((await alice.evaluate(type("Key name", KEY_NAME))) === KEY_NAME, "the API keys tab has no name field");
  must(await alice.evaluate(clickText("Create key")), "the API keys tab has no create button");
  must(
    await alice.waitFor(`document.querySelector("main")?.textContent.includes("copy it now")`, 20_000),
    "the shown-once banner never appeared",
  );
  const banner = await alice.evaluate(SETTINGS);
  const token = banner.token ?? "";
  const prefix = token.slice(0, 12);
  check(
    "the banner carries a whole ok_live_ token, and the page holds exactly one copy of it",
    /^ok_live_[0-9a-f]{64}$/.test(token) && banner.text.split(token).length - 1 === 1,
    token ? `${prefix}… (${token.length} chars, ${banner.text.split(token).length - 1}×)` : "no token in the banner",
  );

  must(await alice.evaluate(clickLabel("Dismiss")), "the banner has no dismiss control");
  must(
    await alice.waitFor(
      `document.querySelector("main")?.textContent.includes(${JSON.stringify(`${prefix}…`)})`,
      20_000,
    ),
    "the issued key never appeared in the list",
  );
  const listed = await alice.evaluate(SETTINGS);
  check(
    "dismissed, the list names the key by its 12-character prefix and the token is nowhere on the page",
    listed.text.includes(`${prefix}…`) && listed.text.includes(KEY_NAME) && !listed.text.includes(token),
    listed.text.slice(0, 200),
  );

  // The strongest half of "shown once" is not on any screen: a fresh server
  // render cannot produce the token because nothing stored can, and the row
  // holds the SHA-256 the drive computes for itself — the same contract ingest
  // looks keys up by, in the other language (D139).
  const settingsHtml = await pageFor(alice, "/app/settings");
  const keyRow = await pgOne(`SELECT prefix, token_hash, revoked_at FROM api_keys WHERE workspace_id = $1`, [
    alice.workspaceId,
  ]);
  check(
    "shown once is a fact about the store: a fresh render has the prefix and not the token, and the row holds only its SHA-256",
    !settingsHtml.html.includes(token) &&
      settingsHtml.html.includes(prefix) &&
      keyRow?.prefix === prefix &&
      keyRow?.token_hash === createHash("sha256").update(token, "utf8").digest("hex") &&
      keyRow?.revoked_at === null,
    `${keyRow?.prefix} hash=${keyRow?.token_hash?.slice(0, 16)}… revoked=${keyRow?.revoked_at}`,
  );

  step("alice invites bob, and the link she copies is the invitation the store holds");
  await openTab(alice, "Members", `document.querySelector("main")?.textContent.includes("invite a teammate")`);
  const roster = await alice.evaluate(SETTINGS);
  check(
    "before the invite the roster is alice alone, with no open invitations",
    roster.text.includes("members · 1") &&
      roster.text.includes(ACTORS.alice.email) &&
      !roster.text.includes(ACTORS.bob.email) &&
      roster.text.includes("No open invitations."),
    roster.text.slice(0, 200),
  );

  must(
    (await alice.evaluate(type("Teammate's email", ACTORS.bob.email))) === ACTORS.bob.email,
    "the invite form has no email field",
  );
  must(await alice.evaluate(clickText("Invite")), "the invite form has no submit button");
  must(
    await alice.waitFor(
      `document.querySelector("main")?.textContent.includes(${JSON.stringify(ACTORS.bob.email)})`,
      20_000,
    ),
    "the invitation never appeared in the pending list",
  );

  // Taken the way the inviter takes it. No email is sent this sprint (D143's
  // U4), so the copy button IS the delivery mechanism, and reading the clipboard
  // asserts the affordance instead of asserting around it.
  await alice.grantClipboard();
  must(await alice.evaluate(clickText("copy link")), "the pending invitation has no copy control");
  const copied = await alice.evaluate(`navigator.clipboard.readText()`);
  const invitation = await pgOne(`SELECT id, email, status FROM "invitation" WHERE "organizationId" = $1`, [
    aliceOrgId,
  ]);
  check(
    "the copied link is an absolute URL to the pending invitation row itself, addressed to bob",
    copied === `${BASE}/invite/${invitation?.id}` &&
      invitation?.email === ACTORS.bob.email &&
      invitation?.status === "pending",
    `${copied} | row ${invitation?.id} ${invitation?.email} ${invitation?.status}`,
  );

  step("bob accepts — a membership is ADDED, and nothing is moved (D140/D143)");
  must(
    await bob.goto(new URL(copied).pathname, `document.body.textContent.includes("Accept invitation")`),
    `bob's invite link never rendered an accept surface — ${copied}`,
  );
  const card = await bob.evaluate(STATE);
  check(
    "the surface names the org he is joining and the address the link works for",
    card.text.includes(`Join ${aliceOrgName}`) && card.text.includes(ACTORS.bob.email),
    card.text.slice(0, 200),
  );
  must(await bob.evaluate(clickText("Accept invitation")), "the accept surface has no button");
  must(
    await bob.waitFor(`document.body.textContent.includes("viewing your own workspace")`, 20_000),
    "acceptance never landed on the joined surface",
  );

  await openTab(alice, "Members", `document.querySelector("main")?.textContent.includes("members · 2")`);
  const rosterAfter = await alice.evaluate(SETTINGS);
  check(
    "alice's roster now shows bob under the name and address his OWN signup created, and the invitation is spent",
    rosterAfter.text.includes("members · 2") &&
      rosterAfter.text.includes(ACTORS.bob.email) &&
      rosterAfter.text.includes(ACTORS.bob.name) &&
      rosterAfter.text.includes("No open invitations."),
    rosterAfter.text.slice(0, 240),
  );

  const bobUserId = (await pgOne(`SELECT id FROM "user" WHERE email = $1`, [ACTORS.bob.email]))?.id;
  const bobMemberships = await pgRows(
    `SELECT "organizationId" AS org_id, role FROM "member" WHERE "userId" = $1`,
    [bobUserId],
  );
  check(
    "the write was additive: a member row in alice's org, and bob still owner of his own",
    bobMemberships.length === 2 &&
      bobMemberships.some((m) => m.org_id === aliceOrgId && m.role === "member") &&
      bobMemberships.some((m) => m.org_id === bobOrgId && m.role === "owner"),
    JSON.stringify(bobMemberships),
  );
  // This one is the TRIPWIRE'S OWN PRECONDITION, and it is asserted positively:
  // better-auth moves the session row's activeOrganizationId to the inviting org
  // (measured at 1.7.1, crud-invites.mjs:330). If that ever stopped happening,
  // every "not re-homed" claim below would pass for a reason that has nothing to
  // do with the owner pin holding.
  const bobSession = await pgOne(
    `SELECT "activeOrganizationId" AS active FROM "session" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [bobUserId],
  );
  check(
    "and the library DID point his session row at alice's org — the column the resolution ignores (D143)",
    bobSession?.active === aliceOrgId,
    `session.activeOrganizationId=${bobSession?.active} alice's org=${aliceOrgId}`,
  );

  step("bob is not re-homed: the same content-aware disjointness, run again after acceptance");
  const bobShell = await bob
    .goto("/app", `!!document.querySelector("[data-workspace-id]")`)
    .then(() => bob.evaluate(STATE));
  check(
    "the shell still renders bob's own workspace id, not the org he just joined",
    bobShell.workspaceAttr === bob.workspaceId,
    `${bobShell.workspaceAttr} vs ${bob.workspaceId}`,
  );
  await contentAwareDisjointness(bob, alice, " — after accepting alice's invitation");

  await openTab(bob, "General", `document.querySelector("main")?.textContent.includes("workspace id")`);
  const bobGeneral = await bob.evaluate(SETTINGS);
  check(
    "and his own settings name his own org and workspace, though he is now a member of alice's",
    bobGeneral.text.includes(bobOrgName) &&
      bobGeneral.text.includes(bob.workspaceId) &&
      !bobGeneral.text.includes(aliceOrgName) &&
      !bobGeneral.text.includes(alice.workspaceId),
    bobGeneral.text.slice(0, 160),
  );
  await openTab(bob, "API keys", `document.querySelector("main")?.textContent.includes("api keys · ")`);
  const bobKeysTab = await bob.evaluate(SETTINGS);
  check(
    "his API keys tab is empty — alice's key is hers, shared org or not",
    bobKeysTab.text.includes("No keys yet") && !bobKeysTab.text.includes(prefix),
    bobKeysTab.text.slice(0, 160),
  );

  // -------------------------------------------- metering (the S3.3 step)
  step(`the free plan's quota comes down to ${EVIDENCE_FREE_QUOTA} in this disposable Postgres (D172)`);
  const quotaSeed = spawnSync("node", [join(composeDir, "exit-seed.mjs"), "--lower-free-quota"], {
    cwd: repoRoot,
    env: { ...process.env, OBSTACK_POSTGRES_DSN: PG_DSN },
    encoding: "utf8",
  });
  writeFileSync(join(OUT, "seed-quota.json"), `${quotaSeed.stdout ?? ""}${quotaSeed.stderr ?? ""}`);
  must(quotaSeed.status === 0, `exit-seed.mjs --lower-free-quota failed: ${quotaSeed.stderr}`);
  console.log(`   ${quotaSeed.stdout.trim().split("\n").join("\n   ")}`);
  const freeRow = await pgOne(`SELECT event_quota FROM plans WHERE id = $1`, ["free"]);
  check(
    `the plans catalog — the ONE definition both runtimes read (D163) — now states ${EVIDENCE_FREE_QUOTA}`,
    Number(freeRow?.event_quota) === EVIDENCE_FREE_QUOTA,
    `event_quota=${freeRow?.event_quota}`,
  );

  // The positive control for everything below: alice's 220 seeded traces went
  // STRAIGHT INTO CLICKHOUSE and never through ingest, so her ledger is empty
  // and her shell carries no banner. Without this line, "the banner is raised"
  // could be a banner that is always there.
  const quietLedger = await ledgerOf(alice.workspaceId);
  const quietShell = await pageFor(alice, "/app/traces");
  check(
    "before a single metered event: no ledger row, and no banner in the shell (the control for 'raised')",
    quietLedger.events === 0 && !quietShell.html.includes(BANNER_MARK),
    `${quietLedger.events} metered event(s), banner ${quietShell.html.includes(BANNER_MARK)}`,
  );

  step(`alice's own key carries ${FILL_EVENTS} events over OTLP — the only way a meter moves`);
  const fillTrace = (n) => `f1${n.toString(16).padStart(30, "0")}`;
  for (let batch = 0; batch < FILL_BATCHES; batch++) {
    const spans = [];
    for (let i = 0; i < FILL_PER_BATCH; i++) {
      const n = batch * FILL_PER_BATCH + i;
      spans.push(spanOf(fillTrace(n), `${QUOTA_TOKEN}-fill-${n}`));
    }
    const sent = await otlp("traces", token, tracesExport(spans));
    must(sent.status === 200, `ingest refused export ${batch}: HTTP ${sent.status} ${sent.body.slice(0, 200)}`);
  }
  const lastUnderQuotaSendAt = Date.now();
  // One malformed body on the same key, past auth. The exit criterion asks for
  // the workspace's ingest-ERROR count to be VISIBLE in the product, and a zero
  // renders exactly like a number nobody writes — so the drive makes one.
  const malformed = await otlp("traces", token, "{not an otlp payload");
  check(
    "a malformed payload on a valid key is one 4xx and a counted drop, never a 5xx (D6/D26)",
    malformed.status === 400,
    `HTTP ${malformed.status}`,
  );

  step(`the crossing propagates: flush ${FLUSH_MS / 1000}s writes the ledger, TTL ${STATE_TTL_MS / 1000}s reaches ingest (D166)`);
  let ledger = await ledgerOf(alice.workspaceId);
  const flushDeadline = Date.now() + 30_000;
  while (ledger.events < FILL_EVENTS && Date.now() < flushDeadline) {
    await sleep(500);
    ledger = await ledgerOf(alice.workspaceId);
  }
  check(
    `the metering flush wrote all ${FILL_EVENTS} accepted events into usage_ledger, past the ${EVIDENCE_FREE_QUOTA} quota`,
    ledger.events === FILL_EVENTS,
    `${ledger.events} event(s) after ${Math.round((Date.now() - lastUnderQuotaSendAt) / 1000)}s`,
  );
  // Measured from the last export, because that is when the workspace-state
  // entry ingest is holding was last able to be built — it was built with a
  // ledger that had not crossed yet, and it lives for one TTL.
  await sleep(Math.max(0, lastUnderQuotaSendAt + STATE_TTL_MS + 3_000 - Date.now()));

  step("over quota, the D165 pinned vectors: one trace survives WHOLE, two are absent WHOLE (D186(iii))");
  for (const vector of PINNED_VECTORS) {
    const hash = fnv1a64(vector.traceId);
    check(
      `${vector.traceId} → FNV-1a 64 ${vector.fnv1a}, therefore ${vector.keep ? "KEPT" : "DROPPED"} — re-derived here, not copied`,
      hash === vector.fnv1a && (hash % 10n === 0n) === vector.keep,
      `${hash}`,
    );
  }
  const vectorSpans = [];
  const vectorRecords = [];
  for (const vector of PINNED_VECTORS) {
    for (let i = 0; i < VECTOR_SPANS; i++) {
      vectorSpans.push(spanOf(vector.traceId, `${QUOTA_TOKEN}-vector-span-${i}`));
    }
    vectorRecords.push(recordOf(vector.traceId, `${QUOTA_TOKEN} vector log line`));
  }
  // All three traces in ONE export of each signal: the shedding is per trace
  // INSIDE a batch, which is the shape a real exporter sends and the shape a
  // "drop the whole request" bug would pass a one-trace-per-request test with.
  const vectorTraces = await otlp("traces", token, tracesExport(vectorSpans));
  const vectorLogs = await otlp("logs", token, logsExport(vectorRecords));
  check(
    "an over-quota export is still answered 200 — sampling is degradation, not a refusal (D165)",
    vectorTraces.status === 200 && vectorLogs.status === 200,
    `traces ${vectorTraces.status} · logs ${vectorLogs.status}`,
  );

  const kept = PINNED_VECTORS.find((vector) => vector.keep);
  const chSpansOf = (traceId, where = "") =>
    chCount(`SELECT count() FROM obstack.spans WHERE trace_id='${traceId}'${where}`);
  const chLogsOf = (traceId, where = "") =>
    chCount(`SELECT count() FROM obstack.logs WHERE trace_id='${traceId}'${where}`);
  // Presence FIRST and polled — the writer batches every second — because it is
  // what makes the absences below a fact about sampling rather than about a
  // batch that had not flushed yet. Content-aware (D142): the rows are found by
  // the words this run's telemetry says, not only by an id.
  const mine = ` AND workspace_id='${alice.workspaceId}' AND name LIKE '%${QUOTA_TOKEN}%'`;
  const mineLogs = ` AND workspace_id='${alice.workspaceId}' AND body LIKE '%${QUOTA_TOKEN}%'`;
  let keptSpans = 0;
  let keptLogs = 0;
  const arrival = Date.now() + 20_000;
  while ((keptSpans < VECTOR_SPANS || keptLogs < 1) && Date.now() < arrival) {
    await sleep(500);
    keptSpans = await chSpansOf(kept.traceId, mine);
    keptLogs = await chLogsOf(kept.traceId, mineLogs);
  }
  check(
    `the surviving trace landed complete — all ${VECTOR_SPANS} of its spans and its correlated log record`,
    keptSpans === VECTOR_SPANS && keptLogs === 1,
    `${keptSpans} span(s), ${keptLogs} log record(s)`,
  );
  for (const vector of PINNED_VECTORS.filter((v) => !v.keep)) {
    // Asked WITHOUT a workspace filter, which is stricter than it needs to be:
    // a sampled-out trace has no row anywhere, so the query that would catch a
    // half-dropped trace also catches one that landed in the wrong tenant.
    const strandedSpans = await chSpansOf(vector.traceId);
    const strandedLogs = await chLogsOf(vector.traceId);
    check(
      `and ${vector.traceId} is absent whole — no span and no log record of it, in any workspace`,
      strandedSpans === 0 && strandedLogs === 0,
      `${strandedSpans} span(s), ${strandedLogs} log record(s)`,
    );
  }

  step("the drops are counted in both places a drop is visible (D162)");
  const quotaDrops = await ingestMetric("obstack_ingest_dropped_total", {
    workspace_id: alice.workspaceId,
    reason: "quota",
  });
  const bobDrops = await ingestMetric("obstack_ingest_dropped_total", {
    workspace_id: bob.workspaceId,
    reason: "quota",
  });
  const decodeDrops = await ingestMetric("obstack_ingest_dropped_total", {
    workspace_id: alice.workspaceId,
    reason: "decode",
  });
  check(
    `obstack_ingest_dropped_total{reason="quota"} counts the ${EXPECTED_QUOTA_DROPS} shed records against alice, and nothing against bob`,
    quotaDrops === EXPECTED_QUOTA_DROPS && bobDrops === 0,
    `alice=${quotaDrops} bob=${bobDrops}`,
  );
  check(
    "and the malformed payload is counted under decode, not folded into the quota drops",
    decodeDrops === 1,
    `decode=${decodeDrops}`,
  );

  // One flush past the last export, so the health row and the ledger both hold
  // everything this step sent before either is compared with a screen.
  await sleep(FLUSH_MS + 2_000);
  ledger = await ledgerOf(alice.workspaceId);
  const health = await pgOne(
    `SELECT accepted, dropped_decode, dropped_unsupported, dropped_quota, last_event_at
       FROM api_key_health WHERE workspace_id = $1`,
    [alice.workspaceId],
  );
  check(
    `the ledger holds exactly what ingest accepted — ${FILL_EVENTS} under quota plus the surviving trace, and none of what it shed`,
    ledger.events === EXPECTED_ACCEPTED && ledger.asOf !== null,
    `${ledger.events} event(s), want ${EXPECTED_ACCEPTED}`,
  );
  check(
    "and the per-key health row agrees with it, drop for drop (D100)",
    Number(health?.accepted) === EXPECTED_ACCEPTED &&
      Number(health?.dropped_quota) === EXPECTED_QUOTA_DROPS &&
      Number(health?.dropped_decode) === 1 &&
      health?.last_event_at !== null,
    JSON.stringify(health),
  );

  step("one usage definition: the banner number IS the tab number, on one screen (D171)");
  await openTab(alice, "Billing & usage", `document.querySelector("main")?.textContent.includes("usage this period")`);
  const meter = await alice.evaluate(BILLING);
  const bannerPair = pairIn(meter.banner);
  const tabPair = pairIn(meter.main.split("events (spans + log records)")[1] ?? "");
  check(
    "the banner is raised, and it names the plan whose quota it divides by",
    meter.banner !== null && meter.banner.includes("Free-tier events used"),
    meter.banner ?? "no banner rendered",
  );
  check(
    `banner == tab == the drive's own sum of usage_ledger: ${EXPECTED_ACCEPTED} of ${EVIDENCE_FREE_QUOTA}`,
    bannerPair !== null &&
      tabPair !== null &&
      bannerPair[0] === tabPair[0] &&
      bannerPair[1] === tabPair[1] &&
      bannerPair[0] === ledger.events &&
      bannerPair[0] === EXPECTED_ACCEPTED &&
      bannerPair[1] === EVIDENCE_FREE_QUOTA,
    `banner ${JSON.stringify(bannerPair)} · tab ${JSON.stringify(tabPair)} · ledger ${ledger.events}`,
  );
  check(
    "the banner says what is happening to telemetry right now, in the D165 words",
    Boolean(meter.banner?.includes("sampling active now")) &&
      Boolean(meter.banner?.includes("a sampled-out trace drops whole")),
    meter.banner ?? "no banner rendered",
  );
  check(
    "and the tab says the same thing about the same number, and dates it (D162)",
    meter.main.includes("over quota — ingestion is sampling now") &&
      /as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(meter.main),
    meter.main.slice(0, 400),
  );

  step("the Data & ingest tab: what this workspace's key carried, refused and shed (D100/D141)");
  await openTab(alice, "Data & ingest", `document.querySelector("main")?.textContent.includes("ingest health · ")`);
  const ingestTab = await alice.evaluate(SETTINGS);
  check(
    `the three totals are the health row's own — ${EXPECTED_ACCEPTED} accepted · 1 receive-path error · ${EXPECTED_QUOTA_DROPS} sampled out`,
    statAfter(ingestTab.text, "events accepted") === Number(health?.accepted) &&
      statAfter(ingestTab.text, "receive-path errors") === Number(health?.dropped_decode) &&
      statAfter(ingestTab.text, "sampled out (quota)") === Number(health?.dropped_quota),
    `accepted=${statAfter(ingestTab.text, "events accepted")} errors=${statAfter(ingestTab.text, "receive-path errors")} ` +
      `sampled=${statAfter(ingestTab.text, "sampled out (quota)")} vs row ${JSON.stringify(health)}`,
  );
  check(
    "attributed to the key alice issued, with the basis and the staleness of the count stated (D162)",
    ingestTab.text.includes(`${prefix}…`) &&
      /receive-path errors, as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(ingestTab.text) &&
      ingestTab.text.includes("write-path failures are not counted here"),
    ingestTab.text.slice(0, 240),
  );

  step("a plan change round-trips: checkout → return → reconcile → plan row → the tab says Pro (D168)");
  await openTab(alice, "Billing & usage", `document.querySelector("main")?.textContent.includes("change plan")`);
  must(await alice.evaluate(clickText("Upgrade to Pro")), "the Billing & usage tab offers no Pro upgrade");
  must(
    await alice.waitFor(
      `location.search.includes("checkout=") && document.querySelector("main")?.textContent.includes("Your plan is updated")`,
      30_000,
    ),
    "the checkout never came back to a reconciled settings page",
  );
  const returned = await alice.evaluate(BILLING);
  const planRow = await pgOne(
    `SELECT plan_id, polar_customer_id, polar_subscription_id FROM workspace_plans WHERE workspace_id = $1`,
    [alice.workspaceId],
  );
  check(
    "the return path reconciled by READING the checkout back: Postgres holds alice's plan row, on pro, with the rail's ids",
    planRow?.plan_id === "pro" &&
      typeof planRow?.polar_customer_id === "string" &&
      planRow.polar_customer_id.length > 0 &&
      typeof planRow?.polar_subscription_id === "string" &&
      planRow.polar_subscription_id.length > 0,
    JSON.stringify(planRow),
  );
  check(
    "and the page the customer lands on says so, in the fixed copy the server chose (D121)",
    returned.main.includes("Your plan is updated"),
    returned.main.slice(0, 200),
  );

  // The plan is read on the NEXT render, and that is a measured property of
  // this seam rather than a convenience: the layout resolves `getUsage` before
  // the page below it reconciles the returning checkout, and D183's
  // request-scoped cache then hands the page the same object the layout
  // already got — so the render that announces the upgrade is still measured
  // against the plan the customer had a second ago (returned to the manager as
  // a seam finding). What the round trip has to prove is that the plan the
  // catalog sells is the plan the product then shows, and that is here.
  await openTab(alice, "Billing & usage", `document.querySelector("main")?.textContent.includes("usage this period")`);
  const upgraded = await alice.evaluate(BILLING);
  const proPair = pairIn(upgraded.main.split("events (spans + log records)")[1] ?? "");
  const proPlan = await pgOne(`SELECT event_quota, retention_days FROM plans WHERE id = $1`, ["pro"]);
  check(
    "the tab now shows the plan it just bought — its name, its catalog quota, its retention, none of them restated in TypeScript (D163)",
    proPair !== null &&
      proPair[0] === ledger.events &&
      proPair[1] === Number(proPlan?.event_quota) &&
      upgraded.main.includes(`${proPlan?.retention_days} days · Pro`),
    `${JSON.stringify(proPair)} vs catalog ${JSON.stringify(proPlan)}`,
  );
  check(
    "and the banner goes with it — the same used number, now under a quota that does not warrant one",
    upgraded.banner === null,
    upgraded.banner,
  );

  step("alice revokes the key — the row is stamped, and the list says so about THAT key");
  await openTab(
    alice,
    "API keys",
    `document.querySelector("main")?.textContent.includes(${JSON.stringify(`${prefix}…`)})`,
  );
  must(await alice.evaluate(clickText("revoke")), "the listed key has no revoke control");
  // Polled in the store rather than read off the copy, and this is the D142
  // reason: the tab carries the standing sentence "a revoked key stops being
  // accepted within 30 seconds" whether or not anything is revoked, so a page
  // containing the word says nothing about this key (measured on T5's surface).
  let revokedAt = null;
  for (let attempt = 0; attempt < 40 && !revokedAt; attempt++) {
    revokedAt = (
      await pgOne(`SELECT revoked_at FROM api_keys WHERE workspace_id = $1`, [alice.workspaceId])
    )?.revoked_at;
    if (!revokedAt) await sleep(250);
  }
  check("the key's row carries a revoked_at stamp", Boolean(revokedAt), `revoked_at=${revokedAt}`);
  await openTab(alice, "API keys", REVOKED_IN_LIST);
  const revokedTab = await alice.evaluate(SETTINGS);
  check(
    "the list renders the revoked state against that prefix, with no revoke control left on it",
    new RegExp(`${prefix}….{0,80}revoked \\d{4}-\\d{2}-\\d{2}`).test(revokedTab.text),
    revokedTab.text.slice(0, 240),
  );

  step("the identity store, after two strangers, one key and one invitation (D138)");
  const demoWorkspaces = await pgRows(`SELECT id, org_id FROM workspaces WHERE id = 'ws_demo' OR org_id = 'org_demo'`);
  const demoMembers = await pgRows(`SELECT id FROM "member" WHERE "organizationId" = 'org_demo'`);
  check(
    "exactly one ws_demo row, on org_demo — 0004's continuity seed, which supersedes S3.1's zero-rows line (D138)",
    demoWorkspaces.length === 1 &&
      demoWorkspaces[0].id === "ws_demo" &&
      demoWorkspaces[0].org_id === "org_demo",
    JSON.stringify(demoWorkspaces),
  );
  check(
    "and NO member row references org_demo — which is what keeps it product-invisible, by construction",
    demoMembers.length === 0,
    `${demoMembers.length} member row(s)`,
  );
  const strangerWorkspaces = await pgRows(`SELECT id FROM workspaces WHERE id = ANY($1)`, [
    [alice.workspaceId, bob.workspaceId],
  ]);
  check(
    "the two stranger workspaces stand beside it, one per signup",
    strangerWorkspaces.length === 2,
    JSON.stringify(strangerWorkspaces.map((w) => w.id)),
  );
  const devKey = await pgOne(`SELECT prefix, workspace_id, revoked_at FROM api_keys WHERE id = 'key_dev_local'`);
  const aliceKeys = await pgRows(`SELECT prefix, revoked_at FROM api_keys WHERE workspace_id = $1`, [
    alice.workspaceId,
  ]);
  const bobKeys = await pgRows(`SELECT id FROM api_keys WHERE workspace_id = $1`, [bob.workspaceId]);
  check(
    "api_keys holds the seeded dev row live on ws_demo, alice's one issued-and-revoked key, and nothing of bob's",
    devKey?.workspace_id === "ws_demo" &&
      devKey?.prefix === "ok_dev_local" &&
      devKey?.revoked_at === null &&
      aliceKeys.length === 1 &&
      aliceKeys[0].prefix === prefix &&
      aliceKeys[0].revoked_at !== null &&
      bobKeys.length === 0,
    `dev=${JSON.stringify(devKey)} alice=${JSON.stringify(aliceKeys)} bob=${bobKeys.length}`,
  );

  // ------------------------------------------------- session, then none
  step("alice signs out — the one cookie goes, and so does the shell");
  await alice.goto("/app/traces", `!!document.querySelector("[data-workspace-id]")`);
  must(await alice.evaluate(clickLabel("Account menu")), "the account menu is not in the top bar");
  await alice.waitFor(`document.body.textContent.includes("Sign out")`);
  const menuState = await alice.evaluate(STATE);
  check(
    "the account menu names the signed-in operator and the workspace being read",
    menuState.text.includes(ACTORS.alice.email) && menuState.text.includes(`workspace ${alice.workspaceId}`),
    ACTORS.alice.email,
  );
  // A browser sends Origin on this POST by itself; the same request from curl
  // without one is refused 403 MISSING_OR_NULL_ORIGIN — which is precisely why
  // sign-out is asserted from a browser and not with fetch.
  must(await alice.evaluate(clickText("Sign out")), "the sign-out button is not in the account menu");
  must(await alice.waitFor(`location.pathname === "/login"`, 20_000), "sign-out did not land on /login");
  const jarAfter = await alice.cookies();
  check("no session cookie survives the sign-out", jarAfter.length === 0, jarAfter.map((c) => c.name).join(", "));

  step("the unauthenticated probe: every wired route refuses a browser with no session");
  // The server log is split HERE (D132): everything above is authenticated work
  // and must be error-free; the NoSessionError line below is the D114 tripwire
  // firing behind a guard that wins the response, which is spec.
  const logSplit = statSync(appLog).size;
  for (const path of ["/app", "/app/traces", `/app/traces/${PROMPT_TRACE}`, "/app/logs", "/app/settings"]) {
    await alice.goto(path, `document.body.textContent.length > 0`);
    const state = await alice.evaluate(STATE);
    check(
      `${path} with no session lands on /login and renders no telemetry`,
      state.url.startsWith("/login") && !state.text.includes(SPAN_PROMPT_TOKEN) && state.workspaceAttr === null,
      state.url,
    );
  }

  step("the server log: clean everywhere, with exactly one named exception (D132)");
  // Sliced as BYTES, because that is what the mark is: the log carries `⨯`, `✓`
  // and ANSI escapes, so a byte offset used as a string index lands mid-line and
  // hands the first segment a fragment of the second one's first error — a
  // split that reports the allowlisted line as an unallowed one (measured).
  const wholeLog = readFileSync(appLog);
  const isError = (line) => /Error\b|⨯|unhandledRejection/.test(line);
  const authenticated = wholeLog.subarray(0, logSplit).toString("utf8").split("\n").filter(isError);
  const unauthenticated = wholeLog.subarray(logSplit).toString("utf8").split("\n").filter(isError);
  check(
    "no error line at all across every authenticated step",
    authenticated.length === 0,
    authenticated.slice(0, 3).join(" | "),
  );
  // The allowlist is exactly one error, by name, on these steps only: a
  // different error class here — or this one on an authenticated path above —
  // is still red (D132's rider, D60's precedent).
  const notAllowed = unauthenticated.filter((line) => !line.includes("NoSessionError"));
  check(
    "the unauthenticated probe's only error is NoSessionError — the D114 tripwire, allowlisted by name",
    unauthenticated.length > 0 && notAllowed.length === 0,
    notAllowed.slice(0, 3).join(" | ") || "the tripwire logged nothing at all",
  );
} catch (error) {
  // A precondition that did not hold, or a step that threw: the run is over and
  // it is a FAILURE, not an exception nobody counted. Everything asserted up to
  // here still prints, and the artifacts stay on disk.
  failures++;
  console.log(`  FAIL the drive aborted — ${error?.stack ?? error}`);
} finally {
  step("result");
  stopAll();
  writeFileSync(join(OUT, "transcript.json"), JSON.stringify(transcript, null, 2));
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const passed = transcript.filter((t) => t.ok === true).length;
  console.log(`   ${passed} passed, ${failures} failed in ${seconds}s — artifacts in ${OUT}`);
  console.log(`\ne2e drive: ${failures === 0 ? `PASS (${seconds}s)` : `FAIL (${failures})`}`);
  // Explicit: the CDP sockets and the detached children would otherwise hold
  // the loop open past the verdict.
  process.exit(failures === 0 ? 0 : 1);
}
