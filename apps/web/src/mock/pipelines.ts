/** Scheduled and event-driven pipelines/flows and their run history. */

export type RunStatus = "success" | "failed" | "running" | "degraded";

export interface PipelineRun {
  status: RunStatus;
  durationS: number;
  at: string;
  traceId?: string;
  note?: string;
}

export interface Pipeline {
  slug: string;
  name: string;
  /** cron expression or event trigger */
  trigger: string;
  triggerKind: "cron" | "event" | "manual";
  description: string;
  service: string;
  nextRun: string;
  successRate: string;
  /** newest first, up to 10 */
  runs: PipelineRun[];
  /** present while a run is in flight */
  current?: {
    startedAt: string;
    progressPct: number;
    processed: number;
    total: number;
    failed: number;
    eta: string;
    failLink?: string;
  };
}

export const pipelines: Pipeline[] = [
  {
    slug: "zendesk-migration",
    name: "zendesk-migration backfill",
    trigger: "manual · one-off",
    triggerKind: "manual",
    description: "Import 1,800 historical tickets from Zendesk, classify and index them.",
    service: "batch-import",
    nextRun: "—",
    successRate: "—",
    runs: [
      { status: "running", durationS: 2160, at: "13:04 today" },
    ],
    current: {
      startedAt: "13:04 today",
      progressPct: 62,
      processed: 1118,
      total: 1800,
      failed: 41,
      eta: "~22m remaining",
      failLink: "/app/traces?q=bulk&status=error",
    },
  },
  {
    slug: "sync-tickets",
    name: "sync-tickets",
    trigger: "kafka · ticket-events",
    triggerKind: "event",
    description: "Continuous consumer batching ticket updates into Postgres and invalidating caches.",
    service: "sync-worker",
    nextRun: "continuous",
    successRate: "99.2%",
    runs: [
      { status: "success", durationS: 0.37, at: "1m ago", traceId: "1e1b9cc10f22716e" },
      { status: "success", durationS: 0.3, at: "49m ago", traceId: "d3002fbfc3611f37" },
      { status: "failed", durationS: 0.4, at: "2h ago", note: "pg deadlock, batch requeued" },
      { status: "success", durationS: 0.18, at: "2h 48m ago", traceId: "f2eaea127c0092fe" },
      { status: "success", durationS: 0.17, at: "3h ago" },
      { status: "success", durationS: 0.31, at: "3h 31m ago" },
      { status: "success", durationS: 0.15, at: "4h 55m ago" },
      { status: "success", durationS: 0.42, at: "5h 24m ago" },
    ],
  },
  {
    slug: "kb-reindex",
    name: "kb-reindex",
    trigger: "0 */6 * * *",
    triggerKind: "cron",
    description: "Full reindex of the knowledge base for retrieval.",
    service: "kb-service",
    nextRun: "in 5h 15m",
    successRate: "100%",
    runs: [
      {
        status: "degraded",
        durationS: 92,
        at: "12:55 today",
        traceId: "b7e2d94a1c8f5e30",
        note: "completed, but 11 downstream search_kb timeouts during the window",
      },
      { status: "success", durationS: 88, at: "06:55 today" },
      { status: "success", durationS: 90, at: "00:55 today" },
      { status: "success", durationS: 86, at: "yesterday 18:55" },
      { status: "success", durationS: 91, at: "yesterday 12:55" },
    ],
  },
  {
    slug: "ticket-digest",
    name: "ticket-digest",
    trigger: "0 6 * * *",
    triggerKind: "cron",
    description: "Daily summary email of open tickets per workspace.",
    service: "cronjobs",
    nextRun: "tomorrow 06:00",
    successRate: "100%",
    runs: [
      { status: "success", durationS: 41, at: "06:00 today" },
      { status: "success", durationS: 39, at: "yesterday" },
      { status: "success", durationS: 44, at: "2d ago" },
      { status: "success", durationS: 40, at: "3d ago" },
      { status: "success", durationS: 38, at: "4d ago" },
    ],
  },
  {
    slug: "nightly-evals",
    name: "nightly-evals",
    trigger: "0 2 * * *",
    triggerKind: "cron",
    description: "Replay yesterday's traces against the current agent config and score drift.",
    service: "evals-runner",
    nextRun: "tonight 02:00",
    successRate: "96.7%",
    runs: [
      { status: "success", durationS: 1240, at: "02:00 today", note: "4,102 traces replayed" },
      { status: "success", durationS: 1180, at: "yesterday" },
      { status: "failed", durationS: 320, at: "2d ago", note: "provider quota exhausted at 26%" },
      { status: "success", durationS: 1210, at: "3d ago" },
    ],
  },
  {
    slug: "retention-ttl",
    name: "retention-ttl",
    trigger: "0 4 * * *",
    triggerKind: "cron",
    description: "Apply retention policy: expire telemetry past the workspace TTL.",
    service: "obstack-internal",
    nextRun: "tomorrow 04:00",
    successRate: "100%",
    runs: [
      { status: "success", durationS: 12, at: "04:00 today", note: "expired 214k events" },
      { status: "success", durationS: 11, at: "yesterday" },
      { status: "success", durationS: 14, at: "2d ago" },
    ],
  },
];
