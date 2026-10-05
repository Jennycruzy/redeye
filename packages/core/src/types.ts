import type { Wrapper } from "@redeye/shared";

export type EventKind = "earnings" | "scheduled_report" | "material_filing";
export type PlanKind = "protect" | "hold" | "react";
export type DecisionAction = "sell" | "buy" | "hold" | "none";
export type TradeDirection = "sell-only" | "buy-only" | "both";

export interface EventContext {
  ticker: string;
  kind: EventKind;
  releaseTs: number;
  consensus: {
    eps: string;
    basis: string;
    noOfEsts: number;
  } | null;
}

export interface ExtractedReport {
  actualEps: string;
  basis: string;
  verbatim: string;
  verified: boolean;
}

export interface PlanContext {
  kind: PlanKind;
  ticker: string;
  wrapper: Wrapper;
  tokenAddress: string;
  heldShares: string;
  params: {
    maxPriceImpactPct: string;
    minPoolDepthUsd: string;
    sellPct?: string;
    sellAtMs?: number;
    maxUsd?: string;
    surpriseThresholdPct?: string;
    unpricedThresholdPct?: string;
    direction?: TradeDirection;
    windowEndMs?: number;
  };
}

export interface AssetStatusContext {
  reasonCode: string | null;
  reasonMsg: string | null;
}

export interface WalletContext {
  connected: boolean;
  tokenAllowed: boolean;
  quotaLeftUsd: string;
  requiredQuotaUsd: string;
  sessionExpiresAtMs: number;
  requiredUntilMs: number;
}

export interface NormalizedQuote {
  id: string;
  success: boolean;
  side: "buy" | "sell";
  wrapper: Wrapper;
  tokenAddress: string;
  routeTokenAddress: string;
  inputAmount: string;
  inputUnit: "USD" | "TOKEN";
  outputAmount: string;
  outputUnit: "USD" | "TOKEN";
  multiplier: string;
  priceImpactPct: string;
  feeUsd: string;
  quotedAtMs: number;
}

export interface QuoteCheckResult {
  quoteId: string;
  passed: boolean;
  code: "QUOTE_REJECTED" | "QUOTE_STALE" | "IMPACT_TOO_HIGH" | null;
  reason: string;
  impliedPricePerShare: string | null;
  referencePricePerShare: string | null;
  deviationPct: string | null;
  effectiveCostPerShare: string | null;
}

export interface Refusal {
  code: string;
  sentence: string;
}

export interface Decision {
  action: DecisionAction;
  size: { shares?: string; usd?: string };
  wrapper: Wrapper | null;
  reason: string;
  refusal: Refusal | null;
}

export interface DecisionInput {
  plan: PlanContext;
  event: EventContext;
  extracted: ExtractedReport | null;
  quotes: NormalizedQuote[];
  quoteChecks: QuoteCheckResult[];
  status: AssetStatusContext;
  wallet: WalletContext;
  poolDepthUsd: string;
  atMs: number;
  executionEnabled: boolean;
  onChainMoveSinceReleasePct?: string;
}
