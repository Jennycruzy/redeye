import { describe, expect, it } from "vitest";
import { createWindowRecord, hashPlan, nextWindow, verifyReceipt } from "@redeye/core";
import type { Hex } from "viem";
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
    return this.write();
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
  service: PlanService;
  setNow(atMs: number): void;
  setPrice(price: PriceSnapshotOk | null): void;
  setOpen(open: OfficialOpen | null): void;
}

async function harness(options: { chain?: boolean } = {}): Promise<Harness> {
  let now = BEFORE_CLOSE;
  let price: PriceSnapshotOk | null = null;
  let open: OfficialOpen | null = null;
  const store = new SqliteAgentStore(new FakeDatabase());
  const chain = new FakeChain(() => now);
  const service = new PlanService({
    store,
    chain: options.chain === false ? null : chain,
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
