import Decimal from "decimal.js";
import { refusal } from "./refuse.js";
import type { NormalizedQuote, QuoteCheckResult, Refusal } from "./types.js";

export interface QuoteCheckInput {
  ticker: string;
  quote: NormalizedQuote;
  expectedTokenAddress: string;
  expectedWrapper: NormalizedQuote["wrapper"];
  usReferencePricePerShare: string;
  realPricePerShare: string | null;
  realPriceAgeSeconds: number | null;
  marketOpen: boolean;
  maxPriceImpactPct: string;
  checkedAtMs: number;
}

export interface QuoteCheckOutput {
  result: QuoteCheckResult;
  refusal: Refusal | null;
}

function positiveDecimal(value: string, field: string): Decimal {
  try {
    const number = new Decimal(value);
    if (!number.isFinite() || number.lte(0)) throw new Error("not positive");
    return number;
  } catch {
    throw new Error(`${field} must be a positive decimal.`);
  }
}

function nonNegativeDecimal(value: string, field: string): Decimal {
  try {
    const number = new Decimal(value);
    if (!number.isFinite() || number.lt(0)) throw new Error("not non-negative");
    return number;
  } catch {
    throw new Error(`${field} must be a non-negative decimal.`);
  }
}

function result(
  ticker: string,
  quote: NormalizedQuote,
  passed: boolean,
  code: QuoteCheckResult["code"],
  reason: string,
  impliedPricePerShare: string | null,
  referencePricePerShare: string | null,
  deviationPct: string | null,
  effectiveCostPerShare: string | null,
  limitPct: string | null = null
): QuoteCheckOutput {
  const check: QuoteCheckResult = {
    quoteId: quote.id,
    passed,
    code,
    reason,
    impliedPricePerShare,
    referencePricePerShare,
    deviationPct,
    effectiveCostPerShare
  };
  const checkRefusal =
    code === "QUOTE_STALE"
      ? refusal("QUOTE_STALE", { ticker })
      : code === "QUOTE_REJECTED"
        ? refusal("QUOTE_REJECTED", {
            ticker,
            actualPrice: impliedPricePerShare ?? "unknown",
            referencePrice: referencePricePerShare ?? "unknown"
          })
        : code === "IMPACT_TOO_HIGH"
          ? refusal("IMPACT_TOO_HIGH", {
              ticker,
              impactPct: quote.priceImpactPct,
              limitPct: limitPct ?? "unknown"
            })
          : code === "REAL_PRICE_UNAVAILABLE"
            ? refusal("REAL_PRICE_UNAVAILABLE", { ticker })
            : null;
  return { result: check, refusal: checkRefusal };
}

export function checkQuote(input: QuoteCheckInput): QuoteCheckOutput {
  const { quote } = input;
  if (!quote.success) {
    return result(
      input.ticker,
      quote,
      false,
      "QUOTE_REJECTED",
      "Quote response reported success=false.",
      null,
      null,
      null,
      null
    );
  }
  if (quote.id.length === 0) {
    return result(
      input.ticker,
      quote,
      false,
      "QUOTE_REJECTED",
      "Quote id is missing.",
      null,
      null,
      null,
      null
    );
  }
  if (quote.tokenAddress.toLowerCase() !== input.expectedTokenAddress.toLowerCase()) {
    return result(
      input.ticker,
      quote,
      false,
      "QUOTE_REJECTED",
      "Quote token address does not match the held token.",
      null,
      null,
      null,
      null
    );
  }
  if (quote.routeTokenAddress.toLowerCase() !== input.expectedTokenAddress.toLowerCase()) {
    return result(
      input.ticker,
      quote,
      false,
      "QUOTE_REJECTED",
      "Quote route token address does not match the held token.",
      null,
      null,
      null,
      null
    );
  }
  if (quote.wrapper !== input.expectedWrapper) {
    return result(
      input.ticker,
      quote,
      false,
      "QUOTE_REJECTED",
      "Quote wrapper does not match the held wrapper.",
      null,
      null,
      null,
      null
    );
  }
  if (input.checkedAtMs - quote.quotedAtMs > 20_000) {
    return result(
      input.ticker,
      quote,
      false,
      "QUOTE_STALE",
      "Quote is older than 20 seconds.",
      null,
      null,
      null,
      null
    );
  }

  if (
    !input.marketOpen &&
    (input.realPricePerShare === null ||
      input.realPriceAgeSeconds === null ||
      !Number.isFinite(input.realPriceAgeSeconds) ||
      input.realPriceAgeSeconds < 0 ||
      input.realPriceAgeSeconds > 120)
  ) {
    return result(
      input.ticker,
      quote,
      false,
      "REAL_PRICE_UNAVAILABLE",
      "The 24/7 price is missing or older than 120 seconds.",
      null,
      null,
      null,
      null
    );
  }

  const tokenAmount = positiveDecimal(
    quote.side === "buy" ? quote.outputAmount : quote.inputAmount,
    "quote token amount"
  );
  const cashAmount = positiveDecimal(
    quote.side === "buy" ? quote.inputAmount : quote.outputAmount,
    "quote cash amount"
  );
  const multiplier = positiveDecimal(quote.multiplier, "quote multiplier");
  const impact = nonNegativeDecimal(quote.priceImpactPct, "quote price impact");
  const fee = nonNegativeDecimal(quote.feeUsd, "quote fee");
  const maxImpact = positiveDecimal(input.maxPriceImpactPct, "maximum price impact");
  const implied = cashAmount.div(tokenAmount.mul(multiplier));
  const reference = positiveDecimal(
    input.marketOpen ? input.usReferencePricePerShare : (input.realPricePerShare ?? ""),
    "reference price"
  );
  const deviation = implied.minus(reference).abs().div(reference).mul(100);
  const tolerance = Decimal.max(new Decimal(2), new Decimal(input.maxPriceImpactPct).plus(0.5));
  const impliedString = implied.toSignificantDigits(30).toString();
  const referenceString = reference.toSignificantDigits(30).toString();
  const deviationString = deviation.toSignificantDigits(30).toString();
  const effectiveCost =
    quote.side === "buy"
      ? cashAmount.plus(fee).div(tokenAmount.mul(multiplier))
      : cashAmount.minus(fee).div(tokenAmount.mul(multiplier));
  if (impact.gt(maxImpact)) {
    return result(
      input.ticker,
      quote,
      false,
      "IMPACT_TOO_HIGH",
      `Quote impact ${impact.toString()}% exceeds plan limit ${maxImpact.toString()}%.`,
      impliedString,
      referenceString,
      deviationString,
      effectiveCost.toSignificantDigits(30).toString(),
      input.maxPriceImpactPct
    );
  }
  if (deviation.gt(tolerance)) {
    return result(
      input.ticker,
      quote,
      false,
      "QUOTE_REJECTED",
      `Implied price deviates ${deviationString}%, over tolerance ${tolerance.toString()}%.`,
      impliedString,
      referenceString,
      deviationString,
      effectiveCost.toSignificantDigits(30).toString()
    );
  }
  return result(
    input.ticker,
    quote,
    true,
    null,
    "Quote passed the address, freshness, positive-output, and reference-price checks.",
    impliedString,
    referenceString,
    deviationString,
    effectiveCost.toSignificantDigits(30).toString()
  );
}
