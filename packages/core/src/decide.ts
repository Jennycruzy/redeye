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

function refused(
  code: RefusalCode,
  input: DecisionInput,
  details: Record<string, string> = {}
): Decision {
  return {
    action: "none",
    size: {},
    wrapper: null,
    reason: details.reason ?? code,
    refusal: refusal(code, { ticker: input.plan.ticker, ...details })
  };
}

function commonTradeGate(input: DecisionInput): Decision | null {
  if (!input.executionEnabled) return refused("EXECUTION_DISABLED", input);
  if (input.status.reasonCode === "ASSET_PAUSED") {
    return refused("ASSET_PAUSED", input, { reason: input.status.reasonMsg ?? "issuer pause" });
  }
  if (!input.wallet.tokenAllowed) return refused("TOKEN_NOT_ALLOWED", input);
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
      return refused(code, input, {
        actualPrice: failed.impliedPricePerShare ?? "unknown",
        referencePrice: failed.referencePricePerShare ?? "unknown",
        impactPct:
          input.quotes.find((quote) => quote.id === failed.quoteId)?.priceImpactPct ?? "unknown",
        limitPct: input.plan.params.maxPriceImpactPct
      });
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

  const move = decimal(
    required(input.onChainMoveSinceReleasePct, "on-chain move"),
    "on-chain move"
  );
  const unpriced = decimal(
    required(input.plan.params.unpricedThresholdPct, "unpricedThresholdPct"),
    "unpricedThresholdPct"
  );
  const sameDirection = move.isZero() || move.s === surprise.s;
  if (!sameDirection || move.abs().gte(unpriced)) {
    return noTrade("The surprise is already reflected in the on-chain move.");
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
    reason: `React plan: ${surprise.toSignificantDigits(30).toString()}% EPS surprise with ${unpriced.toString()}% still unpriced on chain.`,
    refusal: null
  };
}

export function decide(input: DecisionInput): Decision {
  if (input.plan.kind === "hold") {
    return {
      action: "hold",
      size: {},
      wrapper: input.plan.wrapper,
      reason: "Hold plan: no trades; monitor the release and report the result.",
      refusal: null
    };
  }
  if (input.plan.kind === "protect") return protect(input);
  return react(input);
}
