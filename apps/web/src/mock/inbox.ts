/** Notification inbox + audit log entries. */

export interface Notification {
  id: string;
  kind: "alert" | "pipeline" | "team" | "system";
  title: string;
  time: string;
  unread: boolean;
  href: string;
}

export const notifications: Notification[] = [
  {
    id: "n1",
    kind: "alert",
    title: "CRITICAL · Error rate 14.2% on POST /v1/tickets/bulk",
    time: "34m ago",
    unread: true,
    href: "/app/incidents",
  },
  {
    id: "n2",
    kind: "alert",
    title: "Pod restarted: agent-worker-7d9fb-kx2rq (OOMKilled)",
    time: "17m ago",
    unread: true,
    href: "/app/traces/a3f8c1d92b6e407f",
  },
  {
    id: "n3",
    kind: "pipeline",
    title: "zendesk-migration backfill at 62% — 41 items failed so far",
    time: "12m ago",
    unread: true,
    href: "/app/pipelines",
  },
  {
    id: "n4",
    kind: "alert",
    title: "WARNING · Token spend spike +212% vs baseline",
    time: "35m ago",
    unread: false,
    href: "/app/alerts",
  },
  {
    id: "n5",
    kind: "team",
    title: "Omar Farouk enabled alert rule “Review confidence drop”",
    time: "yesterday",
    unread: false,
    href: "/app/alerts",
  },
  {
    id: "n6",
    kind: "system",
    title: "76% of free-tier events used — resets Sep 1",
    time: "today",
    unread: false,
    href: "/app/settings",
  },
];

export interface AuditEntry {
  who: string;
  action: string;
  when: string;
  ip: string;
}

/**
 * The demo company's cast is invented (D208) and stays that way (D235): every
 * actor below is a Loopwork persona on the corpus-wide `loopwork.ai` mailbox
 * pattern, and every IP is in RFC 5737's documentation range `203.0.113.0/24`,
 * never one that routes to somebody's house. An audit log is where a reader
 * looks to learn who someone is; it is the last place a real person's identity
 * belongs.
 */
export const auditLog: AuditEntry[] = [
  { who: "salma@loopwork.ai", action: "created API key “key-3” (scope: ingest)", when: "today 13:31", ip: "203.0.113.7" },
  { who: "system", action: "alert triggered: Error rate > 5% (POST /v1/tickets/bulk)", when: "today 13:06", ip: "—" },
  { who: "omar@loopwork.ai", action: "enabled alert rule “Review confidence drop”", when: "yesterday 16:20", ip: "203.0.113.88" },
  { who: "salma@loopwork.ai", action: "invited dina@loopwork.ai (member)", when: "yesterday 11:02", ip: "203.0.113.7" },
  { who: "nour@loopwork.ai", action: "connected source “Docker · loopwork-web”", when: "Aug 6 09:41", ip: "203.0.113.19" },
  { who: "salma@loopwork.ai", action: "changed retention 3d → 7d", when: "Aug 5 18:12", ip: "203.0.113.7" },
  { who: "nour@loopwork.ai", action: "signed in (google oauth)", when: "Aug 5 09:00", ip: "203.0.113.19" },
];
