import type { BinanceEvidence } from "@redeye/core";
import type { BinanceFillCheck, BinanceFillRequest, BinanceGate } from "./binance-gate.js";
import { describe, expect, it } from "vitest";
import {
  createWindowRecord,
  createStandingRun,
  expandStandingPlan,
  hashCanonical,
  hashPlan,
  nextWindow,
  planPermissionTypedData,
  deserializePlanPermission,
  serializePlanPermission,
  type NormalizedQuote,
  type WalletContext,
  SIGNED_PLAN_DOMAIN,
  SIGNED_PLAN_TYPES,
  signedPlanMessage,
  type ReceiptReconciliation,
  verifyReceipt
} from "@redeye/core";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import { AgenticWallet, type BawRunner, type OrderResult } from "./agentic-wallet.js";
import type { JobBook, JobKind, JobOpenInput, JobState, JobView } from "./job-chain.js";
import type { ChainWrite, FreezeInput, Outcome, PlanChain } from "./plan-chain.js";
import {
  lockableWindow,
  PlanError,
  PlanService,
  type PermissionTrader,
  type OfficialOpen,
  type StoredPermission,
  type StoredPlan
} from "./plan-service.js";
import type { ExactCall } from "./plan-account.js";
import type { PriceSnapshotOk } from "./price-service.js";
import { FakeDatabase } from "./fake-database.js";
import { SqliteAgentStore } from "./sqlite-store.js";

const AGENT = "0xe201bbf3C736a5d188797974a7e4B9464f707eA8";
const NVDA_TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const TSLA_TOKEN = "0x00000000000000000000000000000000000075a1";
const MULTIPLIER = Number("1.000778223752807865");
// Wednesday 7 Oct 2026, 2 pm in New York; the window runs 20:00 UTC to 13:30 UTC on 8 Oct.
const BEFORE_CLOSE = Date.parse("2026-10-07T18:00:00.000Z");
const CLOSE = Date.parse("2026-10-07T20:00:00.000Z");
const OPEN = Date.parse("2026-10-08T13:30:00.000Z");
const MINUTE = 60_000;

class FakeChain implements PlanChain {
  readonly agentAddress = AGENT;
  readonly freezes: FreezeInput[] = [];
  readonly decisions: Array<{ planId: number; hash: Hex }> = [];
  readonly verdicts: Array<{ planId: number; outcome: Outcome; hash: Hex }> = [];
  readonly cancels: number[] = [];
  readonly fills: Array<{ planId: number; txHash: Hex; step: number }> = [];
  /** Shared with the fake wallet so tests can check the order of on-chain steps. */
  readonly log: string[] = [];
  receivedAmount = "0";
  private block = 0;

  constructor(private readonly clock: () => number) {}

  private write(): ChainWrite {
    this.block += 1;
    return {
      txHash: `0x${this.block.toString(16).padStart(64, "0")}`,
      blockNumber: String(this.block),
      blockTs: Math.floor(this.clock() / 1000)
    };
  }

  async freeze(input: FreezeInput) {
    // Like PlanBook: one plan per owner and window.
    if ((await this.planIdFor(input.owner, input.eventKey)) !== 0)
      throw new Error("DuplicatePlan()");
    this.freezes.push(input);
    return { ...this.write(), planId: this.freezes.length };
  }

  async planIdFor(owner: Address, eventKey: Hex) {
    const index = this.freezes.findIndex(
      (freeze) => freeze.owner === owner && freeze.eventKey === eventKey
    );
    return index + 1;
  }

  async recordDecision(planId: number, hash: Hex) {
    this.decisions.push({ planId, hash });
    this.log.push("decision");
    return this.write();
  }

  async recordFill(planId: number, txHash: Hex, step: number) {
    this.fills.push({ planId, txHash, step });
    this.log.push("fill");
    return this.write();
  }

  async received() {
    return this.receivedAmount;
  }

  /** Whole-token balances by token address (lowercase) for every account; plenty by default. */
  readonly balances = new Map<string, string>();
  readonly balanceReads: Array<{ token: string; account: string }> = [];

  async balance(token: Address, account: Address) {
    this.balanceReads.push({ token: token.toLowerCase(), account });
    return this.balances.get(token.toLowerCase()) ?? "1000000";
  }

  async recordVerdict(planId: number, outcome: Outcome, hash: Hex) {
    this.verdicts.push({ planId, outcome, hash });
    return this.write();
  }

  async cancel(planId: number) {
    this.cancels.push(planId);
    return this.write();
  }
}

const BUYER = "0x1111111111111111111111111111111111111111";
const WEEK_S = 7 * 24 * 60 * 60;

/** Stands in for the ERC-8183 contracts, following the states the live contracts use. */
class FakeJobs implements JobBook {
  readonly buyerAddress = BUYER;
  readonly providerAddress = AGENT;
  readonly opened: JobOpenInput[] = [];
  readonly kinds: JobKind[] = [];
  readonly reviews: Array<{ jobId: number; approve: boolean; reason: Hex }> = [];
  teamJobs = false;
  readonly delivered: Array<{ jobId: number; deliverable: Hex }> = [];
  readonly settled: number[] = [];
  readonly states = new Map<number, JobState>();
  /** Failures to throw from the next calls, by method name. */
  readonly failNext = new Map<string, string>();
  /** When true, the create transaction is sent but the reply is lost, like a crash. */
  loseCreateReply = false;
  /** Job id a sent create transaction made, once mined. */
  readonly sent = new Map<Hex, number>();
  private block = 1000;

  constructor(private readonly clock: () => number) {}

  private fail(method: string): void {
    const message = this.failNext.get(method);
    if (message === undefined) return;
    this.failNext.delete(method);
    throw new Error(message);
  }

  private write(): ChainWrite {
    this.block += 1;
    return {
      txHash: `0x${this.block.toString(16).padStart(64, "0")}`,
      blockNumber: String(this.block),
      blockTs: Math.floor(this.clock() / 1000)
    };
  }

  async disputeWindow() {
    return WEEK_S;
  }

  async create(input: JobOpenInput, kind: JobKind, onSent: (txHash: Hex) => Promise<void>) {
    this.fail("create");
    this.opened.push(input);
    this.kinds.push(kind);
    const jobId = 56_910 + this.opened.length;
    const { txHash } = this.write();
    this.sent.set(txHash, jobId);
    this.states.set(jobId, "open");
    await onSent(txHash);
    if (this.loseCreateReply) throw new Error("connection reset");
    return jobId;
  }

  async createdJobId(txHash: Hex) {
    return this.sent.get(txHash) ?? null;
  }

  async fund(jobId: number) {
    this.fail("fund");
    if (this.states.get(jobId) !== "open") return [];
    this.states.set(jobId, "funded");
    return [this.write().txHash, this.write().txHash];
  }

  async deliver(jobId: number, deliverable: Hex) {
    this.fail("deliver");
    this.delivered.push({ jobId, deliverable });
    this.states.set(jobId, "submitted");
    return this.write();
  }

  async settle(jobId: number) {
    this.settled.push(jobId);
    this.states.set(jobId, "completed");
    return this.write();
  }

  async get(jobId: number): Promise<JobView> {
    return {
      jobId,
      state: this.states.get(jobId)!,
      budget: 10n ** 16n,
      hook: BUYER,
      submittedAt: 0
    };
  }

  async review(jobId: number, approve: boolean, reason: Hex) {
    this.reviews.push({ jobId, approve, reason });
    this.states.set(jobId, approve ? "completed" : "rejected");
    return this.write();
  }
}

const WALLET = "0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2";

/** Stands in for the `baw` tool, answering with the reply shapes Binance documents. */
class FakeBaw {
  readonly calls: string[][] = [];
  sessionEnd = "2026-10-09T14:54:10+00:00";
  quotaLeft = 1000;
  /** USDT per stock token in quotes. */
  pricePerToken = "191.5";
  /** Status returned on each order lookup, in turn; the last one repeats. */
  statuses: Array<"PENDING" | "FINISHED" | "FAILED"> = ["FINISHED"];
  /** When set, the swap reaches the wallet but the reply is lost, like a crash. */
  loseSwapReply = false;
  readonly orders: Array<{ orderId: string; fromTokenQty: string }> = [];

  constructor(private readonly log: string[]) {}

  run: BawRunner = async (args) => {
    this.calls.push(args);
    const [group, command] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
    if (group === "wallet" && command === "settings") {
      return {
        dailyLimit: 1000,
        quotaLeft: this.quotaLeft,
        tradeAllTokens: false,
        sessionExpireTime: this.sessionEnd,
        inactiveSignOutTime: this.sessionEnd
      };
    }
    if (group === "wallet" && command === "address") {
      return { addresses: [{ binanceChainId: "56", chainName: "BSC", address: WALLET }] };
    }
    if (group === "market-order" && command === "quote") {
      // Like the real tool, NVDAB amounts are real shares (tokens × multiplier).
      const qty = Number(flag("--fromTokenQty"));
      const selling = flag("--fromToken").toLowerCase() === NVDA_TOKEN;
      const pricePerShare = Number(this.pricePerToken) / MULTIPLIER;
      return {
        toCoinAmount: String(selling ? qty * pricePerShare : qty / pricePerShare),
        slippage: 0.01
      };
    }
    if (group === "market-order" && command === "swap") {
      this.log.push("swap");
      const n = this.orders.length + 1;
      this.orders.push({ orderId: `order-${n}`, fromTokenQty: flag("--fromTokenQty") });
      if (this.loseSwapReply) throw new Error("connection reset");
      // Like the real tool, the reply's id is not the id the order is listed under.
      return { orderId: `reply-${n}` };
    }
    if (group === "market-order" && command === "list") {
      const wanted = args.includes("--orderId") ? flag("--orderId") : null;
      const order =
        wanted === null ? this.orders.at(-1) : this.orders.find((o) => o.orderId === wanted);
      if (order === undefined) return { list: [] };
      const status = this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0]!;
      const txHash = status === "FINISHED" ? `0x${"ab".repeat(32)}` : null;
      return { list: [{ ...order, status, txHash }] };
    }
    throw new Error(`unexpected baw call: ${args.join(" ")}`);
  };
}

