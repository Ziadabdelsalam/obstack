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

export const ingest = {
  eventsLast24h: 412883,
  droppedLast24h: 37,
  droppedBySource: [
    { source: "Vercel log drain", count: 12, reason: "unparseable JSON body" },
    { source: "OTLP · agent-worker", count: 25, reason: "span attribute exceeds 8KB limit" },
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
