import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { MCP_TOOL_NAMES } from "@/lib/mcp-types";
import { NOT_SERVED_YET, NOT_YET_SERVED, TOOL_DEFINITIONS, noSuch } from "./tools";

test("D649: the handler map is total over the registry, and every face is an object schema", () => {
  for (const name of MCP_TOOL_NAMES) {
    const def = TOOL_DEFINITIONS[name];
    assert.equal(def.name, name, `${name}'s definition names ${def.name}`);
    assert.equal(typeof def.handler, "function");
    assert.equal(def.inputSchema instanceof z.ZodObject, true, `${name}: the face is not an object schema`);
  }
});

test("T3 → T4 pin: fourteen tools still answer NOT_SERVED_YET at T3; T4 drives this to zero", () => {
  // The state is pinned, never implied: this assertion is REWRITTEN by T4 to
  // `assert.deepEqual(NOT_YET_SERVED, [])`, and until then it says exactly
  // which names a client would hear the sentence from.
  assert.deepEqual(
    [...NOT_YET_SERVED].sort(),
    MCP_TOOL_NAMES.filter((n) => n !== "get_trace").sort(),
  );
  assert.equal(NOT_YET_SERVED.length, 14);
  assert.match(NOT_SERVED_YET, /not served yet/);
});

test("D650: the miss sentence is the NO_SUCH_* shape, and get_trace's face refuses an empty id", () => {
  assert.equal(noSuch("trace"), "no trace with this id in your workspace");
  const face = TOOL_DEFINITIONS.get_trace.inputSchema;
  assert.equal(face.safeParse({ id: "" }).success, false);
  assert.equal(face.safeParse({}).success, false);
  assert.equal(face.safeParse({ id: "a3f8c1d92b6e407f" }).success, true);
});
