/**
 * S6.4 costs contract (D460): trace-derived LLM unit economics over
 * `spans WHERE layer = 'llm'`. Client-safe: imports nothing. Fenced OUT by
 * construction (D362): infra $, revenue, margin, per-customer, per-feature,
 * forecasts — none has a field here, so none can be rendered.
 */

/** spans TTL is 30d — the picker cannot exceed it. */
export const COSTS_RANGES = ["24h", "7d", "30d"] as const;
export type CostsRange = (typeof COSTS_RANGES)[number];
export const DEFAULT_COSTS_RANGE: CostsRange = "24h";
/** D402 cap on every grouped list; totals are pre-truncation. */
export const COSTS_GROUP_CAP = 10;

/**
 * "Unpriced" = input_tokens + output_tokens > 0 AND cost_usd = 0 — ingest's
 * no-price-row sentinel (pricing.go Cost). Rendered as "—" and named, never $0.
 */
export interface CostsTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  unpricedCalls: number;
}

export interface ModelCost {
  /** gen_ai_response_model, else gen_ai_request_model; "" when neither. */
  model: string;
  system: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  unpricedCalls: number;
}

export interface ServiceCost {
  service: string;
  costUsd: number;
  calls: number;
  unpricedCalls: number;
  modelCount: number;
}

export interface UnpricedModel {
  model: string;
  calls: number;
}

/** Fixed grid; an empty bucket is costUsd 0 / calls 0 — no calls IS no cost. */
export interface CostsPoint {
  /** ISO time of the bucket start. */
  t: string;
  costUsd: number;
  calls: number;
}

export interface CostsReport {
  range: CostsRange;
  totals: CostsTotals;
  byModel: ModelCost[];
  totalModels: number;
  byService: ServiceCost[];
  totalServices: number;
  unpricedModels: UnpricedModel[];
  totalUnpricedModels: number;
  series: CostsPoint[];
}
