import Decimal from "decimal.js";
import { refusal, type RefusalCode } from "./refuse.js";
import type { Decision, DecisionInput, NormalizedQuote, QuoteCheckResult } from "./types.js";

function decimal(value: string, field: string): Decimal {
  try {
    const result = new Decimal(value);
    if (!result.isFinite()) throw new Error("not finite");
    return result;
  } catch {
    throw new Error(`${field} must be a finite decimal.`);
  }
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`${field} is required for this decision.`);
  return value;
}

function noTrade(reason: string): Decision {
  return { action: "none", size: {}, wrapper: null, reason, refusal: null };
}

function realPrice(input: DecisionInput): Decimal | Decision {
  const age = input.prices.ages.P;
  if (input.prices.P === null || age === null || !Number.isFinite(age) || age < 0 || age > 120) {
    return refused("REAL_PRICE_UNAVAILABLE", input);
  }
  return decimal(input.prices.P, "24/7 price");
}

function tokenGapPct(input: DecisionInput, real: Decimal): Decimal {
  return decimal(input.prices.T, "token price").minus(real).abs().div(real).mul(100);
}

function triggerDropPct(input: DecisionInput, real: Decimal): Decimal {
  const close = decimal(input.prices.C, "US close");
  if (close.lte(0)) throw new Error("US close must be greater than zero.");
  return close.minus(real).div(close).mul(100);
}

function triggerRisePct(input: DecisionInput, real: Decimal): Decimal {
  const close = decimal(input.prices.C, "US close");
  if (close.lte(0)) throw new Error("US close must be greater than zero.");
  return real.minus(close).div(close).mul(100);
}

function tokenBelowRealGapPct(input: DecisionInput, real: Decimal): Decimal {
  return real.minus(decimal(input.prices.T, "token price")).div(real).mul(100);
}

function refused(
  code: RefusalCode,
  input: DecisionInput,
  details: Record<string, string> = {},
  reasonIsCode = false
): Decision {
  return {
    action: "none",
    size: {},
    wrapper: null,
    reason: reasonIsCode ? code : (details.reason ?? code),
    refusal: refusal(code, { ticker: input.plan.ticker, ...details })
  };
}

function auditGate(input: DecisionInput): Decision | null {
  if (input.audit.status === "unavailable") {
    return refused("AUDIT_UNAVAILABLE", input);
  }
  if (input.audit.status === "flagged") {
    return refused("AUDIT_FLAGGED", input, {
      reason: input.audit.reason ?? "the security check reported a risk"
    });
  }
  if (
    input.audit.status === "no_data" &&
    (!input.audit.officialListAddress ||
      !input.audit.multiplierAgreement ||
      input.audit.walletRefused)
  ) {
    return refused("AUDIT_NO_DATA", input);
  }
  return null;
}

function commonTradeGate(input: DecisionInput): Decision | null {
  if (!input.executionEnabled) return refused("EXECUTION_DISABLED", input);
  if (input.status.reasonCode === "ASSET_PAUSED") {
    return refused("ASSET_PAUSED", input, { reason: input.status.reasonMsg ?? "issuer pause" });
  }
  if (!input.wallet.tokenAllowed) return refused("TOKEN_NOT_ALLOWED", input);
  const audit = auditGate(input);
  if (audit) return audit;
  if (!input.wallet.connected) return refused("SESSION_LOST", input);
  if (input.wallet.sessionExpiresAtMs <= input.wallet.requiredUntilMs) {
    return refused("SESSION_EXPIRING", input, {
      sessionEndsAt: new Date(input.wallet.sessionExpiresAtMs).toISOString()
    });
  }
  const quotaLeft = decimal(input.wallet.quotaLeftUsd, "wallet quota left");
  const quotaNeeded = decimal(input.wallet.requiredQuotaUsd, "wallet quota needed");
  if (quotaLeft.lt(quotaNeeded)) {
    return refused("QUOTA_LOW", input, {
      quotaLeftUsd: input.wallet.quotaLeftUsd,
      quotaNeededUsd: input.wallet.requiredQuotaUsd
    });
  }
  const poolDepth = decimal(input.poolDepthUsd, "pool depth");
  const minimumDepth = decimal(input.plan.params.minPoolDepthUsd, "minimum pool depth");
  if (poolDepth.lt(minimumDepth)) {
    return refused("POOL_TOO_THIN", input, {
      currentUsd: input.poolDepthUsd,
      neededUsd: input.plan.params.minPoolDepthUsd
    });
  }
  return null;
}

