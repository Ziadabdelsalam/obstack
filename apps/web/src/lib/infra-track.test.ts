import assert from "node:assert/strict";
import test from "node:test";
import { infraTrackHeading } from "./infra-track";
import { oomTrace, pipelineTrace } from "@/mock/stories";
import type { K8sEvent } from "@/lib/types";

// run with: npm test --workspace apps/web
//
// F2 — the waterfall's infra heading named cluster events on every trace ever
// rendered, including the pipeline trace the landing page ships as a
// screenshot, which carries none. Both branches, executed.

const event = (pod: string): K8sEvent => ({
  id: `ev-${pod}`,
  atMs: 0,
  pod,
  kind: "oom_kill",
  severity: "fatal",
  label: "OOMKilled: container exceeded memory limit",
});

test("no track holds an event: the heading names only what is on the timeline", () => {
  assert.equal(infraTrackHeading([{ events: [] }, { events: [] }]), "infra · pods");
});

test("one track holds an event: the heading earns the second half", () => {
  assert.equal(
    infraTrackHeading([{ events: [] }, { events: [event("agent-worker-7d9fb-kx2rq")] }]),
    "infra · pods & k8s events",
  );
});

test("no tracks at all is still the short heading, never the claim", () => {
  // `Waterfall` only renders the track when there is at least one pod, so this
  // is unreachable there — asserted anyway because `.some()` on an empty array
  // is the one input where a mis-typed predicate would flip the default to the
  // claim rather than away from it.
  assert.equal(infraTrackHeading([]), "infra · pods");
});

test("the two branches correspond to real stories, not just to test fixtures", () => {
  // The falsification the unit cases cannot give: if every story in the corpus
  // carried events, the short heading would be dead code and this repair would
  // change no pixel. The pipeline trace — the one the landing's screenshot
  // shows — carries none, and the OOM story carries some.
  assert.equal(pipelineTrace.k8sEvents?.length ?? 0, 0, "the pipeline trace grew events — re-shoot the screenshot");
  assert.ok((oomTrace.k8sEvents?.length ?? 0) > 0, "no story carries an event — the long heading is unreachable");

  const tracksFor = (trace: typeof oomTrace) => {
    const byPod = new Map<string, K8sEvent[]>();
    for (const s of trace.spans) if (s.pod && !byPod.has(s.pod)) byPod.set(s.pod, []);
    for (const e of trace.k8sEvents ?? []) byPod.set(e.pod, [...(byPod.get(e.pod) ?? []), e]);
    return [...byPod.values()].map((events) => ({ events }));
  };
  assert.equal(infraTrackHeading(tracksFor(pipelineTrace)), "infra · pods");
  assert.equal(infraTrackHeading(tracksFor(oomTrace)), "infra · pods & k8s events");
});
