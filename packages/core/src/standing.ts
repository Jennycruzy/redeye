import Decimal from "decimal.js";
import { createWindowRecord, type EventRecord } from "./events.js";
import { nextWindow, type OffHoursWindow } from "./session.js";
import { refusal } from "./refuse.js";
import type { PlanContext, Refusal } from "./types.js";

const MAX_STANDING_DAYS = 30;
const STANDING_LOCK_OFFSET_MS = 10 * 60 * 1000;

export interface StandingPlanRun {
  runId: string;
  template: PlanContext;
  startAtMs: number;
  untilTs: number;
  stoppedAtMs: number | null;
}

export interface StandingWindowCopy {
  runId: string;
  sequence: number;
  window: OffHoursWindow;
  event: EventRecord;
  plan: PlanContext;
  lockByMs: number;
}

export interface StandingQuota {
  remainingUsd: string;
  requiredUsd: string;
}

export interface StandingLockResult {
  status: "locked" | "refused";
  copy: StandingWindowCopy;
  lockedAtMs: number | null;
  remainingUsd: string | null;
  refusal: Refusal | null;
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`);
  return value;
}

function validateRun(input: StandingPlanRun): void {
  if (input.runId.trim().length === 0) throw new Error("Standing run id must not be empty.");
  finite(input.startAtMs, "standing startAtMs");
  finite(input.untilTs, "standing untilTs");
  if (input.untilTs <= input.startAtMs)
    throw new Error("Standing plan end must be after its start.");
  if (input.untilTs - input.startAtMs > MAX_STANDING_DAYS * 86_400_000) {
    throw new Error("Standing plans may run for at most 30 days.");
  }
  if (input.stoppedAtMs !== null) finite(input.stoppedAtMs, "standing stoppedAtMs");
  if (!input.template.kind.match(/^(guard|buy_dip|sell_rise|hold)$/)) {
    throw new Error("Only off-hours plans can repeat as standing plans.");
  }
}

export function createStandingRun(input: {
  runId: string;
  template: PlanContext;
  startAtMs: number;
  untilTs: number;
}): StandingPlanRun {
  const run: StandingPlanRun = { ...input, stoppedAtMs: null };
  validateRun(run);
  return run;
}

export function stopStandingRun(run: StandingPlanRun, stoppedAtMs: number): StandingPlanRun {
  finite(stoppedAtMs, "standing stoppedAtMs");
  if (stoppedAtMs < run.startAtMs) throw new Error("Standing plan cannot stop before it starts.");
  return { ...run, stoppedAtMs };
}

export function expandStandingPlan(run: StandingPlanRun): StandingWindowCopy[] {
  validateRun(run);
  const copies: StandingWindowCopy[] = [];
  let cursor = run.startAtMs;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const window = nextWindow(cursor);
    if (window.closeTs < run.startAtMs) {
      cursor = window.openTs + 1;
      continue;
    }
    if (window.closeTs > run.untilTs) break;
    const lockByMs = window.closeTs - STANDING_LOCK_OFFSET_MS;
    if (run.stoppedAtMs !== null && lockByMs > run.stoppedAtMs) break;
    const event = createWindowRecord(
      window.kind,
      run.template.ticker,
      window.closeTs,
      window.openTs
    );
    copies.push({
      runId: run.runId,
      sequence: copies.length,
      window,
      event,
      plan: { ...run.template, standingRunId: run.runId },
      lockByMs
    });
    cursor = window.openTs + 1;
  }
  return copies;
}

function quotaFailure(copy: StandingWindowCopy, quota: StandingQuota): StandingLockResult | null {
  const remaining = new Decimal(quota.remainingUsd);
  const required = new Decimal(quota.requiredUsd);
  if (!remaining.isFinite() || remaining.lt(0))
    throw new Error("Standing remaining quota is invalid.");
  if (!required.isFinite() || required.lt(0))
    throw new Error("Standing required quota is invalid.");
  if (remaining.gte(required)) return null;
  return {
    status: "refused",
    copy,
    lockedAtMs: null,
    remainingUsd: quota.remainingUsd,
    refusal: refusal("QUOTA_LOW", {
      ticker: copy.plan.ticker,
      quotaLeftUsd: quota.remainingUsd,
      quotaNeededUsd: quota.requiredUsd
    })
  };
}

export function lockStandingCopy(
  copy: StandingWindowCopy,
  atMs: number,
  quota?: StandingQuota
): StandingLockResult {
  finite(atMs, "standing lock time");
  if (atMs > copy.lockByMs) {
    return {
      status: "refused",
      copy,
      lockedAtMs: null,
      remainingUsd: quota?.remainingUsd ?? null,
      refusal: refusal("LOCK_MISSED", { ticker: copy.plan.ticker })
    };
  }
  if (quota !== undefined) {
    const failure = quotaFailure(copy, quota);
    if (failure !== null) return failure;
    const remaining = new Decimal(quota.remainingUsd).minus(new Decimal(quota.requiredUsd));
    return {
      status: "locked",
      copy,
      lockedAtMs: atMs,
      remainingUsd: remaining.toSignificantDigits(30).toString(),
      refusal: null
    };
  }
  return { status: "locked", copy, lockedAtMs: atMs, remainingUsd: null, refusal: null };
}
