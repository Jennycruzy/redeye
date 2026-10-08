import Decimal from "decimal.js";
import type { EventContext, PlanContext } from "./types.js";

const offHoursKinds = ["overnight", "weekend", "holiday"] as const;

function isOffHours(kind: EventContext["kind"]): boolean {
  return offHoursKinds.includes(kind as (typeof offHoursKinds)[number]);
}

export function planLockDeadlineMs(event: EventContext): number {
  return event.lockTs - (isOffHours(event.kind) ? 5 : 30) * 60 * 1000;
}

export interface PlanValidationIssue {
  field: string;
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  issues: PlanValidationIssue[];
}

function numberValue(
  value: string | number | undefined,
  field: string,
  issues: PlanValidationIssue[]
): Decimal | null {
  if (value === undefined) {
    issues.push({ field, message: "is required." });
    return null;
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    issues.push({ field, message: "must be a finite number." });
    return null;
  }
}

function between(
  value: Decimal | null,
  minimum: string,
  maximum: string,
  field: string,
  issues: PlanValidationIssue[]
): void {
  if (value === null) return;
  if (value.lt(minimum) || value.gt(maximum)) {
    issues.push({ field, message: `must be between ${minimum} and ${maximum}.` });
  }
}

function requiredPositive(value: string, field: string, issues: PlanValidationIssue[]): void {
  const parsed = numberValue(value, field, issues);
  if (parsed !== null && parsed.lte(0))
    issues.push({ field, message: "must be greater than zero." });
}

