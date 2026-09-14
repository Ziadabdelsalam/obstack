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
 * THE S3.4 STEP IS THE ONE D115 NAMED AND THIS FILE DEFERRED THREE TIMES:
 * ATTRIBUTION — that a token issued in the product lands its telemetry in its
 * own workspace and no other. It is taken now, and taken through the surface a
 * customer uses: alice opens /app/onboarding, presses the issue affordance, and
 * the drive reads the token OFF THE RENDERED SNIPPET (the only place it ever
 * exists — a stored token is unrecoverable, D98) and sends a real three-span
 * trace with it over the published OTLP wire. The trace is then asserted present
 * in alice's rows and absent from bob's, by its own WORDS through the product's
 * own search and not only by an id (D142); her waiting panel flips, within one
 * metering flush plus one client poll and never a longer sleep, to a link whose
 * trace id IS the id the drive sent; and /app/connections shows that key's
 * cumulative counts with the instant they were counted at. What is asserted in
 * the metering steps below is a different question — what the events did to the
 * METER — and the two are kept apart: the attribution trace is three events the
 * ledger arithmetic there names and accounts for.
 *
 * AND THE TOKEN IS A SHOWN-ONCE CREDENTIAL, SO THE DRIVE HANDLES IT LIKE ONE.
 * Every line this run prints and every artifact it writes is searched for the
 * literal at the end (the "token hygiene" step): a drive that proved attribution
 * by copying a live key into a CI log would have published it to everyone who
 * can read that log. The only place it is allowed to appear is the Authorization
 * header it is sent in.
 *
 * THE S3.5 STEP IS WHAT SHE DOES WITH A TRACE THAT FAILED. Explain is the first
 * thing in this product that costs a metered run to press, so the step walks the
 * whole of it: alice opens one of her own failed traces, presses Explain, and the
 * panel streams a real answer — the fake engine's, which is the engine with the
 * provider taken out (D168) and the only one CI ever runs, because U6 is absolute
 * and CI never spends. Then it walks the refusal ON PURPOSE, by lowering the
 * plan's Explain allowance the way D172 lowers the event quota, so the run after
 * the last one is refused and the refusal is read as the product outcome it is
 * (D241): a 200, a terminal `refusal` frame, and a sentence a person can act on
 * rather than an error.
 *
 * The evidence links are checked where they are actually decided. A panel can
 * render "show this span" whatever the id underneath it says, so the second run
 * is made as the panel makes it — the same POST, carrying her session — and read
 * as the NDJSON contract: every span id the answer cites is checked against the
 * span ids ClickHouse holds for THAT trace (D223). Two independent runs of one
 * trace also have to produce one answer, which is what "deterministic" has to
 * mean for a fake that carries the drive.
 *
 * IT RUNS INSIDE THE METERING PROPAGATION WINDOW, DELIBERATELY (D207). The step
 * below it waits out one flush plus one workspace-state TTL before it can send an
 * over-quota export, and that wait is wall time this drive was already spending.
 * Explain touches the app and Postgres and never ingest, so it changes nothing
 * that wait is about — and the sleep is computed from an ABSOLUTE deadline, so
 * work done first is work the run gets for free.
 *
 * THE BILLING RAIL HERE IS THE FAKE, ALWAYS (D168). It is not a stub: a checkout
 * is created, the browser is redirected to OUR return path with a real id, the
 * settings page reads it back and writes the plan row, so the whole return
 * reconciliation the Polar rails exercise is exercised here with no third party
 * in it. The Polar modes are elsewhere — `polar-sandbox` for the evidence run,
 * `polar` for a production deployment (D338) — and the drive refuses to run
 * under EITHER rather than quietly billing against a real Polar organisation.
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CARRIER_TOKEN,
  ALERT_DEAD_CHANNEL,
  ALERT_DEAD_RULE,
  ALERT_LIVE_CHANNEL,
  ALERT_LIVE_RULE,
  CARRIER_TRACE,
  CHAIN_SERVICES,
  DASHBOARD_NAME,
  dashboardWidgets,
  endUserIds,
  errorSignatures,
  EVIDENCE_FREE_QUOTA,
  LOG_BODY_TOKEN,
  LOG_TRACE,
  metricNames,
  PROMPT_TRACE,
  SLO_AVAILABILITY,
  SLO_AVAILABILITY_TARGET,
  SLO_AVAILABILITY_WINDOW,
  SLO_EMPTY,
  SLO_EMPTY_SERVICE,
  SLO_LATENCY,
  SLO_LATENCY_TARGET,
  SLO_LATENCY_THRESHOLD_MS,
  SLO_LATENCY_WINDOW,
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
const METERED_ACCEPTED = FILL_EVENTS + KEPT_VECTORS * (VECTOR_SPANS + 1);
const EXPECTED_QUOTA_DROPS = (PINNED_VECTORS.length - KEPT_VECTORS) * (VECTOR_SPANS + 1);

/**
 * The content this step's telemetry says, so its rows are found by their WORDS
 * and not only by an id (D142) — the same discipline the seeded fixture keeps,
 * applied to the events that arrive over the wire.
 */
const QUOTA_TOKEN = `zzmeter${RUN}`;

/** The banner's own vocabulary — one string, so "raised" and "absent" are one claim. */
const BANNER_MARK = "-tier events used";

// --------------------------------------- the S3.4 attribution values (D115)
/**
 * The first trace a workspace ever sends is a TRACE, not a span: a root and the
 * two children under it, which is the shape the product's waterfall renders and
 * the shape a single span would not have proven anything about.
 *
 * Its id is derived from this run rather than pinned, because the drive asserts
 * that the panel links THE TRACE IT SENT — an id shared with an earlier run
 * would make that equality satisfiable by a leftover row. Its words are its
 * content label (D142), the same discipline the fixture and the metering step
 * keep: the attribution claim is read out of the product's own search.
 */
const FIRST_SPANS = 3;
const FIRST_LABEL = `zzfirst${RUN}`;
const FIRST_TRACE_ID = createHash("sha256").update(`first-trace-${RUN}`).digest("hex").slice(0, 32);

/**
 * What the ledger holds for alice's WORKSPACE once both wire steps have run —
 * the attribution trace's three events plus what the metering step's own key
 * carried. Two constants rather than one because the two claims are different:
 * the ledger and the Data & ingest tab are per workspace and therefore hold
 * both keys' events, while the per-key health row the metering step reads holds
 * only its own (`METERED_ACCEPTED`).
 */
const EXPECTED_ACCEPTED = FIRST_SPANS + METERED_ACCEPTED;

/**
 * The quickstart's client poll (`components/onboarding/Quickstart.tsx`, D203),
 * mirrored here the way `FLUSH_MS` mirrors the Go constant — and the flip's
 * ceiling is arithmetic over the two, not a number tuned until it passed: the
 * counters move within one metering flush, and the panel learns within one poll
 * of the moment they moved. The extra second and a half is the round trip and
 * the paint, and nothing above it is waited for: a flip that has not happened by
 * then is a FAILURE, never a longer sleep (W4 amendment 4).
 */
const CLIENT_POLL_MS = 5_000;
const FLIP_CEILING_MS = FLUSH_MS + CLIENT_POLL_MS + 1_500;

// ------------------------------------------- the S3.5 Explain values (D245)
/**
 * The Explain allowance this run's free plan gets. Lowered exactly the way the
 * event quota is (D172): the catalog says twenty, and pressing Explain twenty
 * times to watch the twenty-first be refused would buy nothing the second one
 * does not. Two is the smallest number that still walks BOTH sides of the cap —
 * one run allowed, one refused — and it is the PLAN row that is lowered, so the
 * path this exercises (`plans` → `server/explain/quota.ts` → the one atomic
 * statement) is the same path a real workspace crosses at twenty.
 */
const EVIDENCE_EXPLAIN_QUOTA = 2;

/**
 * Every environment name an Explain credential can arrive under (D102): the
 * cloud key and the self-hosted one. Named once because two different things
 * read this list — the environment the app is SERVED with, which must contain
 * neither, and the hygiene sweep at the end, which searches this run's own
 * output for whichever of them the caller's shell happened to hold.
 */
const EXPLAIN_CREDENTIALS = ["ANTHROPIC_API_KEY", "OBSTACK_EXPLAIN_API_KEY"];

const appEnv = {
  ...process.env,
  OBSTACK_DATA_MODE: "live",
  CLICKHOUSE_URL: CH,
  CLICKHOUSE_USER: "obstack_web",
  CLICKHOUSE_PASSWORD: "obstack_web_dev",
  OBSTACK_POSTGRES_DSN: PG_DSN,
  BETTER_AUTH_SECRET,
};
// U6 made mechanical: the server this drive measures holds no Explain
// credential, so there is none for it to spend and none for it to leak. Fake
// mode is the client's default and the refusal below keeps it that way; this
// line is the other half — a key exported in the caller's shell does not travel
// into the process the drive starts, whatever mode anything later decides.
for (const name of EXPLAIN_CREDENTIALS) delete appEnv[name];

// ------------------------------------------------------------- reporting
const startedAt = Date.now();
let failures = 0;
const transcript = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * The free plan's catalog row as this run FOUND it (D566). Both writes below
 * lower it for the run's own proofs, and until S7.4 nothing put it back: a
 * driven stack carried `event_quota = 300, explain_quota = 2` into
 * `usage.integration.test.ts` and `explain/quota.integration.test.ts`, which
 * both read the catalog and went red. Read here by the drive's own pool before
 * the first write, restored in `finally` before the pool ends — never from a
 * number spelled in this file, which would be a second copy of the migration's.
 */
let catalogBefore = null;

/**
 * Everything this run prints, kept as it is printed.
 *
 * The token-hygiene step (D98/W4 amendment 2) asserts that a shown-once key
 * never reached stdout — and on CI stdout IS the log everybody can read. Reading
 * it back requires having kept it: a reviewer's promise that no `console.log`
 * below carries a token is exactly the kind of claim this drive exists to
 * replace with a fact. So the two writers are teed here, once, before any step
 * runs.
 */
const printed = [];
for (const level of ["log", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    printed.push(args.join(" "));
    original(...args);
  };
}

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
  // unauthenticated-slice lines are then read as errors on an authenticated
  // path — a red about a run that already finished (measured).
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
/**
 * The same read as `chCount`, as ROWS: the Explain step needs a span's own
 * words and its id, not a total, and the ids it checks the answer's evidence
 * links against have to come from the store rather than from the answer.
 */
