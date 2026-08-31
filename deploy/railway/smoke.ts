/**
 * Unattended HTTPS smoke suite for an obstack Railway environment (D335/T2).
 *
 * Proves each deployed environment is actually reachable and behaving the way
 * deploy/railway/README.md says — real HTTP probes, never an exit code from
 * `railway logs` or a deploy command (D346). No config-as-code and no reuse
 * of deploy/compose/smoke.ts or trace-checks.ts: those assume a local
 * ClickHouse/Postgres the operator's shell can reach directly, which is
 * exactly what Railway's private networking refuses this script.
 *
 * Reads env names, all optional:
 *   OBSTACK_SMOKE_MARKETING_URL       e.g. https://obstack.dev
 *   OBSTACK_SMOKE_APP_URL             e.g. https://app.obstack.dev
 *   OBSTACK_SMOKE_INGEST_URL          e.g. https://ingest.obstack.dev
 *   OBSTACK_SMOKE_INGEST_GRPC_URL     optional — e.g. https://ingest-grpc.obstack.dev
 *   OBSTACK_SMOKE_API_KEY             optional — an operator-issued ingest key
 *   OBSTACK_SMOKE_APP_SESSION_COOKIE  optional — a signed-in cookie for the
 *                                     D277 rendering arm (/app/onboarding)
 *   OBSTACK_SMOKE_EXPECTED_OTLP_HTTP  optional — the real endpoint that arm
 *                                     expects to see rendered, e.g.
 *                                     https://ingest.obstack.dev
 *
 * An unset URL never fails silently: every probe that host would have run is
 * printed as a SKIPPED line instead. Uses Node's global `fetch` only. The
 * optional gRPC leg additionally imports the vendored
 * @opentelemetry/exporter-trace-otlp-grpc, @opentelemetry/sdk-trace-base and
 * @opentelemetry/resources (present in node_modules — checked, not assumed)
 * plus their own runtime dependencies (@grpc/grpc-js, @opentelemetry/core),
 * lazily, so a plain HTTP-only run never touches them.
 *
 * Usage: npx tsx deploy/railway/smoke.ts
 */

type Status = "ok" | "FAIL" | "SKIPPED";

interface ProbeCounts {
  ok: number;
  fail: number;
  skipped: number;
}

const counts: ProbeCounts = { ok: 0, fail: 0, skipped: 0 };

