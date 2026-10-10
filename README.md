Redeye is the agent for when Wall Street is closed. It prices your stock from the market that never shuts, locks its plan on chain before the close, and at the next open shows whether it kept its word.

Redeye reads the last US close, a source-labelled 24/7 equity price, and the token's own BNB Smart Chain price. It turns a plain plan into deterministic checks, publishes the plan fingerprint before the window starts, and keeps the result visible.

Status: PlanBook is live on BNB Smart Chain and the bounded PlanAccount path is
implemented in the contract, agent and web signer. The current PlanAccount template
is deployed and exact-source verified on BNB Smart Chain. An isolated wallet has
delegated to it and locked a bounded $2 plan on mainnet; browser-wallet authorization
and the first triggered, reconciled PlanAccount swap remain release gates. The Telegram
passkey onboarding path is live behind explicit sponsor caps, with its factory deployed
on BNB Smart Chain; the first real phone registration and signed plan remain release gates.
The always-on agent locks off-hours plans, checks them every minute,
can execute eligible plans through the connected Binance Agentic Wallet, and
publishes their results at the open.

## On chain

| What                                                            | Address or transaction                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| PlanBook                                                        | [`0xC7B860d561f2208c725ac9a873bf4eA5205e9057`](https://bscscan.com/address/0xC7B860d561f2208c725ac9a873bf4eA5205e9057)                            |
| PlanAccount template (bounded permission + ERC-1271 revision)   | [`0x9736a95F6a5c24165Ecf282e3E08016715460AAC`](https://bscscan.com/address/0x9736a95F6a5c24165Ecf282e3E08016715460AAC)                            |
| Agent                                                           | [`0xe201bbf3C736a5d188797974a7e4B9464f707eA8`](https://bscscan.com/address/0xe201bbf3C736a5d188797974a7e4B9464f707eA8)                            |
| First x402 sale: NVDA 24/7 price, 0.002 U, settled by the agent | [settle](https://bscscan.com/tx/0x7dd090f39dfa8ba765a50c3dddc547418a9ac8e1d25244e97737cbf072e79a78) (team buyer wallet, labelled as our own test) |
| PlanJobHook (team jobs)                                         | [`0x42a7F449e4950524c13deBC96a0549100b516594`](https://bscscan.com/address/0x42a7F449e4950524c13deBC96a0549100b516594)                            |
| Plan 1: Guard on NVDA, 7 Oct overnight window                   | [lock](https://bscscan.com/tx/0x759ead4af86268d4015ab4074a58f2dc866ff8ee96dd077f85a5cd6ad2902092), 5 h 27 min before the close                    |

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
- a no-custody PlanAccount permission contract that checks one owner-signed
  permission, Pancake exact-input calldata, price band, replay, revocation,
  expiry and standing-run windows;
- a typed agent HTTP boundary and Node 22 SQLite store with explicit empty and
  unconfigured states;
- a live source-backed price service for the US close, 24/7 price and token price,
  with raw records and public health counters;
- a plan service that locks a plan in PlanBook before the close, checks it every
  minute against the 24/7 price and that night's official close, and records the
  decision and the result (with the official open) on chain.
- automatic post-window reconciliation of Agentic Wallet token and USDT
  transfers; publication waits if chain evidence is unavailable, and the
  reconciliation is included in the receipt fingerprint.
- a wallet-signed PlanAccount relay path with EIP-7702 authorization capture,
  one permission per plan or standing run, and `permissionTx` receipt evidence;
- a guarded Telegram Mini App passkey onboarding path: server-side initData HMAC
  verification, deterministic factory preview, durable per-user/day sponsor limits,
  fee-capped factory deployment, local credential handoff, and WebAuthn ERC-1271
  permission signing into the existing PlanAccount lock route;
- /data for the frozen weekend sample and enriched CSV, and /replay for
  trigger-only replays of the eight latest completed windows. Earnings-night
  data is not available yet and is kept separate from the weekend sample.

The central story is deliberately narrow: a plan must be frozen before the
market-close window, then end as a confirmed action or a visible refusal. The
current price view shows the US close, 24/7 price and token price with source
timestamps. Until a live plan resolves, replay output must be labeled `REPLAY`
and simulations must be labeled `SIMULATED`.

### Wallet-door boundary

The signed-wallet path uses a direct Pancake V3 quote/simulation adapter because
the installed `baw` CLI exposes no Trading API transaction-data endpoint. The
adapter is restricted on chain to Pancake `exactInputSingle`, binds the owner as
recipient, and fails closed when the quote, router or EIP-7702 provider is not
available. The deployed and source-verified template above includes these checks;
do not call the wallet door live until EIP-7702 wallet support and the first
small-value end-to-end trade are confirmed.

## Agent identity

The agent serves its ERC-8004 registration file at `/.well-known/agent-registration.json` (also `/identity`) once `PUBLIC_AGENT_URL` is set. The file lists only services that are live today and the two contracts above. `pnpm identity:register` checks that the file is reachable and simulates the registration; with `--send` it registers the agent in the identity registry on BNB Chain ([`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://bscscan.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)), or points an existing registration (`ERC8004_AGENT_ID`) at the current address.

## MCP server

`POST /mcp` is an MCP server (streamable HTTP, stateless, JSON answers) built on the official `@modelcontextprotocol/sdk`. Its tools are all read-only: `redeye_price` (the latest checked close, 24/7 and token prices with gaps, ages and sources), `redeye_windows`, `redeye_record`, `redeye_run` (one plan and its receipt), and `redeye_plan_draft`, which checks a plan against tonight's window and returns its promise, fingerprint and lock deadline without saving or locking anything. A plan locked after a close belongs to the next close; in the last five minutes before a close a lock is refused rather than moved to another night.

## A2A

The agent card is served at `/.well-known/agent-card.json` (A2A protocol 1.0 and 0.3), with JSON-RPC at `/a2a`. Its skills are read-only: price, windows, record, run and plan check.

## Try it from a terminal

```sh
curl -s https://api.theredeyed-agent.site/health
curl -s https://api.theredeyed-agent.site/record
curl -s https://theredeyed-agent.site/.well-known/agent-card.json
curl -i https://api.theredeyed-agent.site/x402/price/NVDA   # answers 402 with the payment terms
```

The MCP endpoint is `https://api.theredeyed-agent.site/mcp`.

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

The contract test suite is offline and does not deploy or move funds. The first live
plan-triggered wallet execution and the phone-backed Telegram flow are still release
gates. The signed-wallet code path is covered offline and its mainnet template is
deployed and source-verified. Mainnet delegation and plan locking are confirmed;
browser-provider EIP-7702 support, the first phone-backed passkey account and signed plan,
and a triggered small-value mainnet swap remain release gates.

The PlanAccount path also has an opt-in BSC fork test against the live Pancake
SmartRouter, QuoterV2, USDT and INTCB pool. Run it with
`REDEYE_FORK_RPC=... pnpm contract:test:fork`. `pnpm plan-account:live` builds and
signs the same bounded permission as the browser without sending it; add `--send`
only with a dedicated `PLAN_ACCOUNT_TEST_PRIVATE_KEY`. The team's isolated proof
wallet can be used explicitly with `--team-test`.

The agent process requires Node 22, `OWNER_API_TOKEN` and `WEB_ORIGIN`. Build it
with `pnpm agent:build`; it will refuse to start if those values are absent. The
filing feed and Binance Transaction API integration remain separate release gates;
the PlanAccount adapter returns named quote/router/provider errors instead of
simulated success when those prerequisites are unavailable.

The web shell is source-driven and responsive at 360px. Build it with
`pnpm web:build`. With no agent data it shows explicit empty/error states and a
`REPLAY` lead card; it does not render sample prices, hashes or counters.

Receipt verification instructions are in [`docs/verification.md`](docs/verification.md).

The read-only service checks and the source-derived study rebuild are documented in
[`docs/verification.md`](docs/verification.md).

The source probe validates endpoint reachability, response shape, source timestamps and
local prerequisites before implementation depends on external behavior. Findings
belong in [`docs/dx-log.md`](docs/dx-log.md).