async function chRows(sql) {
  const res = await fetch(`${CH}/?user=obstack_web&password=obstack_web_dev`, {
    method: "POST",
    body: `${sql} FORMAT JSONEachRow`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse: ${res.status} ${text}`);
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
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

const serviceAttr = (name) => ({ key: "service.name", value: { stringValue: name } });
const SERVICE_ATTR = serviceAttr(`${QUOTA_TOKEN}-svc`);
/** The service defaults to the metering step's; the attribution step sends its
 *  own, because that name is one of the words its trace is then FOUND by (D142). */
const tracesExport = (spans, service = SERVICE_ATTR) => ({
  resourceSpans: [{ resource: { attributes: [service] }, scopeSpans: [{ spans }] }],
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
 * every statement below is a SELECT, with exactly two exceptions on one row —
 * the Explain step lowers `plans.explain_quota` for the free plan (the D172
 * class), and `finally` puts both lowered columns back from the values this run
 * read before it wrote (D566).
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

/** The severity picker and the promote picker are `<select>`s behind real
 * <label>s (`IncidentEditor.tsx`), so a select is addressed by the label it sits
 * under. React's onChange on a select is the native `change` event, which is
 * why that — and not `input` — is what gets dispatched. */
const choose = (label, value) => `(() => {
  const el = [...document.querySelectorAll("label")]
    .find((l) => (l.textContent || "").trim().startsWith(${JSON.stringify(label)}))?.querySelector("select");
  if (!el) return null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
})()`;

/** A button found by a SUBSTRING of its text: the RCA control renders its label
 *  and a `one Explain run` caption as sibling nodes, so its whole text is not a
 *  sentence anyone would type and `clickText`'s exact match cannot name it. */
const clickIncluding = (text) => `(() => {
  const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`;

/** A store-held string as React serialises it into server HTML: the evaluator's
 *  event titles carry `>` (`Exit gauge threshold: 42 > 40`), and a claim that
 *  reads the raw title off the rendered page would miss every one of them. */
const htmlText = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

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
 * The quickstart, read the way its reader reads it — and read NARROWLY on
 * purpose: this page carries a live token in its snippets once one is issued, so
 * the whole-body `text` every other reader here returns is exactly what must not
 * come back from this one. What the drive gets is a handful of booleans, the
 * linked trace, and the token itself, which goes into a variable and into an
 * Authorization header and nowhere else (D98, W4 amendment 2).
 */
const QUICKSTART = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const text = strip(document.body.textContent || "");
  const snippet = strip(document.querySelector("pre")?.textContent || "");
  const link = document.querySelector('a[href^="/app/traces/"]');
  return {
    badge: text.includes("SAMPLE DATA"),
    waiting: text.includes("waiting for data"),
    issued: text.includes("Key issued"),
    received: text.includes("first trace received"),
    placeholder: snippet.includes("<OBSTACK_API_KEY>"),
    bearer: /OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20\\S+/.test(snippet),
    href: link?.getAttribute("href") ?? null,
    linked: strip(link?.textContent || "") || null,
    token: /ok_live_[0-9a-f]{64}/.exec(snippet)?.[0] ?? null,
  };
})()`;

/**
 * The connections hub as its reader sees it. `main` again, so a claim about the
 * panel cannot be satisfied by the shell around it, and the whole text comes
 * back because every assertion on this surface is about WORDS — the hub renders
 * no token, only a prefix.
 */
const CONNECTIONS = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  return {
    badge: document.body.textContent.includes("SAMPLE DATA"),
    text: strip(document.querySelector("main")?.textContent || ""),
  };
})()`;

/**
 * The Explain panel as its reader sees it, and ONLY the panel: the trace page
 * around it renders the failing span's name and status too, so a claim read off
 * the whole body could be satisfied by the waterfall rather than by the answer.
 * The close control is the anchor — it is the panel's own labelled affordance,
 * and its grandparent is the panel (`ExplainPanel.tsx`: root → header → button).
 *
 * The links are counted rather than followed. What a "show this span" button
 * points at is not in the DOM at all — it calls back into the page with a span
 * id — so the panel proves the affordance exists, and the frame read beside it
 * proves the id under it is a span this trace holds.
 */
const EXPLAIN = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const close = document.querySelector('[aria-label="Close explanation"]');
  const panel = close?.parentElement?.parentElement ?? null;
  const text = strip(panel?.textContent || "");
  const counter = /(\\d+) of (\\d+) Explain runs used this month/.exec(text);
  return {
    open: Boolean(panel),
    text,
    used: counter ? Number(counter[1]) : null,
    quota: counter ? Number(counter[2]) : null,
    spanLinks: [...(panel?.querySelectorAll("button") ?? [])]
      .filter((b) => strip(b.textContent) === "show this span").length,
    logLinks: [...(panel?.querySelectorAll("a") ?? [])]
      .filter((a) => strip(a.textContent) === "show the correlated logs").length,
  };
})()`;

/** A run is over when the counter line is on screen: the panel renders it only
 *  once the stream has reached a terminal state (answer or refusal). */
const EXPLAIN_SETTLED = `/\\d+ of \\d+ Explain runs used this month/.test(document.body.textContent ?? "")`;

/**
 * The RCA panel as its reader sees it, and ONLY the panel — the EXPLAIN reader's
 * reason, one surface over: the incident page around it renders the same row
 * titles in its timeline, so a claim read off the whole body could be satisfied
 * by the rail rather than by the answer. The panel's live region is the anchor:
 * it exists only once the reader has PRESSED the control (`IncidentRcaPanel.tsx`
 * — a page view never runs, D552), and its parent is the panel. `aria-busy` goes
 * false when the stream reaches a terminal state, so that is the settle
 * condition — the counter line alone would not do, because the panel prints it
 * under the control BEFORE any run.
 */
const RCA_SETTLED = `(() => {
  const live = document.querySelector('[aria-live="polite"][aria-busy="false"]');
  return Boolean(live) && /\\d+ of \\d+ Explain runs used this month/.test(live.parentElement?.textContent ?? "");
})()`;
const RCA = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const live = document.querySelector('[aria-live="polite"]');
  const panel = live?.parentElement ?? null;
  const text = strip(panel?.textContent || "");
  const counter = /(\\d+) of (\\d+) Explain runs used this month/.exec(text);
  return {
    open: Boolean(panel),
    text,
    used: counter ? Number(counter[1]) : null,
    quota: counter ? Number(counter[2]) : null,
    // The two link shapes an incident's evidence renders (D553): an in-page
    // anchor onto a timeline row, and a Link to an example trace.
    rowRefs: [...(panel?.querySelectorAll('a[href^="#"]') ?? [])].map((a) => a.getAttribute("href").slice(1)),
    traceRefs: [...(panel?.querySelectorAll('a[href^="/app/traces/"]') ?? [])]
      .map((a) => a.getAttribute("href").slice("/app/traces/".length)),
  };
})()`;

/** The revoke control of ONE named key. The list holds two by the time it is
 *  used — the quickstart's and the metering step's — so "the first revoke
 *  button" would be a claim about row order; the hidden `keyId` the form posts
 *  is the row's own identity, and it is the id Postgres just handed us. */
const clickRevoke = (keyId) => `(() => {
  const field = document.querySelector(${JSON.stringify(`input[name="keyId"][value="${keyId}"]`)});
  const button = field?.closest("form")?.querySelector("button");
  if (!button) return false;
  button.click();
  return true;
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
console.log(
  `   first trace ${FIRST_TRACE_ID} · ${FIRST_SPANS} spans labelled ${FIRST_LABEL} · panel flip ceiling ` +
    `${FLIP_CEILING_MS / 1000}s (flush ${FLUSH_MS / 1000}s + client poll ${CLIENT_POLL_MS / 1000}s)`,
);
// The value, not a claim about it: the refusal below accepts an explicit `fake`
// as well as no value at all, so this prints WHICH of the two this run had and
// leaves "and therefore the fake rail, with no Polar and no secret" to the
// refusal that actually enforces it (D168).
console.log(
  `   billing    OBSTACK_BILLING_MODE ${
    process.env.OBSTACK_BILLING_MODE === undefined
      ? "unset — the fake rail, which is the client's default"
      : JSON.stringify(process.env.OBSTACK_BILLING_MODE)
  } (the refusals below accept no other rail)`,
);
console.log(
  `   explain    fake engine (OBSTACK_EXPLAIN_MODE ${
    process.env.OBSTACK_EXPLAIN_MODE === undefined ? "unset — the client's default" : "fake"
  }, no credential in the served environment) · free allowance lowered to ${EVIDENCE_EXPLAIN_QUOTA} runs`,
);
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
if (process.env.OBSTACK_EXPLAIN_MODE !== undefined && process.env.OBSTACK_EXPLAIN_MODE !== "fake") {
  refuse(
    `OBSTACK_EXPLAIN_MODE is ${JSON.stringify(process.env.OBSTACK_EXPLAIN_MODE)} — U6 is absolute: CI never ` +
      `spends, so this drive asserts against the fake engine's deterministic output (D168) and never calls a ` +
      `provider. The one real-key run is the evidence run, made by a person. Unset it.`,
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

  // S6.4 (D463): the control is `/app/ask`. It was `/app/costs` from S3.1 until
  // this sprint wired that route, and a control is only a control while the
  // route under it is genuinely unwired — `live-routes.test.ts` holds the other
  // half of that pair, going red the day `/app/ask` is wired too.
  step("the SAMPLE badge still exists (positive control — an unwired route)");
  const unwired = await pageFor(alice, "/app/ask");
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

  // S6.4 (D461): PLACED HERE, and it can only be here. The one seeding
  // definition is one shape seeded twice (D135), so the moment bob's workspace
  // is seeded he holds the same two LLM spans she does — the priced one and the
  // unpriced one — and the zero-calls empty state stops being true of anybody.
  // This window, after his signup and before his seed, is the only place the
  // drive can read it, and reading it here also costs nothing: a workspace with
  // no LLM span in it is exactly what the sentence is about.
  const bobCosts = await pageFor(bob, "/app/costs");
  check(
    "and his cost page states that no LLM call has been traced in his workspace, rather than a $0.00 he never spent (D13/D461)",
    bobCosts.status === 200 &&
      bobCosts.html.includes("No LLM calls in this workspace") &&
      bobCosts.html.includes("traces in the last 24 hours.") &&
      !bobCosts.html.includes("SAMPLE DATA"),
    `HTTP ${bobCosts.status} · badge ${bobCosts.html.includes("SAMPLE DATA")} · ` +
      `${bobCosts.html.match(/No LLM calls[^<]*/)?.[0] ?? "no empty sentence"}`,
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

  // ------------------------------- onboarding + attribution (the S3.4 step)
  /**
   * WHY HERE. These steps run after alice is settled and BEFORE the quota comes
   * down: past that line every export is a candidate for sampling, and a first
   * trace that survives one run in ten would make the panel's flip a coin toss
   * rather than a claim. Under quota the three spans are simply accepted — and
   * they are three events in her ledger, which the metering arithmetic below
   * names (`EXPECTED_ACCEPTED`) instead of pretending they did not happen.
   */
  step("alice opens the quickstart: live-wired, a placeholder slot, and an honest wait");
  must(
    await alice.goto("/app/onboarding", `document.body.textContent.includes("Get your first trace")`),
    "/app/onboarding never rendered",
  );
  const quickstart = await alice.evaluate(QUICKSTART);
  check(
    "the route is live-wired — no SAMPLE badge — and the snippets carry the placeholder slot, not a fabricated key",
    !quickstart.badge && quickstart.placeholder && quickstart.token === null,
    `badge=${quickstart.badge} placeholder=${quickstart.placeholder} ` +
      `token=${quickstart.token === null ? "none" : "PRESENT before issuing"}`,
  );
  check(
    "and the panel is waiting, because nothing has ever reached this workspace over the wire (D203)",
    quickstart.waiting && quickstart.linked === null,
    `waiting=${quickstart.waiting} link=${quickstart.linked}`,
  );

  step("she issues a key on that page, and the snippet she copies IS what carries it (D115/D201)");
  must(await alice.evaluate(clickText("Issue a key")), "the quickstart has no issue affordance");
  must(
    await alice.waitFor(`document.body.textContent.includes("Key issued")`, 20_000),
    "the quickstart never confirmed an issued key",
  );
  const issued = await alice.evaluate(QUICKSTART);
  /** Taken FROM THE PAGE, which is the only place it exists (D98) — and from
   *  here on it is a credential: it goes into an Authorization header and into
   *  no `console.log`, no check detail and no artifact (the hygiene step). */
  const firstToken = issued.token ?? "";
  const firstPrefix = firstToken.slice(0, 12);
  check(
    "the token lands in the snippet as a whole ok_live_ key, inside the URL-encoded Bearer header the SDKs read (D78)",
    /^ok_live_[0-9a-f]{64}$/.test(firstToken) && issued.bearer && !issued.placeholder,
    firstToken
      ? `${firstPrefix}… (${firstToken.length} chars) bearer=${issued.bearer} placeholder=${issued.placeholder}`
      : "no token in the snippet",
  );
  must(firstToken, "the quickstart rendered no token — every claim below would be about nothing");
  const firstKey = await pgOne(
    `SELECT id, name, token_hash FROM api_keys WHERE workspace_id = $1 AND prefix = $2`,
    [alice.workspaceId, firstPrefix],
  );
  check(
    "and Postgres holds it under the quickstart's own default name, by its SHA-256 and never by its value (D98/D201)",
    firstKey?.name === "Quickstart" &&
      firstKey?.token_hash === createHash("sha256").update(firstToken, "utf8").digest("hex"),
    `name=${firstKey?.name} hash=${firstKey?.token_hash?.slice(0, 16)}…`,
  );

  step(`that key carries a real trace over OTLP — a root and ${FIRST_SPANS - 1} children, on the published wire (D6)`);
  const firstRoot = spanOf(FIRST_TRACE_ID, `${FIRST_LABEL} POST /checkout`);
  const firstSpans = [
    firstRoot,
    { ...spanOf(FIRST_TRACE_ID, `${FIRST_LABEL} db.query`), parentSpanId: firstRoot.spanId },
    { ...spanOf(FIRST_TRACE_ID, `${FIRST_LABEL} llm.chat`), parentSpanId: firstRoot.spanId },
  ];
  const firstSend = await otlp("traces", firstToken, tracesExport(firstSpans, serviceAttr(`${FIRST_LABEL}-svc`)));
  const sentAt = Date.now();
  check(
    "ingest accepts it — a token nobody pasted from anywhere, issued and used inside one minute",
    firstSend.status === 200,
    `HTTP ${firstSend.status} ${firstSend.body.slice(0, 120)}`,
  );

  step(
    `the waiting panel flips inside ${FLIP_CEILING_MS / 1000}s — one ${FLUSH_MS / 1000}s flush plus one ` +
      `${CLIENT_POLL_MS / 1000}s client poll — and links THAT trace`,
  );
  // Bounded from the SEND, not from now: the ceiling is the arithmetic above and
  // a flip that misses it is red. No sleep here at all — the panel polls itself,
  // and this waits on what it renders.
  const flipped = await alice.waitFor(
    `document.body.textContent.includes("first trace received")`,
    Math.max(0, sentAt + FLIP_CEILING_MS - Date.now()),
  );
  const flipSeconds = ((Date.now() - sentAt) / 1000).toFixed(1);
  const panel = await alice.evaluate(QUICKSTART);
  check(
    "the panel stopped waiting and said so, without a reload — its own poll carried it (D203)",
    flipped && panel.received && !panel.waiting,
    `flipped=${flipped} after ${flipSeconds}s (ceiling ${FLIP_CEILING_MS / 1000}s)`,
  );
  check(
    "and the trace it links is the one the drive sent — the id, not merely the newest row in her store",
    panel.linked === FIRST_TRACE_ID && panel.href === `/app/traces/${FIRST_TRACE_ID}`,
    `${panel.linked} → ${panel.href} · sent ${FIRST_TRACE_ID}`,
  );

  step("ATTRIBUTION (D115/D142): that trace is in alice's workspace, in her words, and in no other");
  const firstSpansIn = (workspace) =>
    chCount(
      `SELECT count() FROM obstack.spans WHERE trace_id='${FIRST_TRACE_ID}' ` +
        `AND workspace_id='${workspace}' AND name LIKE '%${FIRST_LABEL}%'`,
    );
  const inAlice = await firstSpansIn(alice.workspaceId);
  const inBob = await firstSpansIn(bob.workspaceId);
  // Asked without a workspace filter too, which is the half a per-tenant count
  // cannot make: three spans HERE and three spans IN TOTAL is what says the key
  // wrote nowhere else — including into a workspace no actor of this run owns.
  const inAny = await chCount(`SELECT count() FROM obstack.spans WHERE trace_id='${FIRST_TRACE_ID}'`);
  check(
    `all ${FIRST_SPANS} spans landed in the issuing workspace, none in bob's, and none anywhere else in the store`,
    inAlice === FIRST_SPANS && inBob === 0 && inAny === FIRST_SPANS,
    `alice=${inAlice} bob=${inBob} everywhere=${inAny}`,
  );
  // And through the PRODUCT, by the words the trace says (D142): a count could
  // be satisfied by rows a page never reaches, and the tenancy claim is about
  // what each stranger's own surfaces answer.
  const aliceFinds = await pageFor(alice, `/app/traces?q=${FIRST_LABEL}`);
  const bobFinds = await pageFor(bob, `/app/traces?q=${FIRST_LABEL}`);
  check(
    "the product's own search agrees: her list reaches it by its own vocabulary, his reaches nothing at all",
    rowsIn(aliceFinds.html) === 1 &&
      idsIn(aliceFinds.html)[0] === FIRST_TRACE_ID &&
      rowsIn(bobFinds.html) === 0 &&
      bobFinds.html.includes("0 of 0 traces"),
    `alice ${rowsIn(aliceFinds.html)} row(s) ${idsIn(aliceFinds.html)[0]} · bob ${rowsIn(bobFinds.html)} row(s)`,
  );

  step("/app/connections: that key's health, in the words the surface actually renders (D100/D260/D219)");
  must(
    await alice.goto("/app/connections", `document.querySelector("main")?.textContent.includes("connected ·")`),
    "/app/connections never rendered",
  );
  const hub = await alice.evaluate(CONNECTIONS);
  check(
    "no SAMPLE badge on /app/connections either — a live-wired route, while /app/ask above still carries one (D21/D106)",
    !hub.badge,
    "badge present",
  );
  check(
    `the panel lists exactly the key events arrived on: the quickstart's, healthy, with its ${FIRST_SPANS} accepted`,
    hub.text.includes("connected · 1") &&
      hub.text.includes(`${firstPrefix}…`) &&
      hub.text.includes("Quickstart") &&
      hub.text.includes(`${FIRST_SPANS} accepted`) &&
      hub.text.includes("healthy"),
    hub.text.slice(0, 240),
  );
  check(
    "and the settings key, which nothing was ever sent on, is not a source — a credential is not a connection",
    !hub.text.includes(`${prefix}…`),
    `${prefix}… is listed as a connected source`,
  );
  check(
    "the counts say what they are: cumulative and dated, errors receive-path or cardinality-cap drops, quota as sampling and not a fault (D260/D219)",
    /accepted and sampled are cumulative per key, as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(hub.text) &&
      hub.text.includes("errors are receive-path or cardinality-cap drops") &&
      hub.text.includes("sampled records are the plan's quota, not a fault") &&
      /last event \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(hub.text) &&
      hub.text.includes("0 sampled") &&
      hub.text.includes("0 errs"),
    hub.text.slice(0, 320),
  );
  // D260 supersedes D218's refusal: the rate is MEASURED from the windowed
  // rows the metering flush writes, over a window the panel states. This
  // export happened seconds ago, inside the minute still filling, and the
  // window deliberately covers only COMPLETE minutes — so the honest render
  // right now is the dash, which the caveat explains in the same breath
  // (D297). What must never appear is a per-minute figure derived from the
  // cumulative counters, which is what D218 refused and what a "3/min" here
  // would be.
  check(
    "the rate is measured over a stated window, and reads — until a complete minute has passed (D260/D297)",
    hub.text.includes("rate is accepted records per minute over the last 5 complete minutes") &&
      hub.text.includes("— means no records of any kind arrived on that key in the window") &&
      !new RegExp(`${FIRST_SPANS}\\s*/min`).test(hub.text),
    hub.text.slice(0, 320),
  );

  // -------------------------------------------- metering (the S3.3 step)
  step(`the free plan's quota comes down to ${EVIDENCE_FREE_QUOTA} in this disposable Postgres (D172)`);
  // D566: the previous values, captured by this run's own read before anything
  // it does moves them — the seeder keeps holding no previous value (its own
  // doc comment stays true), the drive does.
  catalogBefore = await pgOne(`SELECT event_quota, explain_quota FROM plans WHERE id = 'free'`);
  must(catalogBefore, "the plans catalog holds no free row to lower — the migrations did not run");
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
  // STRAIGHT INTO CLICKHOUSE and never through ingest, so the only thing her
  // ledger holds is the attribution trace's three events — and her shell carries
  // no banner. Without this line, "the banner is raised" could be a banner that
  // is always there.
  const quietLedger = await ledgerOf(alice.workspaceId);
  const quietShell = await pageFor(alice, "/app/traces");
  check(
    `before the fill: the ledger holds the attribution trace's ${FIRST_SPANS} events and nothing else — ` +
      `220 seeded traces cost nothing — and no banner in the shell (the control for 'raised')`,
    quietLedger.events === FIRST_SPANS && !quietShell.html.includes(BANNER_MARK),
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
  while (ledger.events < FIRST_SPANS + FILL_EVENTS && Date.now() < flushDeadline) {
    await sleep(500);
    ledger = await ledgerOf(alice.workspaceId);
  }
  check(
    `the metering flush wrote all ${FILL_EVENTS} accepted events into usage_ledger beside the attribution ` +
      `trace's ${FIRST_SPANS}, past the ${EVIDENCE_FREE_QUOTA} quota`,
    ledger.events === FIRST_SPANS + FILL_EVENTS,
    `${ledger.events} event(s) after ${Math.round((Date.now() - lastUnderQuotaSendAt) / 1000)}s`,
  );
  // ------------------------------------------- explain (the S3.5 step, D245)
  // RUN HERE ON PURPOSE (D207). Everything from this line to the sleep below is
  // wall time the drive was already spending: the sleep is computed from an
  // ABSOLUTE deadline — one flush plus one workspace-state TTL past the last
  // under-quota export — so work done before it costs the run nothing until it
  // exceeds the window. Explain touches the app and Postgres and never ingest,
  // so nothing it does is visible to the propagation this wait is about.
  step(`the free plan's Explain allowance comes down to ${EVIDENCE_EXPLAIN_QUOTA} runs a month (D172 class)`);
  // Written from here rather than from `exit-seed.mjs`: that seeder's subject is
  // the fixture two workspaces are seeded FROM, and this is one row of this
  // step's own setup. Same store, same posture as the quota it lowers beside —
  // an UPDATE this run puts back itself: both columns were captured into
  // `catalogBefore` before the first write and are restored in `finally` from
  // that capture (D566), so a driven stack no longer carries a two-run free plan
  // until `docker compose … down -v`. The number is stated once, above, and
  // every claim below reads it back out of the catalog rather than restating it
  // (D163: no quota is spelled in a surface).
  const explainPlan = await pgOne(
    `UPDATE plans SET explain_quota = $1 WHERE id = 'free' RETURNING id, explain_quota`,
    [EVIDENCE_EXPLAIN_QUOTA],
  );
  check(
    `the plans catalog — the ONE Explain definition (D226) — now includes ${EVIDENCE_EXPLAIN_QUOTA} runs`,
    Number(explainPlan?.explain_quota) === EVIDENCE_EXPLAIN_QUOTA,
    `explain_quota=${explainPlan?.explain_quota}`,
  );

  step("alice opens one of her own failed traces and presses Explain (D102/D168)");
  // Her failing trace, found by the drive's own SQL rather than by the id the
  // fixture happens to give it — and the SAME query hands back the span id the
  // evidence link is checked against below, so "the link names a span this trace
  // holds" is a claim about the store and not about the answer that made it.
  const [failing] = await chRows(
    `SELECT trace_id, span_id, name, service FROM obstack.spans ` +
      `WHERE workspace_id='${alice.workspaceId}' AND status_code='error' ORDER BY trace_id LIMIT 1`,
  );
  must(failing, `${alice.workspaceId} holds no failing span — there is nothing here to explain`);
  const traceSpanIds = new Set(
    (
      await chRows(
        `SELECT span_id FROM obstack.spans ` +
          `WHERE workspace_id='${alice.workspaceId}' AND trace_id='${failing.trace_id}'`,
      )
    ).map((row) => row.span_id),
  );
  /** What the fake writes off THIS trace: the failing span's own name and service. */
  const expectedHeadline = `${failing.name} failed in ${failing.service}`;

  must(
    await alice.goto(
      `/app/traces/${failing.trace_id}`,
      `document.body.textContent.includes("Explain this trace")`,
    ),
    `the failed trace ${failing.trace_id} never rendered its Explain control`,
  );
  const tracePage = await alice.evaluate(STATE);
  check(
    "the trace detail carries neither mode marker in live mode: no SAMPLE badge, and no demo-workspace bar (D228)",
    !tracePage.badge && !tracePage.text.includes("DEMO WORKSPACE"),
    `badge ${tracePage.badge} · demo bar ${tracePage.text.includes("DEMO WORKSPACE")}`,
  );
  must(await alice.evaluate(clickText("Explain this trace")), "the Explain control did not click");
  must(await alice.waitFor(EXPLAIN_SETTLED, 20_000), "the Explain panel never reached a terminal state");
  const answered = await alice.evaluate(EXPLAIN);
  const explainRow = async () =>
    pgOne(`SELECT used, to_char(period_start, 'YYYY-MM') AS month FROM explain_runs WHERE workspace_id = $1`, [
      alice.workspaceId,
    ]);
  const spent = await explainRow();
  check(
    "the panel answered about THIS trace — the failing span's own name and service, under the four labels",
    answered.open &&
      answered.text.includes(expectedHeadline) &&
      answered.text.includes("WHAT FAILED") &&
      answered.text.includes("ROOT CAUSE") &&
      answered.text.includes("SUGGESTED FIX"),
    answered.text.slice(0, 240),
  );
  check(
    "and it says plainly that no model read it — a deployment running the fake cannot show a person a reading nobody made (D102)",
    answered.text.includes("This deployment runs Explain in fake mode"),
    answered.text.slice(0, 240),
  );
  check(
    "the evidence is linked rather than narrated: at least one item offers the span it cites",
    answered.spanLinks >= 1,
    `${answered.spanLinks} span link(s), ${answered.logLinks} log link(s)`,
  );
  check(
    `the counter line divides the plan's own two numbers — 1 of ${EVIDENCE_EXPLAIN_QUOTA}, and no hardcoded 20 anywhere (D163/D226)`,
    answered.used === 1 && answered.quota === EVIDENCE_EXPLAIN_QUOTA,
    `${answered.used} of ${answered.quota}`,
  );
  check(
    "and the spend is one row for this calendar month, in UTC — the drive's own SQL, not the number the panel printed (D225)",
    Number(spent?.used) === 1 && spent?.month === new Date().toISOString().slice(0, 7),
    JSON.stringify(spent),
  );

  step("the frame underneath it: deltas, one terminal event, and evidence ids this trace really holds (D227/D223)");
  // The second run, made the way the panel makes it — the same POST carrying her
  // session — because what a "show this span" button points at is not in the DOM.
  // Two independent runs of one trace must also produce ONE answer: that is what
  // determinism has to mean for the engine CI runs.
  const framed = await fetch(`${BASE}/app/traces/${failing.trace_id}/explain`, {
    method: "POST",
    headers: { cookie: alice.cookieHeader },
  });
  const frames = (await framed.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const deltas = frames.filter((event) => event.type === "delta");
  const terminal = frames.filter((event) => event.type !== "delta");
  check(
    "200 as newline-delimited JSON, never stored, and the frame is deltas then exactly one terminal `result` (D227)",
    framed.status === 200 &&
      framed.headers.get("content-type") === "application/x-ndjson" &&
      (framed.headers.get("cache-control") ?? "").includes("no-store") &&
      deltas.length > 1 &&
      terminal.length === 1 &&
      terminal[0].type === "result" &&
      frames[frames.length - 1] === terminal[0],
    `HTTP ${framed.status} ${framed.headers.get("content-type")} · ${deltas.length} delta(s) · ` +
      `${terminal.map((event) => event.type).join(", ") || "no terminal event"}`,
  );
  const explanation = terminal[0]?.explanation;
  check(
    "the deltas ARE the answer, and the answer is the one the panel rendered — two runs of this trace, one reading",
    deltas.map((event) => event.text).join("").includes(expectedHeadline) &&
      explanation?.headline === expectedHeadline,
    `${explanation?.headline} vs ${expectedHeadline}`,
  );
  const linked = (explanation?.evidence ?? []).filter((item) => item.spanId);
  check(
    "every span id the evidence links is a span ClickHouse holds for this trace, the failing one among them — an id the trace cannot back is dropped, never linked (D102/D223)",
    linked.length >= 1 &&
      linked.every((item) => traceSpanIds.has(item.spanId)) &&
      linked.some((item) => item.spanId === failing.span_id) &&
      !(explanation?.evidence ?? []).some((item) => item.detail.includes("is not in this trace")),
    `${linked.map((item) => item.spanId).join(", ") || "no linked evidence"} vs ${failing.span_id}`,
  );

  step(`run ${EVIDENCE_EXPLAIN_QUOTA + 1} is refused, and the refusal is a product outcome rather than an error (D225/D241)`);
  must(
    await alice.goto(
      `/app/traces/${failing.trace_id}`,
      `document.body.textContent.includes("Explain this trace")`,
    ),
    "the failed trace never rendered a second time",
  );
  must(await alice.evaluate(clickText("Explain this trace")), "the Explain control did not click");
  must(await alice.waitFor(EXPLAIN_SETTLED, 20_000), "the over-quota panel never reached a terminal state");
  const refusedRun = await alice.evaluate(EXPLAIN);
  const afterRefusal = await explainRow();
  check(
    "the panel states what happened and what changes it — the plan's runs for this month are spent, so no run was made",
    refusedRun.text.includes(
      `This workspace has used all ${EVIDENCE_EXPLAIN_QUOTA} Explain runs its plan includes this month, so no run was made`,
    ) && refusedRun.text.includes("resets at the start of next month"),
    refusedRun.text.slice(0, 240),
  );
  check(
    `and it spent nothing: the counter still reads ${EVIDENCE_EXPLAIN_QUOTA} of ${EVIDENCE_EXPLAIN_QUOTA}, and so does the row the statement guards (D225)`,
    refusedRun.used === EVIDENCE_EXPLAIN_QUOTA &&
      refusedRun.quota === EVIDENCE_EXPLAIN_QUOTA &&
      Number(afterRefusal?.used) === EVIDENCE_EXPLAIN_QUOTA,
    `panel ${refusedRun.used} of ${refusedRun.quota} · row ${JSON.stringify(afterRefusal)}`,
  );

  step("one Explain definition: the panel's counter IS the settings meter (D226)");
  await openTab(alice, "Billing & usage", `document.querySelector("main")?.textContent.includes("Explain runs")`);
  const explainMeter = await alice.evaluate(BILLING);
  const explainPair = pairIn(explainMeter.main.split("Explain runs")[1] ?? "");
  check(
    `the meter divides the same two numbers the panel did and the route enforced: ${EVIDENCE_EXPLAIN_QUOTA} of ${EVIDENCE_EXPLAIN_QUOTA}`,
    explainPair !== null &&
      explainPair[0] === refusedRun.used &&
      explainPair[1] === refusedRun.quota &&
      explainPair[0] === Number(afterRefusal?.used),
    `meter ${JSON.stringify(explainPair)} · panel ${refusedRun.used} of ${refusedRun.quota}`,
  );

  // Measured from the last export, because that is when the workspace-state
  // entry ingest is holding was last able to be built — it was built with a
  // ledger that had not crossed yet, and it lives for one TTL. What is left of
  // it after the Explain step is printed, not assumed: it is the measurement the
  // D207 reclaim is made of, and the run that stops having any is the run that
  // starts paying for its steps again.
  const windowLeftMs = Math.max(0, lastUnderQuotaSendAt + STATE_TTL_MS + 3_000 - Date.now());
  console.log(`   ${Math.round(windowLeftMs / 1000)}s of the propagation wait left after the Explain step (D207)`);
  await sleep(windowLeftMs);

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
  // BY KEY, not by workspace: alice holds two keys now — the quickstart's, which
  // carried the attribution trace, and this one — and a health claim that read
  // whichever row came back first would be a claim about neither.
  const health = await pgOne(
    `SELECT h.accepted, h.dropped_decode, h.dropped_unsupported, h.dropped_quota, h.last_event_at
       FROM api_key_health h JOIN api_keys k ON k.id = h.key_id
      WHERE h.workspace_id = $1 AND k.prefix = $2`,
    [alice.workspaceId, prefix],
  );
  check(
    `the ledger holds exactly what ingest accepted — ${FILL_EVENTS} under quota, the surviving trace and the ` +
      `attribution trace's ${FIRST_SPANS}, and none of what it shed`,
    ledger.events === EXPECTED_ACCEPTED && ledger.asOf !== null,
    `${ledger.events} event(s), want ${EXPECTED_ACCEPTED}`,
  );
  check(
    "and this key's own health row agrees with what this key sent, drop for drop (D100)",
    Number(health?.accepted) === METERED_ACCEPTED &&
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

  step("the Data & ingest tab: what this workspace's keys carried, refused and shed (D100/D141)");
  // The tab is per WORKSPACE and sums its keys (`getIngestHealth`), so the
  // denominator here is the drive's own sum over both of alice's health rows —
  // read as its own statement, the way every other number in this drive is.
  const healthTotals = await pgOne(
    `SELECT sum(accepted) AS accepted, sum(dropped_decode) AS dropped_decode,
            sum(dropped_unsupported) AS dropped_unsupported, sum(dropped_quota) AS dropped_quota
       FROM api_key_health WHERE workspace_id = $1`,
    [alice.workspaceId],
  );
  await openTab(alice, "Data & ingest", `document.querySelector("main")?.textContent.includes("ingest health · ")`);
  const ingestTab = await alice.evaluate(SETTINGS);
  check(
    `the three totals are both health rows' own — ${EXPECTED_ACCEPTED} accepted · 1 receive-path error · ${EXPECTED_QUOTA_DROPS} sampled out`,
    Number(healthTotals?.accepted) === EXPECTED_ACCEPTED &&
      statAfter(ingestTab.text, "events accepted") === Number(healthTotals?.accepted) &&
      statAfter(ingestTab.text, "receive-path errors") === Number(healthTotals?.dropped_decode) &&
      statAfter(ingestTab.text, "sampled out (quota)") === Number(healthTotals?.dropped_quota),
    `accepted=${statAfter(ingestTab.text, "events accepted")} errors=${statAfter(ingestTab.text, "receive-path errors")} ` +
      `sampled=${statAfter(ingestTab.text, "sampled out (quota)")} vs rows ${JSON.stringify(healthTotals)}`,
  );
  check(
    "attributed to the keys alice issued, with the basis and the staleness of the count stated (D162)",
    ingestTab.text.includes(`${prefix}…`) &&
      ingestTab.text.includes(`${firstPrefix}…`) &&
      /receive-path errors, as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(ingestTab.text) &&
      ingestTab.text.includes("write-path failures are not counted here"),
    ingestTab.text.slice(0, 240),
  );

  // -------------------------------------------------------- metrics (S6.1)
  /**
   * PLACED HERE, and the placement is load-bearing. `RecordAcceptedMetrics`
   * (D368) increments the SAME `api_key_health.accepted` column the two claims
   * immediately above read EXACTLY — the connections hub's `${FIRST_SPANS}
   * accepted` and the Data & ingest tab's `EXPECTED_ACCEPTED` — so seven data
   * points arriving before either of them would make both of them wrong about
   * a number that is right. Nothing below asserts an accepted count: the
   * remaining usage claims are over `usage_ledger`, which metrics never touch
   * (D365/D368 — metrics are not billed, and quota cannot fire on them, which
   * is also why this step works at all while alice is over her free quota).
   */
  /** Every accepted event on either stranger's keys, summed by the drive's own
   *  statement for the reason the ClickHouse denominators are (D71(b)).
   *  Defined here, before the first leg whose points increment it, because the
   *  dashboards leg below both baselines against this number and needs the two
   *  metric legs' points SETTLED into it first (S6.4 — the metering flush is
   *  periodic and holds its batch across a failed transaction, so "sent
   *  minutes ago" is not "flushed"). */
  const acceptedOnTheirKeys = async () =>
    Number(
      (
        await pgOne(
          `SELECT coalesce(sum(accepted), 0) AS accepted
             FROM api_key_health WHERE workspace_id = ANY($1)`,
          [[alice.workspaceId, bob.workspaceId]],
        )
      )?.accepted ?? 0,
    );
  const acceptedBeforeMetricLegs = await acceptedOnTheirKeys();

  step("alice's metrics go in the FRONT DOOR: three OTLP temperaments on the real /v1/metrics (D370)");
  const metricsSeed = spawnSync(
    "node",
    [
      join(composeDir, "exit-seed.mjs"),
      "--leg",
      "metrics",
      "--workspace",
      alice.workspaceId,
      "--label",
      ACTORS.alice.label,
    ],
    {
      cwd: repoRoot,
      // The key travels in the ENVIRONMENT and never in argv: `ps` publishes a
      // command line to every process on the box, and the hygiene step at the
      // end asserts this token reached nothing this run printed or wrote.
      env: { ...process.env, SEED_METRICS_TOKEN: firstToken, INGEST_OTLP },
      encoding: "utf8",
    },
  );
  writeFileSync(join(OUT, "seed-metrics-alice.json"), `${metricsSeed.stdout ?? ""}${metricsSeed.stderr ?? ""}`);
  must(metricsSeed.status === 0, `exit-seed.mjs --leg metrics failed: ${metricsSeed.stderr}`);
  const metricsSent = JSON.parse(metricsSeed.stdout);
  console.log(`   ${metricsSeed.stdout.trim().split("\n").join("\n   ")}`);
  const aliceMetrics = metricNames(ACTORS.alice.label);
  check(
    "the export the seeder sent is the one this drive is about to open a page on — same three names, from one definition (D115)",
    metricsSent.expectations.map((e) => e.name).sort().join(",") === Object.values(aliceMetrics).sort().join(","),
    `${metricsSent.expectations.map((e) => `${e.name}:${e.type}`).join(" ")} vs ${Object.values(aliceMetrics).join(" ")}`,
  );

  // ------------------------------------------------------ k8s + costs (S6.4)
  /**
   * PLACED IMMEDIATELY AFTER THE LEG ABOVE, for its reason and for one more.
   * The accepted-count rationale is the same one: metric points DO increment
   * `api_key_health.accepted` (D368 — RecordAcceptedMetrics), so like the leg
   * above this one must run after the two claims that read that column
   * exactly; and like that leg it touches `usage_ledger` and quota for
   * nothing (D365 — metrics are not billed). The second reason is FRESHNESS —
   * `INFRA_STALE_MINUTES` is 10
   * and the fixture stamps its points three minutes back (D467), so the cluster
   * this seeds has about six minutes before `/app/infra` stops rendering it at
   * all. The page is therefore opened on the next lines, not after the S6.2
   * five and the dashboards leg, which together take minutes.
   *
   * Same front door as the leg above, for the same reason: the real
   * `/v1/metrics` with alice's own key, in the environment and never in argv.
   * No `--label` — nothing this leg sends is content (D467).
   */
  step("alice's cluster goes in the same FRONT DOOR: two nodes, five pods, one of them already stale (D467)");
  const k8sSeed = spawnSync(
    "node",
    [join(composeDir, "exit-seed.mjs"), "--leg", "k8s", "--workspace", alice.workspaceId],
    {
      cwd: repoRoot,
      env: { ...process.env, SEED_METRICS_TOKEN: firstToken, INGEST_OTLP },
      encoding: "utf8",
    },
  );
  writeFileSync(join(OUT, "seed-k8s-alice.json"), `${k8sSeed.stdout ?? ""}${k8sSeed.stderr ?? ""}`);
  must(k8sSeed.status === 0, `exit-seed.mjs --leg k8s failed: ${k8sSeed.stderr}`);
  const k8sSent = JSON.parse(k8sSeed.stdout);
  console.log(`   ${k8sSeed.stdout.trim().split("\n").join("\n   ")}`);
  /** What the seeder says it sent, in its own words (S2.3 L3) — the pod names,
   *  the header and the ratios below are read from here, never spelled twice. */
  const k8s = k8sSent.expectations;

  /**
   * ARRIVAL IS A BATCH AWAY, AND A PAGE CANNOT POLL. Ingest flushes on its own
   * schedule and the 1m rollup is written by a materialized view on that same
   * insert, so the store is asked — for the seeder's OWN point count — until
   * every point is in `metric_points_1m`, the one table `queryInfraSnapshot`
   * reads. A deadline rather than a sleep: a pipeline that never delivers says
   * so here, instead of turning into an empty cluster three claims later.
   */
  const K8S_ARRIVAL_MS = 30_000;
  const K8S_STORED_SQL =
    `SELECT count() FROM obstack.metric_points_1m WHERE workspace_id = '${alice.workspaceId}' ` +
    `AND (name LIKE 'k8s.%' OR name LIKE 'container.%')`;
  const k8sDeadline = Date.now() + K8S_ARRIVAL_MS;
  let k8sStored = 0;
  for (;;) {
    k8sStored = await chCount(K8S_STORED_SQL);
    if (k8sStored >= k8sSent.points_sent || Date.now() > k8sDeadline) break;
    await sleep(1_000);
  }
  check(
    `all ${k8sSent.points_sent} point(s) of that export reached metric_points_1m — the one table the infra page reads`,
    k8sStored >= k8sSent.points_sent,
    `${k8sStored} row(s) after ${K8S_ARRIVAL_MS / 1000}s`,
  );

  step("/app/infra is live-wired: her own nodes and pods, the stale one absent (D21/D367/D459)");
  const infra = await pageFor(alice, "/app/infra");
  const infraH1 = infra.html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];
  check(
    "the page renders her cluster with no SAMPLE badge — the D21 flip this sprint wires, while /app/ask above still carries one",
    infra.status === 200 && infraH1 === "Infrastructure" && !infra.html.includes("SAMPLE DATA"),
    `HTTP ${infra.status} · <h1>${infraH1}</h1> · badge ${infra.html.includes("SAMPLE DATA")}`,
  );
  check(
    `the header counts what the export actually said, the stale pod already excluded: ${k8s.header}`,
    infra.html.includes(k8s.header),
    infra.html.match(/[0-9]+ nodes · [0-9]+ pods[^<]*/)?.[0] ?? "no header line",
  );
  check(
    "both nodes and every fresh pod render, each pod drilling to its OWN logs filter (D61)",
    k8s.nodeNames.every((n) => infra.html.includes(n)) &&
      k8s.podNames.every((p) => infra.html.includes(`exit-ns/${p}`)) &&
      k8s.podNames.every((p) => infra.html.includes(`href="/app/logs?pod=${p}"`)),
    `missing: ${[...k8s.nodeNames, ...k8s.podNames].filter((n) => !infra.html.includes(n)).join(", ") || "none"}`,
  );
  /** A pod's own row, from its name cell to the end of the row: "5" and
   *  "pending" anywhere on a page of twenty cells would be nobody's claim. */
  const podRow = (name) => {
    const at = infra.html.indexOf(`exit-ns/${name}`);
    return at === -1 ? "" : infra.html.slice(at, infra.html.indexOf("</tr>", at));
  };
  check(
    `${k8s.crashPodName} carries its own ${k8s.crashRestarts} restarts and its real phase, both from the cluster leg`,
    podRow(k8s.crashPodName).includes(`>${k8s.crashRestarts}</td>`) &&
      podRow(k8s.crashPodName).includes(">pending</td>"),
    podRow(k8s.crashPodName).slice(0, 240) || `${k8s.crashPodName} has no row`,
  );
  check(
    `${k8s.kubeletOnlyPodName} renders on the kubelet leg alone, with the cells the cluster leg would fill marked missing rather than guessed (D13/D459)`,
    podRow(k8s.kubeletOnlyPodName).includes(">—</td>"),
    podRow(k8s.kubeletOnlyPodName).slice(0, 240) || `${k8s.kubeletOnlyPodName} has no row`,
  );
  check(
    `${k8s.stalePodName} is in the store and nowhere on the page — a series nobody has reported lately is ABSENT, not "running" (D456)`,
    !infra.html.includes(k8s.stalePodName),
    "the stale pod rendered",
  );
  check(
    "the right-sizing panel states the oversized limit as a MEASUREMENT — peak, limit and window, and no price anywhere (D458/D362)",
    infra.html.includes(
      `exit-ns/${k8s.oversizedPodName}/app peaked at ${k8s.oversizedPct}% of its 512 MiB memory limit`,
    ),
    infra.html.match(/[^>]*peaked at[^<]*/)?.[0] ?? "no recommendation rendered",
  );

  step("/app/infra for a workspace with no collector: the ruled sentence, and no cluster invented for it (D459)");
  const bobInfra = await pageFor(bob, "/app/infra");
  check(
    "bob's infra page says no cluster metrics have arrived, renders no table at all, and carries none of her nodes",
    bobInfra.status === 200 &&
      bobInfra.html.includes("No cluster metrics yet.") &&
      !bobInfra.html.includes("<table") &&
      !bobInfra.html.includes("exit-node") &&
      !bobInfra.html.includes("SAMPLE DATA"),
    `HTTP ${bobInfra.status} · sentence ${bobInfra.html.includes("No cluster metrics yet.")} · ` +
      `table ${bobInfra.html.includes("<table")} · her nodes ${bobInfra.html.includes("exit-node")}`,
  );

  step("/app/costs is live-wired: LLM spend derived from her own traces, every fenced figure ABSENT (D21/D362/D461)");
  const costs = await pageFor(alice, "/app/costs");
  check(
    "her spend is the one PRICED call the seed sent, named by the model that made it, with no SAMPLE badge",
    costs.status === 200 &&
      !costs.html.includes("SAMPLE DATA") &&
      costs.html.includes("$0.000031") &&
      costs.html.includes("gpt-4o-mini"),
    `HTTP ${costs.status} · badge ${costs.html.includes("SAMPLE DATA")} · ` +
      `total ${costs.html.includes("$0.000031")} · model ${costs.html.includes("gpt-4o-mini")}`,
  );
  check(
    "and the call no price table has a row for is COUNTED AND NAMED as unpriced, never folded into that total as free (D461)",
    costs.html.includes("exit-custom-ft") &&
      costs.html.includes("1 calls across 1 models carry no price row, so their cost is unknown — not $0."),
    costs.html.match(/[0-9]+ calls across [^<]*/)?.[0] ?? "no unpriced sentence",
  );
  // D362 as a RESULT: the fenced-out figures are not zeroed, estimated or
  // marked — they are not on the page. The words are the mock's own (customer,
  // infra $, margin, revenue, the billing connection it names). Searched with
  // the <script> blocks stripped, because Next embeds its built-in not-found
  // page — inline `margin:0` styles and all — in every page's RSC flight
  // payload, and a CSS property the reader never sees is not the mock's word.
  const costsVisible = costs.html.replace(/<script[\s\S]*?<\/script>/g, "");
  const fenced = ["Meridian", "$412", "margin", "revenue", "Stripe"].filter((w) => costsVisible.includes(w));
  check(
    "no customer, no revenue, no margin, no infra dollars and no billing connection — obstack holds no input for any of them (D362)",
    fenced.length === 0,
    `present: ${fenced.join(", ")}`,
  );

  /**
   * The contract answers through the app's own modules, which this drive —
   * plain node — cannot import: `metrics-checks.ts` runs under tsx with the
   * SAME environment the server is served with, prints its claims as JSON, and
   * every one of them is re-stated here so the transcript carries the claim
   * and not merely somebody else's exit code (which is also asserted).
   */
  function metricsChecks(actor, answering, extra = []) {
    const run = spawnSync(
      "npx",
      [
        "tsx",
        "--tsconfig",
        "apps/web/tsconfig.json",
        "--conditions",
        "react-server",
        join(composeDir, "metrics-checks.ts"),
        actor.workspaceId,
        JSON.stringify(metricsSent.expectations),
        ...extra,
      ],
      { cwd: repoRoot, env: appEnv, encoding: "utf8" },
    );
    writeFileSync(
      join(OUT, `metrics-checks-${actor.label}.json`),
      `${run.stdout ?? ""}${run.stderr ?? ""}`,
    );
    must(
      run.stdout?.trim().startsWith("{"),
      `metrics-checks.ts printed no claims for ${actor.workspaceId}: ${run.stderr}`,
    );
    const { claims } = JSON.parse(run.stdout);
    for (const c of claims) check(c.claim, c.ok, c.detail);
    // An empty or short claim list reads exactly like a green one, so what is
    // checked is the TIE — every subject this call was made about came back
    // named — plus the exit code, which is the same verdict by another route.
    check(
      `the checks module answered for all ${answering.length} subject(s) of that run, and agrees with its own exit code`,
      answering.every((m) => claims.some((c) => c.metric === m)) &&
        run.status === (claims.every((c) => c.ok) ? 0 : 1),
      `${claims.length} claim(s) [${[...new Set(claims.map((c) => c.metric))].join(", ")}] · exit ${run.status}`,
    );
    return claims;
  }
  metricsChecks(alice, metricsSent.expectations.map((e) => `${e.name}:${e.type}`));
  // The tenancy half, asked of the OTHER stranger with ALICE's expectations:
  // bob sent no metrics at all, so his catalog naming any of hers would be the
  // discovery path reading across the boundary (D142).
  metricsChecks(bob, ["tenancy"], ["--absent"]);

  step("/app/explore is live-wired: it renders the metric that arrived, with no SAMPLE badge (D21/D367)");
  const explore = await pageFor(
    alice,
    `/app/explore?metric=${encodeURIComponent(aliceMetrics.gauge)}&type=gauge&range=1h&agg=avg`,
  );
  const exploreH1 = explore.html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];
  check(
    "the deep link resolves server-side to that metric's own page — the <h1> is the name the export sent",
    explore.status === 200 && exploreH1 === aliceMetrics.gauge,
    `HTTP ${explore.status} · <h1>${exploreH1}</h1> · sent ${aliceMetrics.gauge}`,
  );
  check(
    "and it carries no SAMPLE badge — while /app/ask above still does, which is what makes this absence a fact",
    !explore.html.includes("SAMPLE DATA"),
    "badge present on a live-wired route",
  );
  check(
    "no cardinality-cap banner on a three-series workspace: the cap is read from metric_series, never assumed",
    !explore.html.includes("Series limit reached"),
    "the cap banner rendered for a workspace nowhere near it",
  );

  // ------------------------------------------------- the S6.2 five (D21/D405)
  /**
   * PLACED HERE and reading only: everything these five surfaces answer from is
   * already in the store — alice's seed, the quickstart trace her own key
   * carried, and the traffic the metering steps sent — and none of them writes
   * anything, so no accepted count, ledger row or health counter moves under
   * them (the reason the metrics step above is placed where it is).
   *
   * Read through `pageFor`, server-rendered HTML carrying her session, because
   * every claim below is about what a page SAYS: the seeded words her workspace
   * holds, and the total absence of the other stranger's (D142). The badge's
   * positive control is `/app/ask`, asserted once above — these five state
   * its absence against that same fact rather than re-proving it.
   */
  step("the five surfaces this sprint wired render alice's own workspace (D21/D367/D405)");
  const aliceLabel = ACTORS.alice.label;
  const bobLabel = ACTORS.bob.label;
  const [aliceUser1, aliceUser2] = endUserIds(aliceLabel);
  const aliceSignatures = errorSignatures(aliceLabel);
  const [, CHAIN_AGENT] = CHAIN_SERVICES;
  /** The service her quickstart export named — hers alone, and label-bearing. */
  const firstService = `${FIRST_LABEL}-svc`;

  const map = await pageFor(alice, "/app/map");
  // The map's own SVG, sliced off the page at its tour anchor: edges are the
  // only `<line>` inside it (a node is a rect, a circle and three texts), while
  // the shell around it draws icons made of lines. So this counts hops, and it
  // counts them where the map is.
  const mapSvg = map.html.split('data-tour="map"')[1]?.split("</svg>")[0] ?? "";
  const mapEdges = (mapSvg.match(/<line /g) ?? []).length;
  check(
    "/app/map draws the services alice's own spans name — the fixture's three and her quickstart's — with no SAMPLE badge",
    map.status === 200 &&
      !map.html.includes("SAMPLE DATA") &&
      CHAIN_SERVICES.every((service) => mapSvg.includes(service)) &&
      mapSvg.includes(firstService),
    `HTTP ${map.status} · badge ${map.html.includes("SAMPLE DATA")} · ` +
      `missing: ${CHAIN_SERVICES.filter((s) => !mapSvg.includes(s)).join(", ") || "none"} · quickstart ${mapSvg.includes(firstService)}`,
  );
  check(
    `and it draws exactly the ${CHAIN_SERVICES.length - 1} cross-service hops the fixture chains — an edge exists only where BOTH spans are stored`,
    mapEdges === CHAIN_SERVICES.length - 1,
    `${mapEdges} edge(s) drawn`,
  );
  check(
    "neither the empty state nor a cap banner on a workspace this far under the cap (D402)",
    !map.html.includes("No service has sent a span") && !map.html.includes("services by span volume"),
    "an empty state or a cap banner rendered over real, uncapped data",
  );

  const services = await pageFor(alice, "/app/services");
  check(
    "/app/services catalogs those same services from the traces themselves, with no SAMPLE badge and no cap banner",
    services.status === 200 &&
      !services.html.includes("SAMPLE DATA") &&
      CHAIN_SERVICES.every((service) => services.html.includes(service)) &&
      services.html.includes(firstService) &&
      !services.html.includes("services by span volume") &&
      !services.html.includes("no service has sent a span"),
    `HTTP ${services.status} · badge ${services.html.includes("SAMPLE DATA")} · ` +
      `missing: ${[...CHAIN_SERVICES, firstService].filter((s) => !services.html.includes(s)).join(", ") || "none"} · ` +
      `cap banner ${services.html.includes("services by span volume")} · ` +
      `empty state ${services.html.includes("no service has sent a span")}`,
  );

  const detail = await pageFor(alice, `/app/services/${CHAIN_AGENT}`);
  check(
    `/app/services/${CHAIN_AGENT} scores that service from its own spans and names them in alice's words`,
    detail.status === 200 &&
      !detail.html.includes("SAMPLE DATA") &&
      detail.html.includes(`POST /chat ${aliceLabel}`) &&
      detail.html.includes(`agent.plan ${aliceLabel}`) &&
      !detail.html.includes("No spans from"),
    `HTTP ${detail.status} · ${labelHits(detail.html, aliceLabel)}× ${aliceLabel}`,
  );
  check(
    "and the deploys panel is no longer marked: before any deploy is posted it states its honest empty sentence, not a sample (D362 released by D503)",
    !detail.html.includes("deploy tracking arrives") &&
      detail.html.includes("no deploys recorded for this service"),
    `marked ${detail.html.includes("deploy tracking arrives")} · ` +
      `empty ${detail.html.includes("no deploys recorded for this service")}`,
  );

  const users = await pageFor(alice, "/app/users");
  check(
    "/app/users names the two people her root spans carried an enduser.id for, with no SAMPLE badge and no cap banner",
    users.status === 200 &&
      !users.html.includes("SAMPLE DATA") &&
      users.html.includes(aliceUser1) &&
      users.html.includes(aliceUser2) &&
      !users.html.includes("users by requests") &&
      !users.html.includes("set one on your root span"),
    `HTTP ${users.status} · ${aliceUser1} ${users.html.includes(aliceUser1)} · ${aliceUser2} ${users.html.includes(aliceUser2)}`,
  );
  check(
    "the one whose requests absorbed every failure is the one marked AT RISK, and that failure links to the trace it happened in",
    users.html.includes("AT RISK") && users.html.includes(`POST /chat ${aliceLabel}`),
    "no at-risk user, or no last failure named",
  );

  const issues = await pageFor(alice, "/app/issues");
  check(
    "/app/issues titles her failures with the error messages her own spans carry, with no SAMPLE badge and no cap banner",
    issues.status === 200 &&
      !issues.html.includes("SAMPLE DATA") &&
      issues.html.includes(aliceSignatures.declined) &&
      !issues.html.includes("by occurrences in the last") &&
      !issues.html.includes("No errors in the last"),
    `HTTP ${issues.status} · badge ${issues.html.includes("SAMPLE DATA")} · ` +
      `declined signature ${issues.html.includes(aliceSignatures.declined)} · ` +
      `cap banner ${issues.html.includes("by occurrences in the last")} · ` +
      `empty state ${issues.html.includes("No errors in the last")}`,
  );
  // The grouping rule as an observable result (D399), read off the rendered
  // words rather than counted: the seven timeout failures carry seven different
  // numbers of ms, so if digits did NOT collapse this page would show seven
  // rows of one instead of one row of seven — and one of those numbers would be
  // on it. `&lt;num&gt;` is the placeholder as HTML actually carries it.
  const rawTimeoutOnPage = issues.html.match(new RegExp(`${aliceSignatures.timeoutPrefix} [0-9]+ms`))?.[0];
  check(
    "and the seven timeouts — each stamped with a different number of ms — are ONE group of seven, beside the digit-free four (D399)",
    issues.html.includes(`${aliceSignatures.timeoutPrefix} &lt;num&gt;ms ${aliceLabel}`) &&
      issues.html.includes("7× in 24h") &&
      issues.html.includes("4× in 24h") &&
      rawTimeoutOnPage === undefined,
    `normalized title ${issues.html.includes(`${aliceSignatures.timeoutPrefix} &lt;num&gt;ms ${aliceLabel}`)} · ` +
      `7× ${issues.html.includes("7× in 24h")} · 4× ${issues.html.includes("4× in 24h")} · raw ${rawTimeoutOnPage ?? "none"}`,
  );

  const diff = await pageFor(alice, `/app/traces/diff?a=${PROMPT_TRACE}&b=${LOG_TRACE}`);
  check(
    "/app/traces/diff compares two of her own seeded traces — both ids on the page, neither slot empty, no SAMPLE badge",
    diff.status === 200 &&
      !diff.html.includes("SAMPLE DATA") &&
      diff.html.includes(PROMPT_TRACE) &&
      diff.html.includes(LOG_TRACE) &&
      diff.html.includes(`chat.completion ${aliceLabel}`) &&
      !diff.html.includes("trace not found in this workspace") &&
      !diff.html.includes("pick a second trace"),
    `HTTP ${diff.status} · a ${diff.html.includes(PROMPT_TRACE)} · b ${diff.html.includes(LOG_TRACE)}`,
  );
  // The diff's tenancy half needs an id the two workspaces do NOT share, and
  // the seeded ones are deliberately identical in both (the negative probe's
  // property, above) — so it is asked with the trace alice's own key carried
  // over OTLP, which landed in her workspace and in no other.
  const bobDiff = await pageFor(bob, `/app/traces/diff?a=${FIRST_TRACE_ID}`);
  const aliceDiff = await pageFor(alice, `/app/traces/diff?a=${FIRST_TRACE_ID}`);
  check(
    "asked by the other stranger about a trace only she holds, that same URL resolves to nothing and says so — while for her it renders, in her words",
    bobDiff.html.includes("trace not found in this workspace") &&
      labelHits(bobDiff.html, FIRST_LABEL) === 0 &&
      !aliceDiff.html.includes("trace not found in this workspace") &&
      aliceDiff.html.includes(`${FIRST_LABEL} POST /checkout`),
    `bob ${bobDiff.status} · alice ${aliceDiff.status} · ${labelHits(bobDiff.html, FIRST_LABEL)}× ${FIRST_LABEL} on bob's page`,
  );

  step("content-aware disjointness, on the five new surfaces (the D142 idiom, extended)");
  const bobUsers = endUserIds(bobLabel);
  const bobSignatures = errorSignatures(bobLabel);
  for (const [path, own] of [
    ["/app/map", CHAIN_SERVICES],
    ["/app/services", CHAIN_SERVICES],
    [`/app/services/${CHAIN_AGENT}`, [`POST /chat ${bobLabel}`, `agent.plan ${bobLabel}`]],
    ["/app/users", bobUsers],
    ["/app/issues", [bobSignatures.declined]],
  ]) {
    const his = await pageFor(bob, path);
    check(
      `${path} in bob's browser renders his own workspace and zero of alice's words`,
      his.status === 200 &&
        own.every((word) => his.html.includes(word)) &&
        labelHits(his.html, aliceLabel) === 0 &&
        labelHits(his.html, FIRST_LABEL) === 0,
      `HTTP ${his.status} · missing his own: ${own.filter((w) => !his.html.includes(w)).join(", ") || "none"} · ` +
        `${labelHits(his.html, aliceLabel)}× ${aliceLabel} · ${labelHits(his.html, FIRST_LABEL)}× ${FIRST_LABEL}`,
    );
  }
  // And the same claim the other way round on the two surfaces that name people
  // and services: hers carry her words (asserted above) and none of his.
  for (const [path, html] of [
    ["/app/map", map.html],
    ["/app/users", users.html],
  ]) {
    check(
      `${path} in alice's browser carries zero of ${bobLabel}'s`,
      labelHits(html, bobLabel) === 0,
      `${labelHits(html, bobLabel)}× ${bobLabel}`,
    );
  }

  // ---------------------------------------------------- dashboards (S6.3)
  /**
   * PLACED HERE, and both halves of the placement are load-bearing. It is AFTER
   * the metrics leg because every widget below names one of the three metrics
   * that export sent — a dashboard over metrics that never arrived renders four
   * honest empty cards and proves nothing about the fold (D427). And it is the
   * one seeding in this run that goes STRAIGHT INTO POSTGRES: a dashboard is a
   * row somebody creates in the UI, and no exporter, endpoint or API can put
   * one there, so there is no front door to prefer (D115/D370's rule, and its
   * only exception).
   *
   * That the leg touches Postgres ALONE is measured rather than reasoned about:
   * `api_key_health.accepted` is the column every ingest path increments and
   * the one two claims above read exactly, so both strangers' totals are read
   * before this step and again after it, and must be the same number.
   */
  step("alice's dashboard is seeded straight into Postgres — the one row no front door can write (D115/D424)");
  /**
   * The before-read must not race the metering flush: the two metric legs'
   * points increment this same column, the flush is periodic (FLUSH_MS,
   * mirroring the Go constant) and a failed flush transaction holds its whole
   * batch for a later retry — measured once: both legs' 60 points landed
   * MINUTES after the sends, inside this very pair, turning "the dashboards
   * leg touched nothing" red about a number that was right. So the drive
   * first waits until every metric point it sent this run is IN the column —
   * a deadline, not a sleep, and a stronger claim while it is here: the
   * settled delta must be exactly the points the two seeds reported, no more.
   */
  const expectedMetricPoints = metricsSent.points_sent + k8sSent.points_sent;
  const settleDeadline = Date.now() + 30_000;
  let acceptedBefore = await acceptedOnTheirKeys();
  while (
    acceptedBefore - acceptedBeforeMetricLegs < expectedMetricPoints &&
    Date.now() < settleDeadline
  ) {
    await sleep(1_000);
    acceptedBefore = await acceptedOnTheirKeys();
  }
  check(
    `every metric point this run sent is metered before the leg that must not move the counter — ${expectedMetricPoints} point(s) over the two legs, exactly (D368)`,
    acceptedBefore - acceptedBeforeMetricLegs === expectedMetricPoints,
    `moved by ${acceptedBefore - acceptedBeforeMetricLegs} after ${(Date.now() - (settleDeadline - 30_000)) / 1000}s`,
  );
  const dashboardSeed = spawnSync(
    "node",
    [
      join(composeDir, "exit-seed.mjs"),
      "--leg",
      "dashboards",
      "--workspace",
      alice.workspaceId,
      "--label",
      ACTORS.alice.label,
    ],
    { cwd: repoRoot, env: { ...process.env, OBSTACK_POSTGRES_DSN: PG_DSN }, encoding: "utf8" },
  );
  writeFileSync(join(OUT, "seed-dashboards-alice.json"), `${dashboardSeed.stdout ?? ""}${dashboardSeed.stderr ?? ""}`);
  must(dashboardSeed.status === 0, `exit-seed.mjs --leg dashboards failed: ${dashboardSeed.stderr}`);
  const seeded = JSON.parse(dashboardSeed.stdout).dashboard;
  console.log(`   ${dashboardSeed.stdout.trim().split("\n").join("\n   ")}`);
  const dashboardId = seeded.id;
  /** The titles from the seeder's own definition, never spelled twice (S2.3 L3). */
  const widgetTitles = dashboardWidgets(ACTORS.alice.label).map((w) => w.title);
  check(
    "the row Postgres stored is the one this drive is about to open — a `dash_` id, the four widget titles from one definition, exactly one of them pinned (D425/D437)",
    /^dash_[0-9a-f]{16}$/.test(dashboardId) &&
      seeded.name === DASHBOARD_NAME &&
      Number(seeded.widgets) === widgetTitles.length &&
      Number(seeded.pinned) === 1 &&
      seeded.titles.join("|") === widgetTitles.join("|"),
    `${dashboardId} · ${seeded.name} · ${seeded.widgets} widget(s) · ${seeded.pinned} pinned · ${seeded.titles?.join(", ")}`,
  );

  step("/app/dashboards is live-wired: alice's own dashboard, the four kinds, and the fold on every card (D21/D367/D427)");
  const list = await pageFor(alice, "/app/dashboards");
  check(
    "the list names the dashboard the seed wrote and carries no SAMPLE badge — while /app/ask above still does, which is what makes this absence a fact",
    list.status === 200 &&
      list.html.includes(DASHBOARD_NAME) &&
      !list.html.includes("SAMPLE DATA") &&
      !list.html.includes("no dashboards yet"),
    `HTTP ${list.status} · badge ${list.html.includes("SAMPLE DATA")} · named ${list.html.includes(DASHBOARD_NAME)} · ` +
      `empty state ${list.html.includes("no dashboards yet")}`,
  );

  const board = await pageFor(alice, `/app/dashboards/${dashboardId}`);
  check(
    "the dashboard renders all four kinds by their own titles, with no SAMPLE badge and not one card failing its read (D428)",
    board.status === 200 &&
      !board.html.includes("SAMPLE DATA") &&
      widgetTitles.every((title) => board.html.includes(title)) &&
      !board.html.includes("no dashboard with this id") &&
      // React escapes the apostrophe in "couldn't", so the claim is made on the
      // half of that sentence the HTML carries verbatim.
      !board.html.includes("load this widget") &&
      !board.html.includes("no points in the last"),
    `HTTP ${board.status} · badge ${board.html.includes("SAMPLE DATA")} · ` +
      `missing: ${widgetTitles.filter((t) => !board.html.includes(t)).join(", ") || "none"}`,
  );

  /**
   * One widget card's own HTML. The cards render in widget order and a title
   * appears exactly ONCE on a server-rendered page (the edit controls that
   * repeat it are behind client state), so a card is what lies between its
   * title and the next one — the S6.2-L3 slice idiom, on a grid instead of an
   * SVG. Scoped because a bare "42" counted over the page would also match a
   * clock in a caption; `>42<` inside the card is the rendered VALUE.
   *
   * The LAST card is bounded by `</main>` rather than by the document, and the
   * reason was measured on the red run: everything after that tag is Next's
   * flight payload, which restates every prop this page rendered from — titles
   * and values included — so a slice running to `</body>` would be asserting
   * against the SERIALIZED TREE beside the DOM it means to read.
   */
  const cardOf = (html, i) =>
    (html.split(widgetTitles[i])[1] ?? "").split(widgetTitles[i + 1] ?? "</main>")[0];
  const gauge = metricsSent.expectations.find((e) => e.type === "gauge");
  const cumulative = metricsSent.expectations.find((e) => e.type === "sum");
  check(
    `the stat card folds that gauge to the ONE number the export sent — ${gauge.value}, as of the minute it was stamped — and names the fold that produced it (D427)`,
    cardOf(board.html, 0).includes(`>${gauge.value}<`) &&
      cardOf(board.html, 0).includes(`latest · as of ${gauge.bucket} · last 1h`),
    cardOf(board.html, 0).slice(0, 300),
  );
  check(
    `the top-n and table cards both fold the cumulative sum to its ${cumulative.value} in the one group the export's resource named, each captioned with its own fold (D427)`,
    [cardOf(board.html, 2), cardOf(board.html, 3)].every(
      (card) =>
        card.includes(cumulative.group) &&
        card.includes(`>${cumulative.value}<`) &&
        card.includes("sum · last 1h · ") &&
        card.includes(" buckets had data"),
    ),
    `topn ${cardOf(board.html, 2).slice(0, 200)} ··· table ${cardOf(board.html, 3).slice(0, 200)}`,
  );

  step("the overview's watch slot is a VIEW over the pinned flag — one widget, from a dashboard, no row of its own (D425/D434)");
  const overview = await pageFor(alice, "/app");
  /** The watch slot's own HTML: from the anchor the product tour spotlights to
   *  the end of the page region, which is where it ends (it is the last thing
   *  in `<main>`). `/app` carries SAMPLE chips of its own ABOVE this slot and
   *  Next's flight payload restates all of them BELOW `</main>`, so both bounds
   *  are load-bearing and every claim here is about the SLICE (S6.2-L3). */
  const watchSlice = (html) => (html.split('data-tour="watches"')[1] ?? "").split("</main>")[0];
  const watch = watchSlice(overview.html);
  check(
    "it counts the one widget alice pinned and renders it there — her stat's own title and its folded value — rather than the empty state",
    overview.status === 200 &&
      watch.includes("pinned from your dashboards · 1") &&
      watch.includes(widgetTitles[0]) &&
      watch.includes(`>${gauge.value}<`) &&
      !watch.includes("nothing pinned to the overview yet"),
    `HTTP ${overview.status} · header ${watch.includes("pinned from your dashboards · 1")} · ` +
      `title ${watch.includes(widgetTitles[0])} · value ${watch.includes(`>${gauge.value}<`)} · slice ${watch.length}B`,
  );
  check(
    "and the three widgets she did NOT pin are absent from it — a view over the flag, not over the array",
    widgetTitles.slice(1).every((title) => !watch.includes(title)),
    widgetTitles.slice(1).filter((title) => watch.includes(title)).join(", "),
  );
  check(
    "nothing in that slice claims to be sample content, while the same page above it still does — which is what makes the absence a fact about the slot (D21/F6)",
    !watch.includes("still renders sample content") &&
      overview.html.includes("still renders sample content"),
    `slice ${labelHits(watch, "still renders sample content")} · page ${labelHits(overview.html, "still renders sample content")}`,
  );

  step("and for the other stranger the same three URLs are empty — in the words D436 ruled, never hers (D142)");
  const bobList = await pageFor(bob, "/app/dashboards");
  check(
    "/app/dashboards in bob's browser says he has none, and does not name hers",
    bobList.status === 200 &&
      bobList.html.includes("no dashboards yet — create one, or save a chart from Explore") &&
      !bobList.html.includes(DASHBOARD_NAME) &&
      labelHits(bobList.html, aliceLabel) === 0,
    `HTTP ${bobList.status} · sentence ${bobList.html.includes("no dashboards yet")} · ` +
      `${labelHits(bobList.html, aliceLabel)}× ${aliceLabel}`,
  );
  const bobBoard = await pageFor(bob, `/app/dashboards/${dashboardId}`);
  check(
    "her dashboard's own id, asked for by him, answers exactly what an invented id answers — never her row, never a 500 (D436)",
    bobBoard.status === 200 &&
      bobBoard.html.includes("no dashboard with this id in your workspace") &&
      !bobBoard.html.includes(DASHBOARD_NAME) &&
      labelHits(bobBoard.html, aliceLabel) === 0,
    `HTTP ${bobBoard.status} · sentence ${bobBoard.html.includes("no dashboard with this id in your workspace")} · ` +
      `${labelHits(bobBoard.html, aliceLabel)}× ${aliceLabel}`,
  );
  const bobWatch = watchSlice((await pageFor(bob, "/app")).html);
  check(
    "and his overview's watch slot is the empty state, in the very slice hers renders a widget in",
    bobWatch.includes("nothing pinned to the overview yet — pin a widget from any dashboard") &&
      !bobWatch.includes("pinned from your dashboards · 1") &&
      labelHits(bobWatch, aliceLabel) === 0,
    `sentence ${bobWatch.includes("nothing pinned to the overview yet")} · ` +
      `${labelHits(bobWatch, aliceLabel)}× ${aliceLabel} in his slice`,
  );

  const acceptedAfter = await acceptedOnTheirKeys();
  check(
    `and none of this went near ingest: the accepted counter over both strangers' keys is where it was, ${acceptedBefore} → ${acceptedAfter} (D368)`,
    acceptedAfter === acceptedBefore,
    `api_key_health.accepted moved by ${acceptedAfter - acceptedBefore}`,
  );

  // ---------------------------------------------------- alerts (S7.1)
  /* Rules and channels are seeded the way dashboards are (UI rows, no front
   * door to prefer) — and everything the sprint exists to prove stays real:
   * T4's evaluator inside the ingest container claims the rules on its own
   * tick, reads the gauge the metrics leg SENT through the front door,
   * crosses `avg > 40 over 15m` on its value of 42, writes both events, and
   * the deliverer POSTs one to this drive's own receiver and burns three
   * attempts on a host that does not resolve — so `delivered` and `failed`
   * are both facts the feed must state (D485/D13), not styles it can render. */
  step("the alerts leg: a rule over alice's own gauge fires; both delivery truths become facts (D477–D492)");
  const hooks = [];
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hooks.push({ path: req.url, body });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((ready) => receiver.listen(0, "0.0.0.0", ready));
  const hookTarget = `http://host.docker.internal:${receiver.address().port}/hook`;

  const alertSeed = spawnSync(
    "node",
    [
      join(composeDir, "exit-seed.mjs"),
      "--leg",
      "alerts",
      "--workspace",
      alice.workspaceId,
      "--label",
      ACTORS.alice.label,
      "--target",
      hookTarget,
    ],
    { cwd: repoRoot, env: { ...process.env, OBSTACK_POSTGRES_DSN: PG_DSN }, encoding: "utf8" },
  );
  writeFileSync(join(OUT, "seed-alerts-alice.json"), `${alertSeed.stdout ?? ""}${alertSeed.stderr ?? ""}`);
  must(alertSeed.status === 0, `exit-seed.mjs --leg alerts failed: ${alertSeed.stderr}`);
  console.log(`   ${alertSeed.stdout.trim().split("\n").join("\n   ")}`);

  /* Settle against OBSERVED state, never elapsed time (the S6.4 flush-race
   * lesson): the evaluator's next tick is ≤60s out, the deliverer's ≤5s
   * behind it, and the dead channel needs three 5s rounds to reach `failed`.
   * The loop leaves on the page STATING both truths and the receiver holding
   * the POST — or on the deadline, and the checks below then say which claim
   * died. */
  const alertsDeadline = Date.now() + 120_000;
  let alertsPage = { status: 0, html: "" };
  for (;;) {
    alertsPage = await pageFor(alice, "/app/alerts");
    const settled =
      alertsPage.html.includes(">delivered<") &&
      alertsPage.html.includes("delivery failed") &&
      hooks.length > 0;
    if (settled || Date.now() > alertsDeadline) break;
    await sleep(2_000);
  }
  receiver.close();

  check(
    "/app/alerts renders both fired events at their rules' own severities, and the live rule shows firing (D484)",
    alertsPage.status === 200 &&
      alertsPage.html.includes(`${ALERT_LIVE_RULE}:`) &&
      alertsPage.html.includes(`${ALERT_DEAD_RULE}:`) &&
      alertsPage.html.includes("· firing"),
    `HTTP ${alertsPage.status} · live title ${alertsPage.html.includes(`${ALERT_LIVE_RULE}:`)} · ` +
      `dead title ${alertsPage.html.includes(`${ALERT_DEAD_RULE}:`)} · firing ${alertsPage.html.includes("· firing")}`,
  );
  check(
    "both delivery truths are stated in the feed: `delivered` on the live channel, `delivery failed` on the dead one (D485/D490)",
    alertsPage.html.includes(">delivered<") && alertsPage.html.includes("delivery failed"),
    `delivered ${alertsPage.html.includes(">delivered<")} · failed ${alertsPage.html.includes("delivery failed")}`,
  );
  const hook = hooks.length > 0 ? JSON.parse(hooks[0].body) : null;
  check(
    "the receiver holds the deliverer's actual POST: the versioned document, the rule by name at its severity, alice's workspace (D486)",
    hook !== null &&
      hook.version === 1 &&
      hook.rule?.name === ALERT_LIVE_RULE &&
      hook.rule?.severity === "critical" &&
      hook.workspace === alice.workspaceId &&
      typeof hook.event?.title === "string" &&
      hook.event.title.startsWith(`${ALERT_LIVE_RULE}:`),
    hooks.length === 0 ? "the receiver was never called" : `got ${hooks[0].body.slice(0, 200)}`,
  );
  check(
    "no SAMPLE badge on /app/alerts — the D21 flip this sprint wires, while /app/ask above still carries one",
    !alertsPage.html.includes("SAMPLE DATA"),
    `badge ${alertsPage.html.includes("SAMPLE DATA")}`,
  );
  check(
    "the channel targets render MASKED and the raw target renders nowhere (D487): `/...hook`, never the URL the seed handed over",
    alertsPage.html.includes("/...hook") && !alertsPage.html.includes(hookTarget),
    `masked ${alertsPage.html.includes("/...hook")} · raw ${alertsPage.html.includes(hookTarget)}`,
  );
  const bobAlerts = await pageFor(bob, "/app/alerts");
  check(
    "bob's /app/alerts is the empty state: none of her rules, channels, events or label reach his workspace (D7/D11)",
    bobAlerts.status === 200 &&
      !bobAlerts.html.includes(ALERT_LIVE_RULE) &&
      !bobAlerts.html.includes(ALERT_LIVE_CHANNEL) &&
      !bobAlerts.html.includes(ALERT_DEAD_CHANNEL) &&
      labelHits(bobAlerts.html, aliceLabel) === 0 &&
      bobAlerts.html.includes("no alert events yet"),
    `HTTP ${bobAlerts.status} · rule ${bobAlerts.html.includes(ALERT_LIVE_RULE)} · ` +
      `${labelHits(bobAlerts.html, aliceLabel)}× ${aliceLabel} · empty ${bobAlerts.html.includes("no alert events yet")}`,
  );

  // ---------------------------------------------------- changes (S7.2)
  /* The deploy hook's proof is the documented step ITSELF (D504): the drive
   * lifts the `run:` block out of the docs page between its recipe markers,
   * makes the ONE edit the page tells a reader to make — `service` to the name
   * their spans report — and runs it under bash with the two variables the
   * page names and the GITHUB_* context every Actions runner provides (real on
   * CI; stood in for locally). What is NOT faked is the point: the POST goes
   * through the real front door with the key the quickstart issued, the row
   * lands in Postgres synchronously (D495), a second run of the same step is
   * answered with the ORIGINAL row (D496), and the feed and the service page
   * read it back (D502/D503) — the D362 fence released by a deploy that
   * actually happened. */
  step("the changes leg: the documented GitHub Actions step posts a real deploy through the front door; the feed and the service page state it (D493–D504)");
  const recipePage = readFileSync(
    join(repoRoot, "apps/web/src/content/docs/connectors/github-actions/index.mdx"),
    "utf8",
  );
  const recipeStart = recipePage.indexOf("{/* recipe:start");
  const recipeEnd = recipePage.indexOf("{/* recipe:end */}");
  must(recipeStart >= 0 && recipeEnd > recipeStart, "the docs page lost its recipe markers");
  const recipeFence = recipePage.slice(recipeStart, recipeEnd).match(/```yaml\n([\s\S]*?)\n```/);
  must(recipeFence !== null, "no yaml fence between the recipe markers");
  const recipeLines = recipeFence[1].split("\n");
  const runAt = recipeLines.findIndex((line) => /^\s*run: \|$/.test(line));
  must(runAt >= 0, "the recipe step has no `run: |` block");
  const runIndent = recipeLines[runAt + 1].match(/^\s*/)[0].length;
  const documentedScript = recipeLines.slice(runAt + 1).map((line) => line.slice(runIndent)).join("\n");
  // The one edit the page asks for, made exactly once — and asserted to be one.
  const recipeHalves = documentedScript.split('--arg service "checkout"');
  must(recipeHalves.length === 2, "the recipe no longer carries the one `service` a reader edits");
  const recipeScript = recipeHalves.join(`--arg service ${JSON.stringify(CHAIN_AGENT)}`);
  const githubSha = process.env.GITHUB_SHA ?? createHash("sha1").update(`drive-${RUN}`).digest("hex");
  const deployRef = githubSha.slice(0, 7);
  const githubEnv = {
    GITHUB_SHA: githubSha,
    GITHUB_ACTOR: process.env.GITHUB_ACTOR ?? `alice-ci-${RUN}`,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? "obstack/e2e-drive",
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID ?? `${Date.now()}`,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL ?? "https://github.com",
  };
  const runLink = `${githubEnv.GITHUB_SERVER_URL}/${githubEnv.GITHUB_REPOSITORY}/actions/runs/${githubEnv.GITHUB_RUN_ID}`;
  // The key rides in the child's ENVIRONMENT, into an Authorization header,
  // and into nothing the child prints: curl -fsS writes the answer alone.
  const runRecipe = () =>
    spawnSync("bash", ["-euo", "pipefail", "-c", recipeScript], {
      cwd: repoRoot,
      env: { ...process.env, ...githubEnv, OBSTACK_INGEST_URL: INGEST_OTLP, OBSTACK_API_KEY: firstToken },
      encoding: "utf8",
    });
  const postChange = async (token, body) => {
    const res = await fetch(`${INGEST_OTLP}/v1/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };
  const flagTitle = `flag ${aliceLabel} rollout widened`;
  let firstRun = { status: -1, stdout: "", stderr: "withheld" };
  let secondRun = firstRun;
  let flagPost = { status: 0, body: "" };
  let badHref = { status: 0, body: "" };
  let keyless = { status: 0, body: "" };
  /* The RED half of this leg's proof (S2.0 L1): withholding the POSTS — the
   * step never runs, nothing is posted — must fail the page and answer checks
   * below and never this leg's own preconditions. */
  if (!process.env.RED_WITHHOLD_CHANGES) {
    firstRun = runRecipe();
    secondRun = runRecipe();
    flagPost = await postChange(firstToken, {
      kind: "flag",
      title: flagTitle,
      detail: `rolled out to 25% by ${aliceLabel}`,
      who: `${aliceLabel}-ops`,
      source: "drive",
      link: { label: "the change", href: "https://flags.example.invalid/changes/1" },
    });
    badHref = await postChange(firstToken, {
      kind: "config",
      title: "x",
      link: { label: "x", href: "javascript:alert(1)" },
    });
    keyless = await postChange("", { kind: "config", title: "x" });
  }
  writeFileSync(
    join(OUT, "changes-leg.json"),
    JSON.stringify({ firstRun, secondRun, flagPost, badHref, keyless, deployRef }, null, 2),
  );
  const recipeAnswer = (run) => {
    try {
      return JSON.parse(run.stdout.trim());
    } catch {
      return null;
    }
  };
  const firstAnswer = recipeAnswer(firstRun);
  const secondAnswer = recipeAnswer(secondRun);
  check(
    "the documented step, lifted from the docs page and run verbatim under bash with its one `service` edit, is answered 201 with a new row's id (D504/D495)",
    firstRun.status === 0 &&
      firstAnswer !== null &&
      /^chg_[0-9a-f]{16}$/.test(firstAnswer.id) &&
      firstAnswer.deduplicated === false,
    `exit ${firstRun.status} · stdout ${firstRun.stdout.trim().slice(0, 120)} · stderr ${firstRun.stderr.trim().slice(0, 200)}`,
  );
  check(
    "the same step run again — the retry a re-attempted job makes — is answered 200 deduplicated with the ORIGINAL id, and writes nothing (D496)",
    secondRun.status === 0 &&
      secondAnswer !== null &&
      secondAnswer.deduplicated === true &&
      secondAnswer.id === firstAnswer?.id,
    `exit ${secondRun.status} · stdout ${secondRun.stdout.trim().slice(0, 120)}`,
  );
  check(
    "a flag event posted directly is written too; a `javascript:` href is refused naming `link.href`; a keyless post is refused outright (D499/D6)",
    flagPost.status === 201 && badHref.status === 400 && badHref.body.includes("link.href") && keyless.status === 401,
    `flag ${flagPost.status} · href ${badHref.status} ${badHref.body.slice(0, 80)} · keyless ${keyless.status}`,
  );
  const changesPage = await pageFor(alice, "/app/changes");
  check(
    "/app/changes renders the deploy the step posted and the flag posted directly, newest first, each labelled by its source, with no SAMPLE badge and no incident story (D502/D13)",
    changesPage.status === 200 &&
      changesPage.html.includes(`deploy ${deployRef}`) &&
      changesPage.html.includes(flagTitle) &&
      changesPage.html.includes("via github-actions") &&
      changesPage.html.includes("via drive") &&
      changesPage.html.indexOf(flagTitle) < changesPage.html.indexOf(`deploy ${deployRef}`) &&
      !changesPage.html.includes("SAMPLE DATA") &&
      !changesPage.html.includes("INC-42"),
    `HTTP ${changesPage.status} · deploy ${changesPage.html.includes(`deploy ${deployRef}`)} · ` +
      `flag ${changesPage.html.includes(flagTitle)} · sources ${changesPage.html.includes("via github-actions")}/${changesPage.html.includes("via drive")} · ` +
      `badge ${changesPage.html.includes("SAMPLE DATA")} · INC-42 ${changesPage.html.includes("INC-42")}`,
  );
  check(
    "the deploy's link renders as an EXTERNAL anchor to the workflow run the step named, never a product route (D499)",
    changesPage.html.includes(`href="${runLink}"`) && changesPage.html.includes('rel="noopener noreferrer"'),
    `run link ${changesPage.html.includes(`href="${runLink}"`)} · rel ${changesPage.html.includes('rel="noopener noreferrer"')}`,
  );
  const agentAfterDeploy = await pageFor(alice, `/app/services/${CHAIN_AGENT}`);
  check(
    `/app/services/${CHAIN_AGENT}'s deploys panel now names the deploy the step posted — its ref and its actor — with no mark and no empty sentence: the D362 fence released (D503)`,
    agentAfterDeploy.status === 200 &&
      agentAfterDeploy.html.includes(deployRef) &&
      agentAfterDeploy.html.includes(githubEnv.GITHUB_ACTOR) &&
      !agentAfterDeploy.html.includes("deploy tracking arrives") &&
      !agentAfterDeploy.html.includes("no deploys recorded"),
    `HTTP ${agentAfterDeploy.status} · ref ${agentAfterDeploy.html.includes(deployRef)} · ` +
      `actor ${agentAfterDeploy.html.includes(githubEnv.GITHUB_ACTOR)} · empty ${agentAfterDeploy.html.includes("no deploys recorded")}`,
  );
  const bobChanges = await pageFor(bob, "/app/changes");
  check(
    "bob's /app/changes is the empty state: none of her events, her deploy's ref or her label reach his workspace (D7/D11)",
    bobChanges.status === 200 &&
      bobChanges.html.includes("no changes recorded yet") &&
      !bobChanges.html.includes(deployRef) &&
      !bobChanges.html.includes(flagTitle) &&
      labelHits(bobChanges.html, aliceLabel) === 0,
    `HTTP ${bobChanges.status} · empty ${bobChanges.html.includes("no changes recorded yet")} · ` +
      `ref ${bobChanges.html.includes(deployRef)} · ${labelHits(bobChanges.html, aliceLabel)}× ${aliceLabel}`,
  );

  // ---------------------------------------------------- slos (S7.3)
  /* Objectives are UI rows like rules, so `--leg slos` seeds them straight
   * into the disposable Postgres — and everything the sprint exists to prove
   * stays real: the ingest binary's evaluator claims them on the S7.1 tick,
   * merges alice's own traces in ClickHouse (the ones the clickhouse leg
   * seeded and the quickstart carried), computes attainment and the error
   * budget, writes the status, and emits the breach through the S7.1
   * deliverer to this drive's own receiver. The number on the card is then
   * checked against the drive's OWN recomputation over trace_summaries — a
   * second reader of the same store, so "N of M traces good" is never
   * checked against a number the app produced (D71(b)). */
  step("the slos leg: objectives over alice's own traces are measured by the evaluator — the breach delivered, the healthy one silent, the empty workspace honest (D505–D518)");
  const sloHooks = [];
  const sloReceiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sloHooks.push({ path: req.url, body });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((ready) => sloReceiver.listen(0, "0.0.0.0", ready));
  const sloHookTarget = `http://host.docker.internal:${sloReceiver.address().port}/slo`;

  const sloSeed = spawnSync(
    "node",
    [join(composeDir, "exit-seed.mjs"), "--leg", "slos", "--workspace", alice.workspaceId, "--label", ACTORS.alice.label, "--target", sloHookTarget],
    { cwd: repoRoot, env: { ...process.env, OBSTACK_POSTGRES_DSN: PG_DSN }, encoding: "utf8" },
  );
  writeFileSync(join(OUT, "seed-slos-alice.json"), `${sloSeed.stdout ?? ""}${sloSeed.stderr ?? ""}`);
  must(sloSeed.status === 0, `exit-seed.mjs --leg slos (alice) failed: ${sloSeed.stderr}`);
  const bobSloSeed = spawnSync(
    "node",
    [join(composeDir, "exit-seed.mjs"), "--leg", "slos", "--workspace", bob.workspaceId, "--label", ACTORS.bob.label],
    { cwd: repoRoot, env: { ...process.env, OBSTACK_POSTGRES_DSN: PG_DSN }, encoding: "utf8" },
  );
  writeFileSync(join(OUT, "seed-slos-bob.json"), `${bobSloSeed.stdout ?? ""}${bobSloSeed.stderr ?? ""}`);
  must(bobSloSeed.status === 0, `exit-seed.mjs --leg slos (bob) failed: ${bobSloSeed.stderr}`);
  console.log(`   ${sloSeed.stdout.trim().split("\n").join("\n   ")}`);

  /* The independent recomputation, the D505 definition verbatim: traces merged
   * per trace_id, good = no error span, over the objective's window. Read AFTER
   * the seed and BEFORE the settle, and nothing writes alice's traces between
   * here and the checks — the number is stable by construction. */
  const sloWindowSql = (extra) =>
    `SELECT count() FROM (SELECT trace_id, sum(error_count) AS e FROM obstack.trace_summaries ` +
    `WHERE workspace_id='${alice.workspaceId}' GROUP BY workspace_id, trace_id ` +
    `HAVING min(min_start) >= now() - toIntervalDay(7)${extra})`;
  const sloTotal = await chCount(sloWindowSql(""));
  const sloGood = await chCount(sloWindowSql(" AND e = 0"));
  const sloBad = sloTotal - sloGood;
  const expectedPct = Number(((sloGood * 100) / sloTotal).toFixed(2));
  // D509's integer arithmetic, restated here as a third reader.
  const allowedMilli = sloTotal * (100000 - Math.round(SLO_AVAILABILITY_TARGET * 1000));
  const expectedBurned = Number(((sloBad * 100000 * 100) / allowedMilli).toFixed(2));
  console.log(`   recomputed over trace_summaries: ${sloGood} of ${sloTotal} traces good = ${expectedPct}% · ${expectedBurned}% of the budget consumed`);

  /* Settle against OBSERVED state (the S6.4 lesson): the evaluator's next
   * tick is ≤60s out, the deliverer ≤5s behind it. The loop leaves when the
   * page states both measured truths, the feed names the SLO's event and the
   * receiver holds the POST — or on the deadline, and the checks then say
   * which claim died. */
  const breachTitle = `${SLO_AVAILABILITY}: breached — ${expectedPct}% against a ${SLO_AVAILABILITY_TARGET}% target`;
  /* The feed's card: from the evaluator's title to the next card's opening
   * (the alerts leg's rule events sit right after it in the same feed, so a
   * fixed-length slice would read their `rule:` label as this card's). */
  const feedCardOf = (html) => {
    const at = html.indexOf(breachTitle);
    if (at === -1) return "";
    const next = html.indexOf("rounded-lg border border-line bg-surface p-3.5", at);
    return html.slice(at, next === -1 ? undefined : next);
  };
  /* The settle condition IS the assertion (the S6.4 lesson, met once here in
   * the first green run): the receiver holds the POST a beat before the
   * deliverer's transaction commits the `delivered` mark, so the loop waits
   * for the feed card to SAY delivered, not for the receiver to have been
   * called. */
  const slosDeadline = Date.now() + 120_000;
  let slosPage = { status: 0, html: "" };
  let sloFeed = { status: 0, html: "" };
  for (;;) {
    slosPage = await pageFor(alice, "/app/slos");
    sloFeed = await pageFor(alice, "/app/alerts");
    const settled =
      slosPage.html.includes(">BREACHED<") &&
      slosPage.html.includes(">HEALTHY<") &&
      feedCardOf(sloFeed.html).includes(">delivered<") &&
      sloHooks.length > 0;
    if (settled || Date.now() > slosDeadline) break;
    await sleep(2_000);
  }
  sloReceiver.close();

  /** One card's HTML: from its name to the next card (or the end). */
  const sloCardOf = (html, name) => {
    const at = html.indexOf(name);
    if (at === -1) return "";
    const next = html.indexOf("<section", at);
    return html.slice(at, next === -1 ? undefined : next);
  };
  const availCard = sloCardOf(slosPage.html, SLO_AVAILABILITY);
  const latencyCard = sloCardOf(slosPage.html, SLO_LATENCY);
  check(
    "/app/slos renders both objectives with the status the evaluator measured — BREACHED on the availability card, HEALTHY on the latency card — with no SAMPLE badge and none of the fixture's story (D508/D514)",
    slosPage.status === 200 &&
      availCard.includes(">BREACHED<") &&
      latencyCard.includes(">HEALTHY<") &&
      !slosPage.html.includes(">NO DATA<") &&
      !slosPage.html.includes("SAMPLE DATA") &&
      !slosPage.html.includes("31%") &&
      !slosPage.html.includes("afternoon"),
    `HTTP ${slosPage.status} · breached ${availCard.includes(">BREACHED<")} · healthy ${latencyCard.includes(">HEALTHY<")} · ` +
      `no-data ${slosPage.html.includes(">NO DATA<")} · badge ${slosPage.html.includes("SAMPLE DATA")}`,
  );
  const availObjective = `${SLO_AVAILABILITY_TARGET}% of traces without an error span over ${SLO_AVAILABILITY_WINDOW} · all services`;
  check(
    `the availability card's attainment IS the drive's own recomputation over trace_summaries — ${expectedPct}%, ${sloGood} of ${sloTotal} traces good — under the formatter's exact objective sentence (D505/D509)`,
    availCard.includes(`>${expectedPct}%</span>`) &&
      availCard.includes(`${sloGood.toLocaleString("en-US")} of ${sloTotal.toLocaleString("en-US")} traces good`) &&
      availCard.includes(availObjective),
    `pct ${availCard.includes(`>${expectedPct}%</span>`)} · counts ${availCard.includes(`${sloGood.toLocaleString("en-US")} of ${sloTotal.toLocaleString("en-US")} traces good`)} · objective ${availCard.includes(availObjective)}`,
  );
  check(
    `the error budget is stated UNclamped (${expectedBurned}%) while the bar is clamped at 100% (D509)`,
    availCard.includes(`>${expectedBurned}%</span>`) && availCard.includes("width:100%") && expectedBurned > 100,
    `number ${availCard.includes(`>${expectedBurned}%</span>`)} · bar ${availCard.includes("width:100%")} · burned ${expectedBurned}`,
  );
  const feedCard = feedCardOf(sloFeed.html);
  check(
    "the breach rode the S7.1 pipeline: /app/alerts carries the SLO's event by the evaluator's title, marked delivered, attributed `slo:` and not `rule:` (D511/D512)",
    feedCard.includes(">delivered<") && feedCard.includes(`slo: ${SLO_AVAILABILITY}`) && !feedCard.includes("rule: "),
    `title ${feedCard !== ""} · delivered ${feedCard.includes(">delivered<")} · slo ${feedCard.includes(`slo: ${SLO_AVAILABILITY}`)} · rule-label ${feedCard.includes("rule: ")}`,
  );
  const sloHook = sloHooks.length > 0 ? JSON.parse(sloHooks[0].body) : null;
  check(
    "the receiver holds the deliverer's actual POST: version 1, `rule` null, the SLO by name at `breached` with its objective, alice's workspace (D512)",
    sloHook !== null &&
      sloHook.version === 1 &&
      sloHook.rule === null &&
      sloHook.slo?.name === SLO_AVAILABILITY &&
      sloHook.slo?.status === "breached" &&
      sloHook.slo?.objective === availObjective &&
      sloHook.workspace === alice.workspaceId &&
      sloHook.event?.title === breachTitle,
    sloHooks.length === 0 ? "the receiver was never called" : `got ${sloHooks[0].body.slice(0, 240)}`,
  );
  const latencyObjective = `${SLO_LATENCY_TARGET}% of traces under ${SLO_LATENCY_THRESHOLD_MS} ms over ${SLO_LATENCY_WINDOW} · all services`;
  check(
    "the latency objective is healthy with no channel — computed only, no event in the feed — and its 30d window on a free workspace states the retention clip (D507/D511)",
    latencyCard.includes("no channel — computed only") &&
      latencyCard.includes(latencyObjective) &&
      latencyCard.includes(`${SLO_LATENCY_WINDOW} · 7d retained on Free`) &&
      !sloFeed.html.includes(`slo: ${SLO_LATENCY}`),
    `no-channel ${latencyCard.includes("no channel — computed only")} · objective ${latencyCard.includes(latencyObjective)} · ` +
      `clip ${latencyCard.includes(`${SLO_LATENCY_WINDOW} · 7d retained on Free`)} · feed ${sloFeed.html.includes(`slo: ${SLO_LATENCY}`)}`,
  );
  check(
    "the inspect link is the real traces list, filtered the way the objective is defined (D514)",
    availCard.includes('href="/app/traces?status=error"') && latencyCard.includes(`href="/app/traces?minMs=${SLO_LATENCY_THRESHOLD_MS}"`),
    `availability ${availCard.includes('href="/app/traces?status=error"')} · latency ${latencyCard.includes(`href="/app/traces?minMs=${SLO_LATENCY_THRESHOLD_MS}"`)}`,
  );
  /* Bob's workspace HOLDS traces (the same shape as hers, in his words), so
   * his objective is scoped to a service none of them name: the window is
   * empty and the card must say NO DATA with a dash — never a measured
   * 100%, and never her number (D508). */
  const bobSlos = await pageFor(bob, "/app/slos");
  const bobCard = sloCardOf(bobSlos.html, SLO_EMPTY);
  check(
    `bob's /app/slos lists ONLY his objective — scoped to \`${SLO_EMPTY_SERVICE}\`, a service his traces never name — in the no-data state with a dash where the number would be, evaluated: none of alice's objectives, numbers or words (D508/D7/D11)`,
    bobSlos.status === 200 &&
      bobCard.includes(">NO DATA<") &&
      bobCard.includes(">—</span>") &&
      bobCard.includes(`service ${SLO_EMPTY_SERVICE}`) &&
      bobCard.includes("not yet evaluated") === false &&
      !bobSlos.html.includes(SLO_AVAILABILITY) &&
      !bobSlos.html.includes(SLO_LATENCY) &&
      !bobSlos.html.includes(`${expectedPct}%`) &&
      labelHits(bobSlos.html, aliceLabel) === 0 &&
      !bobSlos.html.includes("SAMPLE DATA"),
    `HTTP ${bobSlos.status} · no-data ${bobCard.includes(">NO DATA<")} · dash ${bobCard.includes(">—</span>")} · ` +
      `evaluated ${!bobCard.includes("not yet evaluated")} · alice's ${bobSlos.html.includes(SLO_AVAILABILITY)} · ${labelHits(bobSlos.html, aliceLabel)}× ${aliceLabel}`,
  );

  // ---------------------------------------------------- incidents (S7.4)
  /* No seeder leg (D559): alice's two incidents and bob's one go in through
   * the real UI — the create form, the promote picker, the resolve form — and
   * the two RCA presses through the real panel, because CRUD and promotion ARE
   * this sprint's deliverable and the one harness that runs the real build is
   * the one that has to exercise them. Placed after the slos arm on purpose
   * (D560): alice is still Free with both Explain runs spent, and every row
   * the timeline joins — both rules' events, the SLO breach, the deploy and
   * the flag — already exists. No settle loop: nothing ticks and the timeline
   * is a read-time join, so every fact is on the first page load after the
   * action returns.
   *
   * TWO INCIDENTS FOR ALICE (D561), because one window cannot carry both
   * claims. A HISTORICAL one over the seeded fixture's own failing roots —
   * created with an explicit start and RESOLVED with an explicit end, so the
   * store holds a closed window two readers can be compared over — carries the
   * trace-leg recomputation: the page's rows against the drive's OWN SQL over
   * `obstack.spans`, §3's definition restated with its `argMin` (D71(b)/D562,
   * the slos arm's shape). An ONGOING one is PROMOTED from the oldest alert
   * event the evaluator wrote, so its window holds every alert event, the
   * deploy and the flag — one page, both stores, one ordered list — and no
   * error span, a premise MEASURED here rather than assumed from the order the
   * arms ran in. Bob's incident is his own fixture for the answered RCA path
   * (D563): alice spent both runs on TRACES, so her RCA is refused with the
   * IDENTICAL sentence and an unmoved counter — one allowance, two subjects —
   * while bob's answered run moves HIS row and nobody else's. */
  step(
    "the incidents leg: two incidents through the front door — a historical one recomputed over spans, an ongoing one promoted from an alert event and stitched across both stores — and the RCA on the one Explain counter (D559–D564)",
  );
  const armStartedAt = Date.now();

  /* The historical window is DERIVED from the store, never typed: the seeded
   * fixture's error spans are the only ones either workspace holds (every span
   * this drive sent itself carries status OK), they are read in order, and the
   * window is cut to hold all but the oldest and the newest — so BOTH bounds
   * are proven to bite. Whole seconds, so the instants round-trip through the
   * form's `YYYY-MM-DD HH:MM:SS` field and back out of Postgres exactly. */
  const errorInstantsOf = async (workspaceId) =>
    (
      await chRows(
        `SELECT toUnixTimestamp(start_time) AS s FROM obstack.spans ` +
          `WHERE workspace_id='${workspaceId}' AND status_code='error' AND trace_id != '' ORDER BY start_time`,
      )
    ).map((row) => Number(row.s));
  const historicalWindowOf = (instants) => ({
    sinceMs: (instants[1] - 60) * 1000,
    untilMs: (instants[instants.length - 2] + 60) * 1000,
  });
  const inside = (instants, { sinceMs, untilMs }) =>
    instants.filter((s) => s * 1000 >= sinceMs && s * 1000 < untilMs).length;
  /** §3's trace leg, restated as the drive's own reader (D562): the same
   *  grouping, the same half-open millisecond bounds, the same `argMin` — so the
   *  example-trace half of the claim compares two readers of one definition. */
  const errorGroupsOf = (workspaceId, { sinceMs, untilMs }) =>
    chRows(
      `SELECT service, name AS span_name, toUInt32(count()) AS errors, ` +
        `toUInt32(min(toUnixTimestamp(start_time))) AS first_seen_epoch_s, ` +
        `toUInt32(max(toUnixTimestamp(start_time))) AS last_seen_epoch_s, ` +
        `argMin(trace_id, start_time) AS example_trace_id ` +
        `FROM obstack.spans WHERE workspace_id='${workspaceId}' AND status_code='error' AND trace_id != '' ` +
        `AND start_time >= fromUnixTimestamp64Milli(toInt64(${sinceMs})) AND start_time < fromUnixTimestamp64Milli(toInt64(${untilMs})) ` +
        `GROUP BY service, span_name ORDER BY first_seen_epoch_s, service, span_name`,
    );
  /** The form's text for an instant — `YYYY-MM-DD HH:MM:SS`, read as UTC by the
   *  editor's one parser — and the two shapes the surface prints it back in. */
  const fieldText = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const clockOf = (epochS) => `${fieldText(epochS * 1000)} UTC`;
  const windowLabelOf = (sinceMs, untilMs) => {
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const hm = (ms) => new Date(ms).toISOString().slice(11, 16);
    const endDay = day(untilMs) === day(sinceMs) ? "" : `${day(untilMs)} `;
    return `${day(sinceMs)} ${hm(sinceMs)} → ${endDay}${hm(untilMs)} UTC`;
  };

  const aliceErrors = await errorInstantsOf(alice.workspaceId);
  const bobErrors = await errorInstantsOf(bob.workspaceId);
  must(
    aliceErrors.length >= 4 && bobErrors.length >= 4,
    `too few error spans to cut a window from — alice ${aliceErrors.length}, bob ${bobErrors.length}`,
  );
  const aliceWindow = historicalWindowOf(aliceErrors);
  const bobWindow = historicalWindowOf(bobErrors);
  must(
    inside(aliceErrors, aliceWindow) === aliceErrors.length - 2 && inside(bobErrors, bobWindow) === bobErrors.length - 2,
    "the historical window does not exclude exactly the oldest and the newest error span",
  );
  // The origin of the promoted incident: the OLDEST event this workspace holds,
  // by the id Postgres holds for it — so the promoted window opens where this
  // run's evaluated history begins, and everything the later arms wrote is
  // inside it by construction rather than by luck.
  const originEvent = await pgOne(
    `SELECT id, title, severity, created_at FROM alert_events WHERE workspace_id = $1 ORDER BY created_at, id LIMIT 1`,
    [alice.workspaceId],
  );
  must(originEvent, `${alice.workspaceId} holds no alert event — there is nothing to promote`);
  const historicalTitle = `${aliceLabel} checkout errors, reconstructed`;
  const bobTitle = `${bobLabel} timeouts, reconstructed`;

  let historicalId = null;
  let promotedId = null;
  let bobIncidentId = null;
  const withheldRca = { open: false, text: "", used: null, quota: null, rowRefs: [], traceRefs: [] };
  let aliceRca = withheldRca;
  let bobRca = withheldRca;
  /* The RED half of this leg's proof (D564, the changes precedent): withholding
   * the WHOLE interaction block — both create submits, the promote click and
   * both RCA presses — must fail every claim below and none of the
   * preconditions above. Nothing after this block is a `must()`, so a red run's
   * failure count is this arm's check count exactly; the presses are INSIDE it
   * so that a red run fails on a refusal that was never rendered rather than
   * on an empty string after two 20-second waits. */
  if (!process.env.RED_WITHHOLD_INCIDENTS) {
    const TITLE_FIELD = `input[placeholder="what is broken, in one line"]`;
    const declare = async (browser, title, severity, sinceMs) => {
      must(
        await browser.goto("/app/incidents", `document.body.textContent.includes("New incident")`),
        `${browser.label}: /app/incidents never rendered its control`,
      );
      must(await browser.evaluate(clickText("New incident")), `${browser.label}: the New incident control did not click`);
      must(await browser.waitFor(`!!document.querySelector('${TITLE_FIELD}')`), `${browser.label}: the new-incident form never opened`);
      must((await browser.evaluate(type("what is broken", title))) === title, `${browser.label}: the form has no title field`);
      must((await browser.evaluate(choose("severity", severity))) === severity, `${browser.label}: the severity picker did not take ${severity}`);
      must(
        (await browser.evaluate(type("YYYY-MM-DD HH:MM", fieldText(sinceMs)))) === fieldText(sinceMs),
        `${browser.label}: the form has no start field`,
      );
      must(await browser.evaluate(clickText("declare incident")), `${browser.label}: the declare control did not click`);
      // The title lives in the input's VALUE until the store answers; it is in
      // the page's text only once the refreshed list renders the card.
      must(
        await browser.waitFor(`document.body.textContent.includes(${JSON.stringify(title)}) && !document.querySelector('${TITLE_FIELD}')`),
        `${browser.label}: the declared incident never appeared in the list`,
      );
      const row = await pgOne(`SELECT id FROM incidents WHERE workspace_id = $1 AND title = $2`, [browser.workspaceId, title]);
      must(row, `${browser.label}: the declared incident is not in Postgres`);
      return row.id;
    };
    const resolveAt = async (browser, id, untilMs) => {
      must(
        await browser.goto(`/app/incidents/${id}`, `document.body.textContent.includes("resolve")`),
        `${browser.label}: /app/incidents/${id} never rendered its controls`,
      );
      must(await browser.evaluate(clickText("resolve")), `${browser.label}: the resolve control did not click`);
      must(
        await browser.waitFor(`!!document.querySelector('input[placeholder="YYYY-MM-DD HH:MM"]')`),
        `${browser.label}: the resolve form never opened`,
      );
      must(
        (await browser.evaluate(type("YYYY-MM-DD HH:MM", fieldText(untilMs)))) === fieldText(untilMs),
        `${browser.label}: the resolve form has no end field`,
      );
      must(await browser.evaluate(clickText("mark resolved")), `${browser.label}: the mark-resolved control did not click`);
      must(await browser.waitFor(`document.body.textContent.includes("RESOLVED")`), `${browser.label}: the incident never read RESOLVED`);
    };
    const pressRca = async (browser) => {
      must(await browser.evaluate(clickIncluding("Generate root-cause analysis")), `${browser.label}: the RCA control did not click`);
      must(await browser.waitFor(RCA_SETTLED, 20_000), `${browser.label}: the RCA panel never reached a terminal state`);
      // One more beat, `goto`'s own posture: the `result` frame's render — the
      // terminal state, the counter — lands one stream read BEFORE the promise
      // resolves and `onFinished` lifts the page's `spent` (ExplainPanel.tsx
      // `runExplain`: `onState` per event, the return after the loop), so a
      // read in that gap would find the answer with its counter one behind it.
      await sleep(350);
      return browser.evaluate(RCA);
    };

    historicalId = await declare(alice, historicalTitle, "critical", aliceWindow.sinceMs);
    await resolveAt(alice, historicalId, aliceWindow.untilMs);
    aliceRca = await pressRca(alice);

    must(
      await alice.goto("/app/incidents", `document.body.textContent.includes("New incident")`),
      "/app/incidents never rendered a second time",
    );
    must(await alice.evaluate(clickText("New incident")), "the New incident control did not click");
    must(await alice.waitFor(`!!document.querySelector("[aria-pressed]")`), "the new-incident form never opened");
    must(await alice.evaluate(clickText("from an alert")), "the form offers no `from an alert` mode");
    must(
      (await alice.evaluate(choose("alert event", originEvent.id))) === originEvent.id,
      `the promote picker does not offer ${originEvent.id}`,
    );
    must(await alice.evaluate(clickText("promote to incident")), "the promote control did not click");
    must(
      await alice.waitFor(`document.querySelectorAll('a[href^="/app/incidents/inc_"]').length >= 2`),
      "the promoted incident never appeared in the list",
    );
    const promotedRow = await pgOne(`SELECT id FROM incidents WHERE workspace_id = $1 AND opened_from_event_id = $2`, [
      alice.workspaceId,
      originEvent.id,
    ]);
    must(promotedRow, "the promoted incident is not in Postgres");
    promotedId = promotedRow.id;

    bobIncidentId = await declare(bob, bobTitle, "warning", bobWindow.sinceMs);
    await resolveAt(bob, bobIncidentId, bobWindow.untilMs);
    bobRca = await pressRca(bob);
  }
  writeFileSync(
    join(OUT, "incidents-leg.json"),
    JSON.stringify({ historicalId, promotedId, bobIncidentId, aliceWindow, bobWindow, originEvent, aliceRca, bobRca }, null, 2),
  );

  /* D562: the instants are bound in SQL — `extract(epoch …)` — and never parsed
   * from a column type in JS (node-postgres reads a naked `timestamp` in the
   * runner's zone, the D179 trap). Whole seconds went in through the forms, so
   * floor/ceil to milliseconds are exact here, and the first check says so: the
   * recomputation's window IS the row's, or nothing below is about the row. */
  const storedWindowOf = async (workspaceId, id) => {
    const row =
      id === null
        ? null
        : await pgOne(
            `SELECT extract(epoch from started_at) AS started_s, extract(epoch from ended_at) AS ended_s, status ` +
              `FROM incidents WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, id],
          );
    return row === null || row.ended_s === null
      ? null
      : { sinceMs: Math.floor(Number(row.started_s) * 1000), untilMs: Math.ceil(Number(row.ended_s) * 1000), status: row.status };
  };
  const count = (html, needle) => html.split(needle).length - 1;
  const traceRowsOn = (html) => count(html, `id="trace:`);
  /** How many rail rows of one kind the page holds, by the kind label the rail renders. */
  const kindRows = (html, label) => count(html, `>${label}</span>`);
  const usedFor = (workspaceId) => pgOne(`SELECT used FROM explain_runs WHERE workspace_id = $1`, [workspaceId]);

  const aliceStored = await storedWindowOf(alice.workspaceId, historicalId);
  check(
    "the historical incident is a RESOLVED row whose window, read back through `extract(epoch …)`, is exactly the one the two forms sent — whole seconds in, the same milliseconds out (D562/D527)",
    aliceStored !== null &&
      aliceStored.status === "resolved" &&
      aliceStored.sinceMs === aliceWindow.sinceMs &&
      aliceStored.untilMs === aliceWindow.untilMs,
    aliceStored === null ? `no resolved row for ${historicalId ?? "a withheld id"}` : `${JSON.stringify(aliceStored)} vs ${JSON.stringify(aliceWindow)}`,
  );
  const aliceGroups = aliceStored === null ? [] : await errorGroupsOf(alice.workspaceId, aliceStored);
  const aliceErrorsInside = aliceGroups.reduce((n, group) => n + group.errors, 0);
  const historical = await pageFor(alice, `/app/incidents/${historicalId}`);
  const historicalLabel = windowLabelOf(aliceWindow.sinceMs, aliceWindow.untilMs);
  check(
    `the historical detail renders the row the store holds — the title, RESOLVED, CRITICAL, \`${historicalLabel}\` — with no SAMPLE badge, no clip register and none of the mock's story (D539/D540/D521)`,
    historical.status === 200 &&
      historical.html.includes(historicalTitle) &&
      historical.html.includes(">RESOLVED<") &&
      historical.html.includes(">CRITICAL<") &&
      historical.html.includes(historicalLabel) &&
      !historical.html.includes("SAMPLE DATA") &&
      !historical.html.includes("d retained on") &&
      !historical.html.includes("INC-42"),
    `HTTP ${historical.status} · title ${historical.html.includes(historicalTitle)} · resolved ${historical.html.includes(">RESOLVED<")} · ` +
      `window ${historical.html.includes(historicalLabel)} · badge ${historical.html.includes("SAMPLE DATA")} · clip ${historical.html.includes("d retained on")}`,
  );
  /** One group's rail row, in the words `traceEntry` composes: drawn at its
   *  first_seen, spanning to its last, counting its errors, linking its argMin. */
  const groupRendered = (html, group) => {
    const span =
      group.first_seen_epoch_s === group.last_seen_epoch_s
        ? clockOf(group.first_seen_epoch_s)
        : `${clockOf(group.first_seen_epoch_s)} → ${clockOf(group.last_seen_epoch_s)}`;
    return (
      html.includes(htmlText(`${group.span_name} on ${group.service}`)) &&
      html.includes(`${group.errors} error${group.errors === 1 ? "" : "s"}, ${span} · grouped by service and span`) &&
      html.includes(`href="/app/traces/${group.example_trace_id}"`)
    );
  };
  check(
    `the timeline's trace leg IS the drive's own recomputation over obstack.spans — ${aliceGroups.length} (service, span) group(s) holding ${aliceErrorsInside} error span(s), each drawn at its first_seen with its count, its span and its argMin example trace — and nothing else was read: zero alert rows, zero change rows, one resolved row (D71(b)/D531/D532/D562)`,
    aliceGroups.length > 0 &&
      aliceErrorsInside === inside(aliceErrors, aliceWindow) &&
      traceRowsOn(historical.html) === aliceGroups.length &&
      kindRows(historical.html, "traces") === aliceGroups.length &&
      aliceGroups.every((group) => groupRendered(historical.html, group)) &&
      kindRows(historical.html, "alert") === 0 &&
      kindRows(historical.html, "change") === 0 &&
      kindRows(historical.html, "resolved") === 1,
    `${aliceGroups.length} group(s) over ${inside(aliceErrors, aliceWindow)} error span(s) · ${traceRowsOn(historical.html)} trace row(s) · ` +
      `rendered ${aliceGroups.map((group) => groupRendered(historical.html, group)).join("/") || "none"} · ` +
      `alert ${kindRows(historical.html, "alert")} · change ${kindRows(historical.html, "change")} · resolved ${kindRows(historical.html, "resolved")}`,
  );
  check(
    "the historical page states what was NOT read rather than showing a quiet hour: the changes leg's empty sentence with its recipe link, no omission sentence, no clip, no empty-window sentence — each honesty state in its honest position (D537/D540/D583)",
    historical.status === 200 &&
      historical.html.includes(historicalTitle) &&
      historical.html.includes("no change events were read for this window or its lead-in") &&
      historical.html.includes('href="/app/docs/connectors/github-actions"') &&
      !historical.html.includes("the rest are not shown") &&
      !historical.html.includes("no evidence was read for it") &&
      !historical.html.includes("rows were read inside this window"),
    `changes-empty ${historical.html.includes("no change events were read for this window or its lead-in")} · recipe ${historical.html.includes('href="/app/docs/connectors/github-actions"')} · ` +
      `omission ${historical.html.includes("the rest are not shown")} · outside ${historical.html.includes("no evidence was read for it")} · empty ${historical.html.includes("rows were read inside this window")}`,
  );
  const aliceCounter = `${Number(afterRefusal?.used)} of ${EVIDENCE_EXPLAIN_QUOTA} Explain runs used this month`;
  check(
    `the RCA control is offered on the historical page — its window holds evidence — under the counter line the plan row states, \`${aliceCounter}\` (D558/D226)`,
    historical.status === 200 && historical.html.includes("Generate root-cause analysis") && historical.html.includes(aliceCounter),
    `control ${historical.html.includes("Generate root-cause analysis")} · counter ${historical.html.includes(aliceCounter)}`,
  );

  const promoted = await pageFor(alice, `/app/incidents/${promotedId}`);
  const originStartMs = originEvent.created_at.getTime();
  const originIso = new Date(originStartMs).toISOString();
  const originTitle = htmlText(originEvent.title);
  check(
    "the promoted incident is ONGOING, marked `from an alert` with the event still held, carrying the event's own title and severity, its window opening at the event's own instant (D526/D544)",
    promoted.status === 200 &&
      promoted.html.includes(">ONGOING<") &&
      promoted.html.includes("from an alert") &&
      !promoted.html.includes("the event is no longer held") &&
      promoted.html.includes(originTitle) &&
      promoted.html.includes(`>${originEvent.severity.toUpperCase()}<`) &&
      promoted.html.includes(`${originIso.slice(0, 10)} ${originIso.slice(11, 16)} UTC → ongoing ·`) &&
      promoted.html.includes("so far"),
    `HTTP ${promoted.status} · ongoing ${promoted.html.includes(">ONGOING<")} · mark ${promoted.html.includes("from an alert")} · ` +
      `held ${!promoted.html.includes("the event is no longer held")} · title ${promoted.html.includes(originTitle)} · severity ${promoted.html.includes(`>${originEvent.severity.toUpperCase()}<`)}`,
  );
  // The two Postgres legs as the drive reads them: every event at or after the
  // origin's instant, in both tables — the same predicate the stitcher binds.
  const alertRows = await pgRows(
    `SELECT id, title, created_at AS at FROM alert_events WHERE workspace_id = $1 AND created_at >= $2 ORDER BY created_at, id`,
    [alice.workspaceId, originEvent.created_at],
  );
  const changeRows = await pgRows(
    `SELECT id, title, at FROM change_events WHERE workspace_id = $1 AND at >= $2 ORDER BY at, id`,
    [alice.workspaceId, originEvent.created_at],
  );
  // D538's total order, restated: the instant at the millisecond the stitcher
  // compares (its legs emit `toISOString()`), then the source rank — a change
  // that shares an instant with an alert is the thing the alert is about — then
  // the key, which for both legs is the event's id. ⟨T8 review: a first cut
  // sorted on the instant alone and let a stable sort settle the ties, which
  // agrees with the stitcher only while no alert and no change share a
  // millisecond — the two evaluator events of one tick can.⟩
  const SOURCE_RANK = { change: 0, alert: 1 };
  const expectedOrder = [
    ...alertRows.map((row) => ({ id: row.id, at: row.at.getTime(), kind: "alert" })),
    ...changeRows.map((row) => ({ id: row.id, at: row.at.getTime(), kind: "change" })),
  ]
    .sort((x, y) => x.at - y.at || SOURCE_RANK[x.kind] - SOURCE_RANK[y.kind] || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((row) => row.id);
  const anchorAt = (id) => promoted.html.indexOf(`id="${id}"`);
  const renderedOrder = [...expectedOrder].sort((a, b) => anchorAt(a) - anchorAt(b));
  check(
    `one page, both stores, one ordered list (D561/D538): ${alertRows.length} alert event(s) and ${changeRows.length} change event(s) from two Postgres tables, every one anchored on the rail by its own id, in D538's order — instant, then source rank, then id — across both tables, and each rail row of those two kinds is one of them`,
    promoted.status === 200 &&
      promoted.html.includes(originTitle) &&
      alertRows.length > 0 &&
      changeRows.length > 0 &&
      expectedOrder.every((id) => anchorAt(id) >= 0) &&
      renderedOrder.join(",") === expectedOrder.join(",") &&
      alertRows.every((row) => promoted.html.includes(htmlText(row.title))) &&
      kindRows(promoted.html, "alert") === alertRows.length &&
      kindRows(promoted.html, "change") === changeRows.length,
    `anchored ${expectedOrder.filter((id) => anchorAt(id) >= 0).length}/${expectedOrder.length} · order ${renderedOrder.join(",") === expectedOrder.join(",")} · ` +
      `alert rows ${kindRows(promoted.html, "alert")} vs ${alertRows.length} · change rows ${kindRows(promoted.html, "change")} vs ${changeRows.length}`,
  );
  const externalAnchor = `href="${runLink}" target="_blank" rel="noopener noreferrer"`;
  check(
    "the change events on that rail are the deploy the documented step posted and the flag posted directly, and the deploy's link renders as an EXTERNAL anchor to the workflow run — the customer's own system, never a product route (D538/D499)",
    promoted.status === 200 &&
      promoted.html.includes(originTitle) &&
      changeRows.some((row) => row.id === firstAnswer?.id) &&
      promoted.html.includes(`deploy ${deployRef}`) &&
      promoted.html.includes(flagTitle) &&
      promoted.html.includes(externalAnchor),
    `deploy row ${changeRows.some((row) => row.id === firstAnswer?.id)} · ref ${promoted.html.includes(`deploy ${deployRef}`)} · flag ${promoted.html.includes(flagTitle)} · anchor ${promoted.html.includes(externalAnchor)}`,
  );
  // The premise, measured (D561): no error span of hers starts inside this
  // window. Every span this drive sent is OK, and the fixture's failing roots
  // all predate the evaluator's first tick — but that is the store's to say.
  const premise = await chCount(
    `SELECT count() FROM obstack.spans WHERE workspace_id='${alice.workspaceId}' AND status_code='error' ` +
      `AND start_time >= fromUnixTimestamp64Milli(toInt64(${originStartMs}))`,
  );
  check(
    `and its trace leg is EMPTY with the store agreeing why — ${premise} error span(s) of hers start inside this window — so the rail carries no trace row and no sentence claims the window itself was empty`,
    promoted.status === 200 &&
      promoted.html.includes(originTitle) &&
      premise === 0 &&
      traceRowsOn(promoted.html) === 0 &&
      kindRows(promoted.html, "traces") === 0 &&
      !promoted.html.includes("rows were read inside this window") &&
      !promoted.html.includes("no change events were read"),
    `premise ${premise} · trace rows ${traceRowsOn(promoted.html)} · empty-window ${promoted.html.includes("rows were read inside this window")} · changes-empty ${promoted.html.includes("no change events were read")}`,
  );

  const aliceList = await pageFor(alice, "/app/incidents");
  const countsOf = (workspaceId) =>
    pgOne(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ongoing')::int AS ongoing FROM incidents WHERE workspace_id = $1`,
      [workspaceId],
    );
  const aliceCounts = await countsOf(alice.workspaceId);
  const aliceOpened = [historicalId, promotedId].filter((id) => id !== null);
  check(
    "/app/incidents lists both incidents this arm opened under a header DERIVED from the read, `{ongoing} ongoing · {total} total` — the promoted one ONGOING and marked, the historical one RESOLVED, newest start first — with no SAMPLE badge and no INC-42 (D545/D519/D521)",
    aliceList.status === 200 &&
      aliceOpened.length === 2 &&
      aliceCounts.total === aliceOpened.length &&
      aliceCounts.ongoing === (promotedId === null ? 0 : 1) &&
      aliceList.html.includes(`${aliceCounts.ongoing} ongoing · ${aliceCounts.total} total`) &&
      aliceOpened.every((id) => aliceList.html.includes(`href="/app/incidents/${id}"`)) &&
      aliceList.html.includes(">ONGOING<") &&
      aliceList.html.includes(">RESOLVED<") &&
      aliceList.html.includes("from an alert") &&
      aliceList.html.indexOf(`href="/app/incidents/${promotedId}"`) < aliceList.html.indexOf(`href="/app/incidents/${historicalId}"`) &&
      !aliceList.html.includes("SAMPLE DATA") &&
      !aliceList.html.includes("INC-42"),
    `HTTP ${aliceList.status} · rows ${JSON.stringify(aliceCounts)} · header ${aliceList.html.includes(`${aliceCounts.ongoing} ongoing · ${aliceCounts.total} total`)} · ` +
      `cards ${aliceOpened.filter((id) => aliceList.html.includes(`href="/app/incidents/${id}"`)).length}/${aliceOpened.length} · badge ${aliceList.html.includes("SAMPLE DATA")}`,
  );
  const bobIncidents = await pageFor(bob, "/app/incidents");
  const bobCounts = await countsOf(bob.workspaceId);
  check(
    "bob's /app/incidents lists ONLY his incident — his title, his id, his own derived header — and none of hers: neither id, neither title, zero of her label (D7/D11/D142)",
    bobIncidents.status === 200 &&
      bobIncidentId !== null &&
      historicalId !== null &&
      promotedId !== null &&
      bobCounts.total === 1 &&
      bobIncidents.html.includes(`${bobCounts.ongoing} ongoing · ${bobCounts.total} total`) &&
      bobIncidents.html.includes(`href="/app/incidents/${bobIncidentId}"`) &&
      bobIncidents.html.includes(bobTitle) &&
      !bobIncidents.html.includes(historicalId) &&
      !bobIncidents.html.includes(promotedId) &&
      !bobIncidents.html.includes(historicalTitle) &&
      !bobIncidents.html.includes(originTitle) &&
      labelHits(bobIncidents.html, aliceLabel) === 0,
    `HTTP ${bobIncidents.status} · rows ${JSON.stringify(bobCounts)} · his card ${bobIncidentId !== null && bobIncidents.html.includes(`href="/app/incidents/${bobIncidentId}"`)} · ` +
      `${labelHits(bobIncidents.html, aliceLabel)}× ${aliceLabel}`,
  );
  const bobView = await pageFor(bob, `/app/incidents/${historicalId}`);
  check(
    "bob asking for HER incident by its id gets the one not-found sentence and none of her words — the tenancy boundary, read from the outside (D440/D539)",
    historicalId !== null &&
      bobView.html.includes("no incident with this id in your workspace") &&
      !bobView.html.includes(historicalTitle) &&
      labelHits(bobView.html, aliceLabel) === 0,
    `HTTP ${bobView.status} · sentence ${bobView.html.includes("no incident with this id in your workspace")} · ${labelHits(bobView.html, aliceLabel)}× ${aliceLabel}`,
  );
  const bobPost = await fetch(`${BASE}/app/incidents/${historicalId}/rca`, { method: "POST", headers: { cookie: bob.cookieHeader } });
  await bobPost.text();
  check(
    "and his POST to her incident's RCA route is the 404 an invented id gets — before any stitch, any config check or any spend (D558, step 3)",
    historicalId !== null && bobPost.status === 404,
    `HTTP ${bobPost.status}`,
  );

  // The Explain collision, made the sharpest available proof (D563): the
  // sentence is EXTRACTED from what the trace panel rendered ~1400 lines above,
  // never retyped, so "identical" is a comparison and not a quotation.
  const refusalSentence = /This workspace has used all .*? a larger plan raises it\./.exec(refusedRun.text)?.[0] ?? null;
  const aliceUsed = await usedFor(alice.workspaceId);
  check(
    "alice's RCA on the historical incident is REFUSED with the sentence the trace panel rendered — byte-identical, extracted from that panel's text — one allowance for two subjects (D563/D555)",
    refusalSentence !== null && aliceRca.open && aliceRca.text.includes(refusalSentence),
    aliceRca.open ? aliceRca.text.slice(0, 240) : "no panel was rendered",
  );
  check(
    `and it spent nothing: her panel's counter and her \`explain_runs\` row both still read ${afterRefusal?.used} of ${EVIDENCE_EXPLAIN_QUOTA} (D225)`,
    aliceRca.open &&
      aliceRca.used === Number(afterRefusal?.used) &&
      aliceRca.quota === EVIDENCE_EXPLAIN_QUOTA &&
      Number(aliceUsed?.used) === Number(afterRefusal?.used),
    `panel ${aliceRca.used} of ${aliceRca.quota} · row ${JSON.stringify(aliceUsed)}`,
  );
  const bobStored = await storedWindowOf(bob.workspaceId, bobIncidentId);
  const bobGroups = bobStored === null ? [] : await errorGroupsOf(bob.workspaceId, bobStored);
  const bobExamples = new Set(bobGroups.map((group) => group.example_trace_id));
  const bobHeadline =
    bobGroups.length > 0
      ? `No alert fired in this incident's window; ${bobGroups[0].span_name} on ${bobGroups[0].service} is its first failing trace`
      : null;
  const bobTally =
    bobStored === null
      ? null
      : `0 alerts, 0 changes and ${bobGroups.length} failing trace${bobGroups.length === 1 ? "" : "s"} share the window ` +
        `${new Date(bobStored.sinceMs).toISOString()} to ${new Date(bobStored.untilMs).toISOString()}.`;
  const bobUsed = await usedFor(bob.workspaceId);
  check(
    "bob's RCA on his own incident is ANSWERED about ITS timeline: the headline names the failing group the drive's recomputation puts first, the tally counts exactly those groups over exactly the stored window, every cited example trace is one the recomputation named, and the answer says no model read it (D550/D553/D102)",
    bobRca.open &&
      bobHeadline !== null &&
      bobRca.text.includes(bobHeadline) &&
      bobRca.text.includes(bobTally) &&
      bobRca.text.includes("WHERE") &&
      bobRca.text.includes("ROOT CAUSE") &&
      bobRca.text.includes("WHAT TO DO NEXT") &&
      bobRca.traceRefs.length >= 1 &&
      bobRca.traceRefs.every((id) => bobExamples.has(id)) &&
      bobRca.text.includes("This deployment runs Explain in fake mode"),
    bobRca.open
      ? `headline ${bobRca.text.includes(bobHeadline ?? " ")} · tally ${bobRca.text.includes(bobTally ?? " ")} · ` +
        `cited ${bobRca.traceRefs.join(",") || "nothing"} of ${[...bobExamples].join(",")} · ${bobRca.text.slice(0, 200)}`
      : "no panel was rendered",
  );
  check(
    `and the spend is his alone: his panel reads 1 of ${EVIDENCE_EXPLAIN_QUOTA}, his \`explain_runs\` row holds 1, and hers still holds ${afterRefusal?.used} (D225/D226)`,
    bobRca.open &&
      bobRca.used === 1 &&
      bobRca.quota === EVIDENCE_EXPLAIN_QUOTA &&
      Number(bobUsed?.used) === 1 &&
      Number(aliceUsed?.used) === Number(afterRefusal?.used),
    `panel ${bobRca.used} of ${bobRca.quota} · bob ${JSON.stringify(bobUsed)} · alice ${JSON.stringify(aliceUsed)}`,
  );
  // Measured, not budgeted (D560): the ~6-minute line is held, and a number
  // over it re-cuts THIS arm, never the line.
  console.log(`   incidents arm: ${Math.round((Date.now() - armStartedAt) / 1000)}s of wall time`);


  // ------------------------------------------------------------- S8.1: the MCP arm
  // The endpoint through the front door (D659–D663): keys issued on the settings
  // tab's own picker, a STOCK client of the protocol against the served app, the
  // two doors, the cross-tenant probe, the unauth probe, the boundary, the
  // setup mint, and the arrival flip for the minted key alone. Every fact the
  // claims read is a withheld default first (D662): `RED_WITHHOLD_MCP` guards
  // the WHOLE interaction block, so a red run's failure count is this arm's
  // check count exactly and never a `must()`.
  step("S8.1: the MCP endpoint — a stock client, two doors, the cross-tenant probe, the setup mint, the arrival flip (D659–D663)");
  const mcpArmStartedAt = Date.now();
  const MCP_ENDPOINT = `${BASE}/mcp`;
  const mcpTypesSource = readFileSync(join(composeDir, "../../apps/web/src/lib/mcp-types.ts"), "utf8");
  // The registry, read off the file the server registers from (the D565 idiom):
  // a tool added there and not served is a red line, not a comment.
  const registryStartAt = mcpTypesSource.indexOf("export const MCP_TOOLS");
  const mcpRegistryLiteral = mcpTypesSource.slice(registryStartAt, mcpTypesSource.indexOf("];", registryStartAt));
  const registryToolNames = [...mcpRegistryLiteral.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
  const cannotMintSentence = /MCP_CANNOT_MINT_SENTENCE =\s*"([^"]+)"/.exec(mcpTypesSource)?.[1] ?? null;
  const rateLimitMax = Number(/MCP_RATE_LIMIT = \{ max: (\d+)/.exec(mcpTypesSource)?.[1] ?? 0);
  const mcpText = (r) => r?.content?.[0]?.text ?? "";
  // OTLP/JSON trace ids are 16 bytes as 32 hex characters: a tag that is not hex
  // is a decode error at ingest (a 400 and a droppedDecode, measured on the
  // first green attempt), so every id this arm exports is an md5 of its label.
  const mcpTraceIdFor = (label) => createHash("md5").update(`${RUN}:mcp:${label}`).digest("hex");
  const mintedTraceId = mcpTraceIdFor("minted");
  const mcpClientFor = async (token) => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new McpClient({ name: "e2e-drive", version: RUN });
    await client.connect(transport);
    return client;
  };
  const mcpRaw = async (headers, body) =>
    fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body ?? { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-drive", version: RUN } } }),
    });
  /** A key of one scope, issued through the settings tab's own picker and captured the way alice's ingest key was (the D98 "shown once" path). */
  const issueScopedKey = async (browser, name, scope) => {
    await openTab(browser, "API keys", `document.querySelector("main")?.textContent.includes("api keys · ")`);
    must((await browser.evaluate(choose("scope", scope))) === scope, `${browser.label}: the scope picker did not take ${scope}`);
    must((await browser.evaluate(type("Key name", name))) === name, `${browser.label}: the API keys tab has no name field`);
    must(await browser.evaluate(clickText("Create key")), `${browser.label}: the API keys tab has no create button`);
    must(
      await browser.waitFor(`document.querySelector("main")?.textContent.includes("copy it now")`, 20_000),
      `${browser.label}: the shown-once banner never appeared for the ${scope} key`,
    );
    const shown = (await browser.evaluate(SETTINGS)).token ?? "";
    must(/^ok_live_[0-9a-f]{64}$/.test(shown), `${browser.label}: no ${scope} token in the banner`);
    must(await browser.evaluate(clickLabel("Dismiss")), `${browser.label}: the banner has no dismiss control`);
    return shown;
  };
  // ---- withheld defaults (D662) ----
  let mcpPageFacts = { status: null, endpoint: false, readOnly: false, toolsLine: false };
  let mcpListedTools = [];
  let mcpTraceSpans = null;
  let mcpTraceRecount = null;
  let mcpSearch = { total: null, ids: [] };
  let mcpIncident = { id: null, retentionDays: null, kinds: null };
  let planRetentionDays = null;
  let mcpSloIds = null;
  let pgSloIds = null;
  let mcpChangeIds = null;
  let pgChangeIds = null;
  let bobSeedCopy = { ok: null, hisLabel: null, herLabel: null };
  let bobMintedText = null;
  let bobIncidentTotal = null;
  let bobOwnIncidents = null;
  let bobSeesAlice = null;
  let ingestKeyAtMcp = { status: null, challenge: null };
  let readKeyAtIngest = null;
  let setupKeyAtIngest = null;
  let unauthAtMcp = { status: null, challenge: null };
  let boundary = { status: null, retryAfter: null };
  let readMintText = null;
  let minted = { token: null, scope: null, name: null, row: null };
  let mintedAtMcp = null;
  let mintedExportStatus = null;
  let mcpArrival = { minted: null, other: null };
  let mintedResolves = null;
  if (!process.env.RED_WITHHOLD_MCP) {
    const aliceRead = await issueScopedKey(alice, `${ACTORS.alice.label}-agent-read`, "read");
    const aliceSetup = await issueScopedKey(alice, `${ACTORS.alice.label}-agent-setup`, "setup");
    const bobRead = await issueScopedKey(bob, `${ACTORS.bob.label}-agent-read`, "read");

    // The page, live: the served address, the tag, the registry's count.
    const mcpPage = await pageFor(alice, "/app/mcp");
    mcpPageFacts = {
      status: mcpPage.status,
      endpoint: mcpPage.html.includes("/mcp"),
      readOnly: mcpPage.html.includes("READ-ONLY"),
      toolsLine: mcpPage.html.includes(`tools · ${registryToolNames.length}`),
    };

    // alice reads her own rows through a stock client.
    const ca = await mcpClientFor(aliceRead);
    try {
      mcpListedTools = (await ca.listTools()).tools.map((t) => t.name);
      const trace = await ca.callTool({ name: "get_trace", arguments: { id: PROMPT_TRACE } });
      mcpTraceSpans = trace.structuredContent?.spanCount ?? null;
      const found = await ca.callTool({ name: "query_traces", arguments: { q: SPAN_PROMPT_TOKEN } });
      mcpSearch = { total: found.structuredContent?.total ?? null, ids: (found.structuredContent?.traces ?? []).map((t) => t.id) };
      // Guarded, not assumed: under RED_WITHHOLD_INCIDENTS there is no historical
      // incident, and a null id would be the SDK's invalid-params error thrown
      // out of this block rather than a withheld default read by the claim.
      if (historicalId) {
        const inc = await ca.callTool({ name: "get_incident", arguments: { id: historicalId } });
        const entries = inc.structuredContent?.timeline?.entries ?? [];
        mcpIncident = {
          id: inc.structuredContent?.incident?.id ?? null,
          retentionDays: inc.structuredContent?.timeline?.retentionDays ?? null,
          kinds: entries.map((e) => e.kind),
        };
      }
      mcpSloIds = ((await ca.callTool({ name: "get_slo_status", arguments: {} })).structuredContent?.slos ?? []).map((s) => s.id).sort();
      mcpChangeIds = ((await ca.callTool({ name: "list_changes", arguments: { limit: 200 } })).structuredContent?.changes ?? []).map((c) => c.id).sort();
      readMintText = mcpText(await ca.callTool({ name: "issue_ingest_key", arguments: { name: "e2e-agent" } }));
    } finally {
      await ca.close();
    }
    // The drive's own readings (D71(b)): the store, not the tool, says what is true.
    mcpTraceRecount = Number((await chRows(`SELECT count() AS n FROM obstack.spans WHERE workspace_id = '${alice.workspaceId}' AND trace_id = '${PROMPT_TRACE}'`))[0]?.n ?? NaN);
    planRetentionDays = Number((await pgOne(`SELECT p.retention_days FROM plans p JOIN workspaces w ON p.id = coalesce((SELECT plan_id FROM workspace_plans wp WHERE wp.workspace_id = w.id), 'free') WHERE w.id = $1`, [alice.workspaceId]))?.retention_days ?? NaN);
    pgSloIds = (await pgRows(`SELECT id FROM slos WHERE workspace_id = $1`, [alice.workspaceId])).map((r) => r.id).sort();
    pgChangeIds = (await pgRows(`SELECT id FROM change_events WHERE workspace_id = $1`, [alice.workspaceId])).map((r) => r.id).sort();

    // bob, the same ids: the not-found sentence, and only his own rows.
    const cb = await mcpClientFor(bobRead);
    try {
      // The seeder plants the SAME trace ids in both tenants on purpose (the
      // same id in two workspaces is two traces): bob's read of the shared id
      // must be HIS copy — his label, never hers — not a not-found.
      const seedCopy = await cb.callTool({ name: "get_trace", arguments: { id: PROMPT_TRACE } });
      const seedRoot = seedCopy.structuredContent?.rootName ?? "";
      bobSeedCopy = { ok: seedCopy.isError !== true, hisLabel: seedRoot.includes(ACTORS.bob.label), herLabel: seedRoot.includes(ACTORS.alice.label) };
      const his = (await cb.callTool({ name: "list_incidents", arguments: {} })).structuredContent ?? {};
      bobIncidentTotal = his.total ?? null;
      bobSeesAlice = (his.incidents ?? []).some((i) => i.id === historicalId || i.id === promotedId);
    } finally {
      await cb.close();
    }
    bobOwnIncidents = Number((await pgOne(`SELECT count(*)::text AS n FROM incidents WHERE workspace_id = $1`, [bob.workspaceId]))?.n ?? NaN);

    // The two doors (D659): the ingest key at /mcp, the agent keys at ingest.
    const ingestAtMcp = await mcpRaw({ authorization: `Bearer ${token}` });
    ingestKeyAtMcp = { status: ingestAtMcp.status, challenge: ingestAtMcp.headers.get("www-authenticate") };
    readKeyAtIngest = (await otlp("traces", aliceRead, tracesExport([spanOf(mcpTraceIdFor("read-at-ingest"), "agent-key-at-ingest")]))).status;
    setupKeyAtIngest = (await otlp("traces", aliceSetup, tracesExport([spanOf(mcpTraceIdFor("setup-at-ingest"), "agent-key-at-ingest")]))).status;
    const anon = await mcpRaw({});
    unauthAtMcp = { status: anon.status, challenge: anon.headers.get("www-authenticate") };

    // The setup mint (D666), and the minted key's one door (D659).
    const cs = await mcpClientFor(aliceSetup);
    try {
      const mint = await cs.callTool({ name: "issue_ingest_key", arguments: { name: "e2e-agent" } });
      const body = mint.structuredContent ?? {};
      minted = {
        token: body.token ?? null,
        scope: body.key?.scope ?? null,
        name: body.key?.name ?? null,
        row: body.key?.id ? await pgOne(`SELECT name, scope FROM api_keys WHERE id = $1 AND workspace_id = $2`, [body.key.id, alice.workspaceId]) : null,
      };
      if (minted.token) {
        mintedAtMcp = (await mcpRaw({ authorization: `Bearer ${minted.token}` })).status;
        mintedExportStatus = (await otlp("traces", minted.token, tracesExport([spanOf(mintedTraceId, "minted-key-export")]))).status;
        // The arrival flip for THAT key alone (D667): ingest writes the health
        // row on its flush; a bounded settle, then the read the agent would make.
        const readKeyRow = await pgOne(`SELECT id FROM api_keys WHERE workspace_id = $1 AND prefix = $2`, [alice.workspaceId, aliceRead.slice(0, 12)]);
        const deadline = Date.now() + 30_000;
        let mintedArrival = null;
        while (Date.now() < deadline) {
          mintedArrival = (await cs.callTool({ name: "check_arrival", arguments: { keyId: body.key.id } })).structuredContent ?? null;
          if (mintedArrival?.arrived) {
            // Arrived, and readable: the trace the minted key exported resolves
            // for her (D661's "get_trace resolves the arrived trace").
            mintedResolves = (await cs.callTool({ name: "get_trace", arguments: { id: mintedTraceId } })).isError !== true;
            if (mintedResolves) break;
          }
          await new Promise((r) => setTimeout(r, 1_000));
        }
        // The cross-tenant probe on an id only SHE holds: bob's read key gets
        // the not-found sentence for the trace her minted key just exported.
        const cbAgain = await mcpClientFor(bobRead);
        try {
          bobMintedText = mcpText(await cbAgain.callTool({ name: "get_trace", arguments: { id: mintedTraceId } }));
        } finally {
          await cbAgain.close();
        }
        const otherArrival = readKeyRow ? (await cs.callTool({ name: "check_arrival", arguments: { keyId: readKeyRow.id } })).structuredContent ?? null : null;
        mcpArrival = { minted: mintedArrival, other: otherArrival };
      }
    } finally {
      await cs.close();
    }
  

    // The boundary (D645), LAST: it spends bob's read key's whole window, and
    // a client that initialises under a spent key gets the 429 as the SDK's
    // thrown error — measured on the second green attempt, when this loop ran
    // before bob's cross-tenant read of the minted trace and aborted the drive.
    let last = null;
    for (let i = 0; i < rateLimitMax + 1; i += 1) last = await mcpRaw({ authorization: `Bearer ${bobRead}` });
    boundary = { status: last?.status ?? null, retryAfter: last?.headers.get("retry-after") ?? null };
  }
  // ---- the claims (K = these, exactly) ----
  check(
    "/app/mcp renders live for alice: 200, the endpoint path, the READ-ONLY tag, and the registry's tool count",
    mcpPageFacts.status === 200 && mcpPageFacts.endpoint && mcpPageFacts.readOnly && mcpPageFacts.toolsLine,
    JSON.stringify(mcpPageFacts),
  );
  check(
    `tools/list under a read key is exactly the registry (${registryToolNames.length} names read off lib/mcp-types.ts)`,
    registryToolNames.length > 0 && [...mcpListedTools].sort().join(",") === [...registryToolNames].sort().join(","),
    `listed ${mcpListedTools.length}: ${mcpListedTools.join(",")}`,
  );
  check(
    "get_trace returns her seeded trace with the span count the store holds (recounted over obstack.spans)",
    Number.isFinite(mcpTraceRecount) && mcpTraceRecount > 0 && mcpTraceSpans === mcpTraceRecount,
    `tool ${mcpTraceSpans} · store ${mcpTraceRecount}`,
  );
  check(
    "query_traces with the prompt token finds exactly the one trace the traces page found for it",
    mcpSearch.total === 1 && mcpSearch.ids.length === 1 && mcpSearch.ids[0] === PROMPT_TRACE,
    JSON.stringify(mcpSearch),
  );
  check(
    "get_incident returns her historical incident with its plan's retention floor and only the four timeline kinds",
    mcpIncident.id === historicalId &&
      mcpIncident.retentionDays === planRetentionDays &&
      Array.isArray(mcpIncident.kinds) &&
      mcpIncident.kinds.every((k) => ["alert", "change", "trace", "resolved"].includes(k)),
    `${JSON.stringify({ ...mcpIncident, kinds: mcpIncident.kinds?.length })} · plan ${planRetentionDays}`,
  );
  check(
    "get_slo_status lists exactly her slos rows",
    Array.isArray(pgSloIds) && pgSloIds.length > 0 && JSON.stringify(mcpSloIds) === JSON.stringify(pgSloIds),
    `tool ${JSON.stringify(mcpSloIds)} · store ${JSON.stringify(pgSloIds)}`,
  );
  check(
    "list_changes lists exactly her change_events rows",
    Array.isArray(pgChangeIds) && pgChangeIds.length > 0 && JSON.stringify(mcpChangeIds) === JSON.stringify(pgChangeIds),
    `tool ${mcpChangeIds?.length} · store ${pgChangeIds?.length}`,
  );
  check(
    "bob's read key: the shared seed id is his own copy (his label, never hers), the trace only she holds is the not-found sentence, and list_incidents is his rows and none of hers",
    bobSeedCopy.ok === true &&
      bobSeedCopy.hisLabel === true &&
      bobSeedCopy.herLabel === false &&
      bobMintedText === "no trace with this id in your workspace" &&
      Number.isFinite(bobOwnIncidents) &&
      bobIncidentTotal === bobOwnIncidents &&
      bobSeesAlice === false,
    `seed ${JSON.stringify(bobSeedCopy)} · minted ${JSON.stringify(bobMintedText)} · total ${bobIncidentTotal} vs ${bobOwnIncidents} · sees alice ${bobSeesAlice}`,
  );
  check(
    "the two doors: her INGEST key at /mcp is a 401 with the challenge; her read and setup keys at /v1/traces are 401s",
    ingestKeyAtMcp.status === 401 && ingestKeyAtMcp.challenge === 'Bearer realm="obstack"' && readKeyAtIngest === 401 && setupKeyAtIngest === 401,
    `${JSON.stringify(ingestKeyAtMcp)} · read@ingest ${readKeyAtIngest} · setup@ingest ${setupKeyAtIngest}`,
  );
  check(
    "no credential at /mcp is the same 401 with the challenge",
    unauthAtMcp.status === 401 && unauthAtMcp.challenge === 'Bearer realm="obstack"',
    JSON.stringify(unauthAtMcp),
  );
  check(
    `the boundary: call ${rateLimitMax + 1} in the window is a 429 with Retry-After`,
    rateLimitMax > 0 && boundary.status === 429 && boundary.retryAfter === "60",
    JSON.stringify(boundary),
  );
  check(
    "a read key cannot mint: issue_ingest_key answers the one refusal sentence",
    cannotMintSentence !== null && readMintText === cannotMintSentence,
    JSON.stringify(readMintText),
  );
  check(
    "a setup key mints an ingest key: ok_live_ shape, scope ingest, the mcp: prefix on the stored row, and the minted key is refused at /mcp",
    /^ok_live_[0-9a-f]{64}$/.test(minted.token ?? "") &&
      minted.scope === "ingest" &&
      minted.name === "mcp:e2e-agent" &&
      minted.row?.name === "mcp:e2e-agent" &&
      minted.row?.scope === "ingest" &&
      mintedAtMcp === 401,
    `${JSON.stringify({ ...minted, token: minted.token ? "…" : null })} · minted@mcp ${mintedAtMcp}`,
  );
  check(
    "the minted key exports (200), check_arrival flips for it alone, the exported trace resolves for her, and her read key's window is unmoved",
    mintedExportStatus === 200 &&
      mcpArrival.minted?.arrived === true &&
      mcpArrival.minted?.keys?.length === 1 &&
      mcpArrival.minted?.keys?.[0]?.accepted >= 1 &&
      mintedResolves === true &&
      mcpArrival.other?.arrived === false,
    `export ${mintedExportStatus} · minted ${JSON.stringify(mcpArrival.minted?.keys?.[0])} · resolves ${mintedResolves} · other arrived ${mcpArrival.other?.arrived}`,
  );
  console.log(`   mcp arm: ${Math.round((Date.now() - mcpArmStartedAt) / 1000)}s of wall time`);

  step("a plan change round-trips: checkout → return → reconcile → redirect → ONE paint says Pro (D168/D189)");
  await openTab(alice, "Billing & usage", `document.querySelector("main")?.textContent.includes("change plan")`);
  must(await alice.evaluate(clickText("Upgrade to Pro")), "the Billing & usage tab offers no Pro upgrade");
  must(
    await alice.waitFor(
      `document.querySelector("main")?.textContent.includes("Your plan is updated")`,
      30_000,
    ),
    "the checkout never came back to a reconciled settings page",
  );
  const landing = await alice.evaluate(`location.pathname + location.search`);
  const proPlan = await pgOne(`SELECT event_quota, retention_days FROM plans WHERE id = $1`, ["pro"]);
  const planRow = await pgOne(
    `SELECT plan_id, polar_customer_id, polar_subscription_id, updated_at FROM workspace_plans WHERE workspace_id = $1`,
    [alice.workspaceId],
  );
  // Both ids are asserted PRESENT (D195). Reconciliation is now a CONVERGENCE:
  // the checkout is only the trigger, and `syncPlanFromRail` writes exactly the
  // rail's present subscription — "active pro ⇒ pro + ids". The subscription id
  // no longer comes off the Checkout object (which carries `customer_id` but
  // `subscription_id: null` even once active — the F5/D194 measurement); it
  // comes off `getSubscriptionState`, which on the real rail reads the
  // subscriptions list and on the fake carries the id set at checkout creation.
  // So poll-on-return fills the column directly and no longer depends on a
  // reachable webhook to backfill it (the resolution of the sandbox-run brief).
  check(
    "the return path converged on the rail's present subscription: Postgres holds alice's plan row, on pro, " +
      "carrying the rail's customer id AND its subscription id (D195)",
    planRow?.plan_id === "pro" &&
      planRow?.polar_customer_id === `cus_${alice.workspaceId}` &&
      typeof planRow?.polar_subscription_id === "string" &&
      planRow.polar_subscription_id.startsWith("sub_"),
    JSON.stringify(planRow),
  );
  check(
    "and then redirected: the landing is /app/settings?upgraded=1, with the checkout id gone from the address bar (D189)",
    landing === "/app/settings?upgraded=1",
    landing,
  );

  // THE LANDING, FETCHED THE WAY THE CUSTOMER'S BROWSER FETCHES IT. A customer
  // returns from Polar's hosted page, so the return is a document navigation:
  // the browser GETs `?checkout=<id>`, follows the redirect this page answers
  // with, and paints the response to `?upgraded=1`. Here the rail is the fake, so
  // its checkout URL is same-origin and the click above became a CLIENT-side
  // transition instead — and Next reuses the shared layout segment across those
  // by design ("shared layouts won't automatically be refetched on every
  // navigation, only the page segment that changes", staleTimes.md), which would
  // make a banner read after the click a claim about the previous document, not
  // about this seam. So the landing URL is fetched as a document, once, and every
  // number below comes out of THAT ONE render (D189).
  must(
    await alice.goto("/app/settings?upgraded=1", `!!document.querySelector("main h1")`),
    "the return landing never rendered",
  );
  const returned = await alice.evaluate(BILLING);
  const proPair = pairIn(returned.main.split("events (spans + log records)")[1] ?? "");
  check(
    "ONE paint carries the notice AND the plan it just bought — name, catalog quota, retention, none of them restated in TypeScript (D163/D189)",
    returned.main.includes("Your plan is updated") &&
      proPair !== null &&
      proPair[0] === ledger.events &&
      proPair[1] === Number(proPlan?.event_quota) &&
      returned.main.includes(`${proPlan?.retention_days} days · Pro`),
    `${JSON.stringify(proPair)} vs catalog ${JSON.stringify(proPlan)} · ${returned.main.slice(0, 200)}`,
  );
  check(
    "and the banner in that same paint goes with it — the same used number, now under a quota that does not warrant one",
    returned.banner === null,
    returned.banner,
  );

  // The refresh, which is where the old shape lied twice: the notice is on the
  // URL, so it survives a reload honestly, and the checkout id is NOT, so a
  // reload cannot reconcile a second time. `updated_at` is the measured proof of
  // the second half — the upsert stamps it on every write, so an unmoved stamp
  // is a write that did not happen (D189).
  must(
    await alice.goto("/app/settings?upgraded=1", `!!document.querySelector("main h1")`),
    "the reloaded return landing never rendered",
  );
  const refreshed = await alice.evaluate(BILLING);
  const refreshedRow = await pgOne(`SELECT updated_at FROM workspace_plans WHERE workspace_id = $1`, [
    alice.workspaceId,
  ]);
  check(
    "a refresh of that URL says the same true thing: the notice is sticky because it is on the URL, beside the plan it is about",
    refreshed.main.includes("Your plan is updated") &&
      refreshed.main.includes(`${proPlan?.retention_days} days · Pro`) &&
      refreshed.banner === null,
    `${refreshed.banner} · ${refreshed.main.slice(0, 200)}`,
  );
  check(
    "and nothing reconciled a second time — the plan row still carries the stamp the return path wrote",
    Boolean(planRow?.updated_at) &&
      Boolean(refreshedRow?.updated_at) &&
      String(refreshedRow.updated_at) === String(planRow.updated_at),
    `${planRow?.updated_at} → ${refreshedRow?.updated_at}`,
  );

  // THE OTHER EXIT of the same seam, walked end to end rather than reasoned
  // about: a return the rail refuses. An id this rail never issued is the
  // `UnknownCheckout` class, and the page maps EVERY refusal — unknown, unpaid,
  // another workspace's (D176), a billing outage — through the one `applied`
  // boolean, so proving this one proves the branch. What it pins that a unit
  // test of `reconcileCheckout` cannot: that the code the redirect names is a
  // member of the settings vocabulary. A typo there still renders a sentence —
  // the generic one — so the refusal's own copy is what is asserted (D121/D189).
  must(
    await alice.goto("/app/settings?checkout=chk_never_issued", `!!document.querySelector("main h1")`),
    "the refused return never rendered",
  );
  const refusedLanding = await alice.evaluate(`location.pathname + location.search`);
  const refused = await alice.evaluate(SETTINGS);
  const refusedRow = await pgOne(`SELECT plan_id, updated_at FROM workspace_plans WHERE workspace_id = $1`, [
    alice.workspaceId,
  ]);
  check(
    "a checkout the rail never issued redirects too — to `?error=checkout-unconfirmed`, with the id gone from the address bar (D189)",
    refusedLanding === "/app/settings?error=checkout-unconfirmed",
    refusedLanding,
  );
  check(
    "and it says the refusal's own sentence, not the generic one and not an upgrade notice (D121)",
    refused.text.includes("We couldn't confirm that checkout, so your plan is unchanged") &&
      !refused.text.includes("That didn't work") &&
      !refused.text.includes("Your plan is updated"),
    refused.text.slice(0, 240),
  );
  check(
    "and nothing was written for it — alice is on the plan she bought, under the stamp the return path wrote",
    refusedRow?.plan_id === "pro" && String(refusedRow?.updated_at) === String(planRow?.updated_at),
    `${JSON.stringify(refusedRow)} vs ${planRow?.updated_at}`,
  );

  step("alice revokes the key — the row is stamped, and the list says so about THAT key");
  await openTab(
    alice,
    "API keys",
    `document.querySelector("main")?.textContent.includes(${JSON.stringify(`${prefix}…`)})`,
  );
  // The metering key BY ID: the list holds two now, and "the revoke control" is
  // only a definite article while there is one of them.
  const meteringKeyId = (
    await pgOne(`SELECT id FROM api_keys WHERE workspace_id = $1 AND prefix = $2`, [alice.workspaceId, prefix])
  )?.id;
  must(meteringKeyId, `no api_keys row for ${prefix}`);
  must(await alice.evaluate(clickRevoke(meteringKeyId)), "the listed key has no revoke control");
  // Polled in the store rather than read off the copy, and this is the D142
  // reason: the tab carries the standing sentence "a revoked key stops being
  // accepted within 30 seconds" whether or not anything is revoked, so a page
  // containing the word says nothing about this key (measured on T5's surface).
  let revokedAt = null;
  for (let attempt = 0; attempt < 40 && !revokedAt; attempt++) {
    revokedAt = (
      await pgOne(`SELECT revoked_at FROM api_keys WHERE workspace_id = $1 AND prefix = $2`, [
        alice.workspaceId,
        prefix,
      ])
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
  const aliceKeys = await pgRows(`SELECT prefix, revoked_at, scope, name FROM api_keys WHERE workspace_id = $1`, [
    alice.workspaceId,
  ]);
  const bobKeys = await pgRows(`SELECT id, scope FROM api_keys WHERE workspace_id = $1`, [bob.workspaceId]);
  const meteringRow = aliceKeys.find((k) => k.prefix === prefix);
  const quickstartRow = aliceKeys.find((k) => k.prefix === firstPrefix);
  // S8.1: the MCP arm issued three more of alice's (read, setup, and the mint's
  // `mcp:` ingest key) and bob's one read key; a run that withheld the arm
  // reads the hook and expects the pre-S8.1 world, so the RED's failure count
  // stays the arm's own (D662).
  const mcpWithheld = Boolean(process.env.RED_WITHHOLD_MCP);
  const aliceScopes = aliceKeys.map((k) => k.scope).sort().join(",");
  const mintedRow = aliceKeys.find((k) => k.name.startsWith("mcp:"));
  check(
    "api_keys holds the seeded dev row live on ws_demo, alice's keys — the quickstart's still live, the settings one revoked, " +
      "and (S8.1) her read, setup and mcp:-minted ingest keys — and bob's one read key",
    devKey?.workspace_id === "ws_demo" &&
      devKey?.prefix === "ok_dev_local" &&
      devKey?.revoked_at === null &&
      aliceKeys.length === (mcpWithheld ? 2 : 5) &&
      meteringRow !== undefined &&
      meteringRow.revoked_at !== null &&
      quickstartRow !== undefined &&
      quickstartRow.revoked_at === null &&
      (mcpWithheld
        ? bobKeys.length === 0
        : aliceScopes === "ingest,ingest,ingest,read,setup" &&
          mintedRow?.scope === "ingest" &&
          mintedRow?.revoked_at === null &&
          bobKeys.length === 1 &&
          bobKeys[0].scope === "read"),
    `dev=${JSON.stringify(devKey)} alice=${JSON.stringify(aliceKeys.map((k) => [k.prefix, k.scope, k.revoked_at ? "revoked" : "live"]))} bob=${JSON.stringify(bobKeys)}`,
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
  // and must be error-free; everything below is the no-session path, which
  // D274 made a redirect (307 → /login) rather than a throw — so the slice
  // below must be error-free TOO, and a NoSessionError appearing there is a
  // regression of the refit, not an allowlisted tripwire.
  const logSplit = statSync(appLog).size;
  // The list is `liveWiredRoutes` itself (apps/web/src/lib/live-routes.ts): a
  // route that reads the workspace's real data is a route an anonymous browser
  // must not reach, so wiring one here is the other half of wiring it there.
  // For four sprints that sentence was a CLAIM this list did not keep — S6.2's
  // /app/costs and /app/infra, S7.2's /app/changes and S7.3's /app/slos were
  // wired there and never probed here — so S7.4 pays the backlog and ends the
  // class: the registry is read below and every entry must be covered (D565).
  const probed = [
    "/app",
    "/app/traces",
    `/app/traces/${PROMPT_TRACE}`,
    "/app/logs",
    "/app/settings",
    "/app/onboarding",
    "/app/connections",
    // /app/explore joined the registry in S6.1, and the five below in S6.2
    // (D21/D367), the diff among them now that nothing is carved out of the
    // wired `/app/traces/` subtree (D400).
    "/app/explore",
    "/app/map",
    "/app/services",
    `/app/services/${CHAIN_AGENT}`,
    "/app/users",
    "/app/issues",
    `/app/traces/diff?a=${PROMPT_TRACE}`,
    // S6.2 too, reclaimed in S7.4: the two surfaces the S6.2 arm asserted
    // live-wired and this list never named (D565).
    "/app/costs",
    "/app/infra",
    // S6.3 (D21/D367): the dashboards list and one dashboard's own page joined
    // that list this sprint, and the id below is the row alice actually holds —
    // an anonymous browser must not reach it either.
    "/app/dashboards",
    `/app/dashboards/${dashboardId}`,
    // S7.1 (D21/D367): alerts joined liveWiredRoutes this sprint — rules,
    // evaluated events and channel names are workspace data an anonymous
    // browser must not reach.
    "/app/alerts",
    // S7.2 and S7.3, reclaimed in S7.4 (D565).
    "/app/changes",
    "/app/slos",
    // S7.4 (D21/D519): the incidents list and one incident's own page — the id
    // is the historical incident alice declared above, a row she holds.
    "/app/incidents",
    // S8.1 (D21/D663): the MCP page — the registry gained it, so the probe does.
    "/app/mcp",
    `/app/incidents/${historicalId}`,
  ];
  for (const path of probed) {
    await alice.goto(path, `document.body.textContent.length > 0`);
    const state = await alice.evaluate(STATE);
    check(
      `${path} with no session lands on /login and renders no telemetry`,
      state.url.startsWith("/login") && !state.text.includes(SPAN_PROMPT_TOKEN) && state.workspaceAttr === null,
      state.url,
    );
  }
  // D565: the registry is read as TEXT, the recipe lift's idiom — not a
  // hand-copied literal like FLUSH_MS, which is the opposite idiom — with
  // `//`-to-end-of-line stripped BEFORE the quoted entries are extracted: the
  // array literal already carries a five-line comment, and the drift class this
  // check ends would otherwise return the first time a comment quoted a path.
  // An exact entry is covered by equality; a trailing-slash entry by a probed
  // path under it that is longer than the prefix.
  const registrySource = readFileSync(join(repoRoot, "apps/web/src/lib/live-routes.ts"), "utf8");
  const registryStart = registrySource.indexOf("export const liveWiredRoutes");
  const registryLiteral = registrySource.slice(registryStart, registrySource.indexOf("];", registryStart));
  const registryEntries = [...registryLiteral.replace(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const uncovered = registryEntries.filter((entry) =>
    entry.endsWith("/") ? !probed.some((path) => path.startsWith(entry) && path.length > entry.length) : !probed.includes(entry),
  );
  check(
    `the probe list covers every one of liveWiredRoutes' ${registryEntries.length} entries — exact ones by equality, subtree ones by a longer probed path — so a route wired there and not probed here is a red line, not a comment (D565)`,
    registryStart >= 0 && registryEntries.length > 0 && uncovered.length === 0,
    uncovered.length > 0 ? `uncovered: ${uncovered.join(", ")}` : `${registryEntries.length} entries, ${probed.length} probes`,
  );
  // The quickstart's poll is not a navigation, so it does not get one: a signed-
  // out client asking for status gets the status code and an empty body, not a
  // login page rendered inside what the caller will parse as JSON (D216). Fetched
  // rather than navigated to for exactly that reason — this is the request the
  // client's `fetch` makes, and `redirect: "manual"` is what makes a redirect
  // show up as a redirect instead of being followed into a 200.
  const pollUnauthed = await fetch(`${BASE}/app/onboarding/status`, { redirect: "manual" });
  const pollBody = await pollUnauthed.text();
  check(
    "/app/onboarding/status with no session is a bare 401 — no redirect, no body (D203/D216)",
    pollUnauthed.status === 401 && pollBody === "",
    `HTTP ${pollUnauthed.status} ${pollUnauthed.headers.get("location") ?? ""} ${pollBody.slice(0, 80)}`,
  );

  step("the server log: clean everywhere, with exactly one named exception (D132)");
  // Sliced as BYTES, because that is what the mark is: the log carries `⨯`, `✓`
  // and ANSI escapes, so a byte offset used as a string index lands mid-line and
  // hands the first segment a fragment of the second one's first error — a
  // split that reports the allowlisted line as an unallowed one (measured).
  const wholeLog = readFileSync(appLog);
  // THIS PREDICATE IS LOAD-BEARING FOR CODE THAT DOES NOT KNOW ABOUT IT (D206).
  // Every deliberate refusal the product LOGS on an authenticated path is read
  // by it, so a refusal worded with "Error" in it would turn a spec'd log line
  // into a red here. The one that came closest is billing's, and the coupling is
  // now mirrored rather than remembered: `apps/web/src/server/billing/
  // reconcile-wording.test.ts` restates this regex as a constant, pins it
  // against this file, and asserts no refusal in `reconcile.ts` matches it. Same
  // shape as the FLUSH_MS mirrors above — change the regex here and that test
  // goes red in the same round.
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
  // D241, and deliberately WITHOUT an allowlist entry: CI runs the fake, which
  // has no provider to lose, so this line appearing at all means either the fake
  // stopped being deterministic or a provider was called in a run that must
  // never spend (U6). Its prefix is stable for exactly this reason, and it is
  // read across the WHOLE log because the run that would print it is the
  // authenticated one above and the split must not become a place to hide it.
  const providerFailures = wholeLog
    .toString("utf8")
    .split("\n")
    .filter((line) => line.includes("[explain] run failed mid-stream"));
  check(
    "no Explain run failed mid-stream — the fake carries the drive, and a provider failure here is not allowlisted anywhere (D241)",
    providerFailures.length === 0,
    providerFailures.slice(0, 2).join(" | "),
  );
  // D274 flipped this assertion's direction: a browser with no session is
  // redirected before anything can throw, so the probe's slice carries no
  // error line at all. The NoSessionError class survives only on the
  // non-request dataForSessionContext(null) contract, which no browser
  // reaches — one appearing here means the redirect refit regressed.
  check(
    "the unauthenticated probe logs no error line at all — no-session is a redirect, never a throw (D274)",
    unauthenticated.length === 0,
    unauthenticated.slice(0, 3).join(" | "),
  );

  step("token hygiene: the keys this run issued appear in nothing it printed and nothing it wrote");
  // Read the same way the log split above is: the drive's own output, as bytes,
  // by the literal. Both UI-issued tokens are checked, not only the quickstart's
  // — "shown once" is a property of the product, and a drive that leaked either
  // one into a CI log would have published a live credential to everyone who can
  // read that log (D98, W4 amendment 2).
  //
  // The scope is what this run PRINTED and what it WROTE: stdout and stderr as
  // they were emitted, the transcript exactly as the finally block is about to
  // serialise it, and every artifact file beside it. Chrome's own profile
  // directories are deliberately not searched — a browser cache holding a page
  // it was just shown is the browser, not this drive's artifact, and every real
  // operator's browser does the same.
  const artifacts = readdirSync(OUT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const searched = [
    ["stdout+stderr", printed.join("\n")],
    ["transcript.json", JSON.stringify(transcript)],
    ...artifacts.map((name) => [name, readFileSync(join(OUT, name)).toString("utf8")]),
  ];
  // The Explain half of this claim is the one that is true by construction and
  // is asserted anyway (D245/S3.4 §6): the served environment carries no Explain
  // credential — the fake authenticates nothing, so there is no key in this run
  // to print — and whichever of the two names the CALLER's shell held is swept
  // as a literal beside the issued tokens, because a drive that printed an
  // operator's Anthropic key would have published it exactly the same way.
  check(
    "the app was served with no Explain credential at all: fake mode signs nothing, so this run held none to leak (U6)",
    EXPLAIN_CREDENTIALS.every((name) => appEnv[name] === undefined),
    EXPLAIN_CREDENTIALS.filter((name) => appEnv[name] !== undefined).join(", "),
  );
  const SENT = "only in the Authorization header it was sent in";
  for (const [secret, whose, only] of [
    [firstToken, "the key issued from the quickstart", SENT],
    [token, "the key issued from settings", SENT],
    ...EXPLAIN_CREDENTIALS.filter((name) => process.env[name]).map((name) => [
      process.env[name],
      `the caller's ${name}`,
      "which this run never sent anywhere — it explains through the fake",
    ]),
  ]) {
    const leaked = searched.filter(([, body]) => body.includes(secret)).map(([name]) => name);
    check(
      `${whose} is in none of ${searched.length} outputs — ${only}`,
      leaked.length === 0,
      `present in ${leaked.join(", ")}`,
    );
  }
} catch (error) {
  // A precondition that did not hold, or a step that threw: the run is over and
  // it is a FAILURE, not an exception nobody counted. Everything asserted up to
  // here still prints, and the artifacts stay on disk.
  failures++;
  console.log(`  FAIL the drive aborted — ${error?.stack ?? error}`);
} finally {
  step("result");
  // D566: the catalog goes back to what THIS RUN read before it wrote, at the
  // top of finally and before the pool ends — and a failed restore is a red
  // check, never an exception out of a finally block. Restoring from a number
  // spelled here (50000/20) is refused: that is a second copy of the
  // migration's values, the divergence class this repo does not keep.
  if (catalogBefore !== null) {
    try {
      const restored = await pgOne(
        `UPDATE plans SET event_quota = $1, explain_quota = $2 WHERE id = 'free' RETURNING event_quota, explain_quota`,
        [catalogBefore.event_quota, catalogBefore.explain_quota],
      );
      check(
        "the free plan's catalog row is back at the values this run read before it lowered them — captured, not spelled — so a driven stack runs the two catalog-reading integration suites green (D566)",
        restored !== null &&
          Number(restored.event_quota) === Number(catalogBefore.event_quota) &&
          Number(restored.explain_quota) === Number(catalogBefore.explain_quota),
        `restored ${JSON.stringify(restored)} vs captured ${JSON.stringify(catalogBefore)}`,
      );
    } catch (error) {
      check("the free plan's catalog row is back at the values this run read before it lowered them (D566)", false, `${error?.message ?? error}`);
    }
  }
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
