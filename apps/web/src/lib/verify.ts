import {
  hashDecision,
  hashCanonical,
  hashPlan,
  hashVerdict,
  type Decision,
  type PlanContext,
  type ReceiptReconciliation,
  type ReceiptVerdict
} from "@redeye/core";
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex
} from "viem";
import { bsc } from "viem/chains";

export const PLANBOOK = "0xC7B860d561f2208c725ac9a873bf4eA5205e9057" as const;

const ABI = parseAbi([
  "struct Plan { address owner; bytes32 eventKey; bytes32 planHash; bytes32 standingRunHash; string ticker; uint64 releaseTs; uint256 jobId; bool decisionRecorded; bool verdictRecorded; bool cancelled; }",
  "function getPlan(uint256 planId) view returns (Plan)",
  "event DecisionRecorded(uint256 indexed planId, bytes32 decisionHash, uint64 at)",
  "event VerdictRecorded(uint256 indexed planId, uint8 outcome, bytes32 verdictHash)"
]);
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
const LOG_BLOCK_CHUNK = 5_000n;

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
  reconciliation?: ReceiptReconciliation;
  trade?: {
    wallet: Hex;
    order: { status: string; txHash: Hex | null } | null;
  };
}

function sameTransfer(
  expected: ReceiptReconciliation["expectedTransfers"][number],
  observed: ReceiptReconciliation["expectedTransfers"][number]
): boolean {
  return (
    expected.tokenAddress.toLowerCase() === observed.tokenAddress.toLowerCase() &&
    expected.account.toLowerCase() === observed.account.toLowerCase() &&
    expected.direction === observed.direction &&
    expected.amountRaw === observed.amountRaw &&
    expected.txHash?.toLowerCase() === observed.txHash?.toLowerCase() &&
    expected.logIndex === observed.logIndex
  );
}

async function checkedTransfers(reconciliation: ReceiptReconciliation) {
  const fromBlock = BigInt(reconciliation.fromBlock);
  const toBlock = BigInt(reconciliation.toBlock);
  const tokenAddresses = reconciliation.tokenAddresses as Address[];
  const observedTransfers: ReceiptReconciliation["expectedTransfers"] = [];
  for (const account of reconciliation.accounts) {
    for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += LOG_BLOCK_CHUNK) {
      const chunkEnd =
        chunkStart + LOG_BLOCK_CHUNK - 1n > toBlock ? toBlock : chunkStart + LOG_BLOCK_CHUNK - 1n;
      const [outgoing, incoming] = await Promise.all([
        client.getLogs({
          address: tokenAddresses,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          event: TRANSFER_EVENT,
          args: { from: account as Address }
        }),
        client.getLogs({
          address: tokenAddresses,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
          event: TRANSFER_EVENT,
          args: { to: account as Address }
        })
      ]);
      for (const log of outgoing) {
        const value = log.args.value;
        if (log.transactionHash === null || log.logIndex === null || value === undefined) {
          throw new Error("BSC returned a transfer log without its transaction, index, or value.");
        }
        observedTransfers.push({
          tokenAddress: log.address.toLowerCase(),
          account: account.toLowerCase(),
          direction: "out",
          amountRaw: value.toString(),
          txHash: log.transactionHash,
          logIndex: log.logIndex
        });
      }
      for (const log of incoming) {
        const value = log.args.value;
        if (log.transactionHash === null || log.logIndex === null || value === undefined) {
          throw new Error("BSC returned a transfer log without its transaction, index, or value.");
        }
        observedTransfers.push({
          tokenAddress: log.address.toLowerCase(),
          account: account.toLowerCase(),
          direction: "in",
          amountRaw: value.toString(),
          txHash: log.transactionHash,
          logIndex: log.logIndex
        });
      }
    }
  }
  return observedTransfers;
}

