/**
 * The account surface's client-safe half (D707, the `lib/users-types.ts`
 * idiom): `server/account.ts` is `server-only` — it holds SQL and the
 * better-auth calls — so the shapes the page hands `AccountLive` and the two
 * numbers the copy states live here, where either side of the server/client
 * boundary can import them. No imports, no mode, no store.
 */

/** D138's bound for a key name, applied to a person's display name for the same reason: a name is chrome, and chrome has a width. */
export const NAME_MAX = 100;

/**
 * better-auth 1.7.1's documented password bounds
 * (`node_modules/better-auth/dist/context/create-context.mjs`,
 * `minPasswordLength: … || 8`, `maxPasswordLength: … || 128`). `authConfig()`
 * overrides neither, and `signup/errors.ts` states the same two numbers in
 * prose; `server/account.test.ts` asserts the three agree, so copy naming a
 * bound the server does not enforce cannot ship (D129).
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * Where on the page a refusal or a notice lands (D712). A code's section is
 * DERIVED from its prefix by `app/app/account/errors.ts`, never carried in
 * the URL — `account` is the page-level fallback for the generic member.
 */
export type AccountSection = "name" | "email" | "password" | "sessions" | "account";

/** One thing the page says back after a redirect, and where it says it. */
export interface AccountFeedback {
  kind: "error" | "notice";
  section: AccountSection;
  message: string;
}

/** The signed-in person, as the page shows them — every date already formatted by the page, in UTC. */
export interface AccountView {
  name: string;
  email: string;
  /** The user row's `createdAt`, formatted as a day. */
  memberSince: string;
}

/**
 * One of the account's own sessions. NO token: the row's `token` is the
 * bearer secret the cookie carries, and `server/account.ts` never selects it
 * (D711) — a session is identified to the page by its id and nothing else.
 */
export interface SessionView {
  id: string;
  /** The session this request arrived on. It is signed out from the top bar, never from the list. */
  current: boolean;
  signedIn: string;
  expires: string;
  /** `session.ipAddress` as better-auth recorded it, or null when the row holds none. */
  ip: string | null;
  /** `describeUserAgent` over the row's user agent. */
  client: string;
}

/** An organization this account is a member of, and the role the member row holds. */
export interface MembershipView {
  orgId: string;
  orgName: string;
  role: string;
  joined: string;
}

/**
 * A user-agent string as two words a person recognises — "Chrome on macOS" —
 * or "unknown browser" when it names nothing this function knows. Substring
 * tests only, in the order the strings nest: an Edge agent also says Chrome
 * and Safari, a Chrome agent also says Safari, an Android agent also says
 * Linux, an iPhone agent also says Mac OS X. Nothing is inferred beyond the
 * family names the agent itself spells, so the label is a reading of the
 * string, not a guess about the device (D13).
 */
export function describeUserAgent(userAgent: string | null): string {
  const ua = userAgent ?? "";
  // No leading word boundary on the family names: the e2e drive's own browser
  // spells itself `HeadlessChrome/`, one word, and a `\b` there would read it
  // as Safari — the family name is specific enough on its own.
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /(?:Firefox|FxiOS)\//.test(ua)
        ? "Firefox"
        : /(?:Chrome|Chromium|CriOS)\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /\bCrOS\b/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  if (!browser && !os) return "unknown browser";
  if (!os) return browser as string;
  return `${browser ?? "browser"} on ${os}`;
}