function quoteFor(
  input: DecisionInput,
  side: NormalizedQuote["side"]
): { quote: NormalizedQuote; check: QuoteCheckResult } | Decision {
  const candidates = input.quotes
    .filter((candidate) => {
      if (candidate.id.length === 0 || candidate.side !== side) return false;
      if (side === "sell" && candidate.wrapper !== input.plan.wrapper) return false;
      if (
        side === "sell" &&
        candidate.tokenAddress.toLowerCase() !== input.plan.tokenAddress.toLowerCase()
      ) {
        return false;
      }
      return true;
    })
    .flatMap((quote) => {
      const check = input.quoteChecks.find((candidate) => candidate.quoteId === quote.id);
      return check?.passed ? [{ quote, check }] : [];
    });

  if (candidates.length === 0) {
    const failed = input.quoteChecks.find((candidate) => candidate.code !== null);
    if (failed) {
      const code = failed.code ?? "QUOTE_REJECTED";
      // Every refusal sentence finds the fields it needs; a missing one would throw
      // at the moment the agent must decide.
      return refused(
        code,
        input,
        {
          reason: failed.reason,
          actualPrice: failed.impliedPricePerShare ?? "unknown",
          referencePrice: failed.referencePricePerShare ?? "unknown",
          impactPct:
            input.quotes.find((quote) => quote.id === failed.quoteId)?.priceImpactPct ?? "unknown",
          limitPct: input.plan.params.maxPriceImpactPct,
          multiplierA: failed.multiplierA ?? "unknown",
          multiplierB: failed.multiplierB ?? "unknown",
          displayedGapPct: failed.deviationPct ?? "unknown",
          orderUsd: "unknown",
          sizedPricePerShare: failed.sizedPricePerShare ?? "unknown"
        },
        true
      );
    }
    return refused("QUOTE_REJECTED", input, { actualPrice: "missing", referencePrice: "missing" });
  }

  candidates.sort((left, right) => {
    if (side === "sell") return 0;
    const leftCost = new Decimal(left.check.effectiveCostPerShare ?? "Infinity");
    const rightCost = new Decimal(right.check.effectiveCostPerShare ?? "Infinity");
    const comparison = leftCost.comparedTo(rightCost);
    if (comparison !== 0) return comparison;
    return left.quote.wrapper === "bStock" ? -1 : right.quote.wrapper === "bStock" ? 1 : 0;
  });
  return candidates[0] as { quote: NormalizedQuote; check: QuoteCheckResult };
}

function protect(input: DecisionInput): Decision {
  const sellAtMs = required(input.plan.params.sellAtMs, "sellAtMs");
  if (input.atMs < sellAtMs) {
    return noTrade("Protect sell time has not arrived.");
  }
  const gate = commonTradeGate(input);
  if (gate) return gate;
  const quote = quoteFor(input, "sell");
  if ("action" in quote) return quote;
  const sellPct = decimal(required(input.plan.params.sellPct, "sellPct"), "sellPct");
  const heldShares = decimal(input.plan.heldShares, "heldShares");
  const shares = heldShares.mul(sellPct).div(100).toSignificantDigits(30).toString();
  return {
    action: "sell",
    size: { shares },
    wrapper: quote.quote.wrapper,
    reason: `Protect plan: sell ${sellPct.toString()}% at the scheduled protection time.`,
    refusal: null
  };
}

