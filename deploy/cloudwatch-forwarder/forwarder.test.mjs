// The forwarder's own harness: plain node:test, no dependencies, invoking the
// real handler against the captured envelope fixture. What it proves is the
// half a Go test cannot — that the artifact deployed into someone else's AWS
// account decodes AWS's envelope and speaks obstack's route correctly.
//
// The envelope fixture is the one the ingest package's tests read, so the two
// halves of this connector cannot drift onto different payloads.

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
      () => handler(envelope(payload)),
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
