/** Workspace-level mock data: members, API keys, billing/usage, ingest health. */

export interface Member {
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  joined: string;
  pending?: boolean;
}

export const members: Member[] = [
  { name: "Salma Nabil", email: "salma@loopwork.ai", role: "owner", joined: "May 2026" },
  { name: "Nour El-Sayed", email: "nour@loopwork.ai", role: "admin", joined: "May 2026" },
  { name: "Omar Farouk", email: "omar@loopwork.ai", role: "member", joined: "Jul 2026" },
  { name: "dina@loopwork.ai", email: "dina@loopwork.ai", role: "member", joined: "—", pending: true },
];

export interface ApiKey {
  name: string;
  masked: string;
  created: string;
}

/**
 * Format-true against the one real key class (D144): `ok_live_` + hex (D139),
 * masked to the twelve characters the product actually stores — a key's tail is
 * never held anywhere, so a mock that showed one would advertise a lookup the
 * real settings surface cannot perform. There is exactly one class of key, so
 * the read-only row that used to sit here is gone rather than restyled.
 *
 * The fields are the real row's fields (D159): no `lastUsed`, because keys hold
 * no liveness column (D138 refused one — S3.3's health rows own that question),
 * and no `scope`, because one class of key means there is no scope to pick.
 */
export const apiKeys: ApiKey[] = [
  { name: "production ingest", masked: "ok_live_9f2e…", created: "May 12, 2026" },
];

export const usage = {
  plan: "Free",
  events: { used: 38214, quota: 50000 },
  explainRuns: { used: 4, quota: 20 },
  seats: { used: 3, quota: 2, note: "1 over — pending invites don't count until accepted" },
  retentionDays: 7,
  resetsOn: "Sep 1, 2026",
};

/**
 * The demo's ingest health, and the one rule its rows obey (S4.4 R3 must-fix 2).
 *
 * `droppedBySource` used to attribute 12 drops to a "Vercel log drain". Nothing
 * in this deployment has a Vercel log drain: the catalog lists Vercel as
 * `coming-soon` (`components/connections/connectors`) and the demo's own
 * connected sources stopped claiming it when R2 must-fix 2 rewired that row to
 * Docker. So the settings Ingest tab was still reporting traffic — and errors —
 * from a source the connections wall says does not exist, which is the same
 * false CAPABILITY claim D208 refuses, just one tab further from anywhere a
 * prerender sweep can read (`SettingsSuite.tsx` renders these rows on a client
 * tab).
 *
 * THE RULE, pinned in `mock/connectors.test.ts` so it cannot rot again: every
 * `source` here is the `name` of a source `mock/connectors.ts` shows as
 * CONNECTED, and the counts add up to `droppedLast24h`. The reasons stay
 * plausible for the source that carries them — a Docker collector forwarding a
 * container's stdout meets lines that are not JSON; an OTLP SDK sends oversized
 * span attributes — and the Docker row's 12 is the same 12 its connected row
 * already shows as `errorCount`, so the two screens tell one story.
 */
export const ingest = {
  eventsLast24h: 412883,
  droppedLast24h: 37,
  droppedBySource: [
    { source: "loopwork-web (docker, staging)", count: 12, reason: "log line is not valid JSON" },
    { source: "agent-worker · obstack-py", count: 25, reason: "span attribute exceeds 8KB limit" },
  ],
  samplingRate: 100,
  degradedMode: false,
};

export interface ModelPrice {
  model: string;
  inputPerM: number;
  outputPerM: number;
  source: "default" | "custom";
}

export const modelPrices: ModelPrice[] = [
  { model: "claude-sonnet-5", inputPerM: 3.0, outputPerM: 15.0, source: "default" },
  { model: "claude-haiku-4-5", inputPerM: 1.0, outputPerM: 5.0, source: "default" },
  { model: "gpt-5.2", inputPerM: 2.5, outputPerM: 10.0, source: "default" },
  { model: "loopwork-ft-classifier", inputPerM: 0.4, outputPerM: 1.6, source: "custom" },
];
