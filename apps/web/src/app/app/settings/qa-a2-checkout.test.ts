import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCheckout } from "@/server/billing";
import { settingsErrorMessage } from "./errors";

// run with: npm test --workspace apps/web
// DESTINATION: apps/web/src/app/app/settings/qa-a2-checkout.test.ts
//
// S3.3 QA area A2 — the `?checkout=` return path (D189 PRG) under hostile URL
// values. The page itself cannot be imported under `--conditions react-server`
// (D54(iii)), so the two halves it is made of are driven directly: the
// reconciliation the return runs, and the error vocabulary the redirect lands
// in. The URL-shape behaviours below were each driven against the running
// product first (production build, live mode, a real session cookie).
delete process.env.OBSTACK_BILLING_MODE;

const WS = "ws_qa_a2_alice";

const norows = async <Row>(): Promise<Row[]> => [] as Row[];

/** Every line the refusal paths emit, exactly as an operator's collector sees it. */
async function capture<T>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  const sink = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = sink;
  console.warn = sink;
  try {
    return { result: await body(), lines };
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

/**
 * B2-3 — S3 — a `?checkout=` value can still inject a LINE TERMINATOR into the
 * D190 refusal log, and with it a whole attacker-chosen `[billing] …` line.
 *
 * `reconcile.ts` quotes the caller-supplied id with `JSON.stringify` precisely
 * to stop this (the 962a7cb class), and that closes `\n` and `\r`. It does NOT
 * close U+2028 LINE SEPARATOR or U+2029 PARAGRAPH SEPARATOR: `JSON.stringify`
 * emits both verbatim, they are ECMAScript line terminators, and every
 * JS-implemented log viewer, JSON-lines splitter and `String.prototype.split`
 * on a line-terminator class treats them as a break.
 *
 * Driven in the running product — `GET /app/settings?checkout=<U+2028-bearing>`
 * with a real session — and the server log's bytes carry `e2 80 a8` inline:
 *
 *   [billing] checkout "chk_a<U+2028>[billing] checkout \"chk_victim\" belongs
 *   to another workspace — not reconciled<U+2028>chk_b" is unknown to the rail
 *
 * i.e. the refusal line is displaced and a second `[billing] ` line the product
 * never emitted appears beside the real D176 tripwire.
 */
test("B2-3: a hostile ?checkout= id cannot put a line terminator in the refusal log", async () => {
  const forged =
    "chk_a\u2028[billing] checkout chk_victim belongs to another workspace — not reconciled\u2029chk_b";

  const { result, lines } = await capture(() => reconcileCheckout(forged, WS, norows as never));

  assert.equal(result.applied, false, "precondition: an id the rail never issued is refused");
  assert.equal(lines.length, 1, "precondition: one refusal, one line");
  assert.doesNotMatch(
    lines[0] ?? "",
    /[\n\r\u2028\u2029]/,
    "no caller-supplied line terminator may reach a refusal line — a forged " +
      "[billing] line beside the D176 tripwire is exactly what D190 quotes ids to prevent",
  );
});

/**
 * The 962a7cb fix itself, re-attacked: `\n` and `\r` in the id stay
 * escaped, and the refusal is still one line. GREEN today — the regression
 * guard that must survive whatever closes B2-3.
 */
test("B2-A2: \\n and \\r in a checkout id stay escaped in the refusal line", async () => {
  const hostile = 'chk_x\n[billing] checkout "chk_zzz" belongs to another workspace\r';

  const { lines } = await capture(() => reconcileCheckout(hostile, WS, norows as never));

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /[\n\r]/);
  assert.match(lines[0] ?? "", /\\n/, "the newline is shown escaped, not obeyed");
});

/**
 * The PRG landing vocabulary (D189/D121): every refused return — empty, absent,
 * repeated, forged, foreign — lands on ONE fixed sentence, and no caller value
 * is ever rendered. Driven in the running product: `?checkout=`,
 * `?checkout=&checkout=<real>`, a 5000-char id, `__proto__` and a stranger's id
 * all answered `307 → /app/settings?error=checkout-unconfirmed`. GREEN.
 */
test("B2-A2: every refused return resolves to the one fixed sentence, never the caller's text", () => {
  const refusal = settingsErrorMessage("checkout-unconfirmed");
  assert.ok(refusal && refusal.includes("your plan is unchanged"));

  for (const hostile of [
    "__proto__",
    "toString",
    "constructor",
    "chk_<script>alert(1)</script>",
    "x".repeat(5000),
    "",
  ]) {
    const message = settingsErrorMessage(hostile);
    assert.ok(message, `${hostile.slice(0, 20)} still gets a sentence`);
    assert.ok(
      !message.includes(hostile.slice(0, 20)) || hostile === "",
      "the caller's text never becomes the sentence (D121)",
    );
  }

  // A repeated parameter is judged by its first member, like every other URL
  // read on this surface — an array whose head is unknown is still the generic.
  assert.equal(settingsErrorMessage(["checkout-unconfirmed", "nonsense"]), refusal);
  assert.equal(settingsErrorMessage(undefined), null);
});
