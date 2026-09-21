import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// D150's property, for every auth surface — they get one treatment, so they
// get one test: in mock mode /signup and /login render no form, their actions
// and the invite-accept action refuse without reaching the auth stack, and none
// of it costs an auth secret or a database. The prototype deployment has
// neither, which is exactly how a form there could only ever fail. D152 makes
// this standing: every future auth-surface server action joins this guard and
// this test at creation.
//
// Importing the page modules is normally impossible under this runner
// (`--conditions react-server` gives React no `createContext`, and next/link
// calls it at module scope — apps/web/package.json's `//test` note). One
// missing function is the whole obstacle, so this file supplies it and then
// imports the real pages: the elements the tests walk are the ones the server
// returns. Nothing below renders a component — a React element is a plain
// object, and `<Link>` inside one is never called.
delete process.env.OBSTACK_DATA_MODE;
delete process.env.BETTER_AUTH_SECRET;
delete process.env.OBSTACK_POSTGRES_DSN;
delete process.env.CLICKHOUSE_URL;
// D340: this file asserts the UNSET arm of `appHost()` — the single-host
// default every deployment before S5 runs, and the `web` service's own build,
// which has no reason to name its own host in its dead-end auth pages.
delete process.env.OBSTACK_APP_ORIGIN;

// D156: this mutation is safe because `node --test` isolates per file —
// every test file is its own child process, so the shimmed React dies with it.
// `--experimental-test-isolation=none` makes it a real leak (one process, every
// suite inheriting a fake `createContext`) — do not adopt that flag without
// moving this shim.
const react = createRequire(import.meta.url)("react");
react.createContext ??= () => ({});

type Element = { type?: unknown; props?: Record<string, unknown> };

/** Every element and string in a returned tree, depth-first. */
function flatten(node: unknown, out: (Element | string)[] = []): (Element | string)[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const child of node) flatten(child, out);
  else if (node && typeof node === "object") {
    const el = node as Element;
    out.push(el);
    flatten(el.props?.children, out);
  }
  return out;
}

const tags = (tree: unknown) =>
  flatten(tree).filter((n): n is Element => typeof n === "object" && typeof n.type === "string")
    .map((n) => n.type as string);

const text = (tree: unknown) => flatten(tree).filter((n) => typeof n === "string").join(" ");

const hrefs = (tree: unknown) =>
  flatten(tree)
    .filter((n): n is Element => typeof n === "object")
    .map((n) => n.props?.href)
    .filter((h): h is string => typeof h === "string");

test("this process really has no auth secret and no Postgres", async () => {
  // The falsification probe (S2.2 L1): every claim below is about rendering
  // WITHOUT them, so both must be genuinely unreachable here — otherwise
  // "mock mode never touches the auth stack" would prove nothing. This is also
  // what makes the D150 property red-provable: put a `getAuth()` call back on
  // the mock path of either page or either action and these refusals are what
  // the tests would hit instead of a rendered notice.
  const { authConfig } = await import("@/server/auth");
  assert.throws(authConfig, /BETTER_AUTH_SECRET is required/);
  const { getPool } = await import("@/server/postgres");
  assert.throws(getPool, /OBSTACK_POSTGRES_DSN is required/);

  const { dataMode } = await import("@/server/data");
  assert.equal(dataMode, "mock", "the one mode predicate both pages read");
});

test("/signup renders the honest no-form state in mock mode (D150)", async () => {
  const page = await import("@/app/signup/page");
  // searchParams is still the live signature; the mock branch never reads it.
  const tree = await page.default({ searchParams: Promise.resolve({}) });

  const rendered = tags(tree);
  assert.ok(!rendered.includes("form"), "mock mode offers no form");
  assert.ok(!rendered.includes("input"), "and nothing to type a password into");
  assert.ok(!rendered.includes("button"), "and nothing to submit");

  // Present tense, about this deployment (D140): what it is, and — with no
  // OBSTACK_APP_ORIGIN configured (D340's unset arm) — that signing up here
  // is real on an obstack the reader runs themselves.
  const copy = text(tree);
  assert.match(copy, /prototype/);
  assert.match(copy, /fictional data/);
  assert.match(copy, /an obstack you run yourself/);

  // Two pointers, both real and both served by THIS build (D327): the demo
  // this deployment IS, and the quickstart in the docs corpus D255 added.
  //
  // The second used to be `/#waitlist`, an anchor into a landing-page block
  // that offered a hosted obstack nobody runs and, on this deployment, had no
  // Blob token to write an address with either. D257 removed the block; this
  // assertion is why the removal could not quietly leave two dead links behind
  // (D156 — this file is the shim of record, so the pointers are asserted here
  // rather than anywhere new). The absence is asserted too: a link that leads
  // to a fragment no page defines is a door to nowhere, and "the new links are
  // present" would stay green beside it.
  const links = hrefs(tree);
  assert.ok(links.includes("/app"), "the demo this deployment is");
  assert.ok(links.includes("/docs/quickstart"), "the quickstart this build serves");
  assert.ok(!links.includes("/#waitlist"), "the removed cloud-preview anchor is still linked");

  // And what the first pointer is CALLED, which only this branch may say. `/`,
  // `/docs`, `/status` and `/changelog` ship the same bytes to both images and
  // therefore call `/app` the app; this tree renders in the mock image alone,
  // where `/app` really is the demo. Asserted on the returned tree because that
  // is the artifact — `app/landing-fence.test.ts` (g) holds the other half, that
  // the words never appear outside this branch in the source.
  assert.match(copy, /Open the demo/, "the label the mock image is the one image that can honestly show");
});

