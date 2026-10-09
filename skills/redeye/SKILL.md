---
name: redeye
description: |
  Use when the user asks what a US stock is worth while Wall Street is closed (overnight,
  weekend, holiday), or wants a plan for their tokenized stock (bStock on BNB Chain) for
  tonight or the weekend: "guard half my Nvidia this weekend", "buy $50 of Tesla if it dips 3%
  tonight", "sell a quarter of my Nvidia if it rises 4%", "what's my plan tonight", "did Redeye
  keep its promise", "show this morning's result", "what's the 24/7 price of NVDA".
  Covers: 24/7 price vs the frozen close, off-hours windows, locking a plan on chain before the
  close in the user's own name, and results at the next open.
metadata:
  author: redeye
  version: "1.0.0"
  site: https://theredeyed-agent.site
  api: https://api.theredeyed-agent.site
  requires:
    bins:
      - node
      - baw
---

# Redeye

Redeye is the agent for when Wall Street is closed. It prices a stock from the futures market
that trades 24/7, locks a plan's fingerprint on BNB Chain **before** the 4 pm New York close, checks
the plan every minute through the night, and at the 9:30 open publishes whether it kept its word:
kept, refused (with the reason) or broken. Every plan is public at https://theredeyed-agent.site/record.

All commands below run `node scripts/redeye.mjs …` from this skill's folder and print one JSON
object with `"ok": true` or `"ok": false` plus a `code` and a plain `reason`.

## What you can do

| The user says                                      | Run                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "What's Nvidia worth right now?"                   | `price NVDA`                                                                                             |
| "When does tonight's window close?"                | `window NVDA`                                                                                            |
| "Guard half my Nvidia if it drops 5% this weekend" | build the plan (below), then `check '<plan>'`, read back, then `lock '<plan>'` and `lock '<plan>' --yes` |
| "What's my plan / how did it go?"                  | `plan <id or #number>`                                                                                   |
| "Show me everything Redeye has promised"           | `record`                                                                                                 |

## Turning plain words into a plan

Read `references/plans.md` for every field and bound. In short:

| Words                                             | kind        | settings                                       |
| ------------------------------------------------- | ----------- | ---------------------------------------------- |
| guard / protect / sell if it drops / falls / dips | `guard`     | `triggerDropPct` (1–20), `sellPct` (10–100)    |
| buy if it drops / buy the dip                     | `buy_dip`   | `triggerDropPct` (1–20), `maxUsd` (at least 5) |
| sell if it rises / take profit / sell the rise    | `sell_rise` | `triggerRisePct` (1–20), `sellPct` (10–100)    |
| hold / do nothing / just record it                | `hold`      | none                                           |

"Half" = 50, "a quarter" = 25, "a third" = 35 (round to the nearest 5 and say so). Always include
`ticker` and `heldShares` (the user's shares; ask if unknown; `buy_dip` may use `"0"`). Example:

```json
{
  "ticker": "NVDA",
  "kind": "guard",
  "heldShares": "2",
  "params": { "triggerDropPct": "5", "sellPct": "50" }
}
```

## Rules you must follow

1. **Read the promise back word for word before locking.** Run `check` (or `lock` without `--yes`)
   and show the user the exact `promise` sentence, the window and the lock deadline. Lock only after
   the user clearly says yes to that sentence. Never add `--yes` on your own.
2. **Never change the plan after the user agreed.** If anything changes, check and read it back again.
3. **Mind the deadline.** Plans lock until 5 minutes before the US close (`window.lockBy`). After the
   close a plan locks for the next window; say which one.
4. **Be exact about what locking does.** A plan locked with this skill is a promise in the user's own
   name: PlanBook on BNB Chain stores its fingerprint under the user's Agentic Wallet address, Redeye
   pays the network fee, and **no funds move and nothing is traded**. It is watched all night and
   graded at the open. Do not say it will trade.
5. **Signing needs the user.** `lock --yes` asks the Binance Agentic Wallet to sign the plan (EIP-712,
   no gas). The wallet needs Developer mode on in the Binance App; if the result is
   `DEVELOPER_MODE_OFF`, tell the user how to turn it on. If the App asks for confirmation, tell the
   user to confirm there; the script waits up to five minutes.
6. **Report prices with their source and age.** The close is frozen at 4 pm; the 24/7 price comes from
   Hyperliquid's xyz market; the token price is the bStock pool on BNB Chain per real share. Never
   call any of them "the real value" without saying which.
7. **No promises about money.** Never say "profit", "guaranteed" or "risk-free". Tokenized stocks can
   lose value. Redeye is not investment advice.

## When something is refused

| code                                       | Say                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `PLAN_INVALID`                             | which field is out of bounds (`issues`), and offer the nearest allowed value |
| `LOCK_MISSED`                              | the close has passed or is under 5 minutes away; offer the next window       |
| `DUPLICATE_PLAN`                           | this wallet already has a plan on this stock for this window                 |
| `SIGNED_LIMIT`                             | Redeye's daily cap on free locks is reached; try tomorrow                    |
| `SIGNATURE_MISMATCH` / `SIGNATURE_EXPIRED` | sign again; nothing was locked                                               |
| `DEVELOPER_MODE_OFF`                       | turn on Developer mode in the Binance App, then retry                        |
| `AGENT_UNREACHABLE`                        | Redeye is not answering; nothing was locked                                  |

## Results

After the open, `plan <id>` shows `outcome` (kept, refused, broken), `openPrice` and links to the
lock, decision, trade and result transactions on BscScan, plus a page that re-checks every
fingerprint against the chain in the browser.
