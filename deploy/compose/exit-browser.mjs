/**
 * The S2.3 exit evidence a server cannot produce: what the two filter bars do
 * in a real browser (T5).
 *
 * Promoted from the T4 reviewer's scratchpad `cdp-resync.mjs` — the transport
 * is that harness's, the assertions are this task's. It exists because the
 * pinned unit runner cannot import a component module at all (D54(ii)), so
 * three claims have no other home:
 *
 *   - carry-forward 2 on BOTH surfaces: a URL that moves underneath a bar —
 *     pager, back, forward, deep link — is adopted into the controls (D69,
 *     widened by D72);
 *   - the D72 wrapper's own behaviour: a late echo of an earlier keystroke does
 *     not rewind text typed since (the pure core carries the red-then-green
 *     unit; this is the end-to-end line);
 *   - `SavedViewsMenu`, whose behavioural coverage of record for S2.3 is
 *     exactly this run: a view created through the UI, the browser reloaded,
 *     the view still listed, then applied (D54(iii)).
 *
 * Driven by `exit-evidence.sh`; standalone against an already-running app and
 * a headless Chrome with --remote-debugging-port:
 *
 *   APP=http://127.0.0.1:3210 CDP_PORT=9333 node deploy/compose/exit-browser.mjs
 */

const PORT = process.env.CDP_PORT ?? "9333";
const BASE = process.env.APP ?? "http://127.0.0.1:3210";
/** Injected latency for the echo race — see the double-navigation step. */
const ECHO_LATENCY_MS = Number(process.env.ECHO_LATENCY_MS ?? 900);

/**
 * Every number this harness expects of the UI is counted in ClickHouse by
 * `exit-evidence.sh` and passed in — never derived by hand here, so the
 * assertions cannot agree with a stale idea of the fixture (S2.0 L1). The
 * defaults match the shipped seed and exist only for a standalone run.
 */
const expect = {
  total: Number(process.env.EXPECT_TOTAL ?? 220),
  pageSize: Number(process.env.EXPECT_PAGE_SIZE ?? 200),
  service: process.env.EXPECT_SERVICE ?? "exit-agent",
  serviceTotal: Number(process.env.EXPECT_SERVICE_TOTAL ?? 146),
  errorTotal: Number(process.env.EXPECT_ERROR_TOTAL ?? 11),
  dbPodErrorRows: Number(process.env.EXPECT_DBPOD_ERROR_ROWS ?? 1),
};
const lastPageRows = expect.total - expect.pageSize;

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let id = 0;
const inflight = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && inflight.has(msg.id)) {
    const { resolve, reject } = inflight.get(msg.id);
    inflight.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    inflight.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);

const evaluate = async (expression) => {
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goto = async (path) => {
  await send("Page.navigate", { url: `${BASE}${path}` }, sessionId);
  await waitFor(`document.readyState === "complete" && !!document.querySelector("main, table")`);
  await sleep(400);
};
async function waitFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(`Boolean(${expression})`)) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

/** Everything an assertion here needs, read out of the rendered page. */
const STATE = `(() => {
  const strip = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const controls = {};
  for (const el of document.querySelectorAll("input, select")) {
    const key = el.getAttribute("aria-label") || el.placeholder;
    if (key) controls[strip(key)] = el.value;
  }
  const spans = [...document.querySelectorAll("span")].map((s) => strip(s.textContent));
  return {
    url: location.pathname + location.search,
    header: spans.find((t) => /of \\d+ traces$/.test(t)) || spans.find((t) => /shown.*last /.test(t)) || null,
    pager: spans.find((t) => /^page \\d+ of \\d+$/.test(t)) || null,
    controls,
    rows: document.querySelectorAll("tbody tr").length,
    firstRow: strip(document.querySelector("tbody tr")?.textContent || "").slice(0, 60),
    badge: document.body.textContent.includes("SAMPLE DATA"),
  };
})()`;

/** Type into a control the way a user does — React listens for `input`. */
const type = (key, value) => `(() => {
  const el = [...document.querySelectorAll("input")]
    .find((i) => (i.getAttribute("aria-label") || i.placeholder || "").startsWith(${JSON.stringify(key)}));
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

const transcript = [];
let failures = 0;
const record = async (label) => {
  const state = await evaluate(STATE);
  transcript.push({ step: label, ...state });
  return state;
};
function check(claim, condition, detail) {
  if (condition) {
    console.log(`  ok   ${claim}`);
  } else {
    failures++;
    console.log(`  FAIL ${claim}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- traces: D69
