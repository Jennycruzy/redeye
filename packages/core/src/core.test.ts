import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical } from "./canonical.js";
import { assertClaimAllowed, canPublishClaim } from "./claims.js";
import { decide } from "./decide.js";
import { verifyExtractedReport } from "./extract.js";
import { assertValidPlan, planLockDeadlineMs, validatePlan } from "./plan-validation.js";
import { checkQuote, compareFillToQuote } from "./quote-check.js";
import { hashDecision, hashPlan, hashVerdict, makeEventKey } from "./receipt.js";
import { verifyReceipt } from "./verify.js";
import { refusal, refusalCodes } from "./refuse.js";
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
    lockTs: 2000,
    openTs: 10_000,
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
    usReferencePricePerShare: "25",
    realPricePerShare: "24",
    realPriceAgeSeconds: 10,
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
    audit: {
      status: "clear",
      reason: null,
      officialListAddress: true,
      multiplierAgreement: true,
      walletRefused: false
    },
    wallet: wallet(),
    poolDepthUsd: "100000",
    atMs: 1000,
    executionEnabled: true,
    prices: {
      C: "25",
      P: "25.1",
      T: "25",
      sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
      ages: { C: 3600, P: 10, T: 5 }
    },
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
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
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
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
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
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
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
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    });

    expect(checked.result.code).toBe("IMPACT_TOO_HIGH");
    expect(checked.refusal?.sentence).toBe(
      "Trading now would move the price 1.1%; your limit is 1%."
    );
  });

  it("uses the fresh 24/7 price while the US market is shut", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote({ outputAmount: "24" }),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
      marketOpen: false,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    });

    expect(checked.result.passed).toBe(true);
    expect(checked.result.referencePricePerShare).toBe("24");
  });

  it.each([
    [null, null],
    ["24", 121]
  ])("refuses a missing or stale 24/7 price", (realPricePerShare, realPriceAgeSeconds) => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote({ outputAmount: "24" }),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "25",
      realPricePerShare,
      realPriceAgeSeconds,
      marketOpen: false,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    });

    expect(checked.result.code).toBe("REAL_PRICE_UNAVAILABLE");
    expect(checked.refusal?.sentence).toBe("We can't see the real price right now, so no trade.");
  });

  it("blocks a multiplier disagreement and keeps the source values", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote(),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000,
      multiplierSources: { list: "1", asset: "10", contract: "1" }
    });

    expect(checked.result.code).toBe("MULTIPLIER_MISMATCH");
    expect(checked.result.stage).toBe("multiplier");
    expect(checked.result.multiplierA).toBe("1");
    expect(checked.result.multiplierB).toBe("10");
    expect(checked.checks.map((entry) => entry.stage)).toEqual(["quote", "multiplier"]);
    expect(checked.refusal?.sentence).toBe(
      "Binance's sources disagree on how many shares one NVDA is (1 vs 10), so no trade."
    );
  });

  it("rejects an exact-sized quote that is too far from the displayed price", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote(),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000,
      displayedPricePerShare: "20"
    });

    expect(checked.result.code).toBe("NO_SIZE_LIQUIDITY");
    expect(checked.result.stage).toBe("sized_quote");
    expect(checked.result.orderUsd).toBe("25");
    expect(checked.result.sizedPricePerShare).toBe("25");
    expect(checked.refusal?.sentence).toBe(
      "NVDA looks 25% cheaper on screen, but a $25 order would only get 25; no trade."
    );
  });

  it("compares the simulated output with the quoted output", () => {
    const checked = checkQuote({
      ticker: "NVDA",
      quote: quote(),
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000,
      simulation: { outputAmount: "24" }
    });

    expect(checked.result.code).toBe("SIM_FAILED");
    expect(checked.result.stage).toBe("simulation");
    expect(checked.result.quoteOutputAmount).toBe("25");
    expect(checked.result.simulationOutputAmount).toBe("24");
    expect(checked.checks.map((entry) => entry.stage)).toEqual(["quote", "simulation"]);
    expect(checked.refusal?.sentence).toContain(
      "Simulation output 24 differs from quoted output 25"
    );
  });

  it("checks a confirmed fill against the quote and the reference", () => {
    const checked = compareFillToQuote({
      ticker: "NVDA",
      quote: quote(),
      filledOutputAmount: "24.9",
      filledPricePerShare: "24.9",
      referencePricePerShare: "25"
    });
    expect(checked.passed).toBe(true);
    expect(checked.deviationFromQuotePct).toBe("0.4");

    const rejected = compareFillToQuote({
      ticker: "NVDA",
      quote: quote(),
      filledOutputAmount: "23",
      filledPricePerShare: "23",
      referencePricePerShare: "25"
    });
    expect(rejected.passed).toBe(false);
    expect(rejected.deviationFromQuotePct).toBe("8");
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
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
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
        prices: {
          C: "25",
          P: "25.125",
          T: "25.1",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
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
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
      marketOpen: true,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;
    const ondoCheck = checkQuote({
      ticker: "NVDA",
      quote: ondo,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "Ondo",
      usReferencePricePerShare: "25",
      realPricePerShare: "24",
      realPriceAgeSeconds: 10,
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
        prices: {
          C: "25",
          P: "25.125",
          T: "25.1",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.action).toBe("buy");
    expect(result.wrapper).toBe("Ondo");
  });

  it("executes Guard only when the real-price trigger and token gap both pass", () => {
    const candidate = quote({ outputAmount: "95" });
    const check = checkQuote({
      ticker: "NVDA",
      quote: candidate,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "100",
      realPricePerShare: "95",
      realPriceAgeSeconds: 10,
      marketOpen: false,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;
    const result = decide(
      decisionInput({
        event: event({
          kind: "weekend",
          lockTs: 1000,
          openTs: 10_000,
          releaseTs: null,
          consensus: null
        }),
        plan: plan({
          kind: "guard",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerDropPct: "5",
            sellPct: "50",
            maxGapToRealPricePct: "0.5"
          }
        }),
        quotes: [candidate],
        quoteChecks: [check],
        atMs: 2000,
        prices: {
          C: "100",
          P: "95",
          T: "95.1",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.action).toBe("sell");
    expect(result.size.shares).toBe("1");
  });

  it("records an unmet off-hours trigger as a kept no-action result at the open", () => {
    const result = decide(
      decisionInput({
        event: event({ kind: "overnight", lockTs: 1000, openTs: 10_000, releaseTs: null }),
        plan: plan({
          kind: "guard",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerDropPct: "5",
            sellPct: "50",
            maxGapToRealPricePct: "0.5"
          }
        }),
        atMs: 10_000,
        prices: {
          C: "100",
          P: "98",
          T: "98",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.refusal?.code).toBe("CONDITION_NOT_MET");
  });

  it("refuses Guard when the token is too far from the 24/7 price", () => {
    const result = decide(
      decisionInput({
        event: event({ kind: "weekend", lockTs: 1000, openTs: 10_000, releaseTs: null }),
        plan: plan({
          kind: "guard",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerDropPct: "5",
            sellPct: "50",
            maxGapToRealPricePct: "0.5"
          }
        }),
        atMs: 2000,
        prices: {
          C: "100",
          P: "95",
          T: "96",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.refusal?.code).toBe("PRICE_OFF_REAL");
  });

  it("executes Sell the rise when the rise trigger and one-sided price band pass", () => {
    const candidate = quote({ outputAmount: "104.8" });
    const check = checkQuote({
      ticker: "NVDA",
      quote: candidate,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "100",
      realPricePerShare: "105",
      realPriceAgeSeconds: 10,
      marketOpen: false,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;
    const result = decide(
      decisionInput({
        event: event({ kind: "overnight", lockTs: 1000, openTs: 10_000, releaseTs: null }),
        plan: plan({
          kind: "sell_rise",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerRisePct: "4",
            sellPct: "25",
            maxGapToRealPricePct: "0.3"
          }
        }),
        quotes: [candidate],
        quoteChecks: [check],
        atMs: 2000,
        prices: {
          C: "100",
          P: "105",
          T: "104.8",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.action).toBe("sell");
    expect(result.size.shares).toBe("0.5");
  });

  it("records an unmet Sell the rise trigger as kept at the open", () => {
    const result = decide(
      decisionInput({
        event: event({ kind: "overnight", lockTs: 1000, openTs: 10_000, releaseTs: null }),
        plan: plan({
          kind: "sell_rise",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerRisePct: "4",
            sellPct: "25",
            maxGapToRealPricePct: "0.3"
          }
        }),
        atMs: 10_000,
        prices: {
          C: "100",
          P: "103",
          T: "103",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.refusal?.code).toBe("CONDITION_NOT_MET");
  });

  it("refuses Sell the rise when the token is too far below the real price", () => {
    const result = decide(
      decisionInput({
        event: event({ kind: "weekend", lockTs: 1000, openTs: 10_000, releaseTs: null }),
        plan: plan({
          kind: "sell_rise",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerRisePct: "4",
            sellPct: "25",
            maxGapToRealPricePct: "0.3"
          }
        }),
        atMs: 2000,
        prices: {
          C: "100",
          P: "105",
          T: "104",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.refusal?.code).toBe("PRICE_OFF_REAL");
  });

  it("allows an official token with no audit data when share counts agree", () => {
    const candidate = quote({ outputAmount: "95" });
    const check = checkQuote({
      ticker: "NVDA",
      quote: candidate,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "100",
      realPricePerShare: "95",
      realPriceAgeSeconds: 10,
      marketOpen: false,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;
    const result = decide(
      decisionInput({
        audit: {
          status: "no_data",
          reason: null,
          officialListAddress: true,
          multiplierAgreement: true,
          walletRefused: false
        },
        event: event({ kind: "overnight", releaseTs: null, lockTs: 1000 }),
        plan: plan({
          kind: "guard",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerDropPct: "5",
            sellPct: "50",
            maxGapToRealPricePct: "0.5"
          }
        }),
        quotes: [candidate],
        quoteChecks: [check],
        atMs: 2000,
        prices: {
          C: "100",
          P: "95",
          T: "95",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.action).toBe("sell");
    expect(result.refusal).toBeNull();
  });

  it("refuses when the wallet rejects a token with no audit data", () => {
    const result = decide(
      decisionInput({
        audit: {
          status: "no_data",
          reason: null,
          officialListAddress: true,
          multiplierAgreement: true,
          walletRefused: true
        },
        plan: plan({ kind: "protect" })
      })
    );

    expect(result.refusal?.code).toBe("AUDIT_NO_DATA");
    expect(result.refusal?.sentence).toBe(
      "The security check has no data on NVDA; its address is from Binance's official stock list."
    );
  });

  it("keeps audit service failure separate from an audit with no data", () => {
    const result = decide(
      decisionInput({
        audit: {
          status: "unavailable",
          reason: "network timeout",
          officialListAddress: true,
          multiplierAgreement: true,
          walletRefused: false
        },
        plan: plan({ kind: "protect" })
      })
    );

    expect(result.refusal?.code).toBe("AUDIT_UNAVAILABLE");
    expect(result.refusal?.sentence).toBe("The security check is unavailable, so no trade.");
  });

  it("buys a dip when its price condition and quote pass", () => {
    const candidate = quote({
      id: "dip-buy",
      side: "buy",
      inputAmount: "25",
      inputUnit: "USD",
      outputAmount: "0.263157894736842105",
      outputUnit: "TOKEN"
    });
    const check = checkQuote({
      ticker: "NVDA",
      quote: candidate,
      expectedTokenAddress: tokenAddress,
      expectedWrapper: "bStock",
      usReferencePricePerShare: "100",
      realPricePerShare: "95",
      realPriceAgeSeconds: 10,
      marketOpen: false,
      maxPriceImpactPct: "1",
      checkedAtMs: 1000
    }).result;
    const result = decide(
      decisionInput({
        event: event({ kind: "overnight", lockTs: 1000, openTs: 10_000, releaseTs: null }),
        plan: plan({
          kind: "buy_dip",
          params: {
            maxPriceImpactPct: "1",
            minPoolDepthUsd: "50000",
            triggerDropPct: "3",
            maxUsd: "25",
            maxGapToRealPricePct: "0.3"
          }
        }),
        quotes: [candidate],
        quoteChecks: [check],
        atMs: 2000,
        prices: {
          C: "100",
          P: "95",
          T: "95.1",
          sources: { C: "nasdaq", P: "hyperliquid:xyz:NVDA", T: "pool" },
          ages: { C: 3600, P: 10, T: 5 }
        }
      })
    );

    expect(result.action).toBe("buy");
    expect(result.size.usd).toBe("25");
  });

  it("keeps refusal sentences deterministic", () => {
    expect(
      refusal("POOL_TOO_THIN", { ticker: "NVDA", currentUsd: "3", neededUsd: "50000" }).sentence
    ).toBe("The NVDA pool holds $3; your plan needs at least $50000.");
  });

  it("gives every refusal code a user sentence", () => {
    for (const code of refusalCodes) {
      expect(
        refusal(code, {
          ticker: "NVDA",
          reason: "source reason",
          currentUsd: "3",
          neededUsd: "50000",
          impactPct: "1.1",
          limitPct: "1",
          actualPrice: "100",
          referencePrice: "25",
          quotaLeftUsd: "10",
          quotaNeededUsd: "25",
          sessionEndsAt: "2026-10-05T23:00:00.000Z",
          gapPct: "2.1",
          multiplierA: "1",
          multiplierB: "10",
          displayedGapPct: "25",
          orderUsd: "25",
          sizedPricePerShare: "25"
        }).sentence.length
      ).toBeGreaterThan(0);
    }
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

  it("validates off-hours bounds and the five-minute lock deadline", () => {
    const window = event({
      kind: "weekend",
      lockTs: Date.parse("2026-10-09T20:00:00.000Z"),
      openTs: Date.parse("2026-10-12T13:30:00.000Z"),
      releaseTs: null,
      consensus: null
    });
    const result = validatePlan(
      plan({
        kind: "buy_dip",
        params: {
          maxPriceImpactPct: "1",
          minPoolDepthUsd: "50000",
          triggerDropPct: "0.5",
          maxUsd: "4",
          maxGapToRealPricePct: "3"
        }
      }),
      window
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        "params.triggerDropPct",
        "params.maxUsd",
        "params.maxGapToRealPricePct"
      ])
    );
    expect(new Date(planLockDeadlineMs(window)).toISOString()).toBe("2026-10-09T19:55:00.000Z");
  });

  it("validates Sell the rise bounds and a rebuy time after the open", () => {
    const window = event({
      kind: "overnight",
      lockTs: Date.parse("2026-10-10T20:00:00.000Z"),
      openTs: Date.parse("2026-10-11T13:30:00.000Z"),
      releaseTs: null,
      consensus: null
    });
    const valid = validatePlan(
      plan({
        kind: "sell_rise",
        params: {
          maxPriceImpactPct: "1",
          minPoolDepthUsd: "50000",
          triggerRisePct: "4",
          sellPct: "25",
          maxGapToRealPricePct: "0.3",
          rebuyAtMs: window.openTs + 30 * 60 * 1000
        }
      }),
      window
    );
    expect(valid.valid).toBe(true);

    const invalid = validatePlan(
      plan({
        kind: "sell_rise",
        params: {
          maxPriceImpactPct: "1",
          minPoolDepthUsd: "50000",
          triggerRisePct: "0.5",
          sellPct: "5",
          maxGapToRealPricePct: "3",
          rebuyAtMs: window.openTs - 1
        }
      }),
      window
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        "params.triggerRisePct",
        "params.sellPct",
        "params.maxGapToRealPricePct",
        "params.rebuyAtMs"
      ])
    );

    const tradingParams = {
      maxPriceImpactPct: "1",
      minPoolDepthUsd: "50000",
      triggerRisePct: "4",
      sellPct: "25",
      maxGapToRealPricePct: "0.3"
    };
    const unaccepted = validatePlan(
      plan({ kind: "sell_rise", door: "agentic_wallet", params: tradingParams }),
      window
    );
    expect(unaccepted.issues.map((issue) => issue.field)).toEqual(["auditNoDataAccepted"]);
    const accepted = validatePlan(
      plan({
        kind: "sell_rise",
        door: "agentic_wallet",
        auditNoDataAccepted: true,
        params: tradingParams
      }),
      window
    );
    expect(accepted.valid).toBe(true);
  });

  it("creates stable event and receipt hashes", () => {
    const eventKey = makeEventKey("NVDA", "earnings", "2026-08-26");
    expect(eventKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(makeEventKey("NVDA", "weekend", "2026-10-09")).toBe(
      "0x5ac80f5b914639a8a70c0534f908a0e24b67e8d00757dc771c92eea898886a84"
    );
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
      lockTs: Date.parse("2026-08-26T20:20:00.000Z"),
      openTs: null,
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
    const verdict = { outcome: "kept" as const, reason: "No action required." };
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

    const tradeDecision = { ...decision, action: "buy" as const, size: { usd: "25" } };
    const tradeReceipt = {
      ...receipt,
      decisions: [
        {
          at: Date.parse("2026-08-26T20:20:02.000Z"),
          input,
          decision: tradeDecision,
          decisionHash: hashDecision(input, tradeDecision)
        }
      ]
    };
    expect(verifyReceipt(tradeReceipt).errors).toContain(
      "a kept trade receipt must include at least one confirmed fill."
    );
  });
});
