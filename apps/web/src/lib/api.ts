/** Typed reads from the Redeye agent. Every number the site shows comes through here. */
import type { SerializedPlanPermission } from "@redeye/core";
import type { Address } from "viem";

export interface PricePoint {
  value: string;
  source: string;
  fetchedAt: string;
  ageSeconds: number;
  sourceRecordPath?: string;
}

export interface PriceItem {
  state: "ok" | "degraded" | "error" | string;
  ticker: string;
  at?: string;
  close?: PricePoint & { date: string };
  real?: PricePoint;
  token?: PricePoint;
  gaps?: { tokenToClosePct: string; tokenToRealPct: string };
  pool?: { address: string; reserveUsd: string; source: string };
  reason?: string;
}

export interface Prices {
  state: string;
  items: PriceItem[];
}

export interface NightTrace {
  state: "ok";
  ticker: string;
  window: { kind: string; closeTs: number; openTs: number };
  phase: "live" | "finished";
  close: { value: string; date: string; source: string } | null;
  points: Array<[number, string]>;
  interval: string;
  source: string;
  fetchedAt: string;
}

export type Outcome = "kept" | "refused" | "broken";

export interface PlanParams {
  maxPriceImpactPct?: string;
  minPoolDepthUsd?: string;
  maxGapToRealPricePct?: string;
  triggerDropPct?: string;
  triggerRisePct?: string;
  sellPct?: string;
  maxUsd?: string;
}

export interface RecordItem {
  id: string;
  planId: number | null;
  owner: string;
  status: "draft" | "locked" | "decided" | "done" | "cancelled" | "missed";
  standingRunId: string | null;
  ticker: string;
  kind: "guard" | "buy_dip" | "sell_rise" | "hold" | string;
  promise: string;
  window: string;
  lockedAt: number | null;
  closeTs: number;
  openTs: number;
  freezeTx: string | null;
  outcome: Outcome | null;
  reason: string | null;
  openPrice: string | null;
  verdictTx: string | null;
  jobId: number | null;
  jobState: string | null;
  teamJobId: number | null;
  teamJobState: string | null;
  params?: PlanParams;
  heldShares?: string;
  door?: "agentic_wallet" | "plan_account" | "signed" | null;
  decisionTx?: string | null;
  decidedAt?: number | null;
  action?: string | null;
  fillTx?: string | null;
}

export interface PlanRecord {
  state: string;
  kept: number;
  refused: number;
  broken: number;
  open: number;
  cancelled: number;
  missed: number;
  items: RecordItem[];
}

export interface Health {
  state: string;
  passes: number;
  longestGapSeconds: number;
  gapsOverMinute: number;
  lastSuccessAt: string | null;
  priceAgeSeconds: Record<string, number>;
}

export interface PasskeyStatus {
  available: boolean;
  rpId: string;
  factory: string | null;
  reason: string | null;
}

export interface StudyWindow {
  n: number;
  closeError: number;
  hyperliquidError: number;
  tokenError: number;
  medianAbsDifference: number;
  overHalfPct: number;
  overOnePct: number;
  maxAbsDifference: number;
  directionWins: number;
  directionN: number;
}

export interface Study {
  state: string;
  source?: string;
  summaryText?: string;
  csv?: string;
  summary?: {
    v?: number;
    source?: string;
    samples: number;
    stocks: string[];
    medianWeekendGap: number;
    windows: Record<string, StudyWindow>;
  };
}

export interface PlanPreview {
  valid: boolean;
  issues: Array<{ field: string; message: string }>;
  promise: string;
  planHash: string;
  runId?: string;
  runHash?: string;
  permission?: SerializedPlanPermission & { template: Address };
  window: { kind: string; closeTs: number; openTs: number; lockBy: number };
}

/** One logged step of a plan: "locked", "check:<ms>", "decided", "result", job steps. */
export interface RunEvent {
  step: string;
  at: string;
  action?: string;
  refusal?: string | null;
  reason?: string;
  txHash?: string;
  prices?: { C: string; P: string; T: string; ages?: Record<string, number> };
  [key: string]: unknown;
}

export interface WalletStatus {
  state: string;
  connected: boolean;
  address?: string;
  sessionEndsAt?: string;
  dailyLimitUsd?: string;
  quotaLeftUsd?: string;
  reason?: string;
  checkedAt?: string;
}

/** Where the agent lives: /api on the same origin unless VITE_AGENT_URL says otherwise. */
const BASE = (import.meta.env.VITE_AGENT_URL ?? "/api").replace(/\/$/, "");

export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {})
    }
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentError(
      response.status,
      "NOT_JSON",
      `The agent sent an unreadable answer for ${path}.`
    );
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; reason?: string } }).error;
    throw new AgentError(
      response.status,
      error?.code ?? "HTTP_ERROR",
      error?.reason ?? `The agent answered ${response.status} for ${path}.`
    );
  }
  return body as T;
}

export const agent = {
  prices: (tickers?: string[]) =>
    request<Prices>(tickers ? `/prices?tickers=${tickers.join(",")}` : "/prices"),
  night: (ticker: string, closeTs?: number) =>
    request<NightTrace>(`/night/${ticker}${closeTs === undefined ? "" : `?close=${closeTs}`}`),
  record: () => request<PlanRecord>("/record"),
  health: () => request<Health>("/health"),
  passkey: () => request<PasskeyStatus>("/passkey"),
  study: () => request<Study>("/study"),
  wallet: () => request<WalletStatus>("/wallet"),
  run: (id: string) => request<Record<string, unknown>>(`/runs/${id}`),
  runEvents: (id: string) => request<{ state: string; items: RunEvent[] }>(`/runs/${id}/events`),
  receipt: (id: string) => request<Record<string, unknown>>(`/runs/${id}/receipt`),
  lockSigned: (body: {
    plan: Record<string, unknown>;
    owner: string;
    issuedAt: number;
    signature?: string;
    permission?: SerializedPlanPermission & { template: Address };
    permissionSignature?: string;
    authorization?: {
      contractAddress: string;
      chainId: number;
      nonce: number;
      yParity: number;
      r: string;
      s: string;
    };
  }) =>
    request<{ id: string; planId: number; freeze: { txHash: string } }>("/signed-plans", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  preview: (plan: Record<string, unknown>) =>
    request<PlanPreview>("/preview", { method: "POST", body: JSON.stringify(plan) }),
  previewStanding: (plan: Record<string, unknown>) =>
    request<PlanPreview>("/preview-standing", {
      method: "POST",
      body: JSON.stringify(plan)
    }),
  startStanding: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>("/standing", {
      method: "POST",
      body: JSON.stringify(body)
    })
};

export const AGENT_BASE = BASE;
