# Redeye

Redeye helps a tokenized-stock holder decide before a company reports, then publishes evidence of what happened.

Status: M0 bootstrap in progress.

The private build specification is intentionally not stored in this repository. This repository contains only implementation notes, source code, fixtures, and generated evidence that is safe to publish.

## Start here

```sh
cp .env.example .env
pnpm m0
```

The M0 probe performs non-destructive checks against public data and chain endpoints, records raw responses under `data/raw/m0/`, and writes a machine-readable report to `data/raw/m0/latest-report.json`. Authenticated wallet, funded-mainnet, and merchant probes run only when their required environment variables and explicit test settings are present.

Execution is disabled by default and must remain disabled during probes.

## Current milestone

M0 validates endpoint reachability, response shape, source timestamps, and local prerequisites before implementation depends on any external behavior. Findings belong in [`docs/dx-log.md`](docs/dx-log.md).