console.log("\n== /app/traces — pager, back, forward (carry-forward 2, D69)");
await goto("/app/traces");
const t1 = await record("A: /app/traces loaded");
check(
  `page 1 renders ${expect.pageSize} rows over the counted total ${expect.total}`,
  t1.header?.endsWith(`${expect.pageSize} of ${expect.total} traces`) && t1.rows === expect.pageSize,
  `${t1.header} | ${t1.rows} rows`,
);
check("no SAMPLE badge on a live-wired route", t1.badge === false);

// A deep link into a filtered view: the inputs must come up holding the URL's
// values, not the empty ones they mount with.
await goto(`/app/traces?service=${expect.service}`);
const t2 = await record("B: deep link into a filtered list");
check("a deep link re-syncs the input", t2.controls["Service filter"] === expect.service, JSON.stringify(t2.controls));
check(
  `and the total is the counted ${expect.serviceTotal}, not the whole workspace`,
  t2.header?.endsWith(`of ${expect.serviceTotal} traces`),
  t2.header,
);

// The history sequence D69 fixes. It runs over a FILTERED list, because the
// pager is the only control that pushes a history entry — every other control
// replaces (the M1 debounce behaviour), so a typed filter would overwrite the
// pager's entry instead of stacking on it.
await goto("/app/traces?range=24h");
const t3 = await record("C: filtered list, page 1");
check("the range control holds the URL's value", t3.controls["Time range filter"] === "24h", JSON.stringify(t3.controls));

await evaluate(clickText("next"));
await waitFor(`location.search.includes("page=2")`);
await sleep(700);
const t4 = await record("D: clicked the pager");
check("pager click lands page 2 in the URL", t4.url === "/app/traces?range=24h&page=2", t4.url);
check(
  "header and URL agree on page 2",
  t4.header?.endsWith(`${lastPageRows} of ${expect.total} traces`) && t4.pager === "page 2 of 2",
  `${t4.header} | ${t4.pager}`,
);
check("page 2 is disjoint from page 1", t4.firstRow !== t3.firstRow);

await evaluate("history.back()");
await waitFor(`location.search === "?range=24h"`);
await sleep(700);
const t5 = await record("E: history.back()");
check("back restores page 1", t5.url === "/app/traces?range=24h" && t5.pager === "page 1 of 2", `${t5.url} | ${t5.pager}`);
check("with the page's own rows and total", t5.header?.endsWith(`${expect.pageSize} of ${expect.total} traces`), t5.header);
check("and every input still matching the URL", t5.controls["Time range filter"] === "24h", JSON.stringify(t5.controls));

await evaluate("history.forward()");
await waitFor(`location.search.includes("page=2")`);
await sleep(700);
const t6 = await record("F: history.forward()");
check("forward restores the filtered state", t6.url === "/app/traces?range=24h&page=2" && t6.pager === "page 2 of 2", `${t6.url} | ${t6.pager}`);
check("inputs included", t6.controls["Time range filter"] === "24h", JSON.stringify(t6.controls));

// The debounced edit path: typing replaces the URL and resets to the first page.
await evaluate(type("Service filter", expect.service));
await waitFor(`location.search.includes("service=${expect.service}")`);
await sleep(700);
const t7 = await record("G: typed a service filter (debounced replace)");
check("a typed filter reaches the URL and drops the page", t7.url === `/app/traces?service=${expect.service}&range=24h`, t7.url);
check("and the list narrows to the counted total", t7.header?.endsWith(`of ${expect.serviceTotal} traces`), t7.header);

// ------------------------------------------------------------ logs: D69 + D72
console.log("\n== /app/logs — deep link, back, forward, and the late echo (D72)");
await goto("/app/logs?sev=error&pod=exit-db-0");
const l1 = await record("F: deep link into a filtered logs view");
check("a deep link re-syncs both controls", l1.controls["Minimum severity"] === "error" && l1.controls["Pod filter"] === "exit-db-0", JSON.stringify(l1.controls));
check("no SAMPLE badge on /app/logs either", l1.badge === false);
check("the filtered view renders exactly the counted rows", l1.rows === expect.dbPodErrorRows, `${l1.rows} rows`);