class FakePermissionTrader implements PermissionTrader {
  readonly ensured: Array<{ owner: Address; permission: string }> = [];
  readonly delegationTx: Hex = `0x${"cd".repeat(32)}`;
  /** Set to quote through the fake wallet tool, so the door can trade in tests. */
  quoter: AgenticWallet | null = null;
  /** Transactions swap() sent, as built by exactCall(). */
  readonly sent: ExactCall[] = [];
  /** Changes the built calldata on every call, to model a transaction that drifted. */
  drift = false;
  private built = 0;

  exactCall(quote: NormalizedQuote, slippagePct: string, permission: StoredPermission): ExactCall {
    const salt = this.drift ? (this.built += 1) : 0;
    const data = toHex(`${quote.id}|${slippagePct}|${permission.owner}|${salt}`);
    return {
      from: AGENT as Address,
      to: permission.owner,
      value: 0n,
      data,
      tokenIn: permission.permission.tokenIn as Address,
      tokenOut: permission.permission.tokenOut as Address,
      amountIn: 1n,
      minAmountOut: 1n
    };
  }

  async address(): Promise<Address> {
    return AGENT;
  }

  async context(
    requiredQuotaUsd: string,
    requiredUntilMs: number,
    _account?: Address
  ): Promise<WalletContext> {
    void _account;
    return {
      connected: true,
      tokenAllowed: true,
      quotaLeftUsd: requiredQuotaUsd,
      requiredQuotaUsd,
      sessionExpiresAtMs: requiredUntilMs + 1,
      requiredUntilMs
    };
  }

  async quote(request: Parameters<PermissionTrader["quote"]>[0]): Promise<NormalizedQuote> {
    if (!this.quoter) throw new Error("quote not used by lock test");
    return this.quoter.quote(request);
  }

  async swap(
    quote: NormalizedQuote,
    slippagePct: string,
    permission: Parameters<PermissionTrader["swap"]>[2]
  ): Promise<OrderResult> {
    if (!this.quoter) throw new Error("swap not used by lock test");
    this.sent.push(this.exactCall(quote, slippagePct, permission));
    return { orderId: `0x${"ab".repeat(32)}`, status: "FINISHED", txHash: `0x${"ab".repeat(32)}` };
  }

  async waitForOrder(_orderId: string): Promise<never> {
    void _orderId;
    throw new Error("order not used by lock test");
  }

  async findOrder(_quote: NormalizedQuote, _sinceMs: number, _replyId?: string): Promise<null> {
    void _quote;
    void _sinceMs;
    void _replyId;
    return null;
  }

  async ensureAccount(owner: Address, permission: Parameters<PermissionTrader["swap"]>[2]) {
    this.ensured.push({ owner, permission: permission.permission.planHash });
    return this.delegationTx;
  }
}

function snapshot(atMs: number, real: string, closeDate = "2026-10-07"): PriceSnapshotOk {
  const at = new Date(atMs).toISOString();
  const point = (value: string, source: string) => ({
    value,
    source,
    fetchedAt: at,
    ageSeconds: 0,
    sourceRecordPath: `raw/${source}.json`
  });
  return {
    v: 1,
    state: "ok",
    ticker: "NVDA",
    at,
    close: { ...point("200", "nasdaq:NVDA:daily-history"), date: closeDate },
    real: point(real, "hyperliquid:xyz:NVDA"),
    token: point(real, "geckoterminal:bsc:pool"),
    gaps: { tokenToClosePct: "0", tokenToRealPct: "0" },
    pool: { address: "0xpool", reserveUsd: "6000000", source: "gecko" }
  };
}

interface Harness {
  database: FakeDatabase;
  store: SqliteAgentStore;
  chain: FakeChain;
  baw: FakeBaw;
  jobs: FakeJobs;
  permissionTrader: FakePermissionTrader | null;
  service: PlanService;
  logs: Record<string, unknown>[];
  setNow(atMs: number): void;
  setPrice(price: PriceSnapshotOk | null): void;
  setOpen(open: OfficialOpen | null): void;
}

function reconciledWindow(plans: StoredPlan[]): ReceiptReconciliation {
  const fillChecks: ReceiptReconciliation["fillChecks"] = plans.flatMap((plan) => {
    const trade = plan.trade;
    const txHash = trade?.order?.txHash;
    if (trade?.order?.status !== "FINISHED" || !txHash || !plan.plan) return [];
    return [
      {
        txHash,
        account: trade.wallet.toLowerCase(),
        stockTokenAddress: plan.plan.tokenAddress.toLowerCase(),
        side: plan.plan.kind === "buy_dip" ? "buy" : "sell"
      }
    ];
  });
  const expectedTransfers = fillChecks.flatMap(
    (fill): ReceiptReconciliation["expectedTransfers"] => [
      {
        tokenAddress: USDT.toLowerCase(),
        account: fill.account,
        direction: fill.side === "buy" ? "out" : "in",
        amountRaw: "100",
        txHash: fill.txHash,
        logIndex: 0
      },
      {
        tokenAddress: fill.stockTokenAddress,
        account: fill.account,
        direction: fill.side === "buy" ? "in" : "out",
        amountRaw: "100",
        txHash: fill.txHash,
        logIndex: 1
      }
    ]
  );
  return {
    v: 1,
    fromBlock: "0x1",
    toBlock: "0x2",
    accounts: [WALLET.toLowerCase()],
    tokenAddresses: [USDT.toLowerCase(), NVDA_TOKEN],
    expectedTransfers,
    fillChecks,
    result: {
      valid: true,
      outcome: "kept",
      errors: [],
      matchedTransfers: expectedTransfers.map((transfer) => ({
        expected: transfer,
        observed: { ...transfer }
      })),
      missingTransfers: [],
      unexpectedTransfers: [],
      missingFillTransfers: []
    }
  };
}

