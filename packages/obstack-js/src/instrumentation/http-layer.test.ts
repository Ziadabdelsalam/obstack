import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { captureSpans } from "../testing/harness";

/**
 * The api layer of the four-layer trace, guarded.
 *
 * `init()` registers `@opentelemetry/instrumentation-http` as a hard dependency
 * for exactly one reason (D77(c)): a plain `node:http` server span carries
 * `http.request.method`, and that attribute — nothing else — is what makes
 * ingest classify the span as `api`. This file exists because that claim used
 * to be propped up by an `OTEL_SEMCONV_STABILITY_OPT_IN=http` default in
 * `init()` which, measured, this instrumentation never reads (D91). Deleting a
 * line on the strength of one manual measurement is how the measurement gets
 * lost; asserting it is how it stays true.
 *
 * The instrumentation is driven directly rather than through `init()` because
 * `init()` needs a live OTLP endpoint; that it is registered at all is covered
 * end to end by the SDK evidence run.
 */
const spans = captureSpans();
const instrumentation = new HttpInstrumentation();
instrumentation.enable();

const STABLE_METHOD = "http.request.method";
const LEGACY_METHOD = "http.method";

let server: Server;
let port: number;

before(async () => {
  // No OTEL_SEMCONV_STABILITY_OPT_IN anywhere in this process, on purpose.
  assert.equal(
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN,
    undefined,
    "the opt-in leaked in from the environment; this file has to run without it or it proves nothing",
  );

  // Required AFTER enable(), never imported at the top of the file: the hook
  // fires on require, so a `node:http` already loaded and destructured hands
  // back the unpatched functions and this suite would silently measure nothing.
  // That is the same ordering the README asks applications for.
  const http = require("node:http") as typeof import("node:http");

  server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  await new Promise<void>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/answer`, (response) => {
      response.resume();
      response.on("end", () => setTimeout(resolve, 50));
    }).on("error", reject);
  });
});

after(async () => {
  instrumentation.disable();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await spans.shutdown();
});

const serverSpan = (): ReadableSpan => {
  const found = spans.finishedSpans().filter((span) => span.kind === SpanKind.SERVER);
  assert.equal(
    found.length,
    1,
    `expected one server span, saw ${found.length} (${spans.finishedSpans().map((s) => s.name).join(", ") || "none"})`,
  );
  return found[0]!;
};

test("a plain node:http server span carries the attribute ingest classifies api on", () => {
  const span = serverSpan();
  assert.equal(
    span.attributes[STABLE_METHOD],
    "GET",
    `no ${STABLE_METHOD} on the server span; ingest would classify it 'other' and the trace would render with three layers instead of four`,
  );
});

test("the stable attribute is emitted without any semconv opt-in", () => {
  // The whole of D91 in one assertion: this instrumentation is past the
  // stability transition at the pinned range, so the legacy spelling is gone
  // and no environment variable is needed to get the stable one.
  const span = serverSpan();
  assert.equal(
    span.attributes[LEGACY_METHOD],
    undefined,
    `the server span still carries the legacy ${LEGACY_METHOD}; the pinned instrumentation moved back to the old convention and init() may now genuinely need the opt-in it no longer sets`,
  );
});
