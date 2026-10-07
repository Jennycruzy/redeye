Redeye is the agent for when Wall Street is closed. It prices your stock from the market that never shuts, locks its plan on chain before the close, and at the next open shows whether it kept its word.

Redeye reads the last US close, a source-labelled 24/7 equity price, and the token's own BNB Smart Chain price. It turns a plain plan into deterministic checks, publishes the plan fingerprint before the window starts, and keeps the result visible.

Status: deterministic core and PlanBook proof layer in progress. Live execution is
disabled and no mainnet deployment is claimed by this repository yet.

The private build specification is intentionally not stored in this repository. This repository contains only implementation notes, source code, fixtures, and generated evidence that is safe to publish.

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
- a no-custody PlanBook contract with uniqueness and lifecycle tests.
- a typed agent HTTP boundary and Node 22 SQLite store with explicit empty and
  unconfigured states;
- a live source-backed price service for the US close, 24/7 price and token price,
  with raw records and public health counters.

The central story is deliberately narrow: a plan must be frozen before the
market-close window, then end as a confirmed action or a visible refusal. The
current price view shows the US close, 24/7 price and token price with source
timestamps. Until a live plan resolves, replay output must be labeled `REPLAY`
and simulations must be labeled `SIMULATED`.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm contract:build
pnpm contract:test
```

The contract test suite is offline and does not deploy or move funds. Mainnet
deployment, wallet execution, the filing feed, the web app and Agent Studio
evidence are not represented as complete yet.

The agent process requires Node 22, `OWNER_API_TOKEN` and `WEB_ORIGIN`. Build it
with `pnpm agent:build`; it will refuse to start if those values are absent. The
wallet, filing feed and PlanBook write services are intentionally not wired into
the store yet, so they return named errors instead of simulated success.

The web shell is source-driven and responsive at 360px. Build it with
`pnpm web:build`. With no agent data it shows explicit empty/error states and a
`REPLAY` lead card; it does not render sample prices, hashes or counters.

Receipt verification instructions are in [`docs/verification.md`](docs/verification.md).

The source probe validates endpoint reachability, response shape, source timestamps and
local prerequisites before implementation depends on external behavior. Findings
belong in [`docs/dx-log.md`](docs/dx-log.md).