async function harness(
  options: {
    chain?: boolean;
    baw?: boolean;
    reconciliation?: boolean;
    jobs?: boolean;
    teamJobLimit?: number;
    signedDailyCap?: number;
    planAccount?: boolean;
    newId?: () => string;
    binance?: BinanceGate;
    binanceFill?: (request: BinanceFillRequest) => Promise<BinanceFillCheck | null>;
    /** A process restart: a new store and service over the same database, chain, wallet and jobs. */
    restartOf?: Harness;
  } = {}
): Promise<Harness> {
  const before = options.restartOf;
  let now = BEFORE_CLOSE;
  let price: PriceSnapshotOk | null = null;
  let open: OfficialOpen | null = null;
  const database = before?.database ?? new FakeDatabase();
  const store = new SqliteAgentStore(database);
  const logs: Record<string, unknown>[] = [];
  const chain = before?.chain ?? new FakeChain(() => now);
  const baw = before?.baw ?? new FakeBaw(chain.log);
  const jobs = before?.jobs ?? new FakeJobs(() => now);
  jobs.teamJobs = (options.teamJobLimit ?? 0) > 0;
  const trader = options.baw
    ? new AgenticWallet(
        baw.run,
        () => now,
        // Waiting moves the test clock, so order timeouts behave as in real time.
        async (ms) => {
          now += ms;
        }
      )
    : null;
  const permissionTrader = options.planAccount ? new FakePermissionTrader() : null;
  if (permissionTrader && trader) permissionTrader.quoter = trader;
  const service = new PlanService({
    store,
    chain: options.chain === false ? null : chain,
    trader,
    permissionTrader,
    ...(options.planAccount
      ? {
          planAccount: {
            template: "0x0000000000000000000000000000000000007001" as Address,
            router: "0x0000000000000000000000000000000000007002" as Address
          }
        }
      : {}),
    jobs: options.jobs ? jobs : null,
    teamJobLimit: options.teamJobLimit ?? 0,
    ...(options.binance === undefined ? {} : { binance: options.binance }),
    ...(options.binanceFill === undefined ? {} : { binanceFill: options.binanceFill }),
    ...(options.signedDailyCap === undefined ? {} : { signedDailyCap: options.signedDailyCap }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    now: () => now,
    ...(options.reconciliation
      ? { reconcileWindow: async (plans: StoredPlan[]) => reconciledWindow(plans) }
      : {}),
    latestPrice: async () => price,
    listedToken: async (ticker) =>
      ticker === "NVDA"
        ? { address: NVDA_TOKEN, multiplier: "1.000778223752807865", multiplierAgreement: true }
        : ticker === "TSLA"
          ? { address: TSLA_TOKEN, multiplier: "1", multiplierAgreement: true }
          : null,
    officialOpen: async () => open,
    log: (line) => logs.push(line)
  });
  return {
    database,
    store,
    chain,
    baw,
    jobs,
    permissionTrader,
    service,
    logs,
    setNow: (atMs) => {
      now = atMs;
      // The shared chain and job fakes still read the first process's clock.
      before?.setNow(atMs);
    },
    setPrice: (value) => {
      price = value;
    },
    setOpen: (value) => {
      open = value;
    }
  };
}

const guardInput = {
  ticker: "NVDA",
  kind: "guard",
  heldShares: "2",
  params: {
    maxPriceImpactPct: "1",
    minPoolDepthUsd: "100000",
    triggerDropPct: "3",
    sellPct: "50",
    maxGapToRealPricePct: "1"
  }
};

async function lockedGuard(h: Harness): Promise<StoredPlan> {
  const draft = (await h.store.planDraft(guardInput)) as StoredPlan;
  return h.service.lock(draft.id);
}

async function plan(h: Harness, id: string): Promise<StoredPlan> {
  const stored = await h.store.getPlan(id);
  if (stored === null) throw new Error("plan missing");
  return stored;
}

describe("plan service", () => {
  it("locks a plan in PlanBook for tonight's window", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    const window = nextWindow(BEFORE_CLOSE);
    const event = createWindowRecord(window.kind, "NVDA", window.closeTs, window.openTs);

    expect(locked.status).toBe("locked");
    expect(window).toMatchObject({ kind: "overnight", closeTs: CLOSE, openTs: OPEN });
    expect(h.chain.freezes).toEqual([
      {
        owner: AGENT,
        eventKey: event.eventKey,
        planHash: hashPlan(locked.plan!),
        ticker: "NVDA",
        lockTs: CLOSE
      }
    ]);
    expect(locked.plan).toMatchObject({ tokenAddress: NVDA_TOKEN, wrapper: "bStock" });
    expect(await h.store.record()).toMatchObject({
      open: 1,
      items: [
        {
          id: locked.id,
          planId: 1,
          status: "locked",
          outcome: null,
          closeTs: CLOSE,
          promise: "If the 24/7 price falls 3% below the close, sell 50% of 2 NVDA shares."
        }
      ]
    });
  });

  it("refuses to lock inside the last five minutes before the close", async () => {
    const h = await harness();
    h.setNow(CLOSE - 4 * MINUTE);
    const draft = (await h.store.planDraft(guardInput)) as StoredPlan;
    await expect(h.service.lock(draft.id)).rejects.toMatchObject({ code: "LOCK_MISSED" });
    expect(h.chain.freezes).toHaveLength(0);
  });

  it("refuses plans that are out of bounds, unlisted or have no PlanBook", async () => {
    const h = await harness();
    const wide = (await h.store.planDraft({
      ...guardInput,
      params: { ...guardInput.params, triggerDropPct: "40" }
    })) as StoredPlan;
    await expect(h.service.lock(wide.id)).rejects.toMatchObject({ code: "PLAN_INVALID" });
    const unlisted = (await h.store.planDraft({ ...guardInput, ticker: "ZZZZ" })) as StoredPlan;
    await expect(h.service.lock(unlisted.id)).rejects.toMatchObject({ code: "TOKEN_NOT_LISTED" });
    const earnings = (await h.store.planDraft({ ...guardInput, kind: "react" })) as StoredPlan;
    await expect(h.service.lock(earnings.id)).rejects.toBeInstanceOf(PlanError);

    const without = await harness({ chain: false });
    const draft = (await without.store.planDraft(guardInput)) as StoredPlan;
    await expect(without.service.lock(draft.id)).rejects.toMatchObject({
      status: 503,
      code: "PLANBOOK_NOT_CONFIGURED"
    });
    expect(h.chain.freezes).toHaveLength(0);
  });

  it("keeps the promise when the trigger is never reached", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);

    h.setNow(CLOSE + 30 * MINUTE);
    h.setPrice(snapshot(CLOSE + 30 * MINUTE, "199"));
    await h.service.tick();
    expect((await plan(h, locked.id)).status).toBe("locked");
    expect(h.chain.decisions).toHaveLength(0);

    h.setNow(OPEN + MINUTE);
    h.setPrice(snapshot(OPEN + MINUTE, "198.5"));
    await h.service.tick();
    expect((await plan(h, locked.id)).status).toBe("decided");
    expect(h.chain.verdicts).toHaveLength(0);
    // The public record shows the decision while the open price is still awaited.
    expect(await h.store.record()).toMatchObject({
      open: 1,
      items: [{ status: "decided", outcome: null }]
    });

    h.setOpen({ value: "198.10", source: "nasdaq:NVDA:daily-history", sourceRecordPath: "raw/x" });
    h.setNow(OPEN + 20 * MINUTE);
    await h.service.tick();
    const done = await plan(h, locked.id);
    expect(done.status).toBe("done");
    expect(done.verdict).toMatchObject({
      outcome: "kept",
      reason: "CONDITION_NOT_MET",
      openPrice: "198.10"
    });
    expect(h.chain.verdicts).toEqual([
      { planId: 1, outcome: "kept", hash: done.verdict!.verdictHash }
    ]);

    const receipt = await h.store.receipt(locked.id);
    expect(verifyReceipt(receipt as Parameters<typeof verifyReceipt>[0])).toMatchObject({
      valid: true
    });
    expect(await h.store.record()).toMatchObject({
      kept: 1,
      open: 0,
      items: [{ status: "done", outcome: "kept", openPrice: "198.10" }]
    });
  });

  it("publishes a refusal when a triggered plan cannot trade yet", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);

    const triggeredAt = CLOSE + 3 * 60 * MINUTE;
    h.setNow(triggeredAt);
    h.setPrice(snapshot(triggeredAt, "192"));
    await h.service.tick();
    const decided = await plan(h, locked.id);
    expect(decided.status).toBe("decided");
    expect(decided.decision?.decision.refusal?.code).toBe("EXECUTION_DISABLED");
    expect(decided.decision?.at).toBe(triggeredAt);

    h.setOpen({ value: "193", source: "nasdaq:NVDA:daily-history", sourceRecordPath: "raw/x" });
    h.setNow(OPEN + 30 * MINUTE);
    await h.service.tick();
    expect((await plan(h, locked.id)).verdict).toMatchObject({
      outcome: "refused",
      reason: "EXECUTION_DISABLED"
    });
    expect(h.chain.decisions).toHaveLength(1);
  });

  it("waits for tonight's official close before checking", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    h.setNow(CLOSE + 10 * MINUTE);
    h.setPrice(snapshot(CLOSE + 10 * MINUTE, "150", "2026-10-06"));
    await h.service.tick();
    const stored = await plan(h, locked.id);
    expect(stored.status).toBe("locked");
    expect(stored.lastEvaluation).toBeUndefined();
  });

  it("does not end a plan on a stale 24/7 price", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    const atMs = CLOSE + 60 * MINUTE;
    h.setNow(atMs);
    h.setPrice(snapshot(atMs - 10 * MINUTE, "150"));
    await h.service.tick();
    const stored = await plan(h, locked.id);
    expect(stored.status).toBe("locked");
    expect(stored.lastEvaluation?.refusal).toBe("REAL_PRICE_UNAVAILABLE");
    expect(h.chain.decisions).toHaveLength(0);
  });

  it("clears a past error once a pass succeeds while waiting for the open", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    h.setNow(OPEN + MINUTE);
    h.setPrice(snapshot(OPEN + MINUTE, "199"));
    await h.service.tick();
    await h.store.savePlan({
      ...(await plan(h, locked.id)),
      lastError: { at: "2026-10-08T13:31:00.000Z", message: "Nasdaq is down" }
    });
    h.setNow(OPEN + 2 * MINUTE);
    await h.service.tick();
    const waiting = await plan(h, locked.id);
    expect(waiting.status).toBe("decided");
    expect(waiting.lastError).toBeUndefined();
  });

  it("publishes without an open price after waiting a full day", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    h.setNow(OPEN + MINUTE);
    h.setPrice(snapshot(OPEN + MINUTE, "199"));
    await h.service.tick();
    h.setNow(OPEN + 25 * 60 * MINUTE);
    await h.service.tick();
    const done = await plan(h, locked.id);
    expect(done.status).toBe("done");
    expect(done.verdict?.openPrice).toBeUndefined();
  });

  it("keeps the error on the plan and retries on the next pass", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    const failing = h.chain.recordDecision.bind(h.chain);
    let failures = 2;
    h.chain.recordDecision = async (planId, hash) => {
      if (failures-- > 0) throw new Error("rpc timeout");
      return failing(planId, hash);
    };
    h.setNow(OPEN + MINUTE);
    h.setPrice(snapshot(OPEN + MINUTE, "199"));
    await h.service.tick();
    expect((await plan(h, locked.id)).lastError?.message).toBe("rpc timeout");
    await h.service.tick();
    // The same error on the next pass is not logged again.
    expect(h.logs).toEqual([
      { code: "PLAN_STEP_FAILED", scope: "plan", id: locked.id, message: "rpc timeout" }
    ]);
    await h.service.tick();
    const decided = await plan(h, locked.id);
    expect(decided.status).toBe("decided");
    expect(decided.lastError).toBeUndefined();
  });

  it("cancels a locked plan before the close only", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    expect((await h.service.cancel(locked.id)).status).toBe("cancelled");
    expect(h.chain.cancels).toEqual([1]);
    expect(await h.store.record()).toMatchObject({
      cancelled: 1,
      open: 0,
      items: [{ status: "cancelled" }]
    });

    const late = await harness();
    const running = await lockedGuard(late);
    late.setNow(CLOSE + MINUTE);
    await expect(late.service.cancel(running.id)).rejects.toMatchObject({
      code: "PLAN_NOT_CANCELLABLE"
    });
    expect(late.chain.cancels).toHaveLength(0);
  });
});

describe("lockable window", () => {
  const NEXT_CLOSE = Date.parse("2026-10-08T20:00:00.000Z");
  const NEXT_OPEN = Date.parse("2026-10-09T13:30:00.000Z");

  it("is tonight until the close, even in its last minutes", () => {
    expect(lockableWindow(BEFORE_CLOSE)).toMatchObject({ closeTs: CLOSE, openTs: OPEN });
    expect(lockableWindow(CLOSE - 3 * MINUTE)).toMatchObject({ closeTs: CLOSE });
  });

  it("moves to the next close once tonight's close has passed", () => {
    expect(lockableWindow(CLOSE)).toMatchObject({ closeTs: NEXT_CLOSE, openTs: NEXT_OPEN });
    expect(lockableWindow(Date.parse("2026-10-08T04:00:00.000Z"))).toMatchObject({
      closeTs: NEXT_CLOSE
    });
  });

  it("skips the weekend to Monday's close", () => {
    const monday = Date.parse("2026-10-12T20:00:00.000Z");
    expect(lockableWindow(Date.parse("2026-10-09T21:00:00.000Z"))).toMatchObject({
      closeTs: monday
    });
    expect(lockableWindow(Date.parse("2026-10-10T12:00:00.000Z"))).toMatchObject({
      closeTs: monday
    });
  });

  it("locks a plan after the close for the next night and waits for that close", async () => {
    const h = await harness();
    h.setNow(Date.parse("2026-10-07T22:00:00.000Z"));
    const locked = await lockedGuard(h);
    expect(h.chain.freezes[0]!.lockTs).toBe(NEXT_CLOSE);
    expect(locked.event).toMatchObject({ lockTs: NEXT_CLOSE, openTs: NEXT_OPEN });

    h.setNow(Date.parse("2026-10-08T15:00:00.000Z"));
    h.setPrice(snapshot(Date.parse("2026-10-08T15:00:00.000Z"), "150", "2026-10-07"));
    await h.service.tick();
    const waiting = await plan(h, locked.id);
    expect(waiting.status).toBe("locked");
    expect(waiting.lastEvaluation).toBeUndefined();
    expect(h.chain.decisions).toHaveLength(0);
  });
});

