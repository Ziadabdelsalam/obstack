export interface Rotation {
  team: string;
  primary: string;
  secondary: string;
  until: string;
  week: { day: string; primary: string }[];
}

export const rotations: Rotation[] = [
  {
    team: "Platform",
    primary: "Nour El-Sayed",
    secondary: "Salma Nabil",
    until: "Mon Aug 11, 09:00",
    week: [
      { day: "Mon", primary: "Nour" }, { day: "Tue", primary: "Nour" }, { day: "Wed", primary: "Salma" },
      { day: "Thu", primary: "Salma" }, { day: "Fri", primary: "Nour" }, { day: "Sat", primary: "Omar" },
      { day: "Sun", primary: "Nour" },
    ],
  },
  {
    team: "AI",
    primary: "Omar Farouk",
    secondary: "Nour El-Sayed",
    until: "Wed Aug 13, 09:00",
    week: [
      { day: "Mon", primary: "Omar" }, { day: "Tue", primary: "Omar" }, { day: "Wed", primary: "Omar" },
      { day: "Thu", primary: "Nour" }, { day: "Fri", primary: "Nour" }, { day: "Sat", primary: "Salma" },
      { day: "Sun", primary: "Omar" },
    ],
  },
  {
    team: "Infra",
    primary: "Salma Nabil",
    secondary: "Omar Farouk",
    until: "Mon Aug 11, 09:00",
    week: [
      { day: "Mon", primary: "Salma" }, { day: "Tue", primary: "Salma" }, { day: "Wed", primary: "Salma" },
      { day: "Thu", primary: "Omar" }, { day: "Fri", primary: "Omar" }, { day: "Sat", primary: "Nour" },
      { day: "Sun", primary: "Salma" },
    ],
  },
];

export interface EscalationPolicy {
  id: string;
  name: string;
  team: string;
  steps: string[];
}

export const escalationPolicies: EscalationPolicy[] = [
  {
    id: "p-critical",
    name: "Critical — page immediately",
    team: "Platform",
    steps: ["Page primary on-call", "5 min no-ack → page secondary", "15 min no-ack → notify #incidents + team lead"],
  },
  {
    id: "p-ai-degraded",
    name: "AI quality degradation",
    team: "AI",
    steps: ["Notify #ai-quality", "10 min no-ack → page AI primary", "30 min unresolved → open incident"],
  },
  {
    id: "p-infra-batch",
    name: "Infra / batch (business hours)",
    team: "Infra",
    steps: ["Notify #infra", "Business hours only → page Infra primary", "Next morning digest otherwise"],
  },
];

export interface NotificationChannel {
  id: string;
  name: string;
  kind: "slack" | "pagerduty" | "email" | "webhook";
  target: string;
  enabled: boolean;
}

export const seedChannels: NotificationChannel[] = [
  { id: "ch-slack", name: "#incidents", kind: "slack", target: "loopwork.slack.com", enabled: true },
  { id: "ch-pd", name: "PagerDuty", kind: "pagerduty", target: "loopwork.pagerduty.com", enabled: true },
  { id: "ch-email", name: "Email digest", kind: "email", target: "oncall@loopwork.ai", enabled: false },
  { id: "ch-webhook", name: "Ops webhook", kind: "webhook", target: "https://hooks.loopwork.ai/obstack", enabled: false },
];

/** Maps existing alertRules (src/mock/intelligence.ts, matched by name) to policies + channels. */
export interface RouteEntry {
  rule: string;
  policyId: string;
  channelIds: string[];
}

export const alertRouting: RouteEntry[] = [
  { rule: "Error rate", policyId: "p-critical", channelIds: ["ch-slack", "ch-pd"] },
  { rule: "p95 latency", policyId: "p-critical", channelIds: ["ch-slack", "ch-pd"] },
  { rule: "Tool failure cluster", policyId: "p-critical", channelIds: ["ch-slack", "ch-pd"] },
  { rule: "Pod crash loop", policyId: "p-infra-batch", channelIds: ["ch-slack", "ch-webhook"] },
  { rule: "Consumer lag", policyId: "p-infra-batch", channelIds: ["ch-slack", "ch-webhook"] },
  { rule: "Token spend spike", policyId: "p-ai-degraded", channelIds: ["ch-slack", "ch-email"] },
  { rule: "Agent loop detection", policyId: "p-ai-degraded", channelIds: ["ch-slack"] },
  { rule: "Review confidence drop", policyId: "p-ai-degraded", channelIds: ["ch-slack"] },
];
