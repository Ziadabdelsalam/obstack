/** The "what changed?" feed: deploys, config, scaling, secrets, flags — one timeline. */

export type ChangeKind = "deploy" | "config" | "scale" | "secret" | "flag" | "infra";

export interface Change {
  kind: ChangeKind;
  at: string;
  title: string;
  detail: string;
  who: string;
  /** inside the INC-42 window or causally linked */
  incident?: boolean;
  link?: { label: string; href: string };
}

export const changes: Change[] = [
  {
    kind: "scale",
    at: "today 13:24",
    title: "batch-import throttled to 50 tickets/min",
    detail: "Operator action during INC-42 — mitigation that ended the cascade",
    who: "ziad",
    incident: true,
    link: { label: "incident", href: "/app/incidents" },
  },
  {
    kind: "infra",
    at: "today 13:22",
    title: "agent-worker-7d9fb-kx2rq restarted (OOMKilled)",
    detail: "Restart #3 in 1h · memory limit 512Mi exceeded during streaming",
    who: "kubelet",
    incident: true,
    link: { label: "OOM trace", href: "/app/traces/a3f8c1d92b6e407f" },
  },
  {
    kind: "config",
    at: "today 13:04",
    title: "zendesk-migration backfill started",
    detail: "One-off job: 1,800 tickets · tripled request volume within 60s — trigger of INC-42",
    who: "omar",
    incident: true,
    link: { label: "pipeline", href: "/app/pipelines" },
  },
  {
    kind: "deploy",
    at: "today 11:40",
    title: "deploy f4a2c91 — tightened draft_reply system prompt",
    detail: "confidence 0.91 → 0.92 · cost/req −9% · no regression",
    who: "nour",
    link: { label: "eval", href: "/app/evals" },
  },
  {
    kind: "flag",
    at: "today 09:15",
    title: "flag kb_rerank_v2 enabled for 25% of workspaces",
    detail: "Gradual rollout · no latency delta observed so far",
    who: "nour",
  },
  {
    kind: "secret",
    at: "yesterday 16:40",
    title: "Zendesk webhook signing secret rotated",
    detail: "Old secret valid for 24h grace · staging endpoints re-verified",
    who: "ziad",
  },
  {
    kind: "deploy",
    at: "Aug 8 · 14:12",
    title: "deploy b81de07 — classify_intent moved to larger model",
    detail: "REGRESSION: confidence 0.92 → 0.78, cost +26% · flagged by nightly evals",
    who: "omar",
    link: { label: "regression", href: "/app/evals" },
  },
  {
    kind: "scale",
    at: "Aug 8 · 09:30",
    title: "HPA max replicas raised 3 → 5 for agent-worker",
    detail: "Preparing for the zendesk migration traffic",
    who: "ziad",
  },
  {
    kind: "deploy",
    at: "Aug 7 · 09:55",
    title: "deploy 9cc41f2 — kb retrieval rerank top-8 → top-4",
    detail: "confidence +0.02 · cost/req −1‰",
    who: "ziad",
  },
  {
    kind: "config",
    at: "Aug 5 · 18:12",
    title: "telemetry retention changed 3d → 7d",
    detail: "Workspace setting · applied by nightly retention-ttl",
    who: "ziad",
    link: { label: "audit", href: "/app/settings" },
  },
];