describe("plan preview", () => {
  it("checks a plan against tonight's window and saves nothing", async () => {
    const h = await harness();
    const preview = await h.service.preview(guardInput);
    expect(preview).toMatchObject({
      valid: true,
      issues: [],
      promise: "If the 24/7 price falls 3% below the close, sell 50% of 2 NVDA shares.",
      window: { kind: "overnight", closeTs: CLOSE, openTs: OPEN, lockBy: CLOSE - 5 * MINUTE }
    });
    expect(preview.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await h.store.listPlans()).toEqual([]);
    expect(h.chain.freezes).toEqual([]);
  });

  it("lists the problems with an out-of-bounds plan", async () => {
    const h = await harness();
    const preview = await h.service.preview({
      ...guardInput,
      params: { ...guardInput.params, triggerDropPct: "40" }
    });
    expect(preview.valid).toBe(false);
    expect(preview.issues.map((issue) => issue.field)).toContain("params.triggerDropPct");
  });

  it("checks against the next close when tonight's has passed", async () => {
    const h = await harness();
    h.setNow(Date.parse("2026-10-08T04:00:00.000Z"));
    expect(await h.service.preview(guardInput)).toMatchObject({
      valid: true,
      window: { closeTs: Date.parse("2026-10-08T20:00:00.000Z") }
    });
  });

  it("reports an unlisted ticker and a passed lock time plainly", async () => {
    const h = await harness();
    expect(await h.service.preview({ ...guardInput, ticker: "ZZZZ" })).toMatchObject({
      valid: false,
      issues: [{ field: "TOKEN_NOT_LISTED" }]
    });
    h.setNow(CLOSE - MINUTE);
    expect((await h.service.preview(guardInput)).issues).toContainEqual({
      field: "lockTs",
      message: "Tonight's lock time has passed."
    });
  });
});

describe("standing plans", () => {
  const standingInput = { ...guardInput, days: 3 };
  const THU_CLOSE = Date.parse("2026-10-08T20:00:00.000Z");
  const FRI_CLOSE = Date.parse("2026-10-09T20:00:00.000Z");

  it("locks tonight's copy at once, linked to the run", async () => {
    const h = await harness();
    const standing = await h.service.startStanding(standingInput);

    expect(standing.status).toBe("active");
    expect(h.chain.freezes).toHaveLength(1);
    expect(h.chain.freezes[0]).toMatchObject({
      lockTs: CLOSE,
      standingRunHash: standing.runHash
    });
    const [night] = Object.values(standing.nights);
    expect(night).toMatchObject({ sequence: 0, status: "locked", closeTs: CLOSE });
    const copy = await plan(h, night!.planStoreId!);
    expect(copy.plan?.standingRunId).toBe(standing.id);
    expect(await h.store.record()).toMatchObject({
      items: [{ standingRunId: standing.id, status: "locked" }]
    });
  });

  it("uses one owner-signed permission across standing windows", async () => {
    const h = await harness({
      planAccount: true,
      newId: () => "unused-server-id"
    });
    const owner = privateKeyToAccount(`0x${"44".repeat(32)}`);
    const input = {
      ...guardInput,
      days: 3,
      runId: "standing-account",
      door: "plan_account",
      auditNoDataAccepted: true,
      owner: owner.address
    };
    const template = {
      kind: "guard" as const,
      standingRunId: "standing-account",
      door: "plan_account" as const,
      auditNoDataAccepted: true,
      ticker: "NVDA",
      wrapper: "bStock" as const,
      tokenAddress: NVDA_TOKEN,
      heldShares: "2",
      params: guardInput.params
    };
    const run = createStandingRun({
      runId: "standing-account",
      template,
      startAtMs: BEFORE_CLOSE,
      untilTs: BEFORE_CLOSE + 3 * 86_400_000
    });
    const copies = expandStandingPlan(run).filter((copy) => copy.lockByMs > BEFORE_CLOSE);
    const runHash = hashCanonical({
      runId: run.runId,
      template: run.template,
      startAtMs: run.startAtMs,
      untilTs: run.untilTs
    });
    const permission = {
      planHash: `0x${"00".repeat(32)}` as Hex,
      standingRunHash: runHash,
      agent: AGENT as Address,
      tokenIn: NVDA_TOKEN as Address,
      tokenOut: USDT as Address,
      maxAmount: 999222381408450703n,
      router: "0x0000000000000000000000000000000000007002" as Address,
      notBefore: BigInt(Math.floor(copies[0]!.event.lockTs! / 1000)),
      notAfter: BigInt(Math.floor(copies.at(-1)!.event.openTs! / 1000)),
      maxPriceDeviationBps: 100n
    };
    const signature = await owner.signTypedData(planPermissionTypedData(owner.address, permission));
    const standing = await h.service.startStanding({
      ...input,
      issuedAt: Math.floor(BEFORE_CLOSE / 1000),
      permission: serializePlanPermission(permission),
      permissionSignature: signature
    });
    expect(standing.owner).toBe(owner.address);
    expect(standing.runHash).toBe(runHash);
    expect(standing.signedPermission).toMatchObject({ owner: owner.address, signature });
    expect(h.chain.freezes[0]).toMatchObject({
      owner: owner.address,
      standingRunHash: runHash
    });
    const night = Object.values(standing.nights)[0]!;
    const copy = await plan(h, night.planStoreId!);
    expect(copy.plan?.door).toBe("plan_account");
    expect(copy.signedPermission?.permission.standingRunHash).toBe(runHash);
    expect(copy.signedPermission?.planHash).toBe(copy.planHash);
    expect(copy.signedPermission?.eventKey).toBe(copy.event?.eventKey);
  });

  it("locks the next night only after the night before it has closed", async () => {
    const h = await harness();
    const standing = await h.service.startStanding(standingInput);

    h.setNow(CLOSE - MINUTE);
    await h.service.tick();
    expect(h.chain.freezes).toHaveLength(1);

    h.setNow(CLOSE + MINUTE);
    await h.service.tick();
    await h.service.tick();
    expect(h.chain.freezes.map((freeze) => freeze.lockTs)).toEqual([CLOSE, THU_CLOSE]);
    const stored = await h.store.getStanding(standing.id);
    expect(Object.values(stored!.nights).map((night) => night.status)).toEqual([
      "locked",
      "locked"
    ]);
  });

  it("publishes a night as missed when its lock time passes without a lock", async () => {
    const h = await harness();
    const standing = await h.service.startStanding(standingInput);

    // The agent is down from Wednesday night until after Thursday's close.
    h.setNow(THU_CLOSE + 30 * MINUTE);
    await h.service.tick();

    expect(h.chain.freezes.map((freeze) => freeze.lockTs)).toEqual([CLOSE, FRI_CLOSE]);
    const stored = await h.store.getStanding(standing.id);
    expect(Object.values(stored!.nights).map((night) => night.status)).toEqual([
      "locked",
      "missed",
      "locked"
    ]);
    expect(await h.store.record()).toMatchObject({
      missed: 1,
      items: expect.arrayContaining([
        expect.objectContaining({ status: "missed", reason: "LOCK_MISSED", planId: null })
      ])
    });
  });

  it("stops future nights but keeps the night already locked", async () => {
    const h = await harness();
    const standing = await h.service.startStanding(standingInput);
    const stopped = await h.service.stopStanding(standing.id);
    expect(stopped.status).toBe("stopped");

    h.setNow(OPEN + MINUTE);
    await h.service.tick();
    expect(h.chain.freezes).toHaveLength(1);
    expect((await h.store.record()) as { open: number }).toMatchObject({ open: 1 });
    await expect(h.service.stopStanding(standing.id)).rejects.toMatchObject({
      code: "STANDING_NOT_ACTIVE"
    });
  });

  it("ends once every night in the run is resolved", async () => {
    const h = await harness();
    const standing = await h.service.startStanding({ ...guardInput, days: 1 });
    expect(Object.keys(standing.nights)).toHaveLength(1);

    h.setNow(BEFORE_CLOSE + 25 * 60 * MINUTE);
    await h.service.tick();
    expect((await h.store.getStanding(standing.id))?.status).toBe("ended");
    expect(h.chain.freezes).toHaveLength(1);
  });

  it("follows the exchange calendar across Thanksgiving", async () => {
    const h = await harness();
    const wednesday = Date.parse("2026-11-25T15:00:00.000Z");
    h.setNow(wednesday);
    const standing = await h.service.startStanding({ ...guardInput, days: 3 });
    const fridayOpen = Date.parse("2026-11-27T14:30:00.000Z");
    h.setNow(fridayOpen + MINUTE);
    await h.service.tick();

    const nights = Object.values((await h.store.getStanding(standing.id))!.nights);
    expect(nights.map((night) => new Date(night.closeTs).toISOString())).toEqual([
      "2026-11-25T21:00:00.000Z",
      "2026-11-27T18:00:00.000Z"
    ]);
    const kinds = await Promise.all(
      nights.map(async (night) => (await plan(h, night.planStoreId!)).event?.kind)
    );
    expect(kinds).toEqual(["holiday", "weekend"]);
  });

  it("rejects bad lengths and out-of-bounds plans before any lock", async () => {
    const h = await harness();
    await expect(h.service.startStanding({ ...guardInput, days: 31 })).rejects.toMatchObject({
      code: "PLAN_INVALID"
    });
    await expect(
      h.service.startStanding({
        ...guardInput,
        days: 3,
        params: { ...guardInput.params, sellPct: "5" }
      })
    ).rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(h.chain.freezes).toHaveLength(0);
    expect(await h.store.listStanding()).toHaveLength(0);
  });
});

