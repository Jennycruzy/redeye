import {
  hashDecision,
  hashPlan,
  hashVerdict,
  type Decision,
  type PlanContext,
  type ReceiptVerdict
} from "@redeye/core";
import { createPublicClient, decodeEventLog, fallback, http, parseAbi, type Hex } from "viem";
import { bsc } from "viem/chains";

export const PLANBOOK = "0xC7B860d561f2208c725ac9a873bf4eA5205e9057" as const;

const ABI = parseAbi([
  "struct Plan { address owner; bytes32 eventKey; bytes32 planHash; bytes32 standingRunHash; string ticker; uint64 releaseTs; uint256 jobId; bool decisionRecorded; bool verdictRecorded; bool cancelled; }",
  "function getPlan(uint256 planId) view returns (Plan)",
  "event DecisionRecorded(uint256 indexed planId, bytes32 decisionHash, uint64 at)",
  "event VerdictRecorded(uint256 indexed planId, uint8 outcome, bytes32 verdictHash)"
]);

/** Public BNB Smart Chain nodes that answer browsers; the check needs nothing from Redeye's server. */
const client = createPublicClient({
  chain: bsc,
  transport: fallback([
    http("https://bsc-dataseed.bnbchain.org"),
    http("https://bsc-rpc.publicnode.com"),
    http("https://bsc-dataseed1.defibit.io")
  ])
});

export interface CheckStep {
  label: string;
  state: "pass" | "fail" | "wait";
  detail: string;
}

/** What the agent published about one plan (GET /runs/{id}). */
export interface PublishedRun {
  planId?: number;
  planHash?: Hex;
  plan?: PlanContext;
  event?: { lockTs: number | null; openTs: number | null };
  freeze?: { txHash: Hex; blockTs: number };
  decision?: {
    input: unknown;
    decision: Decision;
    decisionHash: Hex;
    chain: { txHash: Hex } | null;
  };
  verdict?: ReceiptVerdict & { verdictHash: Hex };
  verdictChain?: { txHash: Hex };
}

async function eventIn<T extends "DecisionRecorded" | "VerdictRecorded">(
  txHash: Hex,
  name: T,
  planId: number
): Promise<Record<string, unknown> | null> {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PLANBOOK.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      const args = decoded.args as Record<string, unknown>;
      if (decoded.eventName === name && args.planId === BigInt(planId)) return args;
    } catch {
      // Another event from PlanBook; keep looking.
    }
  }
  return null;
}

/**
 * Re-does the plan's checks in the browser: recompute each fingerprint from the published
 * data with Redeye's own code, then compare it with what the chain holds.
 */
export async function checkRun(
  run: PublishedRun,
  onStep: (steps: CheckStep[]) => void
): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  const push = (step: CheckStep) => {
    steps.push(step);
    onStep([...steps]);
  };
  if (run.planId === undefined || !run.plan || !run.planHash || !run.freeze) {
    push({
      label: "Published plan",
      state: "fail",
      detail: "The agent has not published this plan's data."
    });
    return steps;
  }

  const recomputed = hashPlan(run.plan);
  push({
    label: "Plan fingerprint matches the published plan",
    state: recomputed === run.planHash ? "pass" : "fail",
    detail: `Recomputed ${recomputed.slice(0, 14)}… from the plan text; published ${run.planHash.slice(0, 14)}…`
  });

  const onChain = await client.readContract({
    address: PLANBOOK,
    abi: ABI,
    functionName: "getPlan",
    args: [BigInt(run.planId)]
  });
  push({
    label: `PlanBook holds the same fingerprint for plan #${run.planId}`,
    state: onChain.planHash === recomputed ? "pass" : "fail",
    detail: `PlanBook ${onChain.planHash.slice(0, 14)}… for ${onChain.ticker}`
  });

  const lockTx = await client.getTransactionReceipt({ hash: run.freeze.txHash });
  const lockBlock = await client.getBlock({ blockNumber: lockTx.blockNumber });
  const lockedAt = Number(lockBlock.timestamp) * 1000;
  const closeAt = Number(onChain.releaseTs) * 1000;
  push({
    label: "Locked before the close",
    state: lockedAt < closeAt ? "pass" : "fail",
    detail: `Block ${lockTx.blockNumber} at ${new Date(lockedAt).toISOString().slice(11, 16)} UTC, ${Math.round(
      (closeAt - lockedAt) / 60000
    )} min before the close`
  });

  if (!run.decision?.chain) {
    push({
      label: "Decision",
      state: "wait",
      detail: "The window is still running; no decision yet."
    });
    return steps;
  }
  const decisionHash = hashDecision(run.decision.input, run.decision.decision);
  const decisionEvent = await eventIn(run.decision.chain.txHash, "DecisionRecorded", run.planId);
  push({
    label: "Decision fingerprint matches the chain",
    state:
      decisionEvent?.decisionHash === decisionHash && decisionHash === run.decision.decisionHash
        ? "pass"
        : "fail",
    detail: `Recomputed ${decisionHash.slice(0, 14)}… from the prices and rules the agent saw`
  });

  if (!run.verdict || !run.verdictChain) {
    push({
      label: "Result",
      state: "wait",
      detail: "The result is published once the official open is known."
    });
    return steps;
  }
  const { verdictHash: published, ...verdict } = run.verdict;
  const verdictHash = hashVerdict(verdict);
  const verdictEvent = await eventIn(run.verdictChain.txHash, "VerdictRecorded", run.planId);
  push({
    label: "Result fingerprint matches the chain",
    state: verdictEvent?.verdictHash === verdictHash && verdictHash === published ? "pass" : "fail",
    detail: `${verdict.outcome}${verdict.openPrice ? `, open ${verdict.openPrice}` : ""}`
  });
  return steps;
}
