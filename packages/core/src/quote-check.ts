import Decimal from "decimal.js";
import { refusal } from "./refuse.js";
import type {
  MultiplierSources,
  NormalizedQuote,
  QuoteCheckCode,
  QuoteCheckResult,
  QuoteCheckStage,
  Refusal
} from "./types.js";

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
  /** Values fetched from the RWA list, the per-asset endpoint and the token contract. */
  multiplierSources?: MultiplierSources;
  /** The token price displayed when this exact-sized quote was requested. */
  displayedPricePerShare?: string | null;
  /** Optional transaction simulation for the exact quote. */
  simulation?: {
    outputAmount: string;
  };
}

export interface QuoteCheckOutput {
  /** The aggregate result used by the decision engine. */
  result: QuoteCheckResult;
  /** Each stage is retained so a receipt can show passes as well as failures. */
  checks: QuoteCheckResult[];
  refusal: Refusal | null;
}

export interface FillComparisonInput {
  ticker: string;
  quote: NormalizedQuote;
  filledOutputAmount: string;
  filledPricePerShare?: string;
  referencePricePerShare?: string;
  maxReferenceDeviationPct?: string;
}

export interface FillComparisonResult {
  quoteId: string;
  passed: boolean;
  quotedOutputAmount: string;
  filledOutputAmount: string;
  deviationFromQuotePct: string;
  filledPricePerShare: string | null;
  referencePricePerShare: string | null;
  deviationFromReferencePct: string | null;
  reason: string;
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

function format(number: Decimal): string {
  return number.toSignificantDigits(30).toString();
}

interface CheckMetadata {
  stage?: QuoteCheckStage;
  multiplierSources?: MultiplierSources | null;
  multiplierA?: string | null;
  multiplierB?: string | null;
  displayedPricePerShare?: string | null;
  sizedPricePerShare?: string | null;
  orderUsd?: string | null;
  quoteOutputAmount?: string | null;
  simulationOutputAmount?: string | null;
  deviationFromQuotePct?: string | null;
}

function makeCheck(
  quote: NormalizedQuote,
  passed: boolean,
  code: QuoteCheckCode | null,
  reason: string,
  impliedPricePerShare: string | null,
  referencePricePerShare: string | null,
  deviationPct: string | null,
  effectiveCostPerShare: string | null,
  metadata: CheckMetadata = {}
): QuoteCheckResult {
  return {
    quoteId: quote.id,
    passed,
    code,
    stage: metadata.stage ?? "quote",
    reason,
    impliedPricePerShare,
    referencePricePerShare,
    deviationPct,
    effectiveCostPerShare,
    multiplierSources: metadata.multiplierSources ?? null,
    multiplierA: metadata.multiplierA ?? null,
    multiplierB: metadata.multiplierB ?? null,
    displayedPricePerShare: metadata.displayedPricePerShare ?? null,
    sizedPricePerShare: metadata.sizedPricePerShare ?? null,
    orderUsd: metadata.orderUsd ?? null,
    quoteOutputAmount: metadata.quoteOutputAmount ?? null,
    simulationOutputAmount: metadata.simulationOutputAmount ?? null,
    deviationFromQuotePct: metadata.deviationFromQuotePct ?? null
  };
}

function refusalFor(
  ticker: string,
  quote: NormalizedQuote,
  check: QuoteCheckResult,
  maxPriceImpactPct: string
): Refusal | null {
  switch (check.code) {
    case "QUOTE_STALE":
      return refusal("QUOTE_STALE", { ticker });
    case "QUOTE_REJECTED":
      return refusal("QUOTE_REJECTED", {
        ticker,
        actualPrice: check.impliedPricePerShare ?? "unknown",
        referencePrice: check.referencePricePerShare ?? "unknown"
      });
    case "IMPACT_TOO_HIGH":
      return refusal("IMPACT_TOO_HIGH", {
        ticker,
        impactPct: quote.priceImpactPct,
        limitPct: maxPriceImpactPct
      });
    case "REAL_PRICE_UNAVAILABLE":
      return refusal("REAL_PRICE_UNAVAILABLE", { ticker });
    case "MULTIPLIER_MISMATCH":
      return refusal("MULTIPLIER_MISMATCH", {
        ticker,
        multiplierA: check.multiplierA ?? "unknown",
        multiplierB: check.multiplierB ?? "unknown"
      });
    case "NO_SIZE_LIQUIDITY":
      return refusal("NO_SIZE_LIQUIDITY", {
        ticker,
        displayedGapPct: check.deviationPct ?? "unknown",
        orderUsd: check.orderUsd ?? "unknown",
        sizedPricePerShare: check.sizedPricePerShare ?? "unknown"
      });
    case "SIM_FAILED":
      return refusal("SIM_FAILED", { ticker, reason: check.reason });
    default:
      return null;
  }
}

function output(
  input: QuoteCheckInput,
  result: QuoteCheckResult,
  checks: QuoteCheckResult[] = [result]
): QuoteCheckOutput {
  return {
    result,
    checks,
    refusal: refusalFor(input.ticker, input.quote, result, input.maxPriceImpactPct)
  };
}

function baseOutput(
  input: QuoteCheckInput,
  passed: boolean,
  code: QuoteCheckCode | null,
  reason: string,
  impliedPricePerShare: string | null = null,
  referencePricePerShare: string | null = null,
  deviationPct: string | null = null,
  effectiveCostPerShare: string | null = null
): QuoteCheckOutput {
  return output(
    input,
    makeCheck(
      input.quote,
      passed,
      code,
      reason,
      impliedPricePerShare,
      referencePricePerShare,
      deviationPct,
      effectiveCostPerShare
    )
  );
}

function multiplierCheck(input: QuoteCheckInput): QuoteCheckResult | null {
  const sources = input.multiplierSources;
  if (sources === undefined) return null;

  const values: Array<[string, string]> = [
    ["RWA list", sources.list],
    ["per-asset", sources.asset]
  ];
  if (sources.contract !== null) values.push(["token contract", sources.contract]);
  values.push(["quote", input.quote.multiplier]);

  const first = values[0];
  if (first === undefined) throw new Error("At least one multiplier source is required.");
  let firstValue: Decimal;
  try {
    firstValue = positiveDecimal(first[1], `${first[0]} multiplier`);
  } catch {
    return makeCheck(
      input.quote,
      false,
      "MULTIPLIER_MISMATCH",
      `${first[0]} multiplier is invalid.`,
      null,
      null,
      null,
      null,
      {
        stage: "multiplier",
        multiplierSources: sources,
        multiplierA: first[1],
        multiplierB: "invalid"
      }
    );
  }

  for (const [source, value] of values.slice(1)) {
    let parsed: Decimal;
    try {
      parsed = positiveDecimal(value, `${source} multiplier`);
    } catch {
      return makeCheck(
        input.quote,
        false,
        "MULTIPLIER_MISMATCH",
        `${source} multiplier is invalid.`,
        null,
        null,
        null,
        null,
        {
          stage: "multiplier",
          multiplierSources: sources,
          multiplierA: first[1],
          multiplierB: value
        }
      );
    }
    if (!parsed.eq(firstValue)) {
      return makeCheck(
        input.quote,
        false,
        "MULTIPLIER_MISMATCH",
        `${first[0]} multiplier ${first[1]} differs from ${source} multiplier ${value}.`,
        null,
        null,
        null,
        null,
        {
          stage: "multiplier",
          multiplierSources: sources,
          multiplierA: first[1],
          multiplierB: value
        }
      );
    }
  }

  return makeCheck(
    input.quote,
    true,
    null,
    "The RWA list, per-asset, token-contract and quote share counts agree.",
    null,
    null,
    null,
    null,
    { stage: "multiplier", multiplierSources: sources }
  );
}

export function checkQuote(input: QuoteCheckInput): QuoteCheckOutput {
  const { quote } = input;
  if (!quote.success) {
    return baseOutput(input, false, "QUOTE_REJECTED", "Quote response reported success=false.");
  }
  if (quote.id.length === 0) {
    return baseOutput(input, false, "QUOTE_REJECTED", "Quote id is missing.");
  }
  if (quote.tokenAddress.toLowerCase() !== input.expectedTokenAddress.toLowerCase()) {
    return baseOutput(
      input,
      false,
      "QUOTE_REJECTED",
      "Quote token address does not match the held token."
    );
  }
  if (quote.routeTokenAddress.toLowerCase() !== input.expectedTokenAddress.toLowerCase()) {
    return baseOutput(
      input,
      false,
      "QUOTE_REJECTED",
      "Quote route token address does not match the held token."
    );
  }
  if (quote.wrapper !== input.expectedWrapper) {
    return baseOutput(
      input,
      false,
      "QUOTE_REJECTED",
      "Quote wrapper does not match the held wrapper."
    );
  }
  if (input.checkedAtMs - quote.quotedAtMs > 20_000) {
    return baseOutput(input, false, "QUOTE_STALE", "Quote is older than 20 seconds.");
  }

  if (
    !input.marketOpen &&
    (input.realPricePerShare === null ||
      input.realPriceAgeSeconds === null ||
      !Number.isFinite(input.realPriceAgeSeconds) ||
      input.realPriceAgeSeconds < 0 ||
      input.realPriceAgeSeconds > 120)
  ) {
    return baseOutput(
      input,
      false,
      "REAL_PRICE_UNAVAILABLE",
      "The 24/7 price is missing or older than 120 seconds."
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
  const tolerance = Decimal.max(new Decimal(2), maxImpact.plus(0.5));
  const impliedString = format(implied);
  const referenceString = format(reference);
  const deviationString = format(deviation);
  const effectiveCost =
    quote.side === "buy"
      ? cashAmount.plus(fee).div(tokenAmount.mul(multiplier))
      : cashAmount.minus(fee).div(tokenAmount.mul(multiplier));
  const effectiveCostString = format(effectiveCost);

  if (impact.gt(maxImpact)) {
    return baseOutput(
      input,
      false,
      "IMPACT_TOO_HIGH",
      `Quote impact ${impact.toString()}% exceeds plan limit ${maxImpact.toString()}%.`,
      impliedString,
      referenceString,
      deviationString,
      effectiveCostString
    );
  }
  if (deviation.gt(tolerance)) {
    return baseOutput(
      input,
      false,
      "QUOTE_REJECTED",
      `Implied price deviates ${deviationString}%, over tolerance ${tolerance.toString()}%.`,
      impliedString,
      referenceString,
      deviationString,
      effectiveCostString
    );
  }

  const checks: QuoteCheckResult[] = [
    makeCheck(
      quote,
      true,
      null,
      "Quote passed the address, freshness, positive-output, and reference-price checks.",
      impliedString,
      referenceString,
      deviationString,
      effectiveCostString
    )
  ];

  const multiplierResult = multiplierCheck(input);
  if (multiplierResult !== null) {
    checks.push(multiplierResult);
    if (!multiplierResult.passed) return output(input, multiplierResult, checks);
  }

  if (input.displayedPricePerShare !== undefined && input.displayedPricePerShare !== null) {
    const displayed = positiveDecimal(input.displayedPricePerShare, "displayed token price");
    const sizedGap = effectiveCost.minus(displayed).abs().div(displayed).mul(100);
    const sizedCheck = makeCheck(
      quote,
      sizedGap.lte(maxImpact),
      sizedGap.gt(maxImpact) ? "NO_SIZE_LIQUIDITY" : null,
      sizedGap.gt(maxImpact)
        ? `The exact-sized quote differs from the displayed token price by ${format(sizedGap)}%.`
        : "The exact-sized quote is within the plan's price-impact limit of the displayed token price.",
      impliedString,
      referenceString,
      format(sizedGap),
      effectiveCostString,
      {
        stage: "sized_quote",
        displayedPricePerShare: format(displayed),
        sizedPricePerShare: effectiveCostString,
        orderUsd: format(cashAmount)
      }
    );
    checks.push(sizedCheck);
    if (!sizedCheck.passed) return output(input, sizedCheck, checks);
  }

  if (input.simulation !== undefined) {
    const quotedOutput = positiveDecimal(quote.outputAmount, "quote output amount");
    const simulatedOutput = positiveDecimal(
      input.simulation.outputAmount,
      "simulation output amount"
    );
    const simulationDeviation = simulatedOutput
      .minus(quotedOutput)
      .abs()
      .div(quotedOutput)
      .mul(100);
    const simulationCheck = makeCheck(
      quote,
      simulationDeviation.lte(0.5),
      simulationDeviation.gt(0.5) ? "SIM_FAILED" : null,
      simulationDeviation.gt(0.5)
        ? `Simulation output ${format(simulatedOutput)} differs from quoted output ${format(quotedOutput)} by ${format(simulationDeviation)}%.`
        : "Simulation output is within 0.5% of the quoted output.",
      impliedString,
      referenceString,
      deviationString,
      effectiveCostString,
      {
        stage: "simulation",
        quoteOutputAmount: format(quotedOutput),
        simulationOutputAmount: format(simulatedOutput),
        deviationFromQuotePct: format(simulationDeviation)
      }
    );
    checks.push(simulationCheck);
    if (!simulationCheck.passed) return output(input, simulationCheck, checks);
  }

  const aggregate = makeCheck(
    quote,
    true,
    null,
    "Quote passed every available address, freshness, share-count, size, simulation, and reference-price check.",
    impliedString,
    referenceString,
    deviationString,
    effectiveCostString,
    { stage: "all" }
  );
  return output(input, aggregate, checks);
}

export function compareFillToQuote(input: FillComparisonInput): FillComparisonResult {
  const quoted = positiveDecimal(input.quote.outputAmount, "quote output amount");
  const filled = positiveDecimal(input.filledOutputAmount, "filled output amount");
  const outputDeviation = filled.minus(quoted).abs().div(quoted).mul(100);
  const maxOutputDeviation = new Decimal("0.5");

  let filledPrice: Decimal | null = null;
  let referencePrice: Decimal | null = null;
  let referenceDeviation: Decimal | null = null;
  let referencePassed = true;
  if (input.filledPricePerShare !== undefined || input.referencePricePerShare !== undefined) {
    if (input.filledPricePerShare === undefined || input.referencePricePerShare === undefined) {
      throw new Error("filledPricePerShare and referencePricePerShare must be supplied together.");
    }
    filledPrice = positiveDecimal(input.filledPricePerShare, "filled price per share");
    referencePrice = positiveDecimal(input.referencePricePerShare, "reference price per share");
    const maxReferenceDeviation = positiveDecimal(
      input.maxReferenceDeviationPct ?? "2.5",
      "maximum fill reference deviation"
    );
    referenceDeviation = filledPrice.minus(referencePrice).abs().div(referencePrice).mul(100);
    referencePassed = referenceDeviation.lte(maxReferenceDeviation);
  }

  const passed = outputDeviation.lte(maxOutputDeviation) && referencePassed;
  return {
    quoteId: input.quote.id,
    passed,
    quotedOutputAmount: format(quoted),
    filledOutputAmount: format(filled),
    deviationFromQuotePct: format(outputDeviation),
    filledPricePerShare: filledPrice === null ? null : format(filledPrice),
    referencePricePerShare: referencePrice === null ? null : format(referencePrice),
    deviationFromReferencePct: referenceDeviation === null ? null : format(referenceDeviation),
    reason: passed
      ? "The confirmed fill is within 0.5% of the quote and the available reference price band."
      : `The confirmed fill differs from the quote by ${format(outputDeviation)}%${referenceDeviation === null ? "" : ` and from the reference by ${format(referenceDeviation)}%`}.`
  };
}
