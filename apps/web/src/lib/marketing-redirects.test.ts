import assert from "node:assert/strict";
import test from "node:test";
import { marketingRedirects } from "./marketing-redirects";

// run with: npm test --workspace apps/web
//
// D354 (C-1 low finding): the redirects that send a stranger away from the
// marketing image's dead-end `/signup`,`/login` to the real app only make
// sense on a MOCK build with an origin configured — extracted out of
// `next.config.ts` so this can be asserted directly, without going through
// `next build`'s config loader.

function reset(): void {
  delete process.env.OBSTACK_DATA_MODE;
  delete process.env.OBSTACK_APP_ORIGIN;
}

test("mock + origin: four redirects, to the configured origin", () => {
  reset();
  process.env.OBSTACK_DATA_MODE = "mock";
  process.env.OBSTACK_APP_ORIGIN = "https://app.example.test";
  assert.deepEqual(marketingRedirects(), [
    { source: "/signup", destination: "https://app.example.test/signup", permanent: false },
    { source: "/signup/:path*", destination: "https://app.example.test/signup/:path*", permanent: false },
    { source: "/login", destination: "https://app.example.test/login", permanent: false },
    { source: "/login/:path*", destination: "https://app.example.test/login/:path*", permanent: false },
  ]);
  reset();
});

test("live + origin: no redirects — the live image's /signup and /login are the real forms, not a dead end", () => {
  reset();
  process.env.OBSTACK_DATA_MODE = "live";
  process.env.OBSTACK_APP_ORIGIN = "https://app.example.test";
  assert.deepEqual(marketingRedirects(), []);
  reset();
});

test("mock + unset origin: no redirects — the single-host default", () => {
  reset();
  process.env.OBSTACK_DATA_MODE = "mock";
  assert.deepEqual(marketingRedirects(), []);
  reset();
});

test("a trailing slash on the origin is not baked into the destination", () => {
  reset();
  process.env.OBSTACK_DATA_MODE = "mock";
  process.env.OBSTACK_APP_ORIGIN = "https://app.example.test/";
  const [first] = marketingRedirects();
  assert.equal(first.destination, "https://app.example.test/signup");
  reset();
});
