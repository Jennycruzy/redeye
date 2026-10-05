import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical } from "./canonical.js";
import { assertClaimAllowed, canPublishClaim } from "./claims.js";
import { decide } from "./decide.js";
import { verifyExtractedReport } from "./extract.js";
import { assertValidPlan, validatePlan } from "./plan-validation.js";
import { checkQuote } from "./quote-check.js";
import { hashDecision, hashPlan, hashVerdict, makeEventKey } from "./receipt.js";
import { verifyReceipt } from "./verify.js";
import { refusal } from "./refuse.js";
import type {
  DecisionInput,
  EventContext,
  NormalizedQuote,
  PlanContext,
  WalletContext
} from "./types.js";

const tokenAddress = "0x0000000000000000000000000000000000000001";

function quote(overrides: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return {
    id: "quote-1",
    success: true,
    side: "sell",
    wrapper: "bStock",
    tokenAddress,
    routeTokenAddress: tokenAddress,
    inputAmount: "1",
    inputUnit: "TOKEN",
    outputAmount: "25",
    outputUnit: "USD",
    multiplier: "1",
    priceImpactPct: "0.1",
    feeUsd: "0",
    quotedAtMs: 1000,
    ...overrides
  };
}

function wallet(overrides: Partial<WalletContext> = {}): WalletContext {
  return {
    connected: true,
    tokenAllowed: true,
    quotaLeftUsd: "500",
    requiredQuotaUsd: "50",
    sessionExpiresAtMs: 100_000,
    requiredUntilMs: 10_000,
    ...overrides
  };
}

function plan(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    kind: "protect",
    ticker: "NVDA",
    wrapper: "bStock",
    tokenAddress,
    heldShares: "2",
    params: {
      maxPriceImpactPct: "1",
      minPoolDepthUsd: "50000",
      sellPct: "50",
      sellAtMs: 1000
    },
    ...overrides
  };
}

function event(overrides: Partial<EventContext> = {}): EventContext {
  return {
    ticker: "NVDA",
    kind: "earnings",
    releaseTs: 2000,
    consensus: { eps: "1", basis: "adjusted diluted USD per share", noOfEsts: 3 },
    ...overrides
  };
}

function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  const candidate = quote();
  const check = checkQuote({
    ticker: "NVDA",
    quote: candidate,
    expectedTokenAddress: tokenAddress,
    expectedWrapper: "bStock",
    referencePricePerShare: "25",
    lastPoolPricePerShare: "24",
    marketOpen: true,
    maxPriceImpactPct: "1",
    checkedAtMs: 1000
  }).result;
  return {
    plan: plan(),
    event: event(),
    extracted: null,
    quotes: [candidate],
    quoteChecks: [check],
    status: { reasonCode: null, reasonMsg: null },
    wallet: wallet(),
    poolDepthUsd: "100000",
    atMs: 1000,
    executionEnabled: true,
    ...overrides
  };
}

describe("canonical receipts", () => {
  it("sorts object keys and hashes the canonical form", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(hashCanonical({ b: 2, a: 1 })).toBe(hashCanonical({ a: 1, b: 2 }));
    expect(hashCanonical({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("quote checks", () => {
  it("accepts a quote within the reference tolerance", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote(),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      referencePricePerShare: "25",
      lastPoolPricePerShare: "24",
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    });

    expect(checked.result.passed).toBe(true);
    expect(checked.result.impliedPricePerShare).toBe("25");
  });

  it("rejects an absurd successful quote and gives a user sentence", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote({ outputAmount: "1000" }),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      referencePricePerShare: "25",
      lastPoolPricePerShare: "24",
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    });

    expect(checked.result.code).toBe("QUOTE_REJECTED");
    expect(checked.refusal?.sentence).toBe(
      "The price quote didn't make sense (1000 vs reference 25); no trade."
    );
  });

  it("rejects quotes older than twenty seconds", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote({ quotedAtMs: 1000 }),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      referencePricePerShare: "25",
      lastPoolPricePerShare: "24",
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 21_001
    });

    expect(checked.result.code).toBe("QUOTE_STALE");
    expect(checked.refusal?.sentence).toBe("The price quote expired; fetching a new one.");
  });

  it("rejects a quote whose reported impact exceeds the plan limit", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote({ priceImpactPct: "1.1" }),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      referencePricePerShare: "25",
      lastPoolPricePerShare: "24",
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    });

    expect(checked.result.code).toBe("IMPACT_TOO_HIGH");
    expect(checked.refusal?.sentence).toBe(
      "Selling now would move the price 1.1%; your limit is 1%."
    );
  });
});

