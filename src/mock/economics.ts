/** AI unit economics: cost joined to customers, features and models. */

export interface CustomerCost {
  org: string;
  plan: "Free" | "Pro" | "Scale";
  revenueMo: number;
  llmCostMo: number;
  trendPct: number;
  reqs30d: number;
}

export const customerCosts: CustomerCost[] = [
  { org: "Meridian Labs", plan: "Scale", revenueMo: 299, llmCostMo: 84.2, trendPct: 12, reqs30d: 41200 },
  { org: "Kite Commerce", plan: "Scale", revenueMo: 299, llmCostMo: 41.7, trendPct: -4, reqs30d: 28900 },
  { org: "Atlas Support", plan: "Pro", revenueMo: 49, llmCostMo: 22.1, trendPct: 31, reqs30d: 11800 },
  { org: "Nimbus Retail", plan: "Pro", revenueMo: 49, llmCostMo: 11.3, trendPct: 6, reqs30d: 7400 },
  { org: "Brightline AI", plan: "Free", revenueMo: 0, llmCostMo: 6.8, trendPct: 58, reqs30d: 3900 },
];

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
  { label: "LLM cost · 30d", value: "$2,232", delta: "+9%", good: false },
  { label: "cost / request", value: "$0.019", delta: "−9%", good: true },
  { label: "LLM COGS vs MRR", value: "8.2%", delta: "healthy < 15%", good: true },
  { label: "most expensive customer", value: "Meridian", delta: "28% margin hit", good: false },
] as const;