test("/login renders the same honest no-form state in mock mode (D150)", async () => {
  const page = await import("@/app/login/page");
  const tree = await page.default({ searchParams: Promise.resolve({}) });

  const rendered = tags(tree);
  assert.ok(!rendered.includes("form"), "mock mode offers no form");
  assert.ok(!rendered.includes("input"));
  assert.ok(!rendered.includes("button"));

  const copy = text(tree);
  assert.match(copy, /nothing here to sign in to/);
  assert.match(copy, /an obstack you run yourself/);

  const links = hrefs(tree);
  assert.ok(links.includes("/app"));
  assert.ok(links.includes("/docs/quickstart"));
  assert.ok(!links.includes("/#waitlist"), "the removed cloud-preview anchor is still linked");
  assert.match(copy, /Open the demo/, "the same label, warranted by the same gate");
});

test("/app/account renders the honest no-account state in mock mode (D150/D707)", async () => {
  // The eighth surface, and the first INSIDE the shell: the account page has
  // nothing to show in a deployment that keeps no accounts, so its mock branch
  // returns before `connection()`, before `searchParams` and before any auth
  // import's first use — the settings page's D125 ordering.
  const page = await import("@/app/app/account/page");
  const tree = await page.default({ searchParams: Promise.resolve({}) });

  const rendered = tags(tree);
  assert.ok(!rendered.includes("form"), "mock mode offers no form");
  assert.ok(!rendered.includes("input"), "and nothing to type a password into");
  assert.ok(!rendered.includes("button"), "and nothing to submit");

  const copy = text(tree);
  assert.match(copy, /prototype/);
  assert.match(copy, /keeps no accounts/);
  assert.match(copy, /an obstack you run yourself/);

  // Two pointers, both real and both in this build (D327): the overview this
  // demo IS, and the docs page about accounts on the in-app mount.
  const links = hrefs(tree);
  assert.ok(links.includes("/app"), "the overview this deployment is");
  assert.ok(links.includes("/app/docs/accounts-and-access"), "the accounts page of the docs corpus this build serves");
});

test("every account action trips the same way in mock mode (D152/D707)", async () => {
  // Five functions sharing ONE gate (`accountSession`), asserted per action
  // rather than on the helper — the settings list's shape, for its reason: a
  // future action that forgets the gate leaves this list unchanged and green.
  //
  // Same proof: the redirect target is a bare `/app/account`. Take the mode
  // check out and the post reaches `readAccount`, which builds the auth
  // instance on the missing secret and throws something that is not a redirect
  // at all. Empty FormData throughout — the guard runs before any field is
  // read, so nothing below it can be what answered.
  const actions = await import("@/app/app/account/actions");
  const cases: [string, (form: FormData) => Promise<unknown>][] = [
    ["update name", actions.updateName],
    ["update email", actions.updateEmail],
    ["change password", actions.updatePassword],
    ["sign out a session", actions.revokeSession],
    ["sign out other sessions", actions.revokeOtherSessions],
  ];

  for (const [where, action] of cases) {
    const logged: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    let signal: { digest?: unknown } | undefined;
    try {
      await action(new FormData());
    } catch (error) {
      signal = error as { digest?: unknown };
    } finally {
      console.error = real;
    }

    const digest = String(signal?.digest);
    assert.equal(digest.split(";")[0], "NEXT_REDIRECT", `${where}: refused by sending back`);
    assert.ok(digest.includes(";/app/account;"), `${where}: to the account page itself, with no code appended`);
    assert.match(logged[0] ?? "", new RegExp(`\\[account\\] ${where} posted in mock mode`));
  }
});

