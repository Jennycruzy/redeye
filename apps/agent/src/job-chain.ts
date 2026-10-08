import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import type { ChainWrite } from "./plan-chain.js";

/**
 * ERC-8183 contracts on BNB Chain, from @bnbagent/sdk 0.6.0 and read on chain on 2026-10-07.
 * The commerce contract needs the router as each job's hook; the router only lets a job be
 * funded once a whitelisted policy is registered for it, and the optimistic policy approves
 * a delivered job when nobody disputes it within its window (7 days on 2026-10-07).
 */
export const JOB_COMMERCE = getAddress("0xea4daa3100a767e86fded867729ae7446476eba6");
export const JOB_ROUTER = getAddress("0x51895229e12f9876011789b04f8698af06ccd6da");
export const JOB_POLICY = getAddress("0x9c01845705b3078aa2e8cff7520a6376fd766de5");
export const JOB_TOKEN = getAddress("0x55d398326f99059ff775485246999027b3197955");
/** 0.01 USDT (18 decimals on BNB Chain), the smallest budget the spec allows. */
export const JOB_BUDGET = 10_000_000_000_000_000n;

export const COMMERCE_ABI = parseAbi([
  "struct Job { uint256 id; address client; address provider; address evaluator; string description; uint256 budget; uint256 expiredAt; uint8 status; address hook; uint256 submittedAt; bytes32 deliverable; }",
  "function createJobWithToken(address provider, address evaluator, uint256 expiredAt, string description, address hook, address token) returns (uint256)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
  "function getJob(uint256 jobId) view returns (Job)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)"
]);
const ROUTER_ABI = parseAbi([
  "function registerJob(uint256 jobId, address policy)",
  "function settle(uint256 jobId, bytes evidence)",
  "function jobPolicy(uint256 jobId) view returns (address)"
]);
const POLICY_ABI = parseAbi(["function disputeWindow() view returns (uint64)"]);
const TOKEN_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
]);

export const JOB_STATES = [
  "open",
  "funded",
  "submitted",
  "completed",
  "rejected",
  "expired"
] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * "official": the router is hook and evaluator, and the optimistic policy approves after its
 * dispute window. "team": our PlanJobHook is the hook and the team buyer is the evaluator,
 * approving or rejecting directly; these jobs are labelled as approved by our own wallet.
 */
export type JobKind = "official" | "team";

export interface JobView {
  jobId: number;
  state: JobState;
  budget: bigint;
  hook: Address;
  /** Unix seconds; 0 until delivered. */
  submittedAt: number;
}

export interface JobOpenInput {
  description: string;
  /** Unix seconds after which the buyer may take the budget back. */
  expiresAt: number;
}

/** The plan's job: the team buyer pays, the agent delivers, the router settles. */
export interface JobBook {
  readonly buyerAddress: Address;
  readonly providerAddress: Address;
  /** Seconds a delivered job waits for disputes before it can be settled. */
  disputeWindow(): Promise<number>;
  /**
   * Sends the create transaction. `onSent` runs before waiting for it to be mined, so a
   * crash after sending can be recovered with `createdJobId` instead of opening a second job.
   */
  create(
    input: JobOpenInput,
    kind: JobKind,
    onSent: (txHash: Hex) => Promise<void>
  ): Promise<number>;
  /** False when no PlanJobHook address is configured. */
  readonly teamJobs: boolean;
  /** The job id a sent create transaction made, or null while it is not mined. */
  createdJobId(txHash: Hex): Promise<number | null>;
  /** Registers the policy, sets the budget and pays it in; steps already done are skipped. */
  fund(jobId: number): Promise<Hex[]>;
  deliver(jobId: number, deliverable: Hex): Promise<ChainWrite>;
  /** Settles a delivered official job once its dispute window has passed. */
  settle(jobId: number): Promise<ChainWrite>;
  /** The buyer approves (complete) or rejects a delivered team job. */
  review(jobId: number, approve: boolean, reason: Hex): Promise<ChainWrite>;
  get(jobId: number): Promise<JobView>;
}

export interface JobBookOptions {
  rpcUrl: string;
  buyerKey: Hex;
  agentKey: Hex;
  /** PlanJobHook on BNB Chain; team jobs are off without it. */
  teamHook?: Address | null;
}