describe("trading through the Agentic Wallet", () => {
  const tradingGuard = { ...guardInput, door: "agentic_wallet", auditNoDataAccepted: true };
  const TRIGGERED = CLOSE + 2 * 60 * MINUTE;

  async function triggered(h: Harness): Promise<StoredPlan> {
    const draft = (await h.store.planDraft(tradingGuard)) as StoredPlan;
    const locked = await h.service.lock(draft.id);
    h.setNow(TRIGGERED);
    h.setPrice(snapshot(TRIGGERED, "192"));
    await h.service.tick();
    return plan(h, locked.id);
  }

  it("needs a connected wallet and the owner's audit acceptance to lock", async () => {
    const none = await harness();
    const draft = (await none.store.planDraft(tradingGuard)) as StoredPlan;
    await expect(none.service.lock(draft.id)).rejects.toMatchObject({
      code: "WALLET_NOT_CONNECTED"
    });

    const h = await harness({ baw: true });
    const unaccepted = (await h.store.planDraft({
      ...tradingGuard,
      auditNoDataAccepted: false
    })) as StoredPlan;
    await expect(h.service.lock(unaccepted.id)).rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(h.chain.freezes).toHaveLength(0);
  });

  it("refuses to lock a plan for more shares than the wallet holds", async () => {
    const h = await harness({ baw: true });
    // 1.998 tokens at 1.000778 shares each is 1.9996 shares, short of the 2 named.
    h.chain.balances.set(NVDA_TOKEN, "1.998");
    const draft = (await h.store.planDraft(tradingGuard)) as StoredPlan;
    await expect(h.service.lock(draft.id)).rejects.toMatchObject({
      code: "HOLDINGS_SHORT",
      message: expect.stringContaining("1.999554 NVDA shares, less than the 2")
    });
    expect(h.chain.balanceReads).toEqual([{ token: NVDA_TOKEN, account: WALLET }]);
    expect(h.chain.freezes).toHaveLength(0);

    h.chain.balances.set(NVDA_TOKEN, "1.9985");
    expect((await h.service.lock(draft.id)).status).toBe("locked");
  });

  it("refuses to lock Buy the dip for more USDT than the wallet holds", async () => {
    const h = await harness({ baw: true });
    h.chain.balances.set(USDT.toLowerCase(), "4.99");
    const draft = (await h.store.planDraft({
      ...tradingGuard,
      kind: "buy_dip",
      params: { ...tradingGuard.params, maxUsd: "5" }
    })) as StoredPlan;
    await expect(h.service.lock(draft.id)).rejects.toMatchObject({ code: "HOLDINGS_SHORT" });
    h.chain.balances.set(USDT.toLowerCase(), "5");
    expect((await h.service.lock(draft.id)).status).toBe("locked");
  });

  it("records the decision, then trades, then records the fill", async () => {
    const h = await harness({ baw: true, reconciliation: true });
    h.chain.receivedAmount = "191.351";
    const traded = await triggered(h);

    expect(h.chain.log).toEqual(["decision", "swap", "fill"]);
    expect(traded.decision?.decision.action).toBe("sell");
    expect(traded.trade).toMatchObject({
      wallet: WALLET,
      order: { status: "FINISHED" },
      received: "191.351"
    });
    const sold = Number(traded.trade!.quote.inputAmount);
    expect(sold * Number("1.000778223752807865")).toBeCloseTo(1, 12);
    // The wallet tool is asked for the plan's 1 share, not for the token amount.
    expect(Number(h.baw.orders[0]!.fromTokenQty)).toBeCloseTo(1, 12);
    // The public record shows the fill before the verdict, not only after it.
    expect(await h.store.record()).toMatchObject({
      items: [{ id: traded.id, status: "decided", action: "sell", fillTx: `0x${"ab".repeat(32)}` }]
    });

    h.setOpen({ value: "193", source: "nasdaq:NVDA:daily-history", sourceRecordPath: "raw/x" });
    h.setNow(OPEN + 30 * MINUTE);
    await h.service.tick();
    const done = await plan(h, traded.id);
    expect(done.verdict).toMatchObject({ outcome: "kept", openPrice: "193" });
    expect(Number(done.verdict?.actionPrice)).toBeCloseTo(191.351, 3);
    const receipt = (await h.store.receipt(traded.id)) as Parameters<typeof verifyReceipt>[0];
    expect(receipt.fills).toHaveLength(1);
    expect(verifyReceipt(receipt)).toMatchObject({ valid: true });
  });

  function binanceGate(
    over: (request: Parameters<BinanceGate>[0]) => Partial<BinanceEvidence> = () => ({})
  ): BinanceGate & { requests: Array<Parameters<BinanceGate>[0]> } {
    const requests: Array<Parameters<BinanceGate>[0]> = [];
    const gate = (async (request) => {
      requests.push(request);
      return {
        v: 1,
        rwa: {
          tokenPrice: "192",
          referencePrice: "191.9",
          tokenToShareRatio: "1.000778223752807865",
          openState: true,
          marketStatus: null,
          reasonCode: "TRADING",
          reasonMsg: null,
          nextOpenTime: null
        },
        marketPrice: "192",
        quote: {
          vendor: "LiquidMesh",
          executionMode: "SWAP",
          quoteId: "bq",
          inputAmount: request.inputAmount,
          outputAmount: request.walletOutputAmount,
          walletOutputAmount: request.walletOutputAmount,
          deviationPct: "0",
          limitPct: "1.5"
        },
        simulation: request.exactCall
          ? {
              kind: "exact",
              status: "SUCCESS",
              failReason: null,
              callHash: keccak256(request.exactCall.data as Hex),
              passed: true,
              detail: "inside the signed bounds"
            }
          : null,
        failure: null,
        calls: [],
        ...over(request)
      } satisfies BinanceEvidence;
    }) as BinanceGate & { requests: Array<Parameters<BinanceGate>[0]> };
    gate.requests = requests;
    return gate;
  }

  it("waits while a Binance module is down, then trades with Binance's evidence on record", async () => {
    let down = true;
    const gate = binanceGate(() =>
      down ? { failure: { module: "trading", code: 50001, message: "service unavailable" } } : {}
    );
    const h = await harness({ baw: true, reconciliation: true, binance: gate });
    h.chain.receivedAmount = "191.351";
    const waiting = await triggered(h);
    expect(waiting.status).toBe("locked");
    expect(waiting.lastEvaluation?.refusal).toBe("BINANCE_API_UNAVAILABLE");
    expect(h.chain.log).not.toContain("swap");
    expect(gate.requests[0]).toMatchObject({ side: "sell", account: WALLET });

    down = false;
    h.setNow(TRIGGERED + MINUTE);
    h.setPrice(snapshot(TRIGGERED + MINUTE, "192"));
    await h.service.tick();
    const traded = await plan(h, waiting.id);
    expect(h.chain.log).toEqual(["decision", "swap", "fill"]);
    expect(traded.decision?.input.binance).toMatchObject({
      rwa: { reasonCode: "TRADING" },
      quote: { vendor: "LiquidMesh", deviationPct: "0" }
    });
  });

  /** A PlanAccount Guard on NVDA, locked for tonight with an owner-signed permission. */
  async function lockedAccountGuard(h: Harness): Promise<StoredPlan> {
    const owner = privateKeyToAccount(`0x${"44".repeat(32)}`);
    const template = {
      kind: "guard" as const,
      standingRunId: "standing-dry-run",
      door: "plan_account" as const,
      auditNoDataAccepted: true,
      ticker: "NVDA",
      wrapper: "bStock" as const,
      tokenAddress: NVDA_TOKEN,
      heldShares: "2",
      params: guardInput.params
    };
    const run = createStandingRun({
      runId: "standing-dry-run",
      template,
      startAtMs: BEFORE_CLOSE,
      untilTs: BEFORE_CLOSE + 3 * 86_400_000
    });
    const copies = expandStandingPlan(run).filter((copy) => copy.lockByMs > BEFORE_CLOSE);
    const runHash = hashCanonical({
      runId: run.runId,
      template: run.template,
      startAtMs: run.startAtMs,
      untilTs: run.untilTs
    });
    const permission = {
      planHash: `0x${"00".repeat(32)}` as Hex,
      standingRunHash: runHash,
      agent: AGENT as Address,
      tokenIn: NVDA_TOKEN as Address,
      tokenOut: USDT as Address,
      maxAmount: 999222381408450703n,
      router: "0x0000000000000000000000000000000000007002" as Address,
      notBefore: BigInt(Math.floor(copies[0]!.event.lockTs! / 1000)),
      notAfter: BigInt(Math.floor(copies.at(-1)!.event.openTs! / 1000)),
      maxPriceDeviationBps: 100n
    };
    const standing = await h.service.startStanding({
      ...guardInput,
      days: 3,
      runId: "standing-dry-run",
      door: "plan_account",
      auditNoDataAccepted: true,
      owner: owner.address,
      issuedAt: Math.floor(BEFORE_CLOSE / 1000),
      permission: serializePlanPermission(permission),
      permissionSignature: await owner.signTypedData(
        planPermissionTypedData(owner.address, permission)
      )
    });
    return plan(h, Object.values(standing.nights)[0]!.planStoreId!);
  }

  async function triggerAccountGuard(h: Harness, locked: StoredPlan): Promise<StoredPlan> {
    h.setNow(TRIGGERED);
    h.setPrice(snapshot(TRIGGERED, "192"));
    await h.service.tick();
    return plan(h, locked.id);
  }

  it("dry-runs the exact PlanAccount transaction through Binance, then sends that same one", async () => {
    const gate = binanceGate();
    const h = await harness({ baw: true, planAccount: true, binance: gate });
    const locked = await lockedAccountGuard(h);
    const traded = await triggerAccountGuard(h, locked);
    const exact = gate.requests[0]!.exactCall!;
    expect(exact.owner).toBe(locked.signedPermission!.owner);
    expect(traded.decision?.input.binance?.simulation).toMatchObject({
      kind: "exact",
      passed: true,
      callHash: keccak256(exact.data as Hex)
    });
    expect(h.permissionTrader!.sent).toHaveLength(1);
    expect(h.permissionTrader!.sent[0]!.data).toBe(exact.data);
    expect(traded.trade?.order?.status).toBe("FINISHED");
  });

  it("refuses the PlanAccount trade when Binance's dry run fails, and sends nothing", async () => {
    const gate = binanceGate((request) => ({
      simulation: {
        kind: "exact",
        status: "FAILED",
        failReason: "execution reverted: InvalidRouterCall()",
        callHash: keccak256(request.exactCall!.data as Hex),
        passed: false,
        detail: "dry run FAILED: execution reverted: InvalidRouterCall()"
      }
    }));
    const h = await harness({ baw: true, planAccount: true, binance: gate });
    const refused = await triggerAccountGuard(h, await lockedAccountGuard(h));
    expect(refused.decision?.decision.refusal?.code).toBe("SIM_FAILED");
    expect(refused.decision?.decision.refusal?.sentence).toContain("InvalidRouterCall");
    expect(h.permissionTrader!.sent).toHaveLength(0);
  });

  it("will not send a PlanAccount transaction that differs from the one dry-run", async () => {
    const h = await harness({ baw: true, planAccount: true, binance: binanceGate() });
    h.permissionTrader!.drift = true;
    const stuck = await triggerAccountGuard(h, await lockedAccountGuard(h));
    expect(stuck.status).toBe("decided");
    expect(h.permissionTrader!.sent).toHaveLength(0);
    expect(stuck.lastError?.message ?? "").toContain("PLAN_ACCOUNT_CALL_CHANGED");
    // Nothing was saved as sent, so the agent never goes looking for an order that never left.
    expect(stuck.trade).toBeUndefined();
  });

  it("checks a finished fill with Binance's Wallet API once Binance has indexed it", async () => {
    const requests: BinanceFillRequest[] = [];
    let indexed = false;
    const h = await harness({
      baw: true,
      reconciliation: true,
      binanceFill: async (request) => {
        requests.push(request);
        if (!indexed) return null;
        return {
          v: 1,
          at: "2026-10-10T10:00:00.000Z",
          txStatus: "success",
          sent: { token: request.sentToken, amount: "1" },
          received: { token: request.receivedToken, amount: request.chainReceived ?? "0" },
          chainReceived: request.chainReceived,
          matchesChain: true,
          detail: "Binance and the chain agree."
        };
      }
    });
    h.chain.receivedAmount = "191.351";
    const traded = await triggered(h);
    expect(traded.trade?.binanceCheck).toBeUndefined();
    expect(requests[0]).toMatchObject({ wallet: WALLET, chainReceived: "191.351" });

    indexed = true;
    h.setNow(TRIGGERED + MINUTE);
    await h.service.tick();
    const checked = await plan(h, traded.id);
    expect(checked.trade?.binanceCheck).toMatchObject({
      matchesChain: true,
      chainReceived: "191.351"
    });
    const calls = requests.length;
    h.setNow(TRIGGERED + 2 * MINUTE);
    await h.service.tick();
    expect(requests).toHaveLength(calls);
  });

  it("refuses for good when Binance's share ratio disagrees with the listed one", async () => {
    const gate = binanceGate(() => ({
      rwa: {
        tokenPrice: "192",
        referencePrice: "191.9",
        tokenToShareRatio: "1.05",
        openState: true,
        marketStatus: null,
        reasonCode: "TRADING",
        reasonMsg: null,
        nextOpenTime: null
      }
    }));
    const h = await harness({ baw: true, binance: gate });
    const refused = await triggered(h);
    expect(refused.status).toBe("decided");
    expect(refused.decision?.decision.refusal?.code).toBe("MULTIPLIER_MISMATCH");
    expect(h.chain.log).not.toContain("swap");
  });

  it("refuses a token Binance reports as paused for a corporate action", async () => {
    const gate = binanceGate(() => ({
      rwa: {
        tokenPrice: "192",
        referencePrice: "191.9",
        tokenToShareRatio: "1.000778223752807865",
        openState: false,
        marketStatus: "pause",
        reasonCode: "ASSET_PAUSED",
        reasonMsg: "stock_split",
        nextOpenTime: null
      }
    }));
    const h = await harness({ baw: true, binance: gate });
    const refused = await triggered(h);
    expect(refused.decision?.decision.refusal?.code).toBe("ASSET_PAUSED");
    expect(refused.decision?.decision.refusal?.sentence).toContain("stock_split");
    expect(h.chain.log).not.toContain("swap");
  });

  it("refuses a quote that would sell far below the token price and never trades", async () => {
    const h = await harness({ baw: true });
    h.baw.pricePerToken = "170";
    const refused = await triggered(h);
    expect(refused.decision?.decision.refusal?.code).toBe("IMPACT_TOO_HIGH");
    expect(h.baw.calls.some(([, command]) => command === "swap")).toBe(false);
  });

  it("refuses when the wallet session has ended", async () => {
    const h = await harness({ baw: true });
    h.baw.sessionEnd = "2026-10-07T21:00:00+00:00";
    const refused = await triggered(h);
    expect(refused.decision?.decision.refusal?.code).toBe("SESSION_LOST");
    expect(h.chain.log).toEqual(["decision"]);
  });

  it("refuses when the trade is over the wallet's daily limit", async () => {
    const h = await harness({ baw: true });
    h.baw.quotaLeft = 50;
    const refused = await triggered(h);
    expect(refused.decision?.decision.refusal?.code).toBe("QUOTA_LOW");
  });

  it("publishes a failed order as refused, with no fill", async () => {
    const h = await harness({ baw: true, reconciliation: true });
    h.baw.statuses = ["FAILED"];
    const failed = await triggered(h);
    expect(failed.trade?.order?.status).toBe("FAILED");

    h.setOpen({ value: "193", source: "nasdaq:NVDA:daily-history", sourceRecordPath: "raw/x" });
    h.setNow(OPEN + 30 * MINUTE);
    await h.service.tick();
    expect((await plan(h, failed.id)).verdict).toMatchObject({
      outcome: "refused",
      reason: "ORDER_FAILED"
    });
    expect(h.chain.fills).toHaveLength(0);
  });

  it("waits for transfer reconciliation before publishing a wallet result", async () => {
    const h = await harness({ baw: true });
    const traded = await triggered(h);
    h.setOpen({ value: "193", source: "nasdaq:NVDA:daily-history", sourceRecordPath: "raw/x" });
    h.setNow(OPEN + 30 * MINUTE);
    await h.service.tick();

    const waiting = await plan(h, traded.id);
    expect(waiting.status).toBe("decided");
    expect(waiting.verdict).toBeUndefined();
    expect(waiting.lastError?.message).toContain("Transfer reconciliation is not configured");
    expect(h.chain.verdicts).toHaveLength(0);
  });

  it("keeps following a pending order until it finishes", async () => {
    const h = await harness({ baw: true });
    // Pending for longer than the two minutes one pass waits.
    h.baw.statuses = [...Array<"PENDING">(45).fill("PENDING"), "FINISHED"];
    const sent = await triggered(h);
    expect(sent.trade?.order?.status).toBe("PENDING");
    expect(h.chain.fills).toHaveLength(0);

    h.setNow(TRIGGERED + MINUTE);
    await h.service.tick();
    expect((await plan(h, sent.id)).trade?.order?.status).toBe("FINISHED");
    expect(h.chain.fills).toHaveLength(1);
  });

  it("finds an order whose reply was lost instead of trading twice", async () => {
    const h = await harness({ baw: true });
    h.baw.loseSwapReply = true;
    const lost = await triggered(h);
    expect(lost.lastError?.message).toBe("connection reset");
    expect(lost.trade?.order).toBeNull();

    h.baw.loseSwapReply = false;
    h.setNow(TRIGGERED + MINUTE);
    await h.service.tick();
    const found = await plan(h, lost.id);
    expect(found.trade?.order?.status).toBe("FINISHED");
    expect(h.baw.calls.filter(([, command]) => command === "swap")).toHaveLength(1);
  });

  it("buys the dip with the plan's dollar amount", async () => {
    const h = await harness({ baw: true });
    const draft = (await h.store.planDraft({
      ticker: "NVDA",
      kind: "buy_dip",
      heldShares: "2",
      door: "agentic_wallet",
      auditNoDataAccepted: true,
      params: {
        maxPriceImpactPct: "1",
        minPoolDepthUsd: "100000",
        triggerDropPct: "3",
        maxGapToRealPricePct: "1",
        maxUsd: "10"
      }
    })) as StoredPlan;
    const locked = await h.service.lock(draft.id);
    h.setNow(TRIGGERED);
    h.setPrice(snapshot(TRIGGERED, "192"));
    await h.service.tick();
    const bought = await plan(h, locked.id);
    expect(bought.decision?.decision.action).toBe("buy");
    expect(bought.trade?.quote).toMatchObject({ side: "buy", inputAmount: "10" });
  });
});

