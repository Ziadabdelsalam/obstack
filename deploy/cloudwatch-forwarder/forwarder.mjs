// The obstack CloudWatch Logs forwarder: one Lambda, no dependencies.
//
// CloudWatch subscription filters deliver to a Lambda in AWS's own envelope —
// `{ "awslogs": { "data": "<base64(gzip(JSON))>" } }` — which is a shape only
// AWS speaks. This function undoes exactly that envelope and POSTs the decoded
// JSON to obstack's /v1/integrations/cloudwatch route with the workspace's
// ingest key. It does no mapping and holds no product logic: the mapping lives
// in Go, in the obstack repo, where the tests are (D254).
//
// Deliberately dependency-free — zlib and fetch are in the Node runtime, so the
// deployable artifact is this file zipped, with nothing to audit, pin or
// update in someone else's AWS account. SAM and Terraform are refused for the
// same reason (D254): a toolchain for another team's account is scope obstack
// does not own. The README beside this file has the three `aws` CLI commands.
//
// Configuration, both required (D289 — stable names):
//   OBSTACK_INGEST_URL — the full route URL, e.g.
//                        https://ingest.example.com/v1/integrations/cloudwatch
//   OBSTACK_API_KEY    — an obstack ingest key (ok_…) for the target workspace

import { gunzipSync } from "node:zlib";

// A delivery AWS sends only to check the destination answers. It carries no log
// events; forwarding it would put an event on a workspace's usage that nobody
// sent.
const CONTROL_MESSAGE = "CONTROL_MESSAGE";

export const handler = async (event) => {
  const url = process.env.OBSTACK_INGEST_URL;
  const key = process.env.OBSTACK_API_KEY;
  if (!url || !key) {
    // Fail loudly rather than drop: a misconfigured forwarder that returned
    // success would be a silent hole in the pipeline, which is the one thing
    // this artifact must never be.
    throw new Error(
      "OBSTACK_INGEST_URL and OBSTACK_API_KEY are required; set both on the Lambda's environment",
    );
  }

  const encoded = event?.awslogs?.data;
  if (!encoded) {
    throw new Error("event carried no awslogs.data; this function is a CloudWatch Logs subscription destination");
  }

  const payload = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));

  if (payload.messageType === CONTROL_MESSAGE) {
    return { forwarded: 0, controlMessage: true };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    // Throwing is what gives the delivery AWS's own retry and, if configured,
    // its dead-letter queue. Swallowing the failure here would lose the logs
    // quietly.
    const detail = await response.text().catch(() => "");
    throw new Error(`obstack ingest answered ${response.status}: ${detail.slice(0, 200)}`);
  }

  return { forwarded: payload.logEvents?.length ?? 0 };
};