export function createJobBook(options: JobBookOptions): JobBook {
  const buyer = privateKeyToAccount(options.buyerKey);
  const agent = privateKeyToAccount(options.agentKey);
  if (buyer.address === agent.address) {
    throw new Error("The job buyer must be a different wallet from the agent.");
  }
  const transport = http(options.rpcUrl, { timeout: 30_000, retryCount: 2 });
  const reader = createPublicClient({ chain: bsc, transport });
  const writers = {
    buyer: createWalletClient({ account: buyer, chain: bsc, transport }),
    agent: createWalletClient({ account: agent, chain: bsc, transport })
  };

  async function send(
    who: keyof typeof writers,
    call: {
      address: Address;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    },
    onSent?: (txHash: Hex) => Promise<void>
  ) {
    const writer = writers[who];
    // Simulating first turns a revert into a readable error before any fee is spent.
    const { request } = await reader.simulateContract({
      ...call,
      account: writer.account
    } as Parameters<typeof reader.simulateContract>[0]);
    const txHash = await writer.writeContract(request);
    if (onSent) await onSent(txHash);
    const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${call.functionName} reverted: ${txHash}`);
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

  function jobIdFrom(logs: Parameters<typeof parseEventLogs>[0]["logs"]): number {
    const [created] = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs }).filter(
      (log) => log.address.toLowerCase() === JOB_COMMERCE.toLowerCase()
    );
    if (!created) throw new Error("The create transaction emitted no JobCreated event.");
    return Number(created.args.jobId);
  }

  async function get(jobId: number): Promise<JobView> {
    const job = await reader.readContract({
      address: JOB_COMMERCE,
      abi: COMMERCE_ABI,
      functionName: "getJob",
      args: [BigInt(jobId)]
    });
    const state = JOB_STATES[job.status];
    if (state === undefined) throw new Error(`Job ${jobId} has unknown status ${job.status}.`);
    return {
      jobId,
      state,
      budget: job.budget,
      hook: job.hook,
      submittedAt: Number(job.submittedAt)
    };
  }

  return {
    buyerAddress: buyer.address,
    providerAddress: agent.address,
    teamJobs: Boolean(options.teamHook),
    async disputeWindow() {
      return Number(
        await reader.readContract({
          address: JOB_POLICY,
          abi: POLICY_ABI,
          functionName: "disputeWindow"
        })
      );
    },
    async create(input, kind, onSent) {
      if (kind === "team" && !options.teamHook) throw new Error("No PlanJobHook is configured.");
      const hook = kind === "team" ? options.teamHook! : JOB_ROUTER;
      const evaluator = kind === "team" ? buyer.address : JOB_ROUTER;
      const { receipt } = await send(
        "buyer",
        {
          address: JOB_COMMERCE,
          abi: COMMERCE_ABI,
          functionName: "createJobWithToken",
          args: [
            agent.address,
            evaluator,
            BigInt(input.expiresAt),
            input.description,
            hook,
            JOB_TOKEN
          ]
        },
        onSent
      );
      return jobIdFrom(receipt.logs);
    },
    async createdJobId(txHash) {
      const receipt = await reader.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (receipt === null) return null;
      if (receipt.status !== "success") throw new Error(`Job create transaction failed: ${txHash}`);
      return jobIdFrom(receipt.logs);
    },
    async fund(jobId) {
      const id = BigInt(jobId);
      const sent: Hex[] = [];
      const job = await get(jobId);
      if (job.state !== "open") return sent;
      // Only router jobs need a policy; team jobs are approved by the buyer.
      const policy =
        job.hook === JOB_ROUTER
          ? await reader.readContract({
              address: JOB_ROUTER,
              abi: ROUTER_ABI,
              functionName: "jobPolicy",
              args: [id]
            })
          : null;
      if (policy === zeroAddress) {
        const { write } = await send("buyer", {
          address: JOB_ROUTER,
          abi: ROUTER_ABI,
          functionName: "registerJob",
          args: [id, JOB_POLICY]
        });
        sent.push(write.txHash);
      }
      if (job.budget !== JOB_BUDGET) {
        const { write } = await send("buyer", {
          address: JOB_COMMERCE,
          abi: COMMERCE_ABI,
          functionName: "setBudget",
          args: [id, JOB_BUDGET, "0x"]
        });
        sent.push(write.txHash);
      }
      const allowance = await reader.readContract({
        address: JOB_TOKEN,
        abi: TOKEN_ABI,
        functionName: "allowance",
        args: [buyer.address, JOB_COMMERCE]
      });
      if (allowance < JOB_BUDGET) {
        // Approve exactly one budget at a time, so the buyer never leaves a standing allowance.
        const { write } = await send("buyer", {
          address: JOB_TOKEN,
          abi: TOKEN_ABI,
          functionName: "approve",
          args: [JOB_COMMERCE, JOB_BUDGET]
        });
        sent.push(write.txHash);
      }
      const { write } = await send("buyer", {
        address: JOB_COMMERCE,
        abi: COMMERCE_ABI,
        functionName: "fund",
        args: [id, JOB_BUDGET, "0x"]
      });
      sent.push(write.txHash);
      return sent;
    },
    async deliver(jobId, deliverable) {
      const { write } = await send("agent", {
        address: JOB_COMMERCE,
        abi: COMMERCE_ABI,
        functionName: "submit",
        args: [BigInt(jobId), deliverable, "0x"]
      });
      return write;
    },
    async settle(jobId) {
      const { write } = await send("agent", {
        address: JOB_ROUTER,
        abi: ROUTER_ABI,
        functionName: "settle",
        args: [BigInt(jobId), "0x"]
      });
      return write;
    },
    async review(jobId, approve, reason) {
      const { write } = await send("buyer", {
        address: JOB_COMMERCE,
        abi: COMMERCE_ABI,
        functionName: approve ? "complete" : "reject",
        args: [BigInt(jobId), reason, "0x"]
      });
      return write;
    },
    get
  };
}
