import assert from "node:assert/strict";
import test from "node:test";
import { layerOrder } from "./layers";
import { mapLayout, NODE_H, NODE_W, type MapLayout } from "./map-layout";
import type { Layer } from "./types";

// run with: npm test --workspace apps/web -- map-layout
//
// D396 fixes the map's layout as `position = f(layer, name-rank)` and nothing
// else, over the layers PRESENT in the topology (D408). These are the two
// properties that claim buys: the same services always draw the same picture
// (so a refresh does not reshuffle the map under a reader), and no two boxes
// ever land on top of each other.

const node = (service: string, layer: Layer) => ({ service, layer });

// The column geometry, read OFF the layout rather than restated from its
// constants: `api` and `agent` are the first two entries of `layerOrder`, so
// this pair is column 0 and column 1 whatever the column rule turns out to be.
const probe = mapLayout([node("p0", "api"), node("p1", "agent")]);
const X0 = probe.positions.get("p0")!.x;
const PITCH = probe.positions.get("p1")!.x - X0;

/** Which COLUMN a service landed in — the assertions below are about columns, not viewBox units. */
const columnOf = (layout: MapLayout, service: string) =>
  (layout.positions.get(service)!.x - X0) / PITCH;

/** The shape the integration fixture seeds: several layers, several services in one of them. */
const SEEDED = [
  node("topo-gateway", "api"),
  node("topo-agent", "agent"),
  node("topo-worker", "agent"),
  node("topo-cache", "infra"),
  node("topo-model", "llm"),
];

test("position is a pure function of (layer, name-rank) — input order and traffic never move a node", () => {
  const a = mapLayout(SEEDED);
  const b = mapLayout([...SEEDED].reverse());
  assert.deepEqual(Object.fromEntries(b.positions), Object.fromEntries(a.positions));
  assert.equal(b.width, a.width);
  assert.equal(b.height, a.height);
});

test("the columns are the layers PRESENT, so a two-layer workspace draws two ADJACENT columns (D408)", () => {
  assert.ok(PITCH >= NODE_W, `a column pitch has to clear a node box (got ${PITCH})`);

  // `infra` is the 5th entry of layerOrder but the 2nd layer here, so it draws
  // in column 1. Indexing by layerOrder would put it at column 4 and pay four
  // empty columns — ~970 viewBox units of dead space — for a map of two nodes.
  const layout = mapLayout([node("topo-gateway", "api"), node("topo-cache", "infra")]);
  assert.deepEqual(
    [columnOf(layout, "topo-gateway"), columnOf(layout, "topo-cache")],
    [0, 1],
    `columns must be compact (${layerOrder.join(",")} is the ORDER, not the index)`,
  );
  assert.equal(
    layout.width,
    probe.width,
    "two layers is two columns wide, whichever two layers they are",
  );
});

test("a new layer takes its layerOrder place and shifts the layers after it one column right (D408)", () => {
  const before = mapLayout([node("topo-gateway", "api"), node("topo-cache", "infra")]);
  const after = mapLayout([
    node("topo-gateway", "api"),
    node("topo-cache", "infra"),
    node("topo-search", "tool"), // tool sits between api and infra in layerOrder
  ]);
  assert.deepEqual(
    ["topo-gateway", "topo-search", "topo-cache"].map((s) => columnOf(after, s)),
    [0, 1, 2],
    "the new layer is inserted in layerOrder order, not appended after the ones already drawn",
  );
  assert.equal(columnOf(before, "topo-cache"), 1, "infra was column 1 before tool arrived");
});

test("columns follow layerOrder and rows follow the service name in codepoint order", () => {
  const { positions } = mapLayout([
    node("b-svc", "agent"),
    node("a-svc", "agent"),
    node("Z-svc", "agent"), // uppercase sorts BEFORE lowercase by codepoint
    node("edge-svc", "api"),
  ]);
  const agentColumn = ["Z-svc", "a-svc", "b-svc"].map((s) => positions.get(s)!);
  assert.deepEqual(
    agentColumn.map((p) => p.y),
    [...agentColumn].sort((p, q) => p.y - q.y).map((p) => p.y),
    "rows must ascend in codepoint order of the service name",
  );
  assert.equal(new Set(agentColumn.map((p) => p.x)).size, 1, "one layer is one column");
  assert.ok(
    positions.get("edge-svc")!.x < agentColumn[0].x,
    `api precedes agent in layerOrder (${layerOrder.join(",")}), so its column is to the left`,
  );
});

test("no two node boxes overlap, and the viewBox covers every one of them", () => {
  const { positions, width, height } = mapLayout(SEEDED);
  assert.equal(positions.size, SEEDED.length);
  const boxes = [...positions.values()];
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.y >= 0, "a box was placed outside the viewBox origin");
    assert.ok(box.x + NODE_W <= width, "a box overflows the reported width");
    assert.ok(box.y + NODE_H <= height, "a box overflows the reported height");
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [p, q] = [boxes[i], boxes[j]];
      const overlaps =
        p.x < q.x + NODE_W && q.x < p.x + NODE_W && p.y < q.y + NODE_H && q.y < p.y + NODE_H;
      assert.equal(overlaps, false, `boxes ${i} and ${j} overlap: ${JSON.stringify([p, q])}`);
    }
  }
});

test("an empty topology lays out nothing and reports no viewBox to draw", () => {
  const { positions, width, height } = mapLayout([]);
  assert.equal(positions.size, 0);
  assert.equal(width, 0);
  assert.equal(height, 0);
});