export function validatePlan(plan: PlanContext, event: EventContext): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(plan.ticker)) {
    issues.push({ field: "ticker", message: "must be an uppercase ticker." });
  }
  if (plan.ticker !== event.ticker) {
    issues.push({ field: "ticker", message: "must match the event ticker." });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(plan.tokenAddress)) {
    issues.push({ field: "tokenAddress", message: "must be a checksum-valid EVM address format." });
  }
  if (plan.kind === "buy_dip") {
    // Buying the dip spends cash, so a holder may start with no shares at all.
    const held = numberValue(plan.heldShares, "heldShares", issues);
    if (held !== null && held.lt(0)) {
      issues.push({ field: "heldShares", message: "must not be negative." });
    }
  } else {
    requiredPositive(plan.heldShares, "heldShares", issues);
  }
  const maxImpact = numberValue(plan.params.maxPriceImpactPct, "params.maxPriceImpactPct", issues);
  between(maxImpact, "0.2", "3", "params.maxPriceImpactPct", issues);
  const minimumDepth = numberValue(plan.params.minPoolDepthUsd, "params.minPoolDepthUsd", issues);
  if (minimumDepth !== null && minimumDepth.lt("25000")) {
    issues.push({ field: "params.minPoolDepthUsd", message: "must be at least 25000 USD." });
  }

  if (event.kind === "material_filing") {
    issues.push({
      field: "event.kind",
      message: "material filings are feed-only and cannot have a frozen plan."
    });
  }

  if ((plan.kind === "buy_dip" || plan.kind === "sell_rise") && !isOffHours(event.kind)) {
    issues.push({ field: "kind", message: "This plan is allowed only for off-hours windows." });
  }
  if (plan.kind === "protect" && event.kind !== "earnings" && event.kind !== "scheduled_report") {
    issues.push({ field: "kind", message: "Protect is allowed only for scheduled releases." });
  }
  if (plan.kind === "react" && event.kind !== "earnings") {
    issues.push({ field: "kind", message: "React is allowed only for earnings events." });
  }

  if (plan.kind === "guard") {
    const trigger = numberValue(plan.params.triggerDropPct, "params.triggerDropPct", issues);
    between(trigger, "1", "20", "params.triggerDropPct", issues);
    const sellPct = numberValue(plan.params.sellPct, "params.sellPct", issues);
    between(sellPct, "10", "100", "params.sellPct", issues);
    const maximumGap = numberValue(
      plan.params.maxGapToRealPricePct,
      "params.maxGapToRealPricePct",
      issues
    );
    between(maximumGap, "0.2", "2", "params.maxGapToRealPricePct", issues);
  }

  if (plan.kind === "buy_dip") {
    const trigger = numberValue(plan.params.triggerDropPct, "params.triggerDropPct", issues);
    between(trigger, "1", "20", "params.triggerDropPct", issues);
    const maximumGap = numberValue(
      plan.params.maxGapToRealPricePct,
      "params.maxGapToRealPricePct",
      issues
    );
    between(maximumGap, "0.1", "2", "params.maxGapToRealPricePct", issues);
    const maxUsd = numberValue(plan.params.maxUsd, "params.maxUsd", issues);
    if (maxUsd !== null && maxUsd.lt(5)) {
      issues.push({ field: "params.maxUsd", message: "must be at least 5 USD." });
    }
  }

  if (plan.kind === "sell_rise") {
    const trigger = numberValue(plan.params.triggerRisePct, "params.triggerRisePct", issues);
    between(trigger, "1", "20", "params.triggerRisePct", issues);
    const sellPct = numberValue(plan.params.sellPct, "params.sellPct", issues);
    between(sellPct, "10", "100", "params.sellPct", issues);
    const maximumGap = numberValue(
      plan.params.maxGapToRealPricePct,
      "params.maxGapToRealPricePct",
      issues
    );
    between(maximumGap, "0.1", "2", "params.maxGapToRealPricePct", issues);
  }

  if (
    (plan.kind === "guard" || plan.kind === "sell_rise") &&
    plan.params.rebuyAtMs !== undefined &&
    plan.params.rebuyAtMs !== null
  ) {
    const rebuyAt = numberValue(plan.params.rebuyAtMs, "params.rebuyAtMs", issues);
    if (rebuyAt !== null) {
      const earliest = new Decimal(event.openTs);
      const latest = earliest.plus(6 * 60 * 60 * 1000);
      if (rebuyAt.lt(earliest) || rebuyAt.gt(latest)) {
        issues.push({
          field: "params.rebuyAtMs",
          message: "must be between the open and six hours after the open."
        });
      }
    }
  }

  if (plan.kind === "protect") {
    const sellPct = numberValue(plan.params.sellPct, "params.sellPct", issues);
    between(sellPct, "10", "100", "params.sellPct", issues);
    const sellAt = numberValue(plan.params.sellAtMs, "params.sellAtMs", issues);
    if (event.releaseTs === null) {
      issues.push({ field: "event.releaseTs", message: "is required for Protect." });
    } else if (sellAt !== null) {
      const lower = new Decimal(event.releaseTs).minus(6 * 60 * 60 * 1000);
      const upper = new Decimal(event.releaseTs).minus(10 * 60 * 1000);
      if (sellAt.lt(lower) || sellAt.gt(upper)) {
        issues.push({
          field: "params.sellAtMs",
          message: "must be between release minus six hours and release minus ten minutes."
        });
      }
    }
  }

  if (plan.kind === "react") {
    const surprise = numberValue(
      plan.params.surpriseThresholdPct,
      "params.surpriseThresholdPct",
      issues
    );
    between(surprise, "3", "50", "params.surpriseThresholdPct", issues);
    const unpriced = numberValue(
      plan.params.unpricedThresholdPct,
      "params.unpricedThresholdPct",
      issues
    );
    between(unpriced, "1", "10", "params.unpricedThresholdPct", issues);
    const maxUsd = numberValue(plan.params.maxUsd, "params.maxUsd", issues);
    if (maxUsd !== null && maxUsd.lt(5))
      issues.push({ field: "params.maxUsd", message: "must be at least 5 USD." });
    if (plan.params.direction === undefined) {
      issues.push({ field: "params.direction", message: "is required." });
    }
    const windowEnd = numberValue(plan.params.windowEndMs, "params.windowEndMs", issues);
    if (event.releaseTs === null) {
      issues.push({ field: "event.releaseTs", message: "is required for React." });
    } else if (windowEnd !== null && windowEnd.lt(event.releaseTs)) {
      issues.push({ field: "params.windowEndMs", message: "must not be before release." });
    }
  }

  if (plan.door !== undefined && plan.door !== "agentic_wallet") {
    issues.push({ field: "door", message: "must be agentic_wallet when set." });
  }
  if (plan.door !== undefined && plan.auditNoDataAccepted !== true) {
    issues.push({
      field: "auditNoDataAccepted",
      message: "must be true: the security audit has no data for stock tokens."
    });
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidPlan(plan: PlanContext, event: EventContext): void {
  const result = validatePlan(plan, event);
  if (!result.valid) {
    throw new Error(
      `Invalid plan: ${result.issues.map((issue) => `${issue.field} ${issue.message}`).join(" ")}`
    );
  }
}
