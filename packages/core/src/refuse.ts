import type { Refusal } from "./types.js";

export const refusalCodes = [
  "ASSET_PAUSED",
  "TRADING_RESTRICTED",
  "POOL_TOO_THIN",
  "IMPACT_TOO_HIGH",
  "PRICE_OFF_REAL",
  "REAL_PRICE_UNAVAILABLE",
  "QUOTE_REJECTED",
  "QUOTE_STALE",
  "SIM_FAILED",
  "ORDER_FAILED",
  "AUDIT_FLAGGED",
  "AUDIT_UNAVAILABLE",
  "AUDIT_NO_DATA",
  "MULTIPLIER_MISMATCH",
  "NO_SIZE_LIQUIDITY",
  "LOCK_MISSED",
  "QUOTA_LOW",
  "TOKEN_NOT_ALLOWED",
  "PERMISSION_EXPIRED",
  "SESSION_EXPIRING",
  "SESSION_LOST",
  "CONDITION_NOT_MET",
  "NO_CONSENSUS",
  "EPS_BASIS_MISMATCH",
  "EXTRACT_UNVERIFIED",
  "FILING_NOT_FOUND",
  "WINDOW_CLOSED",
  "EXECUTION_DISABLED",
  "BINANCE_API_UNAVAILABLE",
  "QUOTE_DEVIATION_EXCEEDED"
] as const;

export type RefusalCode = (typeof refusalCodes)[number];

export interface RefusalDetails {
  ticker: string;
  reason?: string;
  currentUsd?: string;
  neededUsd?: string;
  impactPct?: string;
  limitPct?: string;
  actualPrice?: string;
  referencePrice?: string;
  quotaLeftUsd?: string;
  quotaNeededUsd?: string;
  sessionEndsAt?: string;
  gapPct?: string;
  multiplierA?: string;
  multiplierB?: string;
  displayedGapPct?: string;
  orderUsd?: string;
  sizedPricePerShare?: string;
}

function required(details: RefusalDetails, field: keyof RefusalDetails): string {
  const value = details[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Refusal ${String(field)} is required.`);
  }
  return value;
}

export function refusal(code: RefusalCode, details: RefusalDetails): Refusal {
  const t = details.ticker;
  let sentence: string;
  switch (code) {
    case "ASSET_PAUSED":
      sentence = `${t} is paused by the issuer for ${required(details, "reason")}; no trade.`;
      break;
    case "TRADING_RESTRICTED":
      sentence = `Binance isn't allowing ${t} trades right now: ${required(details, "reason")}.`;
      break;
    case "POOL_TOO_THIN":
      sentence = `The ${t} pool holds $${required(details, "currentUsd")}; your plan needs at least $${required(details, "neededUsd")}.`;
      break;
    case "IMPACT_TOO_HIGH":
      sentence = `Trading now would move the price ${required(details, "impactPct")}%; your limit is ${required(details, "limitPct")}%.`;
      break;
    case "PRICE_OFF_REAL":
      sentence = `The token is ${required(details, "gapPct")}% away from the real price; your limit is ${required(details, "limitPct")}%.`;
      break;
    case "REAL_PRICE_UNAVAILABLE":
      sentence = "We can't see the real price right now, so no trade.";
      break;
    case "QUOTE_REJECTED":
      sentence = `The price quote didn't make sense (${required(details, "actualPrice")} vs reference ${required(details, "referencePrice")}); no trade.`;
      break;
    case "QUOTE_STALE":
      sentence = "The price quote expired; fetching a new one.";
      break;
    case "SIM_FAILED":
      sentence = `The trade failed a dry run: ${required(details, "reason")}.`;
      break;
    case "BINANCE_API_UNAVAILABLE":
      sentence = "Binance's Web3 API didn't answer, so the agent is waiting before it trades.";
      break;
    case "QUOTE_DEVIATION_EXCEEDED":
      sentence = `Binance's own quote and the wallet's quote disagree (${required(details, "actualPrice")} vs ${required(details, "referencePrice")} per share); no trade while they differ.`;
      break;
    case "ORDER_FAILED":
      sentence = `The trade was sent but didn't go through: ${required(details, "reason")}.`;
      break;
    case "AUDIT_FLAGGED":
      sentence = `A security check flagged ${t}: ${required(details, "reason")}.`;
      break;
    case "AUDIT_UNAVAILABLE":
      sentence = "The security check is unavailable, so no trade.";
      break;
    case "AUDIT_NO_DATA":
      sentence = `The security check has no data on ${t}; its address is from Binance's official stock list.`;
      break;
    case "MULTIPLIER_MISMATCH":
      sentence = `Binance's sources disagree on how many shares one ${t} is (${required(details, "multiplierA")} vs ${required(details, "multiplierB")}), so no trade.`;
      break;
    case "NO_SIZE_LIQUIDITY":
      sentence = `${t} looks ${required(details, "displayedGapPct")}% cheaper on screen, but a $${required(details, "orderUsd")} order would only get ${required(details, "sizedPricePerShare")}; no trade.`;
      break;
    case "LOCK_MISSED":
      sentence = "This window's copy wasn't locked before the close, so it didn't run.";
      break;
    case "QUOTA_LOW":
      sentence = `Your limit has $${required(details, "quotaLeftUsd")} left; this plan needs $${required(details, "quotaNeededUsd")}.`;
      break;
    case "TOKEN_NOT_ALLOWED":
      sentence = `Your settings don't allow trading ${t}.`;
      break;
    case "PERMISSION_EXPIRED":
      sentence = "Your permission for this plan has ended; nothing was traded.";
      break;
    case "SESSION_EXPIRING":
      sentence = `Your wallet session ends at ${required(details, "sessionEndsAt")}; please sign in again.`;
      break;
    case "SESSION_LOST":
      sentence = "Your wallet was signed out; nothing was traded.";
      break;
    case "CONDITION_NOT_MET":
      sentence = "The price never reached your trigger, so nothing was done.";
      break;
    case "NO_CONSENSUS":
      sentence = "Too few analyst estimates to measure a surprise.";
      break;
    case "EPS_BASIS_MISMATCH":
      sentence = "The reported numbers don't match the basis analysts used.";
      break;
    case "EXTRACT_UNVERIFIED":
      sentence = "Couldn't confirm the reported numbers in the filing.";
      break;
    case "FILING_NOT_FOUND":
      sentence = "No release found yet; nothing done.";
      break;
    case "WINDOW_CLOSED":
      sentence = "The plan window has passed.";
      break;
    case "EXECUTION_DISABLED":
      sentence = "Trading is switched off on this agent.";
      break;
  }
  return { code, sentence };
}
