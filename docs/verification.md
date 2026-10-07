# Verification

This command recomputes the hashes and ordering checks in a published Redeye
receipt. It does not connect a wallet and it does not send a transaction.

```sh
pnpm verify -- receipt.json
```

The command checks:

- the event key against ticker, event kind and expected date;
- the plan hash against the canonical pre-freeze plan (`planId: null`);
- the freeze block timestamp against the recorded lock boundary;
- every decision hash against its recorded input;
- every fill transaction hash format;
- the final verdict hash.

Replay receipts and simulations must remain labeled `REPLAY` or `SIMULATED`.

## Read-only service checks

With the agent running locally, these commands inspect only source-backed data:

```sh
curl http://127.0.0.1:8787/health
curl 'http://127.0.0.1:8787/prices?tickers=NVDA,TSLA'
curl http://127.0.0.1:8787/study
```

`/health` reports the last successful refresh and any current feed error.
`/prices` returns the US close, the 24/7 price and the token price with source
timestamps and ages. `/study` returns the generated CSV and summary when the
source records are present; rebuild it with:

```sh
pnpm study:offhours
```

The study command reads only the committed raw study records. It does not fetch
network data.

Until a mainnet receipt is published, this repository makes no claim that a
live plan has been locked or traded. Replay receipts and simulations must remain
labeled `REPLAY` or `SIMULATED`.
