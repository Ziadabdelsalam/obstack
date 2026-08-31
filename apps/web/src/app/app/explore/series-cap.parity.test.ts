import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SERIES_CAP } from "./series-cap";

// run with: npm test --workspace apps/web
//
// D385 (S6.1 T7 round 2): SERIES_CAP is a genuinely cross-language literal —
// services/ingest/internal/write/write.go's DefaultSeriesCap is ingest's own
// ENFORCEMENT of the D363 §2 cardinality cap; series-cap.ts's copy exists only
// so explore's banner can state the same number without importing Go
// (server-cap.ts's own header comment). Nothing makes the two agree by
// construction — exactly the failure class `layer_contract_test.go` exists to
// catch for mapping.go's `Layer*` constants vs apps/web/src/lib/types.ts's
// `Layer` union (PR #3). This is that same shape, mirrored from the TS side:
// read the Go source's real declaration, parse it, compare it against the
// value this file actually exports — never restate the Go number as a SECOND
// TS constant to check against, which would be a third place to update.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITE_GO = path.join(
  HERE,
  "../../../../../../services/ingest/internal/write/write.go",
);

test("D385: SERIES_CAP is the same number as write.go's DefaultSeriesCap, parsed from its real source", () => {
  const source = readFileSync(WRITE_GO, "utf8");
  const match = source.match(/const DefaultSeriesCap = ([\d_]+)/);
  assert.ok(
    match,
    "write.go's DefaultSeriesCap constant moved or was renamed — update this test's regex, do not restate the number",
  );
  const goValue = Number(match![1].replaceAll("_", ""));
  assert.equal(
    SERIES_CAP,
    goValue,
    "series-cap.ts's SERIES_CAP has drifted from write.go's DefaultSeriesCap — the two languages must agree on the D363 §2 cap",
  );
});