// Two real navigations, so there is a history stack to walk: the bar's own
// edits replace rather than push (M1 behaviour), which is exactly why the
// adoption rule has to tell the two apart.
await goto("/app/logs?q=checkpoint");
const l2 = await record("G: deep link into a searched view");
check("the search box holds the URL's term", l2.controls["Search log bodies…"] === "checkpoint", JSON.stringify(l2.controls));

await evaluate("history.back()");
await waitFor(`location.search.includes("pod=exit-db-0")`);
await sleep(700);
const l3 = await record("H: history.back() on logs");
check("back returns to the previous filtered view", l3.url === "/app/logs?sev=error&pod=exit-db-0", l3.url);
check(
  "and every control re-synced to it — the search box emptied itself",
  l3.controls["Search log bodies…"] === "" && l3.controls["Minimum severity"] === "error" && l3.controls["Pod filter"] === "exit-db-0",
  JSON.stringify(l3.controls),
);

await evaluate("history.forward()");
await waitFor(`location.search.includes("q=checkpoint")`);
await sleep(700);
const l4 = await record("I: history.forward() on logs");
check("forward restores the search in the box", l4.controls["Search log bodies…"] === "checkpoint", JSON.stringify(l4.controls));
check("and clears the filters it moved away from", l4.controls["Minimum severity"] === "debug" && l4.controls["Pod filter"] === "", JSON.stringify(l4.controls));

// The echo race, with the network slowed so the window is real rather than
// lucky: type "ab", let the 250 ms debounce push it, then type the third
// character while that navigation is still in flight. The echo of "ab" arrives
// afterwards; with the single remembered URL this surface used to keep, it read
// as somebody else's navigation and rewound the box to "ab" (D72).
await goto("/app/logs");
await send("Network.emulateNetworkConditions", {
  offline: false,
  latency: ECHO_LATENCY_MS,
  downloadThroughput: -1,
  uploadThroughput: -1,
}, sessionId);
await evaluate(type("Search log bodies", "ab"));
await sleep(400); // past the debounce: the navigation for "ab" is in flight
await evaluate(type("Search log bodies", "abc"));
await sleep(ECHO_LATENCY_MS * 3 + 1500); // both echoes land
const l5 = await record("J: fast double navigation (the late echo)");
check(
  "typed text survives the first echo",
  l5.controls["Search log bodies…"] === "abc",
  `the box reads ${JSON.stringify(l5.controls["Search log bodies…"])} — a late echo rewound it`,
);
check("and the URL settles on the later edit", l5.url === "/app/logs?q=abc", l5.url);
await send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
}, sessionId);

// --------------------------------------------- saved views: D54(iii) coverage
console.log("\n== saved views — created, reloaded, listed, applied (D54(iii) coverage of record)");
await goto("/app/traces?status=error&range=24h");
await evaluate(clickText("saved views"));
await sleep(200);
await evaluate(type("Name for the current filters", "exit-evidence"));
await sleep(150);
check("the create form accepted a name", (await evaluate(clickText("save current filters"))) === true);
await sleep(400);
const stored = await evaluate(`localStorage.getItem("obstack.saved-views")`);
check("the view is in the one storage key", (stored || "").includes("exit-evidence"), stored);
check("and it carries no page key (D47(ii)/D53)", !/\bpage\b/.test(stored || ""), stored);

await goto("/app/traces");
await evaluate(clickText("saved views"));
await sleep(300);
const listed = await evaluate(
  `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "exit-evidence")`,
);
check("after a reload onto a different URL, the view is still listed", listed === true);

await evaluate(clickText("exit-evidence"));
await waitFor(`location.search.includes("status=error")`);
await sleep(700);
const v1 = await record("K: applied the saved view");
check("applying sets the URL", v1.url === "/app/traces?status=error&range=24h", v1.url);
check("applying sets the controls to the same thing", v1.controls["Status filter"] === "error" && v1.controls["Time range filter"] === "24h", JSON.stringify(v1.controls));
check("and the list is the filtered one", v1.header?.endsWith(`of ${expect.errorTotal} traces`), v1.header);

console.log(`\nbrowser evidence: ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
console.log(JSON.stringify(transcript, null, 2));
ws.close();
process.exit(failures === 0 ? 0 : 1);
