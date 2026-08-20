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

  // Present tense, about this deployment (D140): what it is, and that hosted
  // obstack is not something we run for anyone yet.
  const copy = text(tree);
  assert.match(copy, /prototype/);
  assert.match(copy, /fictional data/);
  assert.match(copy, /host obstack for anyone yet/);

  // Two pointers, both real: the demo this deployment IS, and the waitlist
  // block on the landing page.
  const links = hrefs(tree);
  assert.ok(links.includes("/app"), "the live demo");
  assert.ok(links.includes("/#waitlist"), "the cloud-preview waitlist");
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
  assert.match(copy, /host obstack for anyone yet/);

  const links = hrefs(tree);
  assert.ok(links.includes("/app"));
  assert.ok(links.includes("/#waitlist"));
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
