import {
  createPublicClient,
  createWalletClient,
  formatUnits,
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
  "function freezeStandingPlan(address planOwner, bytes32 eventKey, bytes32 planHash, bytes32 standingRunHash, string ticker, uint64 releaseTs, uint256 jobId) returns (uint256)",
  "function recordDecision(uint256 planId, bytes32 decisionHash)",
  "function recordFill(uint256 planId, bytes32 txHash, uint8 step)",
  "function recordVerdict(uint256 planId, uint8 outcome, bytes32 verdictHash)",
  "function cancelPlan(uint256 planId)",
  "event PlanFrozen(uint256 indexed planId, address indexed owner, bytes32 indexed eventKey, bytes32 planHash, string ticker, uint64 releaseTs, uint256 jobId)"
]);

const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
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
  /** Set for one night's copy of a standing plan; links the copy to its run on chain. */
  standingRunHash?: Hex;
  /** The plan's ERC-8183 job, or 0 when it has none. */
  jobId?: number;
}

/** Writes to PlanBook. Every method waits for the transaction to be mined. */
export interface PlanChain {
  readonly agentAddress: Address;
  freeze(input: FreezeInput): Promise<ChainWrite & { planId: number }>;
  recordDecision(planId: number, decisionHash: Hex): Promise<ChainWrite>;
  recordFill(planId: number, txHash: Hex, step: number): Promise<ChainWrite>;
  /**
   * The amount of `token` that reached `account` in a mined transaction, read from its
   * Transfer logs, in whole-token units.
   */
  received(txHash: Hex, token: Address, account: Address): Promise<string>;
  /** What `account` holds of `token` now, in whole-token units. */
  balance(token: Address, account: Address): Promise<string>;
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
    functionName:
      | "freezePlan"
      | "freezeStandingPlan"
      | "recordDecision"
      | "recordFill"
      | "recordVerdict"
      | "cancelPlan",
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
      const lockTs = BigInt(Math.floor(input.lockTs / 1000));
      const { receipt, write } =
        input.standingRunHash === undefined
          ? await send("freezePlan", [
              input.owner,
              input.eventKey,
              input.planHash,
              input.ticker,
              lockTs,
              BigInt(input.jobId ?? 0)
            ])
          : await send("freezeStandingPlan", [
              input.owner,
              input.eventKey,
              input.planHash,
              input.standingRunHash,
              input.ticker,
              lockTs,
              BigInt(input.jobId ?? 0)
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
    async recordFill(planId, txHash, step) {
      return (await send("recordFill", [BigInt(planId), txHash, step])).write;
    },
    async received(txHash, token, account) {
      const receipt = await reader.getTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`Transaction failed: ${txHash}`);
      const transfers = parseEventLogs({
        abi: ERC20_ABI,
        eventName: "Transfer",
        logs: receipt.logs
      });
      const raw = transfers
        .filter(
          (log) =>
            log.address.toLowerCase() === token.toLowerCase() &&
            log.args.to.toLowerCase() === account.toLowerCase()
        )
        .reduce((sum, log) => sum + log.args.value, 0n);
      const decimals = await reader.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "decimals"
      });
      return formatUnits(raw, decimals);
    },
    async balance(token, account) {
      const [raw, decimals] = await Promise.all([
        reader.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account]
        }),
        reader.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" })
      ]);
      return formatUnits(raw, decimals);
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
