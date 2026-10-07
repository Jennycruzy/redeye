import { randomUUID } from "node:crypto";
import {
  createStandingRun,
  createWindowRecord,
  decide,
  expandStandingPlan,
  hashCanonical,
  hashDecision,
  hashPlan,
  hashVerdict,
  nextWindow,
  planLockDeadlineMs,
  validatePlan,
  type Decision,
  type DecisionInput,
  type EventContext,
  type EventRecord,
  type PlanContext,
  type PlanKind,
  type ReceiptBundle,
  type ReceiptVerdict,
  type RefusalCode,
  type StandingPlanRun
} from "@redeye/core";
import type { Address, Hex } from "viem";
import type { ChainWrite, Outcome, PlanChain } from "./plan-chain.js";
import type { PriceSnapshotOk } from "./price-service.js";

const WINDOW_PLAN_KINDS: readonly PlanKind[] = ["guard", "buy_dip", "sell_rise", "hold"];
const EVALUATION_LOG_INTERVAL_MS = 5 * 60 * 1000;
/** After this long without an official open, the result is published without it. */
const OPEN_PRICE_WAIT_MS = 24 * 60 * 60 * 1000;

/** Refusals caused by a limit the user wrote into the plan count as a kept promise. */
const PLAN_LIMIT_CODES: ReadonlySet<RefusalCode> = new Set([
  "CONDITION_NOT_MET",
  "PRICE_OFF_REAL",
  "POOL_TOO_THIN",
  "IMPACT_TOO_HIGH"
]);
/** Refusals that may clear on the next check, so they never end a plan during the window. */
const TRANSIENT_CODES: ReadonlySet<RefusalCode> = new Set(["REAL_PRICE_UNAVAILABLE"]);

export class PlanError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export type PlanStatus = "draft" | "locked" | "decided" | "done" | "cancelled";

export interface StoredDecision {
  at: number;
  input: DecisionInput;
  decision: Decision;
  decisionHash: Hex;
  chain: ChainWrite | null;
}

export interface StoredPlan {
  v: 1;
  id: string;
  status: PlanStatus;
  createdAt: string;
  input: Record<string, unknown>;
  plan?: PlanContext;
  event?: EventRecord;
  planHash?: Hex;
  owner?: Address;
  planId?: number;
  freeze?: ChainWrite;
  lastEvaluation?: { at: number; action: Decision["action"]; refusal: string | null };
  decision?: StoredDecision;
  verdict?: ReceiptVerdict & { verdictHash: Hex };
  verdictChain?: ChainWrite | null;
  lastError?: { at: string; message: string };
}

export interface PlanRecordItem {
  id: string;
  /** Null for a standing-plan night that was never locked (LOCK_MISSED). */
  planId: number | null;
  owner: Address;
  status: PlanStatus | "missed";
  standingRunId: string | null;
  ticker: string;
  kind: PlanKind;
  promise: string;
  window: EventRecord["kind"];
  /** Block time of the lock transaction, in milliseconds. */
  lockedAt: number | null;
  closeTs: number;
  openTs: number;
  freezeTx: Hex | null;
  outcome: Outcome | null;
  reason: string | null;
  openPrice: string | null;
  verdictTx: Hex | null;
}

/** The plan in one plain sentence, as shown in the public record. */
export function describePlan(plan: PlanContext): string {
  const shares = `${plan.heldShares} ${plan.ticker} shares`;
  const { params } = plan;
  if (plan.kind === "guard") {
    return `If the 24/7 price falls ${params.triggerDropPct}% below the close, sell ${params.sellPct}% of ${shares}.`;
  }
  if (plan.kind === "buy_dip") {
    return `If the 24/7 price falls ${params.triggerDropPct}% below the close, buy up to $${params.maxUsd} of ${plan.ticker}.`;
  }
  if (plan.kind === "sell_rise") {
    return `If the 24/7 price rises ${params.triggerRisePct}% above the close, sell ${params.sellPct}% of ${shares}.`;
  }
  return `Hold ${shares} through the window and report the result at the open.`;
}

export type StandingStatus = "active" | "stopped" | "ended";

/** One night of a standing run: either locked as its own plan, or missed. */
export interface StandingNight {
  sequence: number;
  status: "locked" | "missed";
  planStoreId: string | null;
  closeTs: number;
}

