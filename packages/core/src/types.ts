import type { Wrapper } from "@redeye/shared";

export type EventKind =
  "overnight" | "weekend" | "holiday" | "earnings" | "scheduled_report" | "material_filing";
export type PlanKind = "guard" | "buy_dip" | "sell_rise" | "protect" | "hold" | "react";
export type DecisionAction = "sell" | "buy" | "hold" | "none";
export type TradeDirection = "sell-only" | "buy-only" | "both";

export interface EventContext {
  ticker: string;
  kind: EventKind;
  lockTs: number;
  openTs: number;
  releaseTs: number | null;
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
  standingRunId?: string | null;
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
    triggerDropPct?: string;
    triggerRisePct?: string;
    maxGapToRealPricePct?: string;
    rebuyAtMs?: number | null;
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

export type SecurityAuditStatus = "clear" | "flagged" | "unavailable" | "no_data";

export interface SecurityAuditContext {
  status: SecurityAuditStatus;
  reason: string | null;
  officialListAddress: boolean;
  multiplierAgreement: boolean;
  walletRefused: boolean;
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

export type QuoteCheckCode =
  | "QUOTE_REJECTED"
  | "QUOTE_STALE"
  | "IMPACT_TOO_HIGH"
  | "REAL_PRICE_UNAVAILABLE"
  | "MULTIPLIER_MISMATCH"
  | "NO_SIZE_LIQUIDITY"
  | "SIM_FAILED";

export type QuoteCheckStage = "quote" | "multiplier" | "sized_quote" | "simulation" | "all";

export interface MultiplierSources {
  list: string;
  asset: string;
  contract: string | null;
}

export interface QuoteCheckResult {
  quoteId: string;
  passed: boolean;
  code: QuoteCheckCode | null;
  stage: QuoteCheckStage;
  reason: string;
  impliedPricePerShare: string | null;
  referencePricePerShare: string | null;
  deviationPct: string | null;
  effectiveCostPerShare: string | null;
  multiplierSources: MultiplierSources | null;
  multiplierA: string | null;
  multiplierB: string | null;
  displayedPricePerShare: string | null;
  sizedPricePerShare: string | null;
  orderUsd: string | null;
  quoteOutputAmount: string | null;
  simulationOutputAmount: string | null;
  deviationFromQuotePct: string | null;
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

export interface DecisionPrices {
  C: string;
  P: string | null;
  T: string;
  sources: {
    C: string;
    P: string | null;
    T: string;
  };
  ages: {
    C: number;
    P: number | null;
    T: number;
  };
}

export interface DecisionInput {
  plan: PlanContext;
  event: EventContext;
  extracted: ExtractedReport | null;
  quotes: NormalizedQuote[];
  quoteChecks: QuoteCheckResult[];
  status: AssetStatusContext;
  audit: SecurityAuditContext;
  wallet: WalletContext;
  poolDepthUsd: string;
  atMs: number;
  executionEnabled: boolean;
  prices: DecisionPrices;
}
