/** Unit economics: total cost of serving — AI (tokens) + infrastructure — joined to customers, features and models. */

export interface CustomerCost {
  org: string;
  plan: "Free" | "Pro" | "Scale";
  revenueMo: number;
  llmCostMo: number;
  /** infra cost allocated by request-volume share (compute, db, network) */
  infraCostMo: number;
  trendPct: number;
  reqs30d: number;
}

export const customerCosts: CustomerCost[] = [
  { org: "Meridian Labs", plan: "Scale", revenueMo: 299, llmCostMo: 84.2, infraCostMo: 79.6, trendPct: 12, reqs30d: 41200 },
  { org: "Kite Commerce", plan: "Scale", revenueMo: 299, llmCostMo: 41.7, infraCostMo: 55.8, trendPct: -4, reqs30d: 28900 },
  { org: "Atlas Support", plan: "Pro", revenueMo: 49, llmCostMo: 22.1, infraCostMo: 22.8, trendPct: 31, reqs30d: 11800 },
  { org: "Nimbus Retail", plan: "Pro", revenueMo: 49, llmCostMo: 11.3, infraCostMo: 14.3, trendPct: 6, reqs30d: 7400 },
  { org: "Brightline AI", plan: "Free", revenueMo: 0, llmCostMo: 6.8, infraCostMo: 7.5, trendPct: 58, reqs30d: 3900 },
];

export interface InfraCost {
  name: string;
  costMo: number;
  note: string;
}

export const infraCosts: InfraCost[] = [
  { name: "GKE nodes · 3 pools", costMo: 268, note: "pool2 (highmem) is 52% — agent streaming buffers" },
  { name: "Postgres (Cloud SQL)", costMo: 74, note: "storage growing 4%/mo · ticket_events dominates" },
  { name: "network egress", costMo: 38, note: "LLM provider traffic is 61% of egress" },
  { name: "kafka disks + misc", costMo: 32, note: "retention 72h on ticket-events" },
];

export const infraTotalMo = infraCosts.reduce((s, i) => s + i.costMo, 0);

export interface FeatureCost {
  name: string;
  sharePct: number;
  costMo: number;
  note?: string;
}

export const featureCosts: FeatureCost[] = [
  { name: "draft_reply", sharePct: 44, costMo: 982, note: "claude-sonnet-5 · longest prompts" },
  { name: "classify_intent", sharePct: 27, costMo: 603, note: "8.1% still on sonnet via bulk path" },
  { name: "review_reply", sharePct: 11, costMo: 246 },
  { name: "kb embeddings", sharePct: 8, costMo: 178 },
  { name: "ticket summaries (digest)", sharePct: 6, costMo: 134 },
  { name: "other", sharePct: 4, costMo: 89 },
];

export const modelCosts = [
  { model: "claude-sonnet-5", sharePct: 61, costMo: 1362 },
  { model: "claude-haiku-4-5", sharePct: 31, costMo: 692 },
  { model: "loopwork-ft-classifier", sharePct: 8, costMo: 178 },
];

export const econStats = [
  { label: "total COGS · 30d", value: "$2,644", delta: "+8%", good: false },
  { label: "AI vs infra split", value: "84 / 16", delta: "$2,232 · $412", good: true },
  { label: "cost / request (all-in)", value: "$0.023", delta: "−7%", good: true },
  { label: "COGS vs MRR", value: "9.7%", delta: "healthy < 15%", good: true },
] as const;