describe("plans signed in the owner's own wallet", () => {
  // A throwaway key: the test signs exactly as a browser wallet would.
  const owner = privateKeyToAccount(`0x${"42".repeat(32)}`);
  const holdInput = {
    ticker: "NVDA",
    kind: "hold",
    heldShares: "3",
    params: { maxPriceImpactPct: "1", minPoolDepthUsd: "100000", maxGapToRealPricePct: "1" }
  };

  async function sign(
    plan: typeof guardInput | typeof holdInput,
    issuedAtS: number,
    promise: string
  ) {
    const context = {
      kind: "guard" as const,
      standingRunId: null,
      ticker: plan.ticker,
      wrapper: "bStock" as const,
      tokenAddress: NVDA_TOKEN,
      heldShares: plan.heldShares,
      params: plan.params
    };
    const message = signedPlanMessage({
      promise,
      owner: owner.address,
      ticker: plan.ticker,
      planHash: hashPlan({ ...context, kind: plan.kind as "guard" }),
      windowCloseMs: CLOSE,
      issuedAtS
    });
    return owner.signTypedData({
      domain: SIGNED_PLAN_DOMAIN,
      types: SIGNED_PLAN_TYPES,
      primaryType: "Plan",
      message
    });
  }

  it("locks under the signer's address, pays no job, and labels it signed", async () => {
    const h = await harness({ jobs: true, teamJobLimit: 4 });
    const issuedAt = Math.floor(BEFORE_CLOSE / 1000);
    const preview = await h.service.preview(holdInput);
    const signature = await sign(holdInput, issuedAt, preview.promise!);
    const locked = await h.service.lockSigned({
      plan: holdInput,
      owner: owner.address,
      issuedAt,
      signature
    });
    expect(locked.status).toBe("locked");
    expect(locked.owner).toBe(owner.address);
    expect(h.chain.freezes[0]).toMatchObject({ owner: owner.address, planHash: preview.planHash });
    expect(h.jobs.kinds).toEqual([]);
    expect(await h.store.record()).toMatchObject({
      items: [{ owner: owner.address, door: "signed", status: "locked" }]
    });
  });

  it("refuses a plan that differs from what was signed", async () => {
    const h = await harness();
    const issuedAt = Math.floor(BEFORE_CLOSE / 1000);
    const preview = await h.service.preview(holdInput);
    const signature = await sign(holdInput, issuedAt, preview.promise!);
    await expect(
      h.service.lockSigned({
        plan: { ...holdInput, heldShares: "30" },
        owner: owner.address,
        issuedAt,
        signature
      })
    ).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" });
    expect(h.chain.freezes).toHaveLength(0);
  });

  it("refuses an old signature and a plan that asks to trade", async () => {
    const h = await harness();
    const stale = Math.floor(BEFORE_CLOSE / 1000) - 11 * 60;
    const preview = await h.service.preview(holdInput);
    const signature = await sign(holdInput, stale, preview.promise!);
    await expect(
      h.service.lockSigned({ plan: holdInput, owner: owner.address, issuedAt: stale, signature })
    ).rejects.toMatchObject({ code: "SIGNATURE_EXPIRED" });
    await expect(
      h.service.lockSigned({
        plan: { ...holdInput, door: "agentic_wallet" },
        owner: owner.address,
        issuedAt: stale + 11 * 60,
        signature
      })
    ).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("stops at the daily cap, and sits beside the team's own plan on the same stock", async () => {
    const h = await harness({ signedDailyCap: 1 });
    await lockedGuard(h);
    const issuedAt = Math.floor(BEFORE_CLOSE / 1000);
    const preview = await h.service.preview(holdInput);
    const signature = await sign(holdInput, issuedAt, preview.promise!);
    await h.service.lockSigned({ plan: holdInput, owner: owner.address, issuedAt, signature });
    expect(h.chain.freezes.map((f) => f.owner)).toEqual([AGENT, owner.address]);

    const other = privateKeyToAccount(`0x${"43".repeat(32)}`);
    const otherSignature = await other.signTypedData({
      domain: SIGNED_PLAN_DOMAIN,
      types: SIGNED_PLAN_TYPES,
      primaryType: "Plan",
      message: signedPlanMessage({
        promise: preview.promise!,
        owner: other.address,
        ticker: "NVDA",
        planHash: preview.planHash as `0x${string}`,
        windowCloseMs: CLOSE,
        issuedAtS: issuedAt
      })
    });
    await expect(
      h.service.lockSigned({
        plan: holdInput,
        owner: other.address,
        issuedAt,
        signature: otherSignature
      })
    ).rejects.toMatchObject({ code: "SIGNED_LIMIT" });
  });

  it("checks a PlanAccount preview against the connected owner after the live dry-run failure", async () => {
    const h = await harness({ planAccount: true });
    const preview = await h.service.preview({
      ticker: "NVDA",
      kind: "buy_dip",
      heldShares: "0",
      door: "plan_account",
      owner: owner.address,
      auditNoDataAccepted: true,
      params: {
        maxPriceImpactPct: "1",
        minPoolDepthUsd: "100000",
        triggerDropPct: "1",
        maxGapToRealPricePct: "1",
        maxUsd: "2"
      }
    });
    expect(preview.valid).toBe(true);
    expect(h.chain.balanceReads.at(-1)).toEqual({
      token: USDT.toLowerCase(),
      account: owner.address
    });
  });

  it("locks a bounded PlanAccount permission under the wallet owner", async () => {
    const h = await harness({ planAccount: true, jobs: true });
    const input = { ...guardInput, door: "plan_account", auditNoDataAccepted: true };
    const preview = await h.service.preview(input);
    expect(preview.valid).toBe(true);
    expect(preview.permission).toMatchObject({
      planHash: preview.planHash,
      tokenIn: NVDA_TOKEN,
      tokenOut: USDT,
      maxAmount: expect.any(String)
    });
    const { template: _template, ...permission } = preview.permission!;
    void _template;
    const signature = await owner.signTypedData(
      planPermissionTypedData(owner.address, deserializePlanPermission(permission))
    );
    const locked = await h.service.lockSigned({
      plan: input,
      owner: owner.address,
      issuedAt: Math.floor(BEFORE_CLOSE / 1000),
      permission,
      permissionSignature: signature
    });
    expect(locked.status).toBe("locked");
    expect(locked.owner).toBe(owner.address);
    expect(locked.signedPermission).toMatchObject({
      owner: owner.address,
      signature,
      delegationTx: h.permissionTrader!.delegationTx
    });
    expect(locked.signedPermission!.permission).toMatchObject({
      ...permission,
      tokenIn: expect.stringMatching(new RegExp(`^${NVDA_TOKEN}$`, "i"))
    });
    expect(h.permissionTrader!.ensured).toEqual([
      { owner: owner.address, permission: preview.planHash }
    ]);
    expect(h.chain.freezes[0]).toMatchObject({ owner: owner.address, planHash: preview.planHash });
    expect(h.jobs.kinds).toEqual(["official"]);
    expect(await h.store.record()).toMatchObject({
      items: [{ owner: owner.address, door: "plan_account", status: "locked" }]
    });
  });
});

describe("ERC-8183 jobs", () => {
  async function finished(h: Harness): Promise<StoredPlan> {
    const locked = await lockedGuard(h);
    h.setOpen({ value: "198.10", source: "nasdaq:NVDA:daily-history", sourceRecordPath: "raw/x" });
    h.setNow(OPEN + MINUTE);
    h.setPrice(snapshot(OPEN + MINUTE, "199"));
    await h.service.tick();
    return plan(h, locked.id);
  }

  it("opens and pays for a job before the lock, and links it in PlanBook", async () => {
    const h = await harness({ jobs: true });
    const locked = await lockedGuard(h);

    expect(h.jobs.opened).toHaveLength(1);
    expect(h.jobs.opened[0]!.expiresAt).toBe(OPEN / 1000 + WEEK_S + 3 * 24 * 60 * 60);
    expect(JSON.parse(h.jobs.opened[0]!.description)).toMatchObject({
      task: "Redeye plan: If the 24/7 price falls 3% below the close, sell 50% of 2 NVDA shares.",
      planHash: locked.planHash,
      ticker: "NVDA",
      window: "overnight"
    });
    expect(h.chain.freezes[0]!.jobId).toBe(56_911);
    expect(locked.job).toMatchObject({ jobId: 56_911, state: "funded" });
    expect(locked.job!.fundTxs).toHaveLength(2);
    expect(await h.store.record()).toMatchObject({
      items: [{ id: locked.id, jobId: 56_911, jobState: "funded" }]
    });
  });

  it("locks without a job when no buyer is configured", async () => {
    const h = await harness();
    const locked = await lockedGuard(h);
    expect(locked.job).toBeUndefined();
    expect(h.chain.freezes[0]!.jobId).toBeUndefined();
  });

  it("still locks the promise when the job cannot be opened", async () => {
    const h = await harness({ jobs: true });
    h.jobs.failNext.set("create", "buyer has no gas");
    const locked = await lockedGuard(h);
    expect(locked.status).toBe("locked");
    expect(locked.job).toBeUndefined();
    expect(h.chain.freezes[0]!.jobId).toBeUndefined();
  });

  it("links a job whose funding failed and pays it on the next pass", async () => {
    const h = await harness({ jobs: true });
    h.jobs.failNext.set("fund", "rpc timeout");
    const locked = await lockedGuard(h);
    expect(h.chain.freezes[0]!.jobId).toBe(56_911);
    expect(locked.job).toMatchObject({ state: "open", lastError: { message: "rpc timeout" } });

    h.setNow(CLOSE + MINUTE);
    await h.service.tick();
    const paid = await plan(h, locked.id);
    expect(paid.job).toMatchObject({ state: "funded" });
    expect(paid.job!.lastError).toBeUndefined();
  });

  it("finds a job whose create reply was lost instead of opening a second one", async () => {
    const h = await harness({ jobs: true });
    h.jobs.loseCreateReply = true;
    const locked = await lockedGuard(h);
    expect(locked.job).toMatchObject({ jobId: null, state: "creating" });
    expect(h.chain.freezes[0]!.jobId).toBeUndefined();

    h.jobs.loseCreateReply = false;
    h.setNow(CLOSE + MINUTE);
    await h.service.tick();
    expect(h.jobs.opened).toHaveLength(1);
    expect((await plan(h, locked.id)).job).toMatchObject({ jobId: 56_911, state: "funded" });
  });

  it("delivers the result fingerprint once the result is published", async () => {
    const h = await harness({ jobs: true });
    const done = await finished(h);
    expect(done.status).toBe("done");
    expect(h.jobs.delivered).toHaveLength(0);

    await h.service.tick();
    const delivered = await plan(h, done.id);
    expect(delivered.job!.manifest).toEqual({
      v: 1,
      planId: 1,
      receipt: `/plans/${done.id}/receipt`,
      verdictHash: done.verdict!.verdictHash
    });
    expect(h.jobs.delivered).toEqual([{ jobId: 56_911, deliverable: delivered.job!.deliverable }]);
    expect(delivered.job!.state).toBe("submitted");

    await h.service.tick();
    expect(h.jobs.delivered).toHaveLength(1);
  });

  it("settles only after the dispute window has passed", async () => {
    const h = await harness({ jobs: true });
    const done = await finished(h);
    await h.service.tick();
    const delivered = await plan(h, done.id);
    const deliveredAt = delivered.job!.deliverChain!.blockTs * 1000;

    h.setNow(deliveredAt + WEEK_S * 1000);
    await h.service.tick();
    expect(h.jobs.settled).toEqual([]);

    h.setNow(deliveredAt + WEEK_S * 1000 + 3 * MINUTE);
    await h.service.tick();
    expect(h.jobs.settled).toEqual([56_911]);
    const settled = await plan(h, done.id);
    expect(settled.job).toMatchObject({ state: "completed" });
    expect(settled.job!.settleChain).toBeDefined();
    expect(await h.store.record()).toMatchObject({ items: [{ jobState: "completed" }] });
  });

  it("keeps a delivery error on the job and retries without touching the plan", async () => {
    const h = await harness({ jobs: true });
    const done = await finished(h);
    h.jobs.failNext.set("deliver", "nonce too low");
    await h.service.tick();
    const failed = await plan(h, done.id);
    expect(failed.status).toBe("done");
    expect(failed.lastError).toBeUndefined();
    expect(failed.job).toMatchObject({ state: "funded", lastError: { message: "nonce too low" } });

    await h.service.tick();
    expect((await plan(h, done.id)).job).toMatchObject({ state: "submitted" });
  });

  it("opens a team job as well for the first plans only", async () => {
    const h = await harness({ jobs: true, teamJobLimit: 1 });
    const first = await lockedGuard(h);
    const draft = (await h.store.planDraft({ ...guardInput, ticker: "TSLA" })) as StoredPlan;
    const second = await h.service.lock(draft.id);

    expect(h.jobs.kinds).toEqual(["official", "team", "official"]);
    expect(first.job).toMatchObject({ kind: "official", jobId: 56_911, state: "funded" });
    expect(first.teamJob).toMatchObject({ kind: "team", jobId: 56_912, state: "funded" });
    expect(second.teamJob).toBeUndefined();
    // PlanBook links the official job.
    expect(h.chain.freezes.map((freeze) => freeze.jobId)).toEqual([56_911, 56_913]);
    expect(JSON.parse(h.jobs.opened[1]!.description).review).toBe(
      "team job: approved by Redeye's own buyer wallet only if the receipt verifies"
    );
    // A team job is reviewed at the open, so it needs no room for the dispute window.
    expect(h.jobs.opened[1]!.expiresAt).toBe(OPEN / 1000 + 3 * 24 * 60 * 60);
  });

  it("refuses a second plan for the same stock and window before opening any job", async () => {
    const h = await harness({ jobs: true, teamJobLimit: 4 });
    await lockedGuard(h);
    const draft = (await h.store.planDraft({ ...guardInput, kind: "hold" })) as StoredPlan;
    await expect(h.service.lock(draft.id)).rejects.toMatchObject({
      code: "DUPLICATE_PLAN",
      message: expect.stringContaining("Plan #1 is already locked for NVDA")
    });
    expect(h.jobs.kinds).toEqual(["official", "team"]);
    expect(h.chain.freezes).toHaveLength(1);
    expect((await plan(h, draft.id)).job).toBeUndefined();
  });

  it("has the buyer approve a team job once the receipt verifies", async () => {
    const h = await harness({ jobs: true, teamJobLimit: 1 });
    const done = await finished(h);
    await h.service.tick();
    expect(h.jobs.delivered.map((d) => d.jobId)).toEqual([56_911, 56_912]);

    await h.service.tick();
    expect(h.jobs.reviews).toEqual([
      { jobId: 56_912, approve: true, reason: keccak256(toBytes("RECEIPT_VERIFIED")) }
    ]);
    const reviewed = await plan(h, done.id);
    expect(reviewed.teamJob).toMatchObject({
      state: "completed",
      reviewReason: "RECEIPT_VERIFIED"
    });
    expect(reviewed.job).toMatchObject({ state: "submitted" });
    expect(await h.store.record()).toMatchObject({
      items: [{ jobState: "submitted", teamJobState: "completed" }]
    });
    expect(h.jobs.settled).toEqual([]);
  });

  it("has the buyer reject a team job when the receipt does not verify", async () => {
    const h = await harness({ jobs: true, teamJobLimit: 1 });
    const done = await finished(h);
    await h.service.tick();
    const receipt = (await h.store.receipt(done.id)) as Record<string, unknown>;
    await h.store.saveReceipt(done.id, {
      ...receipt,
      verdictHash: `0x${"00".repeat(32)}`
    } as never);

    await h.service.tick();
    expect(h.jobs.reviews).toEqual([
      { jobId: 56_912, approve: false, reason: keccak256(toBytes("RECEIPT_INVALID")) }
    ]);
    expect((await plan(h, done.id)).teamJob).toMatchObject({
      state: "rejected",
      reviewReason: "RECEIPT_INVALID"
    });
  });
});

describe("restarting the agent", () => {
  it("grades a plan awaiting its open price once, after a restart", async () => {
    const first = await harness({ jobs: true });
    const locked = await lockedGuard(first);
    first.setNow(OPEN + MINUTE);
    first.setPrice(snapshot(OPEN + MINUTE, "199"));
    await first.service.tick();
    expect((await plan(first, locked.id)).status).toBe("decided");

    const second = await harness({ jobs: true, restartOf: first });
    second.setNow(OPEN + 20 * MINUTE);
    second.setPrice(snapshot(OPEN + 20 * MINUTE, "199"));
    second.setOpen({
      value: "198.10",
      source: "nasdaq:NVDA:daily-history",
      sourceRecordPath: "raw/x"
    });
    await second.service.tick();
    await second.service.tick();

    const done = await plan(second, locked.id);
    expect(done.verdict).toMatchObject({ outcome: "kept", openPrice: "198.10" });
    expect(second.chain.freezes).toHaveLength(1);
    expect(second.chain.verdicts).toEqual([
      { planId: 1, outcome: "kept", hash: done.verdict!.verdictHash }
    ]);
    expect(second.jobs.opened).toHaveLength(1);
    const receipt = (await second.store.receipt(locked.id)) as Parameters<typeof verifyReceipt>[0];
    expect(verifyReceipt(receipt)).toMatchObject({ valid: true });
  });

  it("keeps watching a locked plan after a restart without locking or paying again", async () => {
    const first = await harness({ jobs: true });
    const locked = await lockedGuard(first);

    const second = await harness({ jobs: true, restartOf: first });
    second.setNow(CLOSE + 30 * MINUTE);
    second.setPrice(snapshot(CLOSE + 30 * MINUTE, "199"));
    await second.service.tick();
    expect((await plan(second, locked.id)).status).toBe("locked");
    expect(second.chain.freezes).toHaveLength(1);
    expect(second.jobs.opened).toHaveLength(1);
    expect(second.chain.decisions).toHaveLength(0);

    // The trigger is still watched by the new process.
    second.setNow(CLOSE + 60 * MINUTE);
    second.setPrice(snapshot(CLOSE + 60 * MINUTE, "192"));
    await second.service.tick();
    expect((await plan(second, locked.id)).status).toBe("decided");
    expect(second.chain.decisions).toHaveLength(1);
  });

  it("does not trade a second time after a restart", async () => {
    const tradingGuard = { ...guardInput, door: "agentic_wallet", auditNoDataAccepted: true };
    const first = await harness({ baw: true, reconciliation: true });
    first.chain.receivedAmount = "191.351";
    const draft = (await first.store.planDraft(tradingGuard)) as StoredPlan;
    const locked = await first.service.lock(draft.id);
    first.setNow(CLOSE + 2 * 60 * MINUTE);
    first.setPrice(snapshot(CLOSE + 2 * 60 * MINUTE, "192"));
    await first.service.tick();
    expect(first.baw.orders).toHaveLength(1);

    const second = await harness({ baw: true, reconciliation: true, restartOf: first });
    second.setNow(CLOSE + 3 * 60 * MINUTE);
    second.setPrice(snapshot(CLOSE + 3 * 60 * MINUTE, "185"));
    await second.service.tick();
    second.setOpen({
      value: "193",
      source: "nasdaq:NVDA:daily-history",
      sourceRecordPath: "raw/x"
    });
    second.setNow(OPEN + 30 * MINUTE);
    await second.service.tick();
    await second.service.tick();

    expect(second.baw.orders).toHaveLength(1);
    expect(second.chain.log).toEqual(["decision", "swap", "fill"]);
    expect(second.chain.verdicts).toHaveLength(1);
    expect((await plan(second, locked.id)).verdict).toMatchObject({ outcome: "kept" });
  });
});
