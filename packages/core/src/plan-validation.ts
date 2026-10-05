import Decimal from "decimal.js";
import type { EventContext, PlanContext } from "./types.js";

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
  requiredPositive(plan.heldShares, "heldShares", issues);
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

  if (plan.kind === "protect") {
    const sellPct = numberValue(plan.params.sellPct, "params.sellPct", issues);
    between(sellPct, "10", "100", "params.sellPct", issues);
    const sellAt = numberValue(plan.params.sellAtMs, "params.sellAtMs", issues);
    if (sellAt !== null) {
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
    if (event.kind !== "earnings") {
      issues.push({ field: "kind", message: "React is allowed only for earnings events." });
    }
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
    if (windowEnd !== null && windowEnd.lt(event.releaseTs)) {
      issues.push({ field: "params.windowEndMs", message: "must not be before release." });
    }
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