function guard(input: DecisionInput): Decision {
  const real = realPrice(input);
  if ("action" in real) return real;
  const trigger = decimal(
    required(input.plan.params.triggerDropPct, "triggerDropPct"),
    "triggerDropPct"
  );
  const drop = triggerDropPct(input, real);
  if (drop.lt(trigger)) {
    return input.atMs >= input.event.openTs
      ? refused("CONDITION_NOT_MET", input)
      : noTrade(
          `Guard is waiting: the 24/7 price is ${drop.toSignificantDigits(30).toString()}% below the close; the trigger is ${trigger.toString()}%.`
        );
  }
  if (input.atMs >= input.event.openTs) return refused("WINDOW_CLOSED", input);
  const maximumGap = decimal(
    required(input.plan.params.maxGapToRealPricePct, "maxGapToRealPricePct"),
    "maxGapToRealPricePct"
  );
  const gap = tokenGapPct(input, real);
  if (gap.gt(maximumGap)) {
    return refused("PRICE_OFF_REAL", input, {
      gapPct: gap.toSignificantDigits(30).toString(),
      limitPct: maximumGap.toString()
    });
  }
  const gate = commonTradeGate(input);
  if (gate) return gate;
  const quote = quoteFor(input, "sell");
  if ("action" in quote) return quote;
  const sellPct = decimal(required(input.plan.params.sellPct, "sellPct"), "sellPct");
  const shares = decimal(input.plan.heldShares, "heldShares")
    .mul(sellPct)
    .div(100)
    .toSignificantDigits(30)
    .toString();
  return {
    action: "sell",
    size: { shares },
    wrapper: quote.quote.wrapper,
    reason: `Guard: 24/7 price ${drop.toSignificantDigits(30).toString()}% below the close; token within ${gap.toSignificantDigits(30).toString()}% of it.`,
    refusal: null
  };
}

function buyDip(input: DecisionInput): Decision {
  const real = realPrice(input);
  if ("action" in real) return real;
  const trigger = decimal(
    required(input.plan.params.triggerDropPct, "triggerDropPct"),
    "triggerDropPct"
  );
  const drop = triggerDropPct(input, real);
  if (drop.lt(trigger)) {
    return input.atMs >= input.event.openTs
      ? refused("CONDITION_NOT_MET", input)
      : noTrade(
          `Buy-the-dip plan is waiting: the 24/7 price is ${drop.toSignificantDigits(30).toString()}% below the close; the trigger is ${trigger.toString()}%.`
        );
  }
  if (input.atMs >= input.event.openTs) return refused("WINDOW_CLOSED", input);
  const maximumGap = decimal(
    required(input.plan.params.maxGapToRealPricePct, "maxGapToRealPricePct"),
    "maxGapToRealPricePct"
  );
  const gap = tokenGapPct(input, real);
  if (gap.gt(maximumGap)) {
    return refused("PRICE_OFF_REAL", input, {
      gapPct: gap.toSignificantDigits(30).toString(),
      limitPct: maximumGap.toString()
    });
  }
  const gate = commonTradeGate(input);
  if (gate) return gate;
  const quote = quoteFor(input, "buy");
  if ("action" in quote) return quote;
  const maxUsd = required(input.plan.params.maxUsd, "maxUsd");
  return {
    action: "buy",
    size: { usd: maxUsd },
    wrapper: quote.quote.wrapper,
    reason: `Buy the dip: 24/7 price ${drop.toSignificantDigits(30).toString()}% below the close; token within ${gap.toSignificantDigits(30).toString()}% of it.`,
    refusal: null
  };
}

function sellRise(input: DecisionInput): Decision {
  const real = realPrice(input);
  if ("action" in real) return real;
  const trigger = decimal(
    required(input.plan.params.triggerRisePct, "triggerRisePct"),
    "triggerRisePct"
  );
  const rise = triggerRisePct(input, real);
  if (rise.lt(trigger)) {
    return input.atMs >= input.event.openTs
      ? refused("CONDITION_NOT_MET", input)
      : noTrade(
          `Sell-the-rise plan is waiting: the 24/7 price is ${rise.toSignificantDigits(30).toString()}% above the close; the trigger is ${trigger.toString()}%.`
        );
  }
  if (input.atMs >= input.event.openTs) return refused("WINDOW_CLOSED", input);
  const maximumGap = decimal(
    required(input.plan.params.maxGapToRealPricePct, "maxGapToRealPricePct"),
    "maxGapToRealPricePct"
  );
  const gap = tokenBelowRealGapPct(input, real);
  if (gap.gt(maximumGap)) {
    return refused("PRICE_OFF_REAL", input, {
      gapPct: gap.toSignificantDigits(30).toString(),
      limitPct: maximumGap.toString()
    });
  }
  const gate = commonTradeGate(input);
  if (gate) return gate;
  const quote = quoteFor(input, "sell");
  if ("action" in quote) return quote;
  const sellPct = decimal(required(input.plan.params.sellPct, "sellPct"), "sellPct");
  const shares = decimal(input.plan.heldShares, "heldShares")
    .mul(sellPct)
    .div(100)
    .toSignificantDigits(30)
    .toString();
  return {
    action: "sell",
    size: { shares },
    wrapper: quote.quote.wrapper,
    reason: `Sell the rise: 24/7 price ${rise.toSignificantDigits(30).toString()}% above the close; token is no more than ${gap.toSignificantDigits(30).toString()}% below it.`,
    refusal: null
  };
}