export interface StoredStanding {
  v: 1;
  id: string;
  status: StandingStatus;
  createdAt: string;
  owner: Address;
  run: StandingPlanRun;
  runHash: Hex;
  /** Keyed by the night's event key. */
  nights: Record<string, StandingNight>;
  lastError?: { at: string; message: string };
}

export interface PlanStore {
  getStanding(id: string): Promise<StoredStanding | null>;
  saveStanding(standing: StoredStanding): Promise<void>;
  listStanding(): Promise<StoredStanding[]>;
  getPlan(id: string): Promise<StoredPlan | null>;
  savePlan(plan: StoredPlan): Promise<void>;
  listPlans(): Promise<StoredPlan[]>;
  saveRunEvent(runId: string, step: string, payload: Record<string, unknown>): Promise<void>;
  saveReceipt(runId: string, receipt: ReceiptBundle): Promise<void>;
  saveRecordItem(item: PlanRecordItem): Promise<void>;
}

export interface ListedToken {
  address: string;
  multiplier: string;
  multiplierAgreement: boolean;
}

export interface OfficialOpen {
  value: string;
  source: string;
  sourceRecordPath: string;
}

export interface PlanServiceOptions {
  store: PlanStore;
  /** Null when no PlanBook or agent key is configured; locking is then refused. */
  chain: PlanChain | null;
  latestPrice(ticker: string): Promise<PriceSnapshotOk | null>;
  listedToken(ticker: string): Promise<ListedToken | null>;
  officialOpen(ticker: string, nyDate: string): Promise<OfficialOpen | null>;
  now?: () => number;
  newId?: () => string;
}

function nyDate(atMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(atMs));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlanError(400, "PLAN_INVALID", `${field} is required.`);
  }
  return value.trim();
}

function eventContext(event: EventRecord): EventContext {
  if (event.lockTs === null || event.openTs === null) {
    throw new Error("A window event needs lock and open times.");
  }
  return {
    ticker: event.ticker,
    kind: event.kind,
    lockTs: event.lockTs,
    openTs: event.openTs,
    releaseTs: null,
    consensus: null
  };
}

function paramsFrom(input: Record<string, unknown>): PlanContext["params"] {
  return typeof input.params === "object" && input.params !== null && !Array.isArray(input.params)
    ? (input.params as PlanContext["params"])
    : ({} as PlanContext["params"]);
}

function invalid(issues: Array<{ field: string; message: string }>): PlanError {
  return new PlanError(
    400,
    "PLAN_INVALID",
    issues.map((issue) => `${issue.field} ${issue.message}`).join(" ")
  );
}

function ageSeconds(fetchedAt: string, atMs: number): number {
  return Math.max(0, Math.floor((atMs - Date.parse(fetchedAt)) / 1000));
}

function withoutError(stored: StoredPlan): StoredPlan {
  const { lastError, ...rest } = stored;
  void lastError;
  return rest;
}

function isTerminal(decision: Decision): boolean {
  if (decision.action === "buy" || decision.action === "sell") return true;
  return decision.refusal !== null && !TRANSIENT_CODES.has(decision.refusal.code as RefusalCode);
}

function outcomeFor(decision: Decision): Outcome {
  if (decision.refusal === null) return "kept";
  return PLAN_LIMIT_CODES.has(decision.refusal.code as RefusalCode) ? "kept" : "refused";
}

/**
 * Locks off-hours plans in PlanBook, checks each one every minute between the US
 * close and the next open, and publishes the result at the open. Trading is not
 * connected yet, so a triggered plan is refused with EXECUTION_DISABLED and that
 * refusal is what gets published.
 */
export class PlanService {
  private readonly now: () => number;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly newId: () => string;

