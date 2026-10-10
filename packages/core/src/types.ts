import type { Wrapper } from "@redeye/shared";
import type { Hex } from "viem";

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

/** Who places the plan's trades. Absent means the plan never trades. */
export type TradeDoor = "agentic_wallet" | "plan_account";

export interface PlanContext {
  kind: PlanKind;
  standingRunId?: string | null;
  door?: TradeDoor;
  /**
   * The owner's explicit acceptance that the security audit has no data for this
   * token. Required before a plan may trade; locked with the plan.
   */
  auditNoDataAccepted?: boolean;
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
  /** Raw router call data for a PlanAccount execution, when the quote source provides it. */
  execution?: {
    router: `0x${string}`;
    data: Hex;
    value: string;
    amountInRaw: string;
    referenceAmountOutRaw: string;
    fee: number;
  };
}

export type QuoteCheckCode =
  | "QUOTE_REJECTED"
  | "QUOTE_STALE"
  | "IMPACT_TOO_HIGH"
  | "REAL_PRICE_UNAVAILABLE"
  | "MULTIPLIER_MISMATCH"
  | "NO_SIZE_LIQUIDITY"
  | "SIM_FAILED"
  | "BINANCE_API_UNAVAILABLE"
  | "QUOTE_DEVIATION_EXCEEDED";

export type QuoteCheckStage =
  "quote" | "multiplier" | "sized_quote" | "simulation" | "binance" | "all";

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
  /** What the signed Binance Web3 API modules returned for this trade, when they ran. */
  binance?: BinanceEvidence;
  status: AssetStatusContext;
  audit: SecurityAuditContext;
  wallet: WalletContext;
  poolDepthUsd: string;
  atMs: number;
  executionEnabled: boolean;
  prices: DecisionPrices;
}

/** One signed Binance Web3 API call, without credentials. */
export interface BinanceCall {
  module: string;
  method: string;
  path: string;
  at: string;
  httpStatus: number | null;
  code: number | null;
  latencyMs: number;
  ok: boolean;
}

/** Evidence from the Binance Web3 API, stored in the hashed decision input. */
export interface BinanceEvidence {
  v: 1;
  rwa: {
    tokenPrice: string | null;
    referencePrice: string | null;
    tokenToShareRatio: string | null;
    openState: boolean | null;
    marketStatus: string | null;
    reasonCode: string | null;
    reasonMsg: string | null;
    nextOpenTime: number | null;
  } | null;
  marketPrice: string | null;
  quote: {
    vendor: string;
    executionMode: string;
    quoteId: string;
    inputAmount: string;
    outputAmount: string;
    walletOutputAmount: string;
    deviationPct: string;
    limitPct: string;
  } | null;
  /**
   * Transaction API dry run. "exact" is the transaction the agent will send (the
   * PlanAccount door) and gates the trade; "rehearsal" is Binance's own route for
   * the same swap from the same wallet (the Agentic Wallet builds its own
   * transaction), recorded as evidence only.
   */
  simulation: {
    kind: "exact" | "rehearsal";
    status: string;
    failReason: string | null;
    callHash: string;
    passed: boolean;
    detail: string;
  } | null;
  failure: { module: string; code: number | null; message: string } | null;
  calls: BinanceCall[];
}
