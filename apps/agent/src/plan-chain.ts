import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

export const PLAN_BOOK_ABI = parseAbi([
  "function freezePlan(address planOwner, bytes32 eventKey, bytes32 planHash, string ticker, uint64 releaseTs, uint256 jobId) returns (uint256)",
  "function recordDecision(uint256 planId, bytes32 decisionHash)",
  "function recordVerdict(uint256 planId, uint8 outcome, bytes32 verdictHash)",
  "function cancelPlan(uint256 planId)",
  "event PlanFrozen(uint256 indexed planId, address indexed owner, bytes32 indexed eventKey, bytes32 planHash, string ticker, uint64 releaseTs, uint256 jobId)"
]);

/** PlanBook outcome codes. */
export const OUTCOME_CODES = { kept: 1, refused: 2, broken: 3 } as const;
export type Outcome = keyof typeof OUTCOME_CODES;

export interface ChainWrite {
  txHash: Hex;
  blockNumber: string;
  blockTs: number;
}

export interface FreezeInput {
  owner: Address;
  eventKey: Hex;
  planHash: Hex;
  ticker: string;
  lockTs: number;
}

/** Writes to PlanBook. Every method waits for the transaction to be mined. */
export interface PlanChain {
  readonly agentAddress: Address;
  freeze(input: FreezeInput): Promise<ChainWrite & { planId: number }>;
  recordDecision(planId: number, decisionHash: Hex): Promise<ChainWrite>;
  recordVerdict(planId: number, outcome: Outcome, verdictHash: Hex): Promise<ChainWrite>;
  cancel(planId: number): Promise<ChainWrite>;
}

export interface PlanChainOptions {
  rpcUrl: string;
  planBook: Address;
  privateKey: Hex;
}

export function createPlanChain(options: PlanChainOptions): PlanChain {
  const account = privateKeyToAccount(options.privateKey);
  const transport = http(options.rpcUrl, { timeout: 30_000, retryCount: 2 });
  const reader = createPublicClient({ chain: bsc, transport });
  const writer = createWalletClient({ account, chain: bsc, transport });

  async function send(
    functionName: "freezePlan" | "recordDecision" | "recordVerdict" | "cancelPlan",
    args: readonly unknown[]
  ) {
    // Simulating first turns a contract revert into a readable error before any fee is spent.
    const { request } = await reader.simulateContract({
      account,
      address: options.planBook,
      abi: PLAN_BOOK_ABI,
      functionName,
      args
    } as Parameters<typeof reader.simulateContract>[0]);
    const txHash = await writer.writeContract(request);
    const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success")
      throw new Error(`PlanBook ${functionName} reverted: ${txHash}`);
    const block = await reader.getBlock({ blockNumber: receipt.blockNumber });
    return {
      receipt,
      write: {
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        blockTs: Number(block.timestamp)
      }
    };
  }

  return {
    agentAddress: account.address,
    async freeze(input) {
      const { receipt, write } = await send("freezePlan", [
        input.owner,
        input.eventKey,
        input.planHash,
        input.ticker,
        BigInt(Math.floor(input.lockTs / 1000)),
        0n
      ]);
      const [frozen] = parseEventLogs({
        abi: PLAN_BOOK_ABI,
        eventName: "PlanFrozen",
        logs: receipt.logs
      });
      if (!frozen) throw new Error(`PlanBook freeze emitted no PlanFrozen event: ${write.txHash}`);
      return { ...write, planId: Number(frozen.args.planId) };
    },
    async recordDecision(planId, decisionHash) {
      return (await send("recordDecision", [BigInt(planId), decisionHash])).write;
    },
    async recordVerdict(planId, outcome, verdictHash) {
      return (await send("recordVerdict", [BigInt(planId), OUTCOME_CODES[outcome], verdictHash]))
        .write;
    },
    async cancel(planId) {
      return (await send("cancelPlan", [BigInt(planId)])).write;
    }
  };
}
