import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { API_KEY_PLACEHOLDER, categories, connectors } from "./connectors";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const moduleSource = readFileSync(path.join(import.meta.dirname, "connectors.ts"), "utf8");
const composeFile = readFileSync(
  path.join(repoRoot, "deploy/compose/docker-compose.yml"),
  "utf8",
);

const stepText = (): string[] =>
  connectors.flatMap((c) => (c.connectSteps ?? []).flatMap((s) => [s.body ?? "", s.snippet ?? ""]));

// The T4 done-check, asserted rather than reviewed (S2.0 L1): the fabricated
// key and the three endpoints that never existed (a chart repo, a published
// collector image, a CloudFormation host) must not come back.
test("no fabricated key or endpoint anywhere in the definition", () => {
  for (const lie of ["ok_live_9f2e", "charts.obstack.dev", "obstack/collector:latest", "cf.obstack.dev"]) {
    assert.equal(moduleSource.includes(lie), false, `${lie} is back in the connector definition`);
  }
});

// "Every step command names an artifact that exists in-repo or in compose"
// (T4 done-check). Anything spelled like a repo path is resolved on disk —
// delete or rename `deploy/collector/up.sh` and this goes red.
test("every in-repo path a step names exists on disk", () => {
  const paths = new Set(
    stepText().flatMap((t) => t.match(/deploy\/[A-Za-z0-9._/-]+[A-Za-z0-9]/g) ?? []),
  );
  assert.ok(paths.size >= 4, "expected the steps to name the real artifacts");
  for (const p of paths) {
    assert.ok(existsSync(path.join(repoRoot, p)), `${p} named by a connect step does not exist`);
  }
});

// The compose OTLP endpoints and the pinned collector image are facts of
// docker-compose.yml, not copy: assert against the file itself.
test("OTLP endpoints and the collector image match compose", () => {
  const text = stepText().join("\n");
  for (const port of ["4317", "4318"]) {
    assert.ok(text.includes(`127.0.0.1:${port}`), `the OTLP steps must name 127.0.0.1:${port}`);
    assert.ok(composeFile.includes(`"127.0.0.1:${port}:${port}"`), `compose no longer publishes ${port}`);
  }
  const image = "otel/opentelemetry-collector-k8s:0.158.0";
  assert.ok(text.includes(image), "the collector steps must name the pinned image");
  assert.ok(composeFile.includes(`image: ${image}`), "compose no longer pins that image");
});

// The Helm step's `--set` has to name a value the chart actually declares.
test("the helm step sets a value the chart declares", () => {
  const values = readFileSync(path.join(repoRoot, "deploy/helm/obstack/values.yaml"), "utf8");
  const text = stepText().join("\n");
  assert.ok(text.includes(`--set collector.apiKey=${API_KEY_PLACEHOLDER}`));
  assert.match(values, /^collector:$/m);
  assert.match(values, /^ {2}apiKey:/m);
});

// D210: the definition carries the placeholder, never a token — every step
// with a key slot uses the exported literal so the surfaces interpolate
// against one string.
test("every key slot is the exported placeholder", () => {
  assert.equal(API_KEY_PLACEHOLDER, "<OBSTACK_API_KEY>");
  const snippets = connectors.flatMap((c) =>
    (c.connectSteps ?? []).map((s) => s.snippet ?? "").filter((s) => /API_KEY|apiKey|Bearer/.test(s)),
  );
  assert.equal(snippets.length, 5);
  for (const s of snippets) {
    assert.ok(s.includes(API_KEY_PLACEHOLDER), `a key slot without the placeholder: ${s}`);
  }
  // The OTel env var carries it URL-encoded — a raw space drops the header (D78).
  assert.ok(stepText().some((t) => t.includes(`Authorization=Bearer%20${API_KEY_PLACEHOLDER}`)));
});

// D101/D208: no receiving component exists for either, in EITHER mode.
test("vercel and aws-cloudwatch are coming-soon with no connect flow", () => {
  for (const slug of ["vercel", "aws-cloudwatch"]) {
    const c = connectors.find((x) => x.slug === slug);
    assert.ok(c, `${slug} card missing`);
    assert.equal(c.status, "coming-soon");
    assert.equal(c.connectSteps, undefined);
  }
  assert.deepEqual(
    connectors.filter((c) => c.status === "available").map((c) => c.slug),
    ["otlp", "kubernetes", "docker"],
  );
});

test("every card's category is a rendered category", () => {
  for (const c of connectors) assert.ok(categories.includes(c.category), `${c.slug}: ${c.category}`);
});