function compareTransfers(
  reconciliation: ReceiptReconciliation,
  observedTransfers: ReceiptReconciliation["expectedTransfers"]
): ReceiptReconciliation["result"] {
  const used = new Set<number>();
  const matchedTransfers: ReceiptReconciliation["result"]["matchedTransfers"] = [];
  const missingTransfers: ReceiptReconciliation["expectedTransfers"] = [];
  for (const expected of reconciliation.expectedTransfers) {
    const index = observedTransfers.findIndex(
      (observed, i) => !used.has(i) && sameTransfer(expected, observed)
    );
    if (index < 0) missingTransfers.push(expected);
    else {
      used.add(index);
      matchedTransfers.push({ expected, observed: observedTransfers[index]! });
    }
  }
  const unexpectedTransfers = observedTransfers
    .filter((_, index) => !used.has(index))
    .sort((left, right) =>
      `${left.txHash}:${left.logIndex}:${left.tokenAddress}:${left.account}:${left.direction}`.localeCompare(
        `${right.txHash}:${right.logIndex}:${right.tokenAddress}:${right.account}:${right.direction}`
      )
    );
  const usdt = "0x55d398326f99059ff775485246999027b3197955";
  const missingFillTransfers = reconciliation.fillChecks
    .filter((fill) => {
      const cashDirection = fill.side === "buy" ? "out" : "in";
      const stockDirection = fill.side === "buy" ? "in" : "out";
      const hasCash = observedTransfers.some(
        (transfer) =>
          transfer.txHash?.toLowerCase() === fill.txHash.toLowerCase() &&
          transfer.account.toLowerCase() === fill.account.toLowerCase() &&
          transfer.tokenAddress.toLowerCase() === usdt &&
          transfer.direction === cashDirection
      );
      const hasStock = observedTransfers.some(
        (transfer) =>
          transfer.txHash?.toLowerCase() === fill.txHash.toLowerCase() &&
          transfer.account.toLowerCase() === fill.account.toLowerCase() &&
          transfer.tokenAddress.toLowerCase() === fill.stockTokenAddress.toLowerCase() &&
          transfer.direction === stockDirection
      );
      return !hasCash || !hasStock;
    })
    .map((fill) => fill.txHash);
  const errors = missingTransfers.map(
    (transfer) =>
      `recorded fill has no matching ${transfer.direction} transfer for ${transfer.tokenAddress} (${transfer.amountRaw}).`
  );
  errors.push(
    ...unexpectedTransfers.map(
      (transfer) =>
        `unrecorded ${transfer.direction} transfer found for ${transfer.tokenAddress} (${transfer.amountRaw}) in ${transfer.txHash ?? "an unknown transaction"}.`
    )
  );
  errors.push(
    ...missingFillTransfers.map(
      (hash) => `recorded fill ${hash} is missing its stock or USDT transfer.`
    )
  );
  return {
    valid: errors.length === 0,
    outcome: errors.length === 0 ? "kept" : "broken",
    errors,
    matchedTransfers,
    missingTransfers,
    unexpectedTransfers,
    missingFillTransfers
  };
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
    label: "The plan matches what Redeye published",
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
    label: `BNB Chain holds the same plan #${run.planId}`,
    state: onChain.planHash === recomputed ? "pass" : "fail",
    detail: `On chain ${onChain.planHash.slice(0, 14)}… for ${onChain.ticker}`
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
    label: "The decision matches what is on chain",
    state:
      decisionEvent?.decisionHash === decisionHash && decisionHash === run.decision.decisionHash
        ? "pass"
        : "fail",
    detail: `Recomputed ${decisionHash.slice(0, 14)}… from the prices and rules the agent saw`
  });

  const fill = run.trade?.order;
  if (fill?.status === "FINISHED" && fill.txHash) {
    const swap = await client.getTransactionReceipt({ hash: fill.txHash });
    push({
      label: "The trade is on chain",
      state:
        swap.status === "success" &&
        [swap.from, swap.to].some((a) => a?.toLowerCase() === run.trade!.wallet.toLowerCase())
          ? "pass"
          : "fail",
      detail: `Made by the plan's wallet ${run.trade!.wallet.slice(0, 6)}…${run.trade!.wallet.slice(-4)} in block ${swap.blockNumber}`
    });
  }

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
    label: "The result matches what is on chain",
    state: verdictEvent?.verdictHash === verdictHash && verdictHash === published ? "pass" : "fail",
    detail: `${verdict.outcome}${verdict.openPrice ? `, open ${verdict.openPrice}` : ""}`
  });

  if (run.plan.door === "agentic_wallet" || run.plan.door === "plan_account") {
    const reconciliation = run.reconciliation;
    if (!reconciliation) {
      push({
        label: "Wallet transfers match the recorded trades",
        state: "fail",
        detail: "The agent did not publish transfer reconciliation for this trading plan."
      });
      return steps;
    }
    const publishedHash = hashCanonical(reconciliation);
    const observed = await checkedTransfers(reconciliation);
    const recomputed = compareTransfers(reconciliation, observed);
    const resultMatches = hashCanonical(recomputed) === hashCanonical(reconciliation.result);
    const hashMatches = publishedHash === run.verdict.reconciliationHash;
    push({
      label: "Wallet transfers match the recorded trades",
      state: resultMatches && hashMatches && recomputed.valid ? "pass" : "fail",
      detail:
        resultMatches && hashMatches
          ? `${observed.length} wallet transfers checked across blocks ${reconciliation.fromBlock}–${reconciliation.toBlock}.`
          : "The published reconciliation does not match the wallet's transfer logs on BNB Smart Chain."
    });
  }
  return steps;
}
