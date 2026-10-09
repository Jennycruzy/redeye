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
- the optional `permissionTx` EIP-7702 delegation transaction hash;
- every decision hash against its recorded input;
- every fill transaction hash format;
- the final verdict hash;
- the receipt's expected token transfers against its observed on-chain transfers.

Verification fails when reconciliation evidence is missing. A missing transfer for
a recorded fill, or an unrecorded transfer in the supplied account/window scope,
marks the reconciliation broken.

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

The web app's /data page shows the frozen weekend-study summary and downloads
that CSV. /replay shows whether a selected trigger crossed in the latest eight
completed windows using historical five-minute 24/7 candles; it does not simulate
execution or submit a transaction. There is no earnings-night dataset published yet.

The same checks are publicly available at:

```sh
curl https://api.theredeyed-agent.site/health
curl 'https://api.theredeyed-agent.site/prices?tickers=NVDA,TSLA'
curl https://api.theredeyed-agent.site/record
curl https://api.theredeyed-agent.site/.well-known/agent-card.json
```

The study command reads only the stored raw study records. It does not fetch network
data.

The public record contains mainnet-locked plans and one completed no-trade verdict.
Seven weekend plans are currently locked, including PlanAccount plan #8 with a
confirmed EIP-7702 delegation and freeze transaction. No plan-triggered production
trade has been claimed yet; that claim requires a confirmed fill and a passing
reconciliation. Replay receipts and simulations remain labeled `REPLAY` or `SIMULATED`.
