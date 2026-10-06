# Off-hours study raw data

Frozen on 2026-10-05 around 21:10–21:16 UTC. This folder is the source of truth for the off-hours study.
Rebuild the study from these files. Do not re-fetch them, because the hosted APIs can return different
values later.

| File | What it holds |
|---|---|
| `pools.json` | Ticker → `[PancakeSwap v3 pool address on BSC, pool liquidity in USD at fetch time, pool creation time in ms]` for 15 bStocks. |
| `study_raw.json` | Per ticker: `hl` = Hyperliquid `xyz:<TICKER>` 1 h candle closes (key = candle open, Unix seconds UTC); `gt` = GeckoTerminal 1 h close of the bStock pool in USD (same keys); `nas` = Nasdaq daily history, `date → [official open, official close]`; `liq` = pool liquidity. Window 2026-08-01 → 2026-10-05 14:00 UTC. |
| `study_rows.json` | One row per stock-weekend (15 stocks × 8 weekends = 120): Friday close `C`, Monday open `O`, and Hyperliquid (`H_*`) and token (`B_*`) prices at Sat 12:00, Sun 23:00 and Mon 07:00 UTC. |

Sources: `api.hyperliquid.xyz/info` (candleSnapshot), `api.geckoterminal.com/api/v2/networks/bsc/pools/<pool>/ohlcv/hour`,
`api.nasdaq.com/api/quote/<T>/historical`.

Exclusions: AAPL (the GeckoTerminal pool price comes back in the wrong unit) and SKHY (Hyperliquid's SKHX is
a different instrument from SKHY). That leaves 104 rows across 13 stocks.

Reproduce (Python 3, standard library only), from this folder:

```
python3 ../../../scripts/study/reference/build_rows.py   # rewrites study_rows.json (same bytes), 120 rows
python3 ../../../scripts/study/reference/analyze.py      # summary, 104 rows
```

SHA-256:

```
f43eaa60580299fae54ceafe98aaf8fae6855cc5a986923290650ce7396e671a  pools.json
00659abf56938d184086be7c84aa2ef2928f27f7c0eaaeec8d5bfe6791272dab  study_raw.json
5af8fd2f8ff23a044c149ae6aa0889bda6ed81fe2fa9a57c40d3f1336af0ddb7  study_rows.json
```