/** Prints one probe line and tallies it. Never throws. */
function record(
  status: Status,
  host: string,
  method: string,
  path: string,
  statusLabel: string,
  expectation: string,
): void {
  console.log(`${status}  ${host} ${method} ${path} → ${statusLabel} (${expectation})`);
  if (status === "ok") counts.ok += 1;
  else if (status === "FAIL") counts.fail += 1;
  else counts.skipped += 1;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface FetchAttempt {
  response: Response | null;
  error: unknown;
}

/** fetch() that never throws — TLS/network failures come back as `error`. */
async function safeFetch(url: string, init?: RequestInit): Promise<FetchAttempt> {
  try {
    const response = await fetch(url, init);
    return { response, error: null };
  } catch (error) {
    return { response: null, error };
  }
}

/**
 * The `GET /` probe on every host is labelled "TLS valid", and a reply over
 * plain HTTP would satisfy it — a false green on the one assertion the DNS
 * cut-over rests on, since a mistyped `http://` origin would report the
 * certificate as fine when no certificate was ever presented. So the scheme
 * is checked before the request, not inferred from it.
 */
async function probeTls(host: string, baseUrl: string): Promise<void> {
  if (!baseUrl.startsWith("https://")) {
    record("FAIL", host, "GET", "/", "no TLS", `TLS valid — the URL is not https: (${baseUrl})`);
    return;
  }
  const tls = await safeFetch(baseUrl + "/");
  if (tls.response) {
    record("ok", host, "GET", "/", String(tls.response.status), "TLS valid");
  } else {
    record("FAIL", host, "GET", "/", "ERROR", `TLS valid — ${describeError(tls.error)}`);
  }
}

interface ProbeDef {
  method: string;
  path: string;
  expectation: string;
}

/** Prints a SKIPPED line for every probe a host would have run, unset URL. */
function skipHost(host: string, defs: readonly ProbeDef[], reason: string): void {
  for (const def of defs) {
    record("SKIPPED", host, def.method, def.path, "-", `${def.expectation} — SKIPPED (${reason})`);
  }
}

// ---------------------------------------------------------------------------
// marketing: TLS, /app 200, /docs/quickstart 200, /signup redirects to APP_URL
// ---------------------------------------------------------------------------

const MARKETING_PROBES: readonly ProbeDef[] = [
  { method: "GET", path: "/", expectation: "TLS valid" },
  { method: "GET", path: "/app", expectation: "200" },
  { method: "GET", path: "/docs/quickstart", expectation: "200" },
  { method: "GET", path: "/signup", expectation: "30x, Location starts with APP_URL" },
];

async function probeMarketing(baseUrl: string, appUrl: string | undefined): Promise<void> {
  const host = "marketing";

  await probeTls(host, baseUrl);

  const app = await safeFetch(baseUrl + "/app");
  if (app.response?.status === 200) {
    record("ok", host, "GET", "/app", String(app.response.status), "200");
  } else {
    record("FAIL", host, "GET", "/app", app.response ? String(app.response.status) : "ERROR", "200");
  }

  const docs = await safeFetch(baseUrl + "/docs/quickstart");
  if (docs.response?.status === 200) {
    record("ok", host, "GET", "/docs/quickstart", String(docs.response.status), "200");
  } else {
    record("FAIL", host, "GET", "/docs/quickstart", docs.response ? String(docs.response.status) : "ERROR", "200");
  }

  const signup = await safeFetch(baseUrl + "/signup", { redirect: "manual" });
  if (!signup.response) {
    record("FAIL", host, "GET", "/signup", "ERROR", `30x, Location starts with APP_URL — ${describeError(signup.error)}`);
  } else {
    const status = signup.response.status;
    const location = signup.response.headers.get("location") ?? "";
    const isRedirect = status >= 300 && status < 400;
    if (!appUrl) {
      record(
        "FAIL",
        host,
        "GET",
        "/signup",
        `${status} Location=${location}`,
        "30x, Location starts with APP_URL — cannot verify, OBSTACK_SMOKE_APP_URL is unset",
      );
    } else if (isRedirect && location.startsWith(appUrl)) {
      record("ok", host, "GET", "/signup", `${status} Location=${location}`, "30x, Location starts with APP_URL");
    } else {
      record("FAIL", host, "GET", "/signup", `${status} Location=${location}`, "30x, Location starts with APP_URL");
    }
  }
}

// ---------------------------------------------------------------------------
// app: /login 200 + <form, sign-up/email 404, billing webhook unsigned 4xx
// ---------------------------------------------------------------------------

const APP_PROBES: readonly ProbeDef[] = [
  { method: "GET", path: "/", expectation: "TLS valid" },
  { method: "GET", path: "/login", expectation: "200, body contains <form" },
  { method: "POST", path: "/api/auth/sign-up/email", expectation: "404" },
  { method: "POST", path: "/api/billing/webhook", expectation: "400-499, never 5xx" },
];

async function probeApp(baseUrl: string): Promise<void> {
  const host = "app";

  await probeTls(host, baseUrl);

  const login = await safeFetch(baseUrl + "/login");
  if (login.response?.status === 200) {
    const body = await login.response.text();
    if (body.includes("<form")) {
      record("ok", host, "GET", "/login", "200", "200, body contains <form");
    } else {
      record("FAIL", host, "GET", "/login", "200", "200, body contains <form — no <form in body");
    }
  } else {
    record("FAIL", host, "GET", "/login", login.response ? String(login.response.status) : "ERROR", "200, body contains <form");
  }

  const signUp = await safeFetch(baseUrl + "/api/auth/sign-up/email", { method: "POST" });
  if (signUp.response?.status === 404) {
    record("ok", host, "POST", "/api/auth/sign-up/email", "404", "404");
  } else {
    record("FAIL", host, "POST", "/api/auth/sign-up/email", signUp.response ? String(signUp.response.status) : "ERROR", "404");
  }

  const webhook = await safeFetch(baseUrl + "/api/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ smoke: "unsigned" }),
  });
  if (webhook.response && webhook.response.status >= 400 && webhook.response.status < 500) {
    record("ok", host, "POST", "/api/billing/webhook", String(webhook.response.status), "400-499, never 5xx");
  } else {
    record(
      "FAIL",
      host,
      "POST",
      "/api/billing/webhook",
      webhook.response ? String(webhook.response.status) : "ERROR",
      "400-499, never 5xx",
    );
  }
}

