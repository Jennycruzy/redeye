# Redeye API

Base: `https://api.theredeyed-agent.site` (the site also serves it under `/api`). JSON in and out;
errors are `{"error":{"code","reason"}}` with an HTTP status.

| Method | Path                                   | Returns                                                             |
| ------ | -------------------------------------- | ------------------------------------------------------------------- |
| GET    | `/health`                              | price-service uptime: passes, longest gap, price ages               |
| GET    | `/prices?tickers=NVDA,TSLA`            | close, 24/7 price, token price per real share, gaps, sources, ages  |
| GET    | `/night/{ticker}?close={ms}`           | the 24/7 price in 5-minute steps through one window, with its close |
| GET    | `/record`                              | every plan with status, outcome and transaction hashes              |
| GET    | `/runs/{id}`                           | one plan as published (plan, fingerprint, decision, verdict)        |
| GET    | `/runs/{id}/events`                    | the agent's logged checks and steps                                 |
| GET    | `/runs/{id}/receipt`                   | the receipt once graded                                             |
| POST   | `/preview`                             | checks a plan against the next lockable window; saves nothing       |
| POST   | `/signed-plans`                        | locks a plan signed by its owner (below)                            |
| GET    | `/.well-known/agent-card.json`         | A2A card (JSON-RPC at `/a2a`)                                       |
| GET    | `/.well-known/agent-registration.json` | ERC-8004 registration (agent #368521)                               |
| POST   | `/mcp`                                 | MCP over streamable HTTP, read-only tools                           |
| GET    | `/x402/price/{ticker}`                 | the 24/7 price, paid per call over x402                             |

## Signed plans

`POST /signed-plans` with `{ plan, owner, issuedAt, signature }`. The signature is EIP-712 over:

```
domain  { name: "Redeye", version: "1", chainId: 56,
          verifyingContract: 0xC7B860d561f2208c725ac9a873bf4eA5205e9057 }
Plan    { string promise; address owner; string ticker; bytes32 planHash;
          uint64 windowClose; uint64 issuedAt }
```

`promise`, `planHash` and `windowClose` (seconds) come from `POST /preview` for the same plan;
`issuedAt` is the signing time in seconds and must be under 10 minutes old. The agent rebuilds all
of it, recovers the signer, and locks the plan in PlanBook with `owner` as the plan's owner.
