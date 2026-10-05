# Redeye

Redeye helps a tokenized-stock holder decide before a company reports, then publishes evidence of what happened.

Status: deterministic core and PlanBook proof layer in progress. Live execution is
disabled and no mainnet deployment is claimed by this repository yet.

The private build specification is intentionally not stored in this repository. This repository contains only implementation notes, source code, fixtures, and generated evidence that is safe to publish.

## Start here

```sh
cp .env.example .env
pnpm m0
```

The M0 probe performs non-destructive checks against public data and chain endpoints, records raw responses under `data/raw/m0/`, and writes a machine-readable report to `data/raw/m0/latest-report.json`. Authenticated wallet, funded-mainnet, and merchant probes run only when their required environment variables and explicit test settings are present.

Execution is disabled by default and must remain disabled during probes.

## Current milestone

The current implementation establishes the first proof slice:

- typed source records and fail-loud public-data parsers;
- deterministic Protect, Hold and React decisions;
- quote freshness, address, reference-price and price-impact checks;
- verbatim filing-value verification;
- canonical plan, decision and verdict hashes;
- a no-custody PlanBook contract with uniqueness and lifecycle tests.
- a typed agent HTTP boundary and Node 22 SQLite store with explicit empty and
  unconfigured states.

The central story is deliberately narrow: a plan must be frozen before its
release, then end as a confirmed action or a visible refusal. Until a live plan
resolves, replay output must be labeled `REPLAY` and simulations must be labeled
`SIMULATED`.

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

Receipt verification instructions are in [`docs/verification.md`](docs/verification.md).

M0 still validates endpoint reachability, response shape, source timestamps and
local prerequisites before implementation depends on external behavior. Findings
belong in [`docs/dx-log.md`](docs/dx-log.md).