  constructor(private readonly options: PlanServiceOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  async lock(id: string): Promise<StoredPlan> {
    const chain = this.requireConfiguredChain();
    const stored = await this.requirePlan(id);
    if (stored.status !== "draft") {
      throw new PlanError(409, "PLAN_NOT_DRAFT", `Plan ${id} is already ${stored.status}.`);
    }
    const atMs = this.now();
    const plan = await this.planFromInput(stored.input, null);
    const window = nextWindow(atMs);
    const event = createWindowRecord(window.kind, plan.ticker, window.closeTs, window.openTs);
    const context = eventContext(event);
    if (atMs >= planLockDeadlineMs(context)) {
      throw new PlanError(
        409,
        "LOCK_MISSED",
        "Plans must be locked at least 5 minutes before the US close."
      );
    }
    const validation = validatePlan(plan, context);
    if (!validation.valid) throw invalid(validation.issues);
    return this.freeze(chain, stored, plan, event);
  }

  /**
   * Starts a standing plan: the same plan, locked again before every close until it
   * ends or is stopped. Each night becomes its own plan in PlanBook, linked to the run.
   */
  async startStanding(input: Record<string, unknown>): Promise<StoredStanding> {
    const chain = this.requireConfiguredChain();
    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      throw new PlanError(400, "PLAN_INVALID", "days must be a whole number from 1 to 30.");
    }
    const atMs = this.now();
    const id = this.newId();
    const template = await this.planFromInput(input, id);
    let run: StandingPlanRun;
    try {
      run = createStandingRun({
        runId: id,
        template,
        startAtMs: atMs,
        untilTs: atMs + days * 86_400_000
      });
    } catch (error) {
      throw new PlanError(
        400,
        "PLAN_INVALID",
        error instanceof Error ? error.message : String(error)
      );
    }
    const [first] = expandStandingPlan(run).filter((copy) => copy.lockByMs > atMs);
    if (first === undefined) {
      throw new PlanError(400, "PLAN_INVALID", "The run covers no market close.");
    }
    const validation = validatePlan(template, eventContext(first.event));
    if (!validation.valid) throw invalid(validation.issues);
    const standing: StoredStanding = {
      v: 1,
      id,
      status: "active",
      createdAt: new Date(atMs).toISOString(),
      owner: chain.agentAddress,
      run,
      runHash: hashCanonical({
        runId: run.runId,
        template: run.template,
        startAtMs: run.startAtMs,
        untilTs: run.untilTs
      }),
      nights: {}
    };
    await this.options.store.saveStanding(standing);
    await this.advanceStanding(standing);
    return (await this.options.store.getStanding(id)) ?? standing;
  }

  /** Stops future nights. Nights already locked stay public promises. */
  async stopStanding(id: string): Promise<StoredStanding> {
    const standing = await this.options.store.getStanding(id);
    if (standing === null) {
      throw new PlanError(404, "STANDING_NOT_FOUND", "The requested standing plan does not exist.");
    }
    if (standing.status !== "active") {
      throw new PlanError(409, "STANDING_NOT_ACTIVE", `Standing plan ${id} is ${standing.status}.`);
    }
    const atMs = this.now();
    const stopped: StoredStanding = {
      ...standing,
      status: "stopped",
      run: { ...standing.run, stoppedAtMs: atMs }
    };
    await this.options.store.saveStanding(stopped);
    return stopped;
  }

  async cancel(id: string): Promise<StoredPlan> {
    const stored = await this.requirePlan(id);
    if (stored.status === "draft") {
      const cancelled: StoredPlan = { ...stored, status: "cancelled" };
      await this.options.store.savePlan(cancelled);
      return cancelled;
    }
    if (stored.status !== "locked" || stored.planId === undefined || stored.event === undefined) {
      throw new PlanError(409, "PLAN_NOT_CANCELLABLE", `Plan ${id} is ${stored.status}.`);
    }
    if (this.now() >= (stored.event.lockTs ?? 0)) {
      throw new PlanError(
        409,
        "PLAN_NOT_CANCELLABLE",
        "A plan cannot be cancelled after the close."
      );
    }
    if (this.options.chain === null) {
      throw new PlanError(503, "PLANBOOK_NOT_CONFIGURED", "PlanBook is not configured.");
    }
    const write = await this.options.chain.cancel(stored.planId);
    const cancelled: StoredPlan = { ...stored, status: "cancelled" };
    await this.options.store.savePlan(cancelled);
    await this.options.store.saveRunEvent(id, "cancelled", { txHash: write.txHash });
    await this.saveRecord(cancelled);
    return cancelled;
  }

  /** One pass over every active plan. Errors stay on the plan and are retried next pass. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const standing of await this.options.store.listStanding()) {
        if (standing.status !== "active") continue;
        try {
          await this.advanceStanding(standing);
        } catch (error) {
          await this.options.store.saveStanding({
            ...standing,
            lastError: {
              at: new Date(this.now()).toISOString(),
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
      for (const stored of await this.options.store.listPlans()) {
        if (stored.status !== "locked" && stored.status !== "decided") continue;
        try {
          await this.advance(stored);
        } catch (error) {
          await this.options.store.savePlan({
            ...stored,
            lastError: {
              at: new Date(this.now()).toISOString(),
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Rewrites every public record row from the stored plans, so the record always matches them. */
  async refreshRecord(): Promise<void> {
    for (const stored of await this.options.store.listPlans()) await this.saveRecord(stored);
  }

