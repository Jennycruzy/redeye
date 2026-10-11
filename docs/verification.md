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

The public record contains mainnet-locked plans and one completed no-trade verdict:
protect half an Nvidia holding overnight (plan #1), kept. The first trade made by a
promise was the weekend CRCL sale (plan #6): CRCL rose 1%
over the weekend and at 02:41 UTC on 10 Oct the agent sold 0.0605 CRCL for
5.156124 USDT through the Agentic Wallet. Lock
`0xc20089b42d0b848d1dd689411449c2005ce529676a639c6f70a79b281c1a2c7b`, decision
`0x4a25f64a1bb47ef302ef5dfb978bcf0ce27bd583f797217e954ef6687ab8a62a`, trade
`0x3014f7996e59458934dcd500232fd2674904d183df376daac9c8171770f0e87a`, fill on PlanBook
`0xcea26956f4a1053b9cf6f4feee049781addc82a4082b9ff0b4645d95243e683e`. Binance's Wallet
API and the chain agree on the amount received. Its result is graded at the open on
Monday 12 Oct. A $2 buy-the-dip on Intel from the team's own wallet through PlanAccount
(EIP-7702, plan #8) is locked; no trade has gone through that route yet. A Hold on Nvidia
for Monday night (plan #10) was signed by the Agentic Wallet itself; no money moves. Replay receipts and simulations remain labeled `REPLAY` or `SIMULATED`.
