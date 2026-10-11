# B402 investigation

How Redeye got Binance B402 (Binance's x402 facilitator) working, what failed along the way and why. Every number below comes from a live call or the chain; the raw entries are in `docs/dx-log.md`. Times are UTC.

## Summary

- B402 runs on the normal Binance Web3 API gateway (`POST https://web3.binance.com/build/api/v2/b402/{supported,verify,settle}`), signed with the same API key and HMAC scheme as the other Web3 API modules. No merchant client id, RSA key or `X-Tesla-*` headers are needed for this route.
- Access is a per-key permission, "B402 Payments", granted from the Developer Portal. It takes effect only after the API key edit itself is saved.
- One real payment was settled by Binance's facilitator on BNB Chain: 0.002 U from the Binance Agentic Wallet to Redeye's agent wallet, [tx `0xdba0391f…836c`](https://bscscan.com/tx/0xdba0391fe87c1d09a4fce2b3d4f6f13690ab4b341590e6b07636ea5fda19836c).
- Most settles were refused with `errorReason: "invalid_transaction_state"` while `/verify` passed. Root cause: the Agentic Wallet signs EIP-3009 payments with `validAfter` equal to the signing second, U accepts the transfer only in a block whose time is past `validAfter`, and we called `/settle` within a second of signing. A dry run of the exact transfer reverted "Authorization not yet valid" right after signing and would have succeeded 4 seconds later.
- Fix: wait until the chain's latest block time is past `validAfter` before calling `/settle` (`apps/agent/src/b402-web3.ts`).
- With the fix, a complete sale went through at 21:07: the Agentic Wallet paid 0.002 U, Binance settled it ([tx `0x967e6176…3173`](https://bscscan.com/tx/0x967e61768d815efc4642a5ba2ba0e8e7ffdfebcdff76e2ec9593ef951a663173)), and Redeye delivered the NVDA price.

## Timeline

| When               | What happened                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 Oct              | Our spec noted, from public sources, that B402 might be reachable through the Web3 API gateway with the normal key. Not tested.                                                                                                                                                                                            |
| 8 Oct 03:10        | We called `/build/api/v2/b402` with our Web3 API key and got `40103 "Timestamp is required"`. We read that as "B402 needs the separate merchant onboarding" and stopped. In fact the request was sent without the `X-OC-*` signed headers: our signed client did not exist until 10 Oct. The answer never tested access.   |
| 8 Oct              | The merchant (OnchainPay) route needs an application through a Google Form our account could not open. We built x402 with our own facilitator instead; first sale settled on chain 8 Oct.                                                                                                                                  |
| 10 Oct 19:41       | Signed `POST /build/api/v2/b402/supported` (body `{"body":{}}`): HTTP 403, `40104 "No permission: B402"`. The same key and signer got HTTP 200 from `/rwa/tokens` in the same minute, so the signature was accepted and only the permission was missing. Three body shapes gave the same answer.                           |
| 10 Oct 20:00       | Developer Portal → API Key Management → Edit API Key → tick "B402 Payments" → "B402 Payments Application" form (Payout Wallet, Business Name, Business Category, Email, Telegram, Website URL, Expected Monthly Volume, terms). Payout wallet: the agent wallet `0xe201bbf3C736a5d188797974a7e4B9464f707eA8` (write-once). |
| 10 Oct 20:05–20:06 | Still `40104`. The application alone did not enable the permission.                                                                                                                                                                                                                                                        |
| 10 Oct 20:07       | After clicking Save on the Edit API Key window: `/supported` HTTP 200, business code `"000000000"`, 324 ms.                                                                                                                                                                                                                |
| 10 Oct 20:18       | Agentic Wallet swapped 0.1 USDT for 0.099988 U ([tx](https://bscscan.com/tx/0xbc7d56e15b1f832edaf437d434e87f1a792e0570d5ed3873c3ccb7e4625f8783)) so it could pay by EIP-3009.                                                                                                                                              |
| 10 Oct 20:19–20:45 | Five signed payments (table below): all verified, one settled.                                                                                                                                                                                                                                                             |
| 10 Oct 21:03       | No-settle dry run found the cause.                                                                                                                                                                                                                                                                                         |
| 10 Oct 21:05       | Fix built and tested.                                                                                                                                                                                                                                                                                                      |
| 10 Oct 21:07       | Full sale with the fix: settled, data delivered.                                                                                                                                                                                                                                                                           |

## What `/supported` offers

10 payment kinds, all on BNB Chain (`eip155:56`), one signer `0x34F7a661160780Ce1346e6D7B96D2bE244590899`:

| Token                                    | Methods                                            |
| ---------------------------------------- | -------------------------------------------------- |
| U ("United Stables", v1)                 | `eip3009` (exact), `permit2-exact`, `permit2-upto` |
| USD1 ("World Liberty Financial USD", v1) | `eip3009` (exact), `permit2-exact`, `permit2-upto` |
| USDT ("Tether USD")                      | `permit2-exact`, `permit2-upto`                    |
| USDC ("USD Coin")                        | `permit2-exact`, `permit2-upto`                    |

Permit2 spenders: `0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633` (exact), `0x8c819E6De3df83E0e87bBE7651c5D4e83229b239` (upto). Redeye offers U by `eip3009`, which needs no token approval from the buyer.

## The five payments

Same route each time: Redeye's seller (in its own process, never the live agent) fetched `/supported`, issued a 402 for 0.002 U by `eip3009` to the agent wallet, the Agentic Wallet ran `baw x402-payment preview` (READY_TO_SIGN, `needApproveFirst: false`) and `sign`, then Redeye called `/verify` and `/settle`.

| Signed                  | Payment id / nonce                                                              | `/verify`    | `/settle`                                                        | On chain                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ~20:19:07               | not recorded                                                                    | not recorded | not recorded                                                     | no transfer seen; outcome unknown                                                                                |
| 20:19:33                | nonce `0xb81a4de0…81fe00` (from the tx)                                         | not recorded | not recorded                                                     | **settled 20:19:34**, tx `0xdba0391f…836c`, sent by `0x34F7…0899`, 86,301 gas paid by Binance; nonce marked used |
| 20:31                   | `6be1e862…`                                                                     | isValid true | `success: false`, `transaction: ""`, `invalid_transaction_state` | nothing                                                                                                          |
| 20:36:38                | `dc2ea922…`, nonce `0x3fc0783f…3bf1`, validAfter 1791664598, validBefore +120 s | isValid true | refused at +0.6 s and again at +6.6 s, same reason               | nothing; nonce unused                                                                                            |
| 20:44:57                | `11d7644b…`, nonce `0x6c3d60ce…1c62`                                            | isValid true | refused at +0.3 s and +6.5 s, same reason                        | nothing; nonce unused                                                                                            |
| 21:07:35 (with the fix) | nonce `0x566f9948…b37d`, validAfter 1791666454                                  | isValid true | `success: true`, 1.3 s                                           | **settled 21:07:35**, tx `0x967e6176…3173`; data delivered                                                       |

The 20:19:33 run was started by mistake while checking balances; only one 0.002 U ever moved (Agentic Wallet 0.099988 → 0.097988 U). The first two runs' Binance answers were not recorded, because the harness then logged only call status; after that it logged every answer.

## Ruled out, with evidence

- **Our signing or request shape.** `/verify` returned `isValid: true` for every payment, and our body matches the example in Binance's B402 integration guide field for field.
- **Replay of a spent authorization.** Each run fetched a new 402 and got a new payment id, signature and nonce. `authorizationState(payer, nonce)` on U: the settled nonce is used; the 20:36 and 20:44 nonces were never used.
- **Payer state.** U not paused; payer held 0.098 U for a 0.002 U payment; `eip3009` needs no allowance; `baw wallet tx-lock` UNLOCKED; x402 quota $20/day, 0.006 used.
- **Facilitator health.** Signer `0x34F7…0899` held 0.845 BNB and its nonce went from 95,401 (20:19) to 95,500 (20:37), about 100 settlements for other sellers, none pending.
- **The resource URL.** The seller first advertised a placeholder host; with the real `https://api.theredeyed-agent.site/...` the 20:44 settle was refused the same way.

## Root cause

No-settle test at 21:03 (`REDEYE_B402_LIVE=simulate`): the Agentic Wallet signed a fresh payment, and we dry-ran U's `transferWithAuthorization` with that exact signature, as Binance's signer would send it (an `eth_call`; nothing was sent).

| Moment              | Latest block time | `validAfter` | Dry run                                   |
| ------------------- | ----------------- | ------------ | ----------------------------------------- |
| right after signing | 1791666203        | 1791666204   | reverts **"Authorization not yet valid"** |
| 4 s later           | 1791666207        | 1791666204   | would succeed                             |

`/verify` returned `isValid: true` for the same payment, and the nonce stayed unused.

So: the Agentic Wallet sets `validAfter` to the second it signs. U (like other EIP-3009 tokens) accepts the transfer only in a block whose timestamp is past `validAfter`. A settle sent within a second of signing is simulated against a block that is still too early, and B402 answers `invalid_transaction_state` with nothing broadcast. The one success fits a race the chain happened to win. The retries 6 seconds later returning the same answer fit Binance's guide, "Settle is idempotent for the same signed authorization": the facilitator most likely returns its stored first answer for that authorization. That last part is an inference; Binance does not document it.

## Fix

`web3B402Transport` (`apps/agent/src/b402-web3.ts`) now reads `validAfter` from the EIP-3009 authorization and waits, polling the latest BNB Chain block every 0.5 s, until the block time is past it (at most 15 s) before calling `/settle`. Permit2 payments, which have no `validAfter`, settle at once. Tests in `apps/agent/src/b402-web3.test.ts`. A settle that comes back broadcast but not confirmed is checked again every 3 s for up to 45 s; a refusal with nothing broadcast is never resent.

## Confirmed live

21:07: the Agentic Wallet signed (validAfter 1791666454), `/verify` passed, and `/settle` answered `{success: true, transaction: 0x967e6176…3173, amount: "2000000000000000"}` in 1.3 s. On chain: block 126896979 (time 1791666455), status 1, sent by Binance's signer `0x34F7…0899`, 86,325 gas paid by Binance, 0.002 U from the Agentic Wallet to the agent wallet. Redeye's seller then answered HTTP 200 with the NVDA price snapshot and a `PAYMENT-RESPONSE` header.

Caveat: in this run the wallet's `validAfter` was already a second old when we settled, so the block was past it immediately and the new wait did not need to hold. The 21:03 dry run is the direct evidence for the cause; the wait guards the case it found.

Two payments in total were settled by Binance today (20:19:34 and 21:07:35); four were refused before broadcast; one is unknown.

## Status

Live. On 11 Oct 2026 at 01:49 UTC the agent was restarted with `X402_SETTLEMENT=b402-web3`, after tests that a restarted agent grades waiting plans once, keeps watching locked ones and never trades twice. Every paid route on `api.theredeyed-agent.site` now asks for a B402 payment whose settler is Binance's signer `0x34F7…0899`. Sales before that time settled through the agent's own facilitator.

## What we would ask Binance for

1. Name the cause in `errorReason`. `invalid_transaction_state` is defined by the x402 spec only as "Blockchain transaction failed or was rejected"; here it meant "authorization not yet valid", which a caller can fix by waiting.
2. Have `/verify` check `validAfter` against chain time, so a payment that cannot settle yet does not pass verify.
3. Have the Agentic Wallet sign `validAfter` a few seconds in the past. The B402 integration guide's own example uses `"validAfter": "0"`.
4. Say on the API key page that the B402 Payments application does not take effect until the key edit is saved, and link the application from the `40104` message.
5. Say on the B402 pages that this route uses the Web3 API key and HMAC, and that the merchant (OnchainPay) docs with RSA and `X-Tesla-*` headers describe a different product.

## How to reproduce

```sh
node scripts/b402-probe.mjs                                   # read-only /supported
cd apps/agent
REDEYE_B402_LIVE=preview  pnpm exec vitest run src/x402-b402-live.test.ts   # builds a 402, wallet previews; nothing signed
REDEYE_B402_LIVE=simulate pnpm exec vitest run src/x402-b402-live.test.ts   # wallet signs; on-chain dry run; verify only
REDEYE_B402_LIVE=pay      pnpm exec vitest run src/x402-b402-live.test.ts   # real 0.002 U payment through B402
```

Against the live agent, from the Redeye skill:

```sh
node skills/redeye/scripts/redeye.mjs buy price NVDA         # the 402 read back as a cost; nothing signed
node skills/redeye/scripts/redeye.mjs buy price NVDA --yes   # real 0.002 U payment, prints Binance's settle tx
```

(`node scripts/b402-probe.mjs` needs a build of `packages/clients`.) The live modes need `BINANCE_WEB3_API_KEY` and `BINANCE_WEB3_API_SECRET` (with the B402 Payments permission) and a paired Agentic Wallet (`baw`).
