Redeye is the agent for when Wall Street is closed. It prices your stock from the market that never shuts, locks its plan on chain before the close, and at the next open shows whether it kept its word.

Redeye reads the last US close, a source-labelled 24/7 equity price, and the token's own BNB Smart Chain price. It turns a plain plan into deterministic checks, publishes the plan fingerprint before the window starts, and keeps the result visible.

Status: PlanBook and PlanAccount are live on BNB Smart Chain, and the agent locks
off-hours plans and publishes their results at the open. Trading from a plan is not
connected yet: a plan whose trigger is reached is published as refused
(`EXECUTION_DISABLED`), never as a trade.

## On chain

| What                                          | Address or transaction                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| PlanBook                                      | [`0xC7B860d561f2208c725ac9a873bf4eA5205e9057`](https://bscscan.com/address/0xC7B860d561f2208c725ac9a873bf4eA5205e9057)         |
| PlanAccount (shared permission code)          | [`0x141B2a28895c12FD17209eC621496f0F9f1F1048`](https://bscscan.com/address/0x141B2a28895c12FD17209eC621496f0F9f1F1048)         |
| Agent                                         | [`0xe201bbf3C736a5d188797974a7e4B9464f707eA8`](https://bscscan.com/address/0xe201bbf3C736a5d188797974a7e4B9464f707eA8)         |
| PlanJobHook (team jobs)                       | [`0x42a7F449e4950524c13deBC96a0549100b516594`](https://bscscan.com/address/0x42a7F449e4950524c13deBC96a0549100b516594)         |
| Plan 1: Guard on NVDA, 7 Oct overnight window | [lock](https://bscscan.com/tx/0x759ead4af86268d4015ab4074a58f2dc866ff8ee96dd077f85a5cd6ad2902092), 5 h 27 min before the close |

## Start here

```sh
cp .env.example .env
pnpm probe
```

The source probe performs non-destructive checks against public data and chain endpoints, records raw responses under `data/raw/probes/`, and writes a machine-readable report to `data/raw/probes/latest-report.json`. Authenticated wallet, funded-mainnet, and merchant probes run only when their required environment variables and explicit test settings are present.

Execution is disabled by default and must remain disabled during probes.

## Current implementation

The current implementation establishes the first proof slice:

- typed source records and fail-loud public-data parsers;
- deterministic overnight, weekend, holiday, Protect, Hold, React, Guard and Buy-the-dip decisions;
- a source-labelled Hyperliquid `xyz` price client with age and unit checks;
- a frozen off-hours study rebuilt from committed raw records with a Node command;
- quote freshness, address, reference-price and price-impact checks;
- verbatim filing-value verification;
- canonical plan, decision and verdict hashes;
- a no-custody PlanBook contract with uniqueness and lifecycle tests;
- a typed agent HTTP boundary and Node 22 SQLite store with explicit empty and
  unconfigured states;
- a live source-backed price service for the US close, 24/7 price and token price,
  with raw records and public health counters;
- a plan service that locks a plan in PlanBook before the close, checks it every
  minute against the 24/7 price and that night's official close, and records the
  decision and the result (with the official open) on chain.

The central story is deliberately narrow: a plan must be frozen before the
market-close window, then end as a confirmed action or a visible refusal. The
current price view shows the US close, 24/7 price and token price with source
timestamps. Until a live plan resolves, replay output must be labeled `REPLAY`
and simulations must be labeled `SIMULATED`.

## Agent identity

The agent serves its ERC-8004 registration file at `/.well-known/agent-registration.json` (also `/identity`) once `PUBLIC_AGENT_URL` is set. The file lists only services that are live today and the two contracts above. `pnpm identity:register` checks that the file is reachable and simulates the registration; with `--send` it registers the agent in the identity registry on BNB Chain ([`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://bscscan.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)), or points an existing registration (`ERC8004_AGENT_ID`) at the current address.

## x402 sales

`GET /x402/price/{ticker}` (0.002 U) sells the live 24/7 price snapshot: the last close, the 24/7 price, the token price, gaps, ages and sources. `GET /x402/window/{ticker}` (0.01 U) sells the off-hours history against the next open, and `GET /x402/record/{id}` returns a plan's receipt for free. Payment is the x402 v2 `exact` scheme in U by EIP-3009 on BNB Chain (EIP-712 domain "United Stables", version "1"), paid to the agent wallet.

`X402_SETTLEMENT` picks how payments settle:

- `self`: the official x402 EVM facilitator (`@x402/evm`) runs inside the agent. It checks the buyer's signature, balance and nonce, simulates the transfer, and the agent wallet submits the buyer's signed `transferWithAuthorization` to U, paying the gas (about $0.003 at 0.05 gwei, more than a $0.002 sale earns). U's own nonce check stops a signed payment from being used twice.
- `b402`: Binance B402 through `@bnb-chain/b402`, once `B402_BASE_URL`, `B402_CLIENT_ID`, `B402_ACCESS_TOKEN` and `B402_PRIVATE_KEY_B64` from the merchant onboarding are set, with a SQLite replay guard.
- unset: paid routes answer `X402_NOT_CONFIGURED`.

The answer is prepared before settlement, so nobody pays for a ticker with nothing to sell, and is sent only after settlement succeeds. A price is sold only if it is under two minutes old. `src/x402-fork.test.ts` settles real payments against a local fork of BNB Chain (`REDEYE_FORK_RPC`).

## Plan jobs (ERC-8183)

When `JOB_BUYER_PRIVATE_KEY` is set (a team wallet, never the agent's own), every locked plan is also an ERC-8183 job on BNB Chain: before the lock the buyer opens the job with the agent as provider, registers the reference optimistic policy, and pays a 0.01 USDT budget; PlanBook records the job id with the plan. After the result is published the agent delivers keccak256 of the manifest `{v, planId, receipt, verdictHash}`, and once the policy's dispute window has passed (7 days on 7 Oct 2026) the agent settles the job through the router. A failed job step never blocks the lock; it is kept on the plan and retried every minute, and a lost reply is recovered from the sent transaction rather than opening a second job.

Team jobs: when `PLAN_JOB_HOOK_ADDRESS` is set, the first `TEAM_JOB_LIMIT` plans also get a second job that names Redeye's own `PlanJobHook` instead of the router, with the team buyer as evaluator. The buyer approves it at the open only if the published receipt verifies and the delivered fingerprint matches it, and rejects it otherwise (the budget then returns to the buyer). These jobs are labelled as approved by our own wallet; they exist because the official route cannot complete a job in under seven days.

Contracts: commerce [`0xEa4DAa3100A767e86FDed867729ae7446476EBA6`](https://bscscan.com/address/0xEa4DAa3100A767e86FDed867729ae7446476EBA6), router [`0x51895229E12F9876011789B04f8698af06cCD6DA`](https://bscscan.com/address/0x51895229E12F9876011789B04f8698af06cCD6DA), policy [`0x9C01845705b3078aA2E8CfF7520a6376fd766dE5`](https://bscscan.com/address/0x9C01845705b3078aA2E8CfF7520a6376fd766dE5).

## Verification

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm contract:build
pnpm contract:test
```

The contract test suite is offline and does not deploy or move funds. Wallet
execution, the filing feed, the web app and Agent Studio evidence are not
represented as complete yet.

The agent process requires Node 22, `OWNER_API_TOKEN` and `WEB_ORIGIN`. Build it
with `pnpm agent:build`; it will refuse to start if those values are absent. The
wallet, filing feed and PlanBook write services are intentionally not wired into
the store yet, so they return named errors instead of simulated success.

The web shell is source-driven and responsive at 360px. Build it with
`pnpm web:build`. With no agent data it shows explicit empty/error states and a
`REPLAY` lead card; it does not render sample prices, hashes or counters.

Receipt verification instructions are in [`docs/verification.md`](docs/verification.md).

The read-only service checks and the source-derived study rebuild are documented in
[`docs/verification.md`](docs/verification.md).

The source probe validates endpoint reachability, response shape, source timestamps and
local prerequisites before implementation depends on external behavior. Findings
belong in [`docs/dx-log.md`](docs/dx-log.md).