describe("deterministic decisions", () => {
  it("keeps a Hold plan independent of wallet connectivity", () => {
    const result = decide(
      decisionInput({
        plan: plan({ kind: "hold" }),
        wallet: wallet({ connected: false }),
        executionEnabled: false
      })
    );

    expect(result.action).toBe("hold");
    expect(result.refusal).toBeNull();
  });

  it("sizes Protect from real shares and the configured percentage", () => {
    const result = decide(decisionInput());

    expect(result.action).toBe("sell");
    expect(result.size.shares).toBe("1");
    expect(result.wrapper).toBe("bStock");
  });

  it("refuses React without enough consensus estimates", () => {
    const result = decide(
      decisionInput({
        plan: plan({
          kind: "react",
          params: {
            ...plan().params,
            surpriseThresholdPct: "10",
            unpricedThresholdPct: "2",
            direction: "both",
            maxUsd: "25"
          }
        }),
        event: event({
          consensus: { eps: "1", basis: "adjusted diluted USD per share", noOfEsts: 2 }
        })
      })
    );

    expect(result.refusal?.code).toBe("NO_CONSENSUS");
  });

  it("reacts only when the surprise remains unpriced", () => {
    const candidate = quote({
      id: "buy-1",
      side: "buy",
      inputAmount: "25",
      inputUnit: "USD",
      outputAmount: "1",
      outputUnit: "TOKEN"
    });
    const check = checkQuote({
      ticker: "NVDA",
      quote: candidate,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      referencePricePerShare: "25",
      lastPoolPricePerShare: "24",
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;
    const result = decide(
      decisionInput({
        plan: plan({
          kind: "react",
          params: {
            ...plan().params,
            surpriseThresholdPct: "10",
            unpricedThresholdPct: "2",
            direction: "both",
            maxUsd: "25"
          }
        }),
        extracted: {
          actualEps: "1.2",
          basis: "adjusted diluted USD per share",
          verbatim: "Adjusted diluted EPS $1.20",
          verified: true
        },
        quotes: [candidate],
        quoteChecks: [check],
        onChainMoveSinceReleasePct: "0.5"
      })
    );

    expect(result.action).toBe("buy");
    expect(result.size.usd).toBe("25");
  });

  it("chooses the lowest effective buy cost and breaks ties toward bStock", () => {
    const bstock = quote({
      id: "bstock-buy",
      side: "buy",
      wrapper: "bStock",
      inputAmount: "25.2",
      inputUnit: "USD",
      outputAmount: "1",
      outputUnit: "TOKEN",
      feeUsd: "0.2"
    });
    const ondo = quote({
      id: "ondo-buy",
      side: "buy",
      wrapper: "Ondo",
      inputAmount: "25.2",
      inputUnit: "USD",
      outputAmount: "1",
      outputUnit: "TOKEN",
      feeUsd: "0.1"
    });
    const bstockCheck = checkQuote({
      ticker: "NVDA",
      quote: bstock,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      referencePricePerShare: "25",
      lastPoolPricePerShare: "24",
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;
    const ondoCheck = checkQuote({
      ticker: "NVDA",
      quote: ondo,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "Ondo",
      referencePricePerShare: "25",
      lastPoolPricePerShare: "24",
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;

    const result = decide(
      decisionInput({
        plan: plan({
          kind: "react",
          params: {
            ...plan().params,
            surpriseThresholdPct: "10",
            unpricedThresholdPct: "2",
            direction: "both",
            maxUsd: "25"
          }
        }),
        extracted: {
          actualEps: "1.2",
          basis: "adjusted diluted USD per share",
          verbatim: "Adjusted diluted EPS $1.20",
          verified: true
        },
        quotes: [bstock, ondo],
        quoteChecks: [bstockCheck, ondoCheck],
        onChainMoveSinceReleasePct: "0.5"
      })
    );

    expect(result.action).toBe("buy");
    expect(result.wrapper).toBe("Ondo");
  });

  it("keeps refusal sentences deterministic", () => {
    expect(
      refusal("POOL_TOO_THIN", { ticker: "NVDA", currentUsd: "3", neededUsd: "50000" }).sentence
    ).toBe("The NVDA pool holds $3; your plan needs at least $50000.");
  });
});

describe("v1.5 proof rules", () => {
  it("verifies extracted values only when the exact excerpt is present", () => {
    const candidate = {
      actualEps: "1.20",
      basis: "adjusted diluted USD per share",
      verbatim: "Adjusted diluted EPS $1.20"
    };
    expect(verifyExtractedReport(candidate, "Results: Adjusted diluted EPS $1.20.").verified).toBe(
      true
    );
    expect(verifyExtractedReport(candidate, "Results: Adjusted diluted EPS $1.30.").verified).toBe(
      false
    );
  });

  it("rejects a plan outside the event and parameter rules", () => {
    const result = validatePlan(
      plan({
        params: {
          ...plan().params,
          sellPct: "5",
          sellAtMs: 1
        }
      }),
      event()
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["params.sellPct", "params.sellAtMs"])
    );
    expect(() =>
      assertValidPlan(plan({ params: { ...plan().params, sellPct: "5", sellAtMs: 1 } }), event())
    ).toThrow("Invalid plan");
  });

  it("creates stable event and receipt hashes", () => {
    const eventKey = makeEventKey("NVDA", "earnings", "2026-08-26");
    expect(eventKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashPlan(plan())).toBe(hashPlan({ ...plan(), params: { ...plan().params } }));
    expect(
      hashDecision(
        { source: "fixture" },
        { action: "hold", size: {}, wrapper: "bStock", reason: "test", refusal: null }
      )
    ).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashVerdict({ outcome: "kept" })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("enforces the v1.5 claim vocabulary", () => {
    expect(
      canPublishClaim("executed", { terminalOrderStatus: "FINISHED", chainConfirmed: true })
    ).toBe(true);
    expect(
      canPublishClaim("executed", { terminalOrderStatus: "FINISHED", chainConfirmed: false })
    ).toBe(false);
    expect(canPublishClaim("live", { fetchedAtMs: 1_000, nowMs: 1_500, freshnessMs: 1_000 })).toBe(
      true
    );
    expect(canPublishClaim("live", { fetchedAtMs: 1_000, nowMs: 3_000, freshnessMs: 1_000 })).toBe(
      false
    );
    expect(() => assertClaimAllowed("x402", {})).toThrow("lacks the required evidence");
  });

  it("verifies the lead-story receipt hashes and freeze ordering", () => {
    const eventRecord = {
      v: 1 as const,
      eventKey: makeEventKey("NVDA", "earnings", "2026-08-26"),
      ticker: "NVDA",
      kind: "earnings" as const,
      issuerCik: "0001045810",
      expectedDate: "2026-08-26",
      sources: [
        {
          name: "edgar",
          form: "8-K",
          seenAt: "2026-08-26T20:20:00.000Z",
          fetchedAt: "2026-08-26T20:20:01.000Z",
          recordPath: "raw/sec/2026-08-26/release.json"
        }
      ],
      releaseTs: Date.parse("2026-08-26T20:20:00.000Z"),
      consensus: null
    };
    const decision = {
      action: "hold" as const,
      size: {},
      wrapper: "bStock" as const,
      reason: "Hold",
      refusal: null
    };
    const input = { source: "fixture" };
    const verdict = { outcome: "refused" as const, reason: "No action required." };
    const receipt = {
      v: 1 as const,
      event: eventRecord,
      plan: { ...plan(), planId: null },
      planHash: hashPlan(plan()),
      freezeTx: `0x${"1".repeat(64)}` as `0x${string}`,
      freezeBlockTs: Date.parse("2026-08-26T20:19:59.000Z"),
      decisions: [
        {
          at: Date.parse("2026-08-26T20:20:02.000Z"),
          input,
          decision,
          decisionHash: hashDecision(input, decision)
        }
      ],
      fills: [],
      verdict,
      verdictHash: hashVerdict(verdict)
    };
    const verified = verifyReceipt(receipt);
    expect(verified.valid).toBe(true);
    expect(verified.errors).toEqual([]);
  });
});