// ---------------------------------------------------------------------------
// ingest: bearer-gated /v1/traces, admin surface never public
// ---------------------------------------------------------------------------

const INGEST_PROBES: readonly ProbeDef[] = [
  { method: "GET", path: "/", expectation: "TLS valid" },
  { method: "POST", path: "/v1/traces", expectation: "401, WWW-Authenticate starts with Bearer" },
  { method: "POST", path: "/v1/traces", expectation: "2xx (with OBSTACK_SMOKE_API_KEY)" },
  { method: "GET", path: "/healthz", expectation: "404 (admin never public)" },
  { method: "GET", path: "/metrics", expectation: "404 (admin never public)" },
];

async function probeIngest(baseUrl: string, apiKey: string | undefined): Promise<void> {
  const host = "ingest";

  const tls = await safeFetch(baseUrl + "/");
  if (tls.response) {
    record("ok", host, "GET", "/", String(tls.response.status), "TLS valid");
  } else {
    record("FAIL", host, "GET", "/", "ERROR", `TLS valid — ${describeError(tls.error)}`);
  }

  const noAuth = await safeFetch(baseUrl + "/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans: [] }),
  });
  if (noAuth.response) {
    const wwwAuth = noAuth.response.headers.get("www-authenticate") ?? "";
    if (noAuth.response.status === 401 && wwwAuth.startsWith("Bearer")) {
      record("ok", host, "POST", "/v1/traces", "401", "401, WWW-Authenticate starts with Bearer");
    } else {
      record(
        "FAIL",
        host,
        "POST",
        "/v1/traces",
        `${noAuth.response.status} WWW-Authenticate=${wwwAuth}`,
        "401, WWW-Authenticate starts with Bearer",
      );
    }
  } else {
    record("FAIL", host, "POST", "/v1/traces", "ERROR", `401, WWW-Authenticate starts with Bearer — ${describeError(noAuth.error)}`);
  }

  if (!apiKey) {
    record("SKIPPED", host, "POST", "/v1/traces", "-", "2xx (with OBSTACK_SMOKE_API_KEY) — SKIPPED (unset OBSTACK_SMOKE_API_KEY)");
  } else {
    const withAuth = await safeFetch(baseUrl + "/v1/traces", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    if (withAuth.response && withAuth.response.status >= 200 && withAuth.response.status < 300) {
      record("ok", host, "POST", "/v1/traces", String(withAuth.response.status), "2xx (with OBSTACK_SMOKE_API_KEY)");
    } else {
      record(
        "FAIL",
        host,
        "POST",
        "/v1/traces",
        withAuth.response ? String(withAuth.response.status) : "ERROR",
        "2xx (with OBSTACK_SMOKE_API_KEY)",
      );
    }
  }

  const healthz = await safeFetch(baseUrl + "/healthz");
  if (healthz.response?.status === 404) {
    record("ok", host, "GET", "/healthz", "404", "404 (admin never public)");
  } else {
    record("FAIL", host, "GET", "/healthz", healthz.response ? String(healthz.response.status) : "ERROR", "404 (admin never public)");
  }

  const metrics = await safeFetch(baseUrl + "/metrics");
  if (metrics.response?.status === 404) {
    record("ok", host, "GET", "/metrics", "404", "404 (admin never public)");
  } else {
    record("FAIL", host, "GET", "/metrics", metrics.response ? String(metrics.response.status) : "ERROR", "404 (admin never public)");
  }
}

// ---------------------------------------------------------------------------
// optional gRPC leg (D336) — one span exported via the vendored gRPC exporter
// ---------------------------------------------------------------------------

const GRPC_PROBE: ProbeDef = { method: "EXPORT", path: "/ (grpc :4317)", expectation: "span export succeeds" };

interface GrpcExportOutcome {
  ok: boolean;
  detail: string;
}