  start(intervalMs = 60_000): () => void {
    if (this.timer !== null) throw new Error("The plan service is already running.");
    void this.refreshRecord().then(() => this.tick());
    this.timer = setInterval(() => void this.tick(), intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Locks each night of a standing run once the night before it has closed, and
   * publishes any night whose lock time passed without a lock as LOCK_MISSED.
   */
  private async advanceStanding(standing: StoredStanding): Promise<void> {
    const atMs = this.now();
    const nights = { ...standing.nights };
    let changed = false;
    // A night whose lock time had passed when the run started was never part of it.
    const copies = expandStandingPlan(standing.run).filter(
      (copy) => copy.lockByMs > standing.run.startAtMs
    );
    for (const copy of copies) {
      const key = copy.event.eventKey;
      if (nights[key] !== undefined) continue;
      if (atMs > copy.lockByMs) {
        nights[key] = {
          sequence: copy.sequence,
          status: "missed",
          planStoreId: null,
          closeTs: copy.window.closeTs
        };
        changed = true;
        await this.saveMissedNight(standing, copy.plan, copy.event);
        continue;
      }
      // One night is locked ahead at a time: each locks once the night before it has closed.
      const previous = copies[copies.indexOf(copy) - 1];
      if (previous !== undefined && atMs < previous.window.closeTs) break;
      const draft: StoredPlan = {
        v: 1,
        id: `${standing.id}-${copy.sequence}`,
        status: "draft",
        createdAt: new Date(atMs).toISOString(),
        input: { standingRunId: standing.id, sequence: copy.sequence }
      };
      const locked = await this.freeze(
        this.requireConfiguredChain(),
        draft,
        copy.plan,
        copy.event,
        standing.runHash
      );
      nights[key] = {
        sequence: copy.sequence,
        status: "locked",
        planStoreId: locked.id,
        closeTs: copy.window.closeTs
      };
      changed = true;
      break;
    }
    const endTs = standing.run.stoppedAtMs ?? standing.run.untilTs;
    const finished =
      atMs > endTs && copies.every((copy) => nights[copy.event.eventKey] !== undefined);
    if (!changed && !finished) return;
    const next: StoredStanding = { ...standing, nights };
    delete next.lastError;
    if (finished) next.status = "ended";
    await this.options.store.saveStanding(next);
  }

  private async saveMissedNight(
    standing: StoredStanding,
    plan: PlanContext,
    event: EventRecord
  ): Promise<void> {
    await this.options.store.saveRecordItem({
      id: `${standing.id}:${event.eventKey}`,
      planId: null,
      owner: standing.owner,
      status: "missed",
      standingRunId: standing.id,
      ticker: plan.ticker,
      kind: plan.kind,
      promise: describePlan(plan),
      window: event.kind,
      lockedAt: null,
      closeTs: event.lockTs ?? 0,
      openTs: event.openTs ?? 0,
      freezeTx: null,
      outcome: null,
      reason: "LOCK_MISSED",
      openPrice: null,
      verdictTx: null
    });
  }

  private async planFromInput(
    input: Record<string, unknown>,
    standingRunId: string | null
  ): Promise<PlanContext> {
    const ticker = text(input.ticker, "ticker").toUpperCase();
    const kind = text(input.kind, "kind") as PlanKind;
    if (!WINDOW_PLAN_KINDS.includes(kind)) {
      throw new PlanError(
        400,
        "PLAN_INVALID",
        `Off-hours plans must be one of: ${WINDOW_PLAN_KINDS.join(", ")}.`
      );
    }
    const token = await this.options.listedToken(ticker);
    if (token === null) {
      throw new PlanError(400, "TOKEN_NOT_LISTED", `${ticker} has no bStock on the official list.`);
    }
    if (!token.multiplierAgreement) {
      throw new PlanError(409, "MULTIPLIER_MISMATCH", `${ticker} share counts disagree.`);
    }
    return {
      kind,
      standingRunId,
      ticker,
      wrapper: "bStock",
      tokenAddress: token.address,
      heldShares: text(input.heldShares, "heldShares"),
      params: paramsFrom(input)
    };
  }

  private async freeze(
    chain: PlanChain,
    stored: StoredPlan,
    plan: PlanContext,
    event: EventRecord,
    standingRunHash?: Hex
  ): Promise<StoredPlan> {
    const context = eventContext(event);
    const planHash = hashPlan(plan);
    const owner = chain.agentAddress;
    const freeze = await chain.freeze({
      owner,
      eventKey: event.eventKey,
      planHash,
      ticker: plan.ticker,
      lockTs: context.lockTs,
      ...(standingRunHash === undefined ? {} : { standingRunHash })
    });
    const locked: StoredPlan = {
      ...stored,
      status: "locked",
      plan,
      event,
      planHash,
      owner,
      planId: freeze.planId,
      freeze
    };
    await this.options.store.savePlan(locked);
    await this.options.store.saveRunEvent(stored.id, "locked", {
      planId: freeze.planId,
      txHash: freeze.txHash,
      lockTs: context.lockTs,
      openTs: context.openTs
    });
    await this.saveRecord(locked);
    return locked;
  }

  private requireConfiguredChain(): PlanChain {
    if (this.options.chain === null) {
      throw new PlanError(
        503,
        "PLANBOOK_NOT_CONFIGURED",
        "PlanBook and the agent key are not configured on this agent."
      );
    }
    return this.options.chain;
  }

  private async advance(stored: StoredPlan): Promise<void> {
    const { plan, event } = stored;
    if (plan === undefined || event === undefined) throw new Error("Locked plan is incomplete.");
    const context = eventContext(event);
    const atMs = this.now();
    if (atMs < context.lockTs) return;

    if (stored.status === "locked") {
      const input = await this.decisionInput(plan, context, atMs);
      if (input === null) return;
      const decision = decide(input);
      const atOpen = atMs >= context.openTs;
      await this.logEvaluation(stored, input, decision);
      if (!atOpen && !isTerminal(decision)) return;
      if (atOpen && decision.refusal?.code === "REAL_PRICE_UNAVAILABLE") return;
      stored = await this.recordDecision(stored, input, decision);
    }

    if (stored.status === "decided" && atMs >= context.openTs) {
      await this.publishResult(stored, atMs);
    }
  }

  private async decisionInput(
    plan: PlanContext,
    event: EventContext,
    atMs: number
  ): Promise<DecisionInput | null> {
    const price = await this.options.latestPrice(plan.ticker);
    // The plan compares against tonight's official close; wait until it is published.
    if (price === null || price.close.date !== nyDate(event.lockTs)) return null;
    const realAge = ageSeconds(price.real.fetchedAt, atMs);
    return {
      plan,
      event,
      extracted: null,
      quotes: [],
      quoteChecks: [],
      status: { reasonCode: null, reasonMsg: null },
      audit: {
        status: "no_data",
        reason: null,
        officialListAddress: true,
        multiplierAgreement: true,
        walletRefused: false
      },
      wallet: {
        connected: false,
        tokenAllowed: true,
        quotaLeftUsd: "0",
        requiredQuotaUsd: "0",
        sessionExpiresAtMs: 0,
        requiredUntilMs: event.openTs
      },
      poolDepthUsd: price.pool.reserveUsd,
      atMs,
      executionEnabled: false,
      prices: {
        C: price.close.value,
        P: price.real.value,
        T: price.token.value,
        sources: { C: price.close.source, P: price.real.source, T: price.token.source },
        ages: {
          C: ageSeconds(price.close.fetchedAt, atMs),
          P: realAge,
          T: ageSeconds(price.token.fetchedAt, atMs)
        }
      }
    };
  }

  private async logEvaluation(
    stored: StoredPlan,
    input: DecisionInput,
    decision: Decision
  ): Promise<void> {
    const refusal = decision.refusal?.code ?? null;
    const previous = stored.lastEvaluation;
    const changed =
      previous === undefined || previous.action !== decision.action || previous.refusal !== refusal;
    if (!changed && input.atMs - previous.at < EVALUATION_LOG_INTERVAL_MS) return;
    stored.lastEvaluation = { at: input.atMs, action: decision.action, refusal };
    await this.options.store.savePlan(stored);
    await this.options.store.saveRunEvent(stored.id, `check:${input.atMs}`, {
      action: decision.action,
      refusal,
      reason: decision.reason,
      prices: input.prices
    });
  }

  private async recordDecision(
    stored: StoredPlan,
    input: DecisionInput,
    decision: Decision
  ): Promise<StoredPlan> {
    const decisionHash = hashDecision(input, decision);
    const chain = this.requireChain();
    const write = await chain.recordDecision(this.requirePlanId(stored), decisionHash);
    const decided: StoredPlan = {
      ...withoutError(stored),
      status: "decided",
      decision: { at: input.atMs, input, decision, decisionHash, chain: write }
    };
    await this.options.store.savePlan(decided);
    await this.options.store.saveRunEvent(stored.id, "decided", {
      action: decision.action,
      refusal: decision.refusal?.code ?? null,
      reason: decision.reason,
      txHash: write.txHash
    });
    return decided;
  }

  private async publishResult(stored: StoredPlan, atMs: number): Promise<void> {
    const { decision, event, plan } = stored;
    if (decision === undefined || event === undefined || plan === undefined) {
      throw new Error("Decided plan is incomplete.");
    }
    const openTs = event.openTs ?? atMs;
    const open = await this.options.officialOpen(plan.ticker, nyDate(openTs));
    if (open === null && atMs - openTs < OPEN_PRICE_WAIT_MS) return;

    const outcome = outcomeFor(decision.decision);
    const verdict: ReceiptVerdict = {
      outcome,
      reason: decision.decision.refusal?.code ?? decision.decision.reason,
      ...(open === null ? {} : { openPrice: open.value })
    };
    const verdictHash = hashVerdict(verdict);
    const write = await this.requireChain().recordVerdict(
      this.requirePlanId(stored),
      outcome,
      verdictHash
    );
    const done: StoredPlan = {
      ...withoutError(stored),
      status: "done",
      verdict: { ...verdict, verdictHash },
      verdictChain: write
    };
    await this.options.store.savePlan(done);
    await this.options.store.saveRunEvent(stored.id, "result", {
      outcome,
      openPrice: open?.value ?? null,
      openSource: open?.sourceRecordPath ?? null,
      txHash: write.txHash
    });
    await this.options.store.saveReceipt(stored.id, this.receipt(done));
    await this.saveRecord(done);
  }

  private receipt(stored: StoredPlan): ReceiptBundle {
    const { event, plan, planHash, freeze, decision, verdict } = stored;
    if (!event || !plan || !planHash || !freeze || !decision || !verdict) {
      throw new Error("Receipt needs a finished plan.");
    }
    const { verdictHash, ...verdictBody } = verdict;
    return {
      v: 1,
      event,
      plan: { ...plan, planId: stored.planId ?? null },
      planHash,
      freezeTx: freeze.txHash,
      freezeBlockTs: freeze.blockTs * 1000,
      decisions: [
        {
          at: decision.at,
          input: decision.input,
          decision: decision.decision,
          decisionHash: decision.decisionHash
        }
      ],
      fills: [],
      verdict: verdictBody,
      verdictHash
    };
  }

  private async saveRecord(stored: StoredPlan): Promise<void> {
    const { plan, event, freeze, owner } = stored;
    if (!plan || !event || !freeze || !owner || stored.planId === undefined) return;
    await this.options.store.saveRecordItem({
      id: stored.id,
      planId: stored.planId,
      owner,
      status: stored.status,
      standingRunId: plan.standingRunId ?? null,
      ticker: plan.ticker,
      kind: plan.kind,
      promise: describePlan(plan),
      window: event.kind,
      lockedAt: freeze.blockTs * 1000,
      closeTs: event.lockTs ?? 0,
      openTs: event.openTs ?? 0,
      freezeTx: freeze.txHash,
      outcome: stored.verdict?.outcome ?? null,
      reason: stored.verdict?.reason ?? null,
      openPrice: stored.verdict?.openPrice ?? null,
      verdictTx: stored.verdictChain?.txHash ?? null
    });
  }

  private async requirePlan(id: string): Promise<StoredPlan> {
    const stored = await this.options.store.getPlan(id);
    if (stored === null)
      throw new PlanError(404, "PLAN_NOT_FOUND", "The requested plan does not exist.");
    return stored;
  }

  private requireChain(): PlanChain {
    if (this.options.chain === null) throw new Error("PlanBook is not configured.");
    return this.options.chain;
  }

  private requirePlanId(stored: StoredPlan): number {
    if (stored.planId === undefined) throw new Error(`Plan ${stored.id} has no PlanBook id.`);
    return stored.planId;
  }
}
