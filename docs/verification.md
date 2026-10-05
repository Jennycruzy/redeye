# Verification

This command recomputes the hashes and ordering checks in a published Redeye
receipt. It does not connect a wallet and it does not send a transaction.

```sh
pnpm verify -- receipt.json
```

The command checks:

- the event key against ticker, event kind and expected date;
- the plan hash against the canonical pre-freeze plan (`planId: null`);
- the freeze block timestamp against the earliest recorded release source;
- every decision hash against its recorded input;
- every fill transaction hash format;
- the final verdict hash.

Until a mainnet receipt is published, this repository makes no claim that the
live judge path is complete. Replay receipts and simulations must remain labeled
`REPLAY` or `SIMULATED`.