function react(input: DecisionInput): Decision {
  if (input.event.kind !== "earnings" || input.event.consensus === null) {
    return refused("NO_CONSENSUS", input);
  }
  if (input.event.consensus.noOfEsts < 3) return refused("NO_CONSENSUS", input);
  if (input.extracted === null || !input.extracted.verified) {
    return refused("EXTRACT_UNVERIFIED", input);
  }
  if (input.extracted.basis !== input.event.consensus.basis) {
    return refused("EPS_BASIS_MISMATCH", input);
  }
  const actual = decimal(input.extracted.actualEps, "actual EPS");
  const consensus = decimal(input.event.consensus.eps, "consensus EPS");
  if (consensus.isZero()) return refused("NO_CONSENSUS", input);
  const surprise = actual.minus(consensus).div(consensus.abs()).mul(100);
  const threshold = decimal(
    required(input.plan.params.surpriseThresholdPct, "surpriseThresholdPct"),
    "surpriseThresholdPct"
  );
  if (surprise.abs().lt(threshold)) {
    return noTrade(
      `EPS surprise ${surprise.toSignificantDigits(30).toString()}% is below the plan threshold.`
    );
  }

  const real = realPrice(input);
  if ("action" in real) return real;
  const close = decimal(input.prices.C, "US close");
  if (close.lte(0)) throw new Error("US close must be greater than zero.");
  const move = real.minus(close).div(close).mul(100);
  const unpriced = decimal(
    required(input.plan.params.unpricedThresholdPct, "unpricedThresholdPct"),
    "unpricedThresholdPct"
  );
  const sameDirection = move.isZero() || move.s === surprise.s;
  if (!sameDirection || move.abs().gte(unpriced)) {
    return noTrade("The surprise is already reflected in the 24/7 price.");
  }

  const direction = required(input.plan.params.direction, "direction");
  const side: NormalizedQuote["side"] = surprise.isNegative() ? "sell" : "buy";
  if (
    (side === "sell" && direction === "buy-only") ||
    (side === "buy" && direction === "sell-only")
  ) {
    return noTrade(`The surprise direction is outside the plan direction (${direction}).`);
  }
  const gate = commonTradeGate(input);
  if (gate) return gate;
  const quote = quoteFor(input, side);
  if ("action" in quote) return quote;
  const maxUsd = required(input.plan.params.maxUsd, "maxUsd");
  return {
    action: side,
    size: { usd: maxUsd },
    wrapper: quote.quote.wrapper,
    reason: `React plan: ${surprise.toSignificantDigits(30).toString()}% EPS surprise with ${unpriced.toString()}% still unpriced in the 24/7 price.`,
    refusal: null
  };
}

export function decide(input: DecisionInput): Decision {
  if (input.plan.kind === "hold") {
    return {
      action: "hold",
      size: {},
      wrapper: input.plan.wrapper,
      reason: "Hold plan: no trades; monitor the window and report the result.",
      refusal: null
    };
  }
  if (input.plan.kind === "guard") return guard(input);
  if (input.plan.kind === "buy_dip") return buyDip(input);
  if (input.plan.kind === "sell_rise") return sellRise(input);
  if (input.plan.kind === "protect") return protect(input);
  return react(input);
}
