// The forwarder's own harness: plain node:test, no dependencies, invoking the
// real handler against the captured envelope fixture. What it proves is the
// half a Go test cannot — that the artifact deployed into someone else's AWS
// account decodes AWS's envelope and speaks obstack's route correctly.
//
// The fixtures are the ones the ingest package's tests read, so the two halves
// of this connector cannot drift onto different payloads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { handler } from "./forwarder.mjs";

const FIXTURES = new URL(
  "../../services/ingest/internal/receive/testdata/cloudwatch/",
  import.meta.url,
);

const readFixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

// The tracked envelope — base64 of gzip of data-message.json, the exact shape
// AWS delivers — so the primary case decodes bytes nobody built at test time.
const trackedEnvelope = () => readFixture("awslogs-envelope.json");

// envelope wraps any other fixture in that same shape, for the cases the
// tracked one cannot cover (a CONTROL_MESSAGE is a different payload).
const envelope = (payload) => ({
  awslogs: { data: gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64") },
});

// withEnv runs fn with the forwarder's configuration set, restoring whatever
// was there — the process is shared across tests in one file.
const withEnv = async (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
};

// stubFetch replaces global fetch and records what the handler sent.
const stubFetch = (response = { ok: true, status: 200 }) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body ?? "",
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

test("decodes the awslogs envelope and POSTs the payload with the bearer key", async () => {
  const payload = readFixture("data-message.json");
  const fetchStub = stubFetch();

  try {
    const result = await withEnv(
      {
        OBSTACK_INGEST_URL: "https://ingest.example.com/v1/integrations/cloudwatch",
        OBSTACK_API_KEY: "ok_test_forwarder",
      },
      () => handler(trackedEnvelope()),
    );

    assert.equal(result.forwarded, payload.logEvents.length);
    assert.equal(fetchStub.calls.length, 1);

    const [{ url, init }] = fetchStub.calls;
    assert.equal(url, "https://ingest.example.com/v1/integrations/cloudwatch");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer ok_test_forwarder");
    assert.equal(init.headers["content-type"], "application/json");
    // The decoded payload goes on verbatim: the mapping is ingest's, not this
    // artifact's.
    assert.deepEqual(JSON.parse(init.body), payload);
  } finally {
    fetchStub.restore();
  }
});

test("acknowledges a CONTROL_MESSAGE without forwarding it", async () => {
  const fetchStub = stubFetch();

  try {
    const result = await withEnv(
      {
        OBSTACK_INGEST_URL: "https://ingest.example.com/v1/integrations/cloudwatch",
        OBSTACK_API_KEY: "ok_test_forwarder",
      },
      () => handler(envelope(readFixture("control-message.json"))),
    );

    assert.equal(result.controlMessage, true);
    assert.equal(result.forwarded, 0);
    assert.equal(fetchStub.calls.length, 0, "a reachability probe must not become telemetry");
  } finally {
    fetchStub.restore();
  }
});

test("throws on a non-2xx answer so AWS retries rather than losing the logs", async () => {
  const fetchStub = stubFetch({ ok: false, status: 401, body: "missing or unknown API key" });

  try {
    await assert.rejects(
      withEnv(
        {
          OBSTACK_INGEST_URL: "https://ingest.example.com/v1/integrations/cloudwatch",
          OBSTACK_API_KEY: "ok_wrong",
        },
        () => handler(envelope(readFixture("data-message.json"))),
      ),
      /401/,
    );
  } finally {
    fetchStub.restore();
  }
});

test("refuses to run unconfigured rather than dropping deliveries silently", async () => {
  await assert.rejects(
    withEnv({ OBSTACK_INGEST_URL: "", OBSTACK_API_KEY: "" }, () =>
      handler(envelope(readFixture("data-message.json"))),
    ),
    /OBSTACK_INGEST_URL and OBSTACK_API_KEY are required/,
  );
});

test("refuses an event that is not a CloudWatch Logs delivery", async () => {
  await assert.rejects(
    withEnv(
      {
        OBSTACK_INGEST_URL: "https://ingest.example.com/v1/integrations/cloudwatch",
        OBSTACK_API_KEY: "ok_test_forwarder",
      },
      () => handler({ Records: [] }),
    ),
    /awslogs\.data/,
  );
});

// The half the stubs cannot prove: this handler against a REAL ingest, over the
// network, landing rows. It runs when OBSTACK_TEST_INGEST_URL and
// OBSTACK_TEST_API_KEY are set — CI sets them because the compose stack is
// already up in that job — and skips otherwise, the standing convention for
// every integration test in this repo.
//
// Without it the two halves of this connector are only ever tested apart: the
// handler against a stubbed fetch, and the route against a payload some Go test
// built. This is the one assertion that the artifact an operator deploys
// actually speaks to the endpoint they point it at.
test("forwards to a real ingest endpoint", async (t) => {
  const url = process.env.OBSTACK_TEST_INGEST_URL;
  const key = process.env.OBSTACK_TEST_API_KEY;
  if (!url || !key) {
    t.skip(
      "set OBSTACK_TEST_INGEST_URL and OBSTACK_TEST_API_KEY (start deploy/compose) to run the live forwarder leg",
    );
    return;
  }

  // The fixture's own timestamps are the vendor's 2019 ones, which ingest's
  // 90-day retention bound drops while forming the part — the instant moves so
  // the delivery is one a running deployment would actually keep, and nothing
  // else does.
  const payload = readFixture("data-message.json");
  const now = Date.now();
  payload.logEvents = payload.logEvents.map((e) => ({ ...e, timestamp: now }));

  const result = await withEnv({ OBSTACK_INGEST_URL: url, OBSTACK_API_KEY: key }, () =>
    handler(envelope(payload)),
  );

  assert.equal(result.forwarded, payload.logEvents.length);
});