async function exportGrpcSpan(grpcUrl: string, apiKey: string): Promise<GrpcExportOutcome> {
  const { BasicTracerProvider } = await import("@opentelemetry/sdk-trace-base");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
  const { credentials, Metadata } = await import("@grpc/grpc-js");
  const { ExportResultCode } = await import("@opentelemetry/core");
  type ReadableSpan = import("@opentelemetry/sdk-trace").ReadableSpan;

  const parsed = new URL(grpcUrl);
  const target = `${parsed.hostname}:${parsed.port || "443"}`;

  const metadata = new Metadata();
  metadata.set("authorization", `Bearer ${apiKey}`);

  const exporter = new OTLPTraceExporter({
    url: target,
    credentials: credentials.createSsl(),
    metadata,
  });

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "obstack-railway-smoke" }),
  });
  const tracer = provider.getTracer("obstack-railway-smoke");
  const span = tracer.startSpan("obstack-railway-smoke-export");
  span.end();

  try {
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([span as unknown as ReadableSpan], (r) => resolve(r));
    });
    if (result.code === ExportResultCode.SUCCESS) {
      return { ok: true, detail: "SUCCESS" };
    }
    return { ok: false, detail: result.error?.message ?? "exporter returned FAILED" };
  } finally {
    await provider.shutdown();
    await exporter.shutdown();
  }
}

