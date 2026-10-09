# Redeye plans

A plan is fixed JSON. The agent rebuilds the sentence and the fingerprint from it, so the same
JSON always gives the same promise.

```json
{
  "ticker": "NVDA",
  "kind": "guard",
  "heldShares": "2",
  "params": {
    "triggerDropPct": "5",
    "sellPct": "50",
    "maxPriceImpactPct": "1",
    "minPoolDepthUsd": "100000",
    "maxGapToRealPricePct": "1"
  }
}
```

`scripts/redeye.mjs` fills `maxPriceImpactPct`, `minPoolDepthUsd` and `maxGapToRealPricePct` with
the values above when they are missing.

## Kinds

| kind        | Acts when (C = last close, P = 24/7 price) | Settings                    | Bounds           |
| ----------- | ------------------------------------------ | --------------------------- | ---------------- |
| `guard`     | P ≤ C × (1 − triggerDropPct/100)           | `triggerDropPct`, `sellPct` | 1–20 %, 10–100 % |
| `buy_dip`   | P ≤ C × (1 − triggerDropPct/100)           | `triggerDropPct`, `maxUsd`  | 1–20 %, ≥ $5     |
| `sell_rise` | P ≥ C × (1 + triggerRisePct/100)           | `triggerRisePct`, `sellPct` | 1–20 %, 10–100 % |
| `hold`      | never trades                               | none                        | —                |

Shared limits: `maxPriceImpactPct` 0.2–3, `minPoolDepthUsd` at least 25,000. `heldShares` is in
real shares (what the user owns), greater than zero except for `buy_dip`.

## Windows

| window    | from                              | to                |
| --------- | --------------------------------- | ----------------- |
| overnight | 4 pm New York close               | next 9:30 am open |
| weekend   | Friday's close                    | Monday's open     |
| holiday   | the close before a market holiday | the next open     |

A plan locks until 5 minutes before the close (`lockBy`). Locked after a close, it belongs to the
next window. PlanBook keeps one plan per owner, stock and window.

## Stocks

Every bStock on Binance's official list with a priced pool, for example NVDA, TSLA, GOOGL, MSFT,
META, AMZN, INTC, TSM, NFLX, HOOD, MSTR, SNDK, CRCL. `price` shows which are priced right now.

## Outcomes

| outcome | Meaning                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| kept    | the plan did what it promised (including "the trigger was never reached, so nothing was done")                   |
| refused | the agent declined to act, with a reason code (for example the trigger was hit but the plan has no way to trade) |
| broken  | something happened that the plan did not allow; published with the cause                                         |
