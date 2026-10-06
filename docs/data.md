# Redeye data methods

This page describes the committed off-hours study and the command that rebuilds
its derived files. The study is descriptive; it does not predict prices or
measure investment performance.

## Frozen inputs

The source records under [`data/raw/offhours/`](../data/raw/offhours/) are
frozen evidence for the current study. `study_raw.json` contains the Nasdaq
daily close/open records, Hyperliquid one-hour records, and GeckoTerminal
one-hour records. `pools.json` records the pool address, observed liquidity and
creation time. `study_rows.json` is the 120-row output of the Python reference
builder.

The reference files under
[`scripts/study/reference/`](../scripts/study/reference/) remain as the record
of how the original download was assembled. `fetch.py` is not part of the
rebuild command and must not be used to refresh the frozen inputs.

## Rebuild

```sh
pnpm study:offhours
```

The command reads only `data/raw/offhours/` and writes these generated files:

- `data/derived/offhours/study_rows.csv`
- `data/derived/offhours/summary.txt`
- `data/derived/offhours/summary.json`

It makes no network requests. The built-in test compares all 120 Node rows
with the frozen Python rows and compares the rendered summary with the Python
reference output:

```sh
pnpm study:offhours:test
```

## Sample and exclusions

The builder creates eight Friday-to-following-Monday rows for each of the 15
stocks in the raw input, covering Fridays from 7 August through 25 September 2026. The analysis excludes AAPL and SKHY because their recorded series fail
the unit or comparability checks described in the raw-data README. The reported
analysis therefore contains 104 rows across 13 stocks.

For each row, `C` is the Friday US close and `O` is the next trading day's US
open. The checkpoints are Saturday 12:00 UTC, Sunday 23:00 UTC and Monday
07:00 UTC. Each checkpoint selects the most recent recorded value no more than
six hours earlier for Hyperliquid, or 24 hours earlier for GeckoTerminal.
Missing values are retained as missing and excluded from the statistic that
requires them; they are never filled or interpolated.

The summary reports absolute error to the Monday open, the token-to-24/7-price
gap, direction counts, and the modelled return from moving the token toward the
24/7 price when their gap exceeds the stated threshold. Fees, slippage and
execution are not included in those descriptive returns.