async function probeGrpc(grpcUrl: string | undefined, apiKey: string | undefined): Promise<void> {
  const host = "ingest-grpc";

  if (!grpcUrl || !apiKey) {
    const missing = [
      !grpcUrl ? "OBSTACK_SMOKE_INGEST_GRPC_URL" : null,
      !apiKey ? "OBSTACK_SMOKE_API_KEY" : null,
    ]
      .filter((v): v is string => v !== null)
      .join(", ");
    record("SKIPPED", host, GRPC_PROBE.method, GRPC_PROBE.path, "-", `${GRPC_PROBE.expectation} — SKIPPED (unset ${missing})`);
    return;
  }

  try {
    const outcome = await exportGrpcSpan(grpcUrl, apiKey);
    if (outcome.ok) {
      record("ok", host, GRPC_PROBE.method, GRPC_PROBE.path, outcome.detail, GRPC_PROBE.expectation);
    } else {
      record("FAIL", host, GRPC_PROBE.method, GRPC_PROBE.path, outcome.detail, GRPC_PROBE.expectation);
    }
  } catch (error) {
    record("FAIL", host, GRPC_PROBE.method, GRPC_PROBE.path, "ERROR", `${GRPC_PROBE.expectation} — ${describeError(error)}`);
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// optional: D277 rendering — the app's onboarding surface shows the real
// configured OTLP HTTP endpoint and never a loopback address, and the D336
// HTTP-only launch means the gRPC endpoint must never appear in the render.
//
// SURFACE DECISION: `/app/onboarding` (apps/web/src/app/app/onboarding/page.tsx)
// is the reachable one. `/app/connections` also calls `resolveIngestEndpoints()`
// (apps/web/src/server/ingest-endpoint.ts) but hands the result to
// `ConnectModal` (apps/web/src/components/connections/ConnectModal.tsx), which
// only renders once `open` state is set by a click
// (`ConnectionsHub.tsx:142-143,382-383`) — Next SSRs the initial (closed)
// state, so a plain authenticated GET never reaches that modal's HTML, and
// there is no separate JSON endpoint that serves it either. `/app/onboarding`
// renders `Quickstart` (`components/onboarding/Quickstart.tsx`) UNCONDITIONALLY
// on load, default tab "python", whose snippet is built by
// `components/onboarding/snippets.ts` `snippetsFor()` and interpolates the
// real endpoint directly (`OTEL_EXPORTER_OTLP_ENDPOINT=${http}`) with no click
// required — real plain-HTML SSR output, reachable by `fetch` + a cookie.
//
// GAP, stated plainly: `snippets.ts`'s asymmetric design (D282) means an
// HTTP-only deployment never renders an explicit "gRPC absence" SENTENCE on
// this page — gRPC is simply omitted from every tab's snippet (`grpcLine`
// stays `""`). The literal gRPC-absence sentence text ("This deployment does
// not publish a gRPC OTLP endpoint — set OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT on
// the web workload to render this step.") lives only in ConnectModal's
// `resolveStepSnippet`, which is unreachable without a real click — no
// `fetch`-only probe can trigger it. This arm therefore asserts gRPC's
// STRUCTURAL absence instead (no gRPC endpoint or `PROTOCOL=grpc` line
// anywhere in the response body) as the closest true statement `fetch` can
// prove, and says so here rather than asserting untested UI behaviour.

const D277_PROBE: ProbeDef = {
  method: "GET",
  path: "/app/onboarding",
  expectation: "HTTP endpoint rendered, gRPC structurally absent, no loopback (D277)",
};

async function probeD277Rendering(
  appUrl: string | undefined,
  cookie: string | undefined,
  expectedHttp: string | undefined,
): Promise<void> {
  const host = "app-render";

  const missing = [
    !appUrl ? "OBSTACK_SMOKE_APP_URL" : null,
    !cookie ? "OBSTACK_SMOKE_APP_SESSION_COOKIE" : null,
    !expectedHttp ? "OBSTACK_SMOKE_EXPECTED_OTLP_HTTP" : null,
  ].filter((v): v is string => v !== null);

  if (!appUrl || !cookie || !expectedHttp) {
    record(
      "SKIPPED",
      host,
      D277_PROBE.method,
      D277_PROBE.path,
      "-",
      `${D277_PROBE.expectation} — SKIPPED (unset ${missing.join(", ")})`,
    );
    return;
  }

  const attempt = await safeFetch(`${appUrl}${D277_PROBE.path}`, {
    headers: { cookie },
  });

  if (!attempt.response) {
    record("FAIL", host, D277_PROBE.method, D277_PROBE.path, "ERROR", `${D277_PROBE.expectation} — ${describeError(attempt.error)}`);
    return;
  }
  if (attempt.response.status !== 200) {
    record(
      "FAIL",
      host,
      D277_PROBE.method,
      D277_PROBE.path,
      String(attempt.response.status),
      `${D277_PROBE.expectation} — expected 200 (not signed in, or not plain HTML?)`,
    );
    return;
  }

  const body = await attempt.response.text();
  const hasExpectedHttp = body.includes(expectedHttp);
  const hasLoopback = body.includes("127.0.0.1") || body.includes("localhost");
  const hasGrpcLine = body.includes("OTEL_EXPORTER_OTLP_PROTOCOL=grpc");

  const failures: string[] = [];
  if (!hasExpectedHttp) failures.push(`missing the configured HTTP endpoint ${expectedHttp}`);
  if (hasLoopback) failures.push("a loopback address (127.0.0.1/localhost) is present");
  if (hasGrpcLine) failures.push("a gRPC protocol line rendered though gRPC should be unset (D336)");

  if (failures.length === 0) {
    record("ok", host, D277_PROBE.method, D277_PROBE.path, "200", D277_PROBE.expectation);
  } else {
    record("FAIL", host, D277_PROBE.method, D277_PROBE.path, "200", `${D277_PROBE.expectation} — ${failures.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const marketingUrl = process.env.OBSTACK_SMOKE_MARKETING_URL;
  const appUrl = process.env.OBSTACK_SMOKE_APP_URL;
  const ingestUrl = process.env.OBSTACK_SMOKE_INGEST_URL;
  const grpcUrl = process.env.OBSTACK_SMOKE_INGEST_GRPC_URL;
  const apiKey = process.env.OBSTACK_SMOKE_API_KEY;
  const appSessionCookie = process.env.OBSTACK_SMOKE_APP_SESSION_COOKIE;
  const expectedOtlpHttp = process.env.OBSTACK_SMOKE_EXPECTED_OTLP_HTTP;

  if (marketingUrl) {
    await probeMarketing(marketingUrl, appUrl);
  } else {
    skipHost("marketing", MARKETING_PROBES, "unset OBSTACK_SMOKE_MARKETING_URL");
  }

  if (appUrl) {
    await probeApp(appUrl);
  } else {
    skipHost("app", APP_PROBES, "unset OBSTACK_SMOKE_APP_URL");
  }

  if (ingestUrl) {
    await probeIngest(ingestUrl, apiKey);
  } else {
    skipHost("ingest", INGEST_PROBES, "unset OBSTACK_SMOKE_INGEST_URL");
  }

  await probeGrpc(grpcUrl, apiKey);

  await probeD277Rendering(appUrl, appSessionCookie, expectedOtlpHttp);

  console.log(
    `\nsmoke: ${counts.ok} ok, ${counts.fail} FAIL, ${counts.skipped} SKIPPED`,
  );
  if (counts.fail > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`smoke: unhandled error — ${describeError(error)}`);
  process.exit(1);
});
