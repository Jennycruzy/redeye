import { describe, expect, it } from "vitest";
import { createWindowRecord, hashPlan, nextWindow, verifyReceipt } from "@redeye/core";
import type { Hex } from "viem";
import { AgenticWallet, type BawRunner } from "./agentic-wallet.js";
import type { JobBook, JobOpenInput, JobState, JobView } from "./job-chain.js";
import type { ChainWrite, FreezeInput, Outcome, PlanChain } from "./plan-chain.js";
import { PlanError, PlanService, type OfficialOpen, type StoredPlan } from "./plan-service.js";
import type { PriceSnapshotOk } from "./price-service.js";
import { FakeDatabase } from "./fake-database.js";
import { SqliteAgentStore } from "./sqlite-store.js";

const AGENT = "0xe201bbf3C736a5d188797974a7e4B9464f707eA8";
const NVDA_TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
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
    this.freezes.push(input);
    return { ...this.write(), planId: this.freezes.length };
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

  async create(input: JobOpenInput, onSent: (txHash: Hex) => Promise<void>) {
    this.fail("create");
    this.opened.push(input);
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
    return { jobId, state: this.states.get(jobId)!, budget: 10n ** 16n, submittedAt: 0 };
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
  private orders: string[] = [];

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
      const qty = Number(flag("--fromTokenQty"));
      const selling = flag("--fromToken").toLowerCase() === NVDA_TOKEN;
      const price = Number(this.pricePerToken);
      return { toCoinAmount: String(selling ? qty * price : qty / price), slippage: 0.01 };
    }
    if (group === "market-order" && command === "swap") {
      this.log.push("swap");
      this.orders.push(`order-${this.orders.length + 1}`);
      if (this.loseSwapReply) throw new Error("connection reset");
      return { orderId: this.orders.at(-1) };
    }
    if (group === "market-order" && command === "list") {
      const orderId = args.includes("--orderId") ? flag("--orderId") : this.orders.at(-1);
      if (orderId === undefined) return { list: [] };
      const status = this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0]!;
      const txHash = status === "FINISHED" ? `0x${"ab".repeat(32)}` : null;
      return { list: [{ orderId, status, txHash }] };
    }
    throw new Error(`unexpected baw call: ${args.join(" ")}`);
  };
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
  store: SqliteAgentStore;
  chain: FakeChain;
  baw: FakeBaw;
  jobs: FakeJobs;
  service: PlanService;
  setNow(atMs: number): void;
  setPrice(price: PriceSnapshotOk | null): void;
  setOpen(open: OfficialOpen | null): void;
}

async function harness(
  options: { chain?: boolean; baw?: boolean; jobs?: boolean } = {}
): Promise<Harness> {
  let now = BEFORE_CLOSE;
  let price: PriceSnapshotOk | null = null;
  let open: OfficialOpen | null = null;
  const store = new SqliteAgentStore(new FakeDatabase());
  const chain = new FakeChain(() => now);
  const baw = new FakeBaw(chain.log);
  const jobs = new FakeJobs(() => now);
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
  const service = new PlanService({
    store,
    chain: options.chain === false ? null : chain,
    trader,
    jobs: options.jobs ? jobs : null,
    now: () => now,
    latestPrice: async () => price,
    listedToken: async (ticker) =>
      ticker === "NVDA"
        ? { address: NVDA_TOKEN, multiplier: "1.000778223752807865", multiplierAgreement: true }
        : null,
    officialOpen: async () => open
  });
  return {
    store,
    chain,
    baw,
    jobs,
    service,
    setNow: (atMs) => {
      now = atMs;
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
    let failures = 1;
    h.chain.recordDecision = async (planId, hash) => {
      if (failures-- > 0) throw new Error("rpc timeout");
      return failing(planId, hash);
    };
    h.setNow(OPEN + MINUTE);
    h.setPrice(snapshot(OPEN + MINUTE, "199"));
    await h.service.tick();
    expect((await plan(h, locked.id)).lastError?.message).toBe("rpc timeout");
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

  it("records the decision, then trades, then records the fill", async () => {
    const h = await harness({ baw: true });
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
    const h = await harness({ baw: true });
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
});
