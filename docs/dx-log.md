# Developer experience log

Append an entry at the moment friction occurs. Use UTC timestamps and include the exact page or command, response/error, time lost, and workaround.

Format:

`YYYY-MM-DD HH:MM UTC | module | page URL + section | what we did | exact error/response | time lost | workaround`

2026-10-05 17:52 UTC | environment | local shell | checked project prerequisites | Node v20.20.2 found; project requires Node >=22.0.0; pnpm v10.33.4 and Foundry v1.5.0 available | 0 min | keep the requirement explicit and resolve before M1 CI
2026-10-05 17:52 UTC | repository | /Users/user | checked workspace before initialization | no existing `redeye` directory; parent home-level repository contains unrelated dirty files | 0 min | use an isolated nested repository
2026-10-05 17:53 UTC | public probes | `pnpm m0` | ran the first non-destructive probe | all network requests returned `TypeError: fetch failed` in the restricted shell; no response status was available | 1 min | reran the same probe with approved network access; no execution was enabled
2026-10-05 17:54 UTC | RWA Data | Binance tokenized-securities market-status endpoint | tested the path initially transcribed from the private notes | HTTP 404, body path `/v1/public/wallet-direct/buw/wallet/market/rwa/market/status/ai` | 4 min | checked the official Binance skill documentation and corrected the path to `/market/token/rwa/market/status/ai`
2026-10-05 17:54 UTC | RWA Data | Binance bStock list | fetched type=3 on BSC | HTTP 200, business code `000000`, 87 rows, first row includes `chainId`, `contractAddress`, `ticker`, `multiplier`, and `d` | 0 min | preserve the raw response and build typed validation around these fields
2026-10-05 17:54 UTC | public data | Nasdaq / SEC / GeckoTerminal / BSC RPC | completed read-only reachability checks | Nasdaq HTTP 200 with 3 rows for 2026-10-05; SEC HTTP 200; GeckoTerminal HTTP 200; BSC RPC returned chain ID `0x38` | 0 min | keep each response under the timestamped M0 raw evidence directory
2026-10-05 17:57 UTC | RWA Data | Binance market-status endpoint | reran the corrected path with network access | HTTP 200, Binance business response shape includes `code`, `data`, `success` | 0 min | use the documented `/market/token/rwa/market/status/ai` path in the client
