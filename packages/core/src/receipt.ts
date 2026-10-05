import { encodePacked, keccak256 } from "viem";
import { hashCanonical } from "./canonical.js";
import type { Decision, EventKind, PlanContext } from "./types.js";
import type { EventRecord } from "./events.js";

export interface ReceiptSource {
  name: string;
  seenAt: string;
  form?: string;
}

export interface ReceiptVerdict {
  outcome: "kept" | "refused" | "broken";
  reason?: string;
  openPrice?: string;
  actionPrice?: string;
  costs?: Record<string, string>;
}

export interface ReceiptFill {
  step: number;
  txHash: `0x${string}`;
  confirmedAt: string;
}

export interface ReceiptBundle {
  v: 1;
  event: EventRecord;
  plan: PlanContext & { planId: number | null };
  planHash: `0x${string}`;
  freezeTx: `0x${string}`;
  freezeBlockTs: number;
  decisions: Array<{ at: number; input: unknown; decision: Decision; decisionHash: `0x${string}` }>;
  fills: ReceiptFill[];
  verdict: ReceiptVerdict;
  verdictHash: `0x${string}`;
}

export function makeEventKey(ticker: string, kind: EventKind, releaseDate: string): `0x${string}` {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) throw new Error("Event ticker must be uppercase.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate))
    throw new Error("Event release date must be YYYY-MM-DD.");
  return keccak256(encodePacked(["string", "string", "string"], [ticker, kind, releaseDate]));
}

export function hashPlan(plan: PlanContext): `0x${string}` {
  return hashCanonical({ ...plan, planId: null });
}

export function hashDecision(input: unknown, decision: Decision): `0x${string}` {
  return hashCanonical({ decision, input });
}

export function hashVerdict(verdict: ReceiptVerdict): `0x${string}` {
  return hashCanonical(verdict);
}
