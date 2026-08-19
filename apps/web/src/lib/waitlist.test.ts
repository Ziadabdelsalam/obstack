import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWaitlistEmail, WAITLIST_EMAIL_MAX_LENGTH } from "./waitlist";

// run with: node --conditions=react-server --test src/lib/waitlist.test.ts
//
// The waitlist's input contract. The blob pathname is derived from this
// function's output, so these tests are really about record identity: two
// inputs this maps to the same string are one waitlist entry, and an input it
// refuses never reaches the store at all.

test("a plain address passes through lowercased and trimmed", () => {
  assert.equal(normalizeWaitlistEmail("  Dev@Example.COM "), "dev@example.com");
});

test("case and whitespace variants collapse to one stored identity", () => {
  const canonical = normalizeWaitlistEmail("dev@example.com");
  assert.equal(normalizeWaitlistEmail("DEV@EXAMPLE.COM"), canonical);
  assert.equal(normalizeWaitlistEmail("\tdev@example.com\n"), canonical);
});

test("shapes that could never receive an invite are refused", () => {
  for (const raw of [
    "",
    "   ",
    "not-an-email",
    "no-at-sign.example.com",
    "spaces in@example.com",
    "dev@example", // no dot in the domain
    "dev@.com@twice", // '@' in what would be the domain
    "@example.com", // empty local part
  ]) {
    assert.equal(normalizeWaitlistEmail(raw), null, JSON.stringify(raw));
  }
});

test("the length cap is enforced after trimming", () => {
  const local = "a".repeat(WAITLIST_EMAIL_MAX_LENGTH - "@example.com".length);
  const atCap = `${local}@example.com`;
  assert.equal(atCap.length, WAITLIST_EMAIL_MAX_LENGTH);
  assert.equal(normalizeWaitlistEmail(atCap), atCap);
  assert.equal(normalizeWaitlistEmail(`a${atCap}`), null);
  // Padding beyond the cap is trimmed away before the length is judged.
  assert.equal(normalizeWaitlistEmail(`   ${atCap}   `), atCap);
});