test("both actions trip rather than reach the auth stack in mock mode", async () => {
  // No form means no legitimate post, so these branches are tripwires: they
  // announce themselves and return. Without them the actions would build the
  // auth instance, fail on the missing secret, and end in a `redirect` — which
  // throws — so "returns undefined" IS the property. The log is captured
  // rather than printed, and asserted: a silent tripwire is not one.
  const { signUp } = await import("@/app/signup/actions");
  const { logIn } = await import("@/app/login/actions");

  const signupForm = new FormData();
  signupForm.set("name", "Ada");
  signupForm.set("email", "ada@example.com");
  signupForm.set("password", "correct horse battery");
  const loginForm = new FormData();
  loginForm.set("email", "ada@example.com");
  loginForm.set("password", "correct horse battery");

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    assert.equal(await signUp(signupForm), undefined);
    assert.equal(await logIn(loginForm), undefined);
  } finally {
    console.error = real;
  }

  assert.match(logged[0] ?? "", /\[signup\] posted in mock mode/);
  assert.match(logged[1] ?? "", /\[login\] posted in mock mode/);
});

test("the invite-accept action trips the same way in mock mode (D152)", async () => {
  // The third auth surface, and the one that cannot exit by returning: this
  // action sends the caller back to `/invite/<id>`, which already renders its
  // own honest state — and `redirect` is control flow that THROWS, so the
  // refusal has to be read off the signal rather than off a return value.
  //
  // What makes it a proof: the target carries NO `?error=`. Take the guard out
  // and the throw still arrives, but from `acceptInvite` failing on the missing
  // secret — caught, coded, and redirected to `?error=invite-failed`. The bare
  // path is the evidence that nothing auth-shaped ran.
  const { acceptInvitation } = await import("@/app/invite/[id]/actions");

  // Alphanumeric: `parseInvitationId`'s alphabet (`invites.ts:58`) refuses an
  // underscore, and an id that fails the parse exits at `notFound()` above the
  // guard — proving nothing about it.
  const form = new FormData();
  form.set("invitationId", "invmockmode");

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let signal: { digest?: unknown } | undefined;
  try {
    await acceptInvitation(form);
  } catch (error) {
    signal = error as { digest?: unknown };
  } finally {
    console.error = real;
  }

  assert.equal(String(signal?.digest).split(";")[0], "NEXT_REDIRECT", "refused by sending back");
  assert.ok(
    String(signal?.digest).includes(";/invite/invmockmode;"),
    "to the invite page itself, with no error code appended",
  );
  assert.match(logged[0] ?? "", /\[invite\] accept posted in mock mode/);
});

test("the quickstart's issue-key action trips the same way in mock mode (D152)", async () => {
  // The fifth surface: the onboarding page issues its own key (D201), so it is
  // an auth-surface action and joins this list at creation — the whole of D152.
  //
  // Same proof shape as the ones above: the redirect target is a bare
  // `/app/onboarding`. Take the mode check out and the post reaches
  // `getSessionContext`, which builds the auth instance on a missing secret and
  // throws something that is not a redirect at all. An EMPTY FormData is
  // deliberate — the guard runs before the key name is read, so nothing below it
  // can be what answered.
  const { issueQuickstartKey } = await import("@/app/app/onboarding/actions");

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let signal: { digest?: unknown } | undefined;
  try {
    await issueQuickstartKey(new FormData());
  } catch (error) {
    signal = error as { digest?: unknown };
  } finally {
    console.error = real;
  }

  const digest = String(signal?.digest);
  assert.equal(digest.split(";")[0], "NEXT_REDIRECT", "refused by sending back");
  assert.ok(
    digest.includes(";/app/onboarding;"),
    "to the onboarding page itself, with no error code appended",
  );
  assert.match(logged[0] ?? "", /\[onboarding\] issue key posted in mock mode/);
});

test("the Explain route 404s rather than running in mock mode (D152)", async () => {
  // The sixth surface, and the first that is a ROUTE rather than an action, so
  // the refusal it owes is a status code: mock mode has no workspace to meter,
  // no Postgres to meter in, and its Explain panel renders prepared stories
  // (D230) — a POST here came from somewhere no visitor can be. Take the mode
  // check out and the request reaches `getSessionContext`, which builds the
  // auth instance on the missing secret and throws; a clean 404 is the evidence
  // that neither the auth stack nor the pool was touched. `params` is a promise
  // that is never awaited, because the guard returns above it.
  const route = await import("@/app/app/traces/[id]/explain/route");

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let response: Response;
  try {
    response = await route.POST(new Request("https://obstack.dev/app/traces/t1/explain", { method: "POST" }), {
      params: Promise.resolve({ id: "t1" }),
    });
  } finally {
    console.error = real;
  }

  assert.equal(response.status, 404, "this route does not exist in this deployment");
  assert.equal(await response.text(), "", "and nothing to read from the refusal");
  assert.match(logged[0] ?? "", /\[explain\] run posted in mock mode/);
});

test("the incident RCA route 404s rather than running in mock mode (D152/D556)", async () => {
  // The seventh surface and the second route (S7.4): the Explain rail's second
  // subject, on the same counter, so it owes the same refusal for the same
  // reasons — no workspace to meter, no Postgres to meter in, and RCA-shaped
  // content in this deployment exists only inside the sha-pinned `/app/incidents`
  // body, where `IncidentRca` types out a fixture. Take the mode check out and
  // the request reaches `getSessionContext`, which builds the auth instance on
  // the missing secret and throws; a clean 404 is the evidence that neither the
  // auth stack nor the pool nor the stitch was touched. `params` is a promise
  // that is never awaited, because the guard returns above it.
  const route = await import("@/app/app/incidents/[id]/rca/route");

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let response: Response;
  try {
    response = await route.POST(new Request("https://obstack.dev/app/incidents/inc_1/rca", { method: "POST" }), {
      params: Promise.resolve({ id: "inc_1" }),
    });
  } finally {
    console.error = real;
  }

  assert.equal(response.status, 404, "this route does not exist in this deployment");
  assert.equal(await response.text(), "", "and nothing to read from the refusal");
  assert.match(logged[0] ?? "", /\[rca\] run posted in mock mode/);
});

test("every settings action trips the same way in mock mode (D152)", async () => {
  // The fourth surface, and the widest: six functions sharing ONE gate
  // (`settingsSession`), so the property is asserted per action rather than on
  // the helper — a future action that forgets to open with it would leave this
  // list unchanged and green, which is exactly what D152 forbids.
  //
  // Same proof shape as the invite accept above: the redirect target carries NO
  // `?error=`. Take the mode check out and the post reaches `getSessionContext`,
  // which builds the auth instance on a missing secret — caught, coded, and
  // redirected to `?error=settings-failed`. A bare `/app/settings` is the
  // evidence that neither the auth stack nor Postgres was touched. Every action
  // is called with an EMPTY FormData on purpose: the guard runs before any field
  // is read, so nothing below it can be what answered.
  const actions = await import("@/app/app/settings/actions");
  const billing = await import("@/app/app/settings/billing-actions");
  const cases: [string, (form: FormData) => Promise<unknown>][] = [
    ["issue key", actions.issueKey],
    ["revoke key", actions.revokeKey],
    ["invite teammate", actions.inviteTeammate],
    ["cancel invitation", actions.cancelInvitation],
    // The plan change lives in its own module — a `"use server"` file may
    // export nothing but server actions, so it carries its own copy of the gate
    // — and joins this list rather than getting a test of its own, because the
    // property is one property (D152). Its guard would also be the difference
    // between refusing and reaching Polar with no workspace behind it.
    ["start checkout", billing.startCheckout],
    // The Data & ingest tab's two. Its READ is not here because it is not an
    // action at all — the page reads those rows (D182) — and the writes carry
    // the same gate as everything above: without it, a post in mock mode would
    // reach `getSessionContext` and then the pool, the two things this
    // deployment does not have.
    ["save price override", actions.saveOverride],
    ["remove price override", actions.deleteOverride],
  ];

  for (const [where, action] of cases) {
    const logged: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    let signal: { digest?: unknown } | undefined;
    try {
      await action(new FormData());
    } catch (error) {
      signal = error as { digest?: unknown };
    } finally {
      console.error = real;
    }

    const digest = String(signal?.digest);
    assert.equal(digest.split(";")[0], "NEXT_REDIRECT", `${where}: refused by sending back`);
    assert.ok(
      digest.includes(";/app/settings;"),
      `${where}: to the settings page itself, with no error code appended`,
    );
    assert.match(logged[0] ?? "", new RegExp(`\\[settings\\] ${where} posted in mock mode`));
  }
});
