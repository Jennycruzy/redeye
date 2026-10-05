# Recorded fixtures

These files are captured source records used only by offline tests. They are not live data and are never read by a live execution path. Each record retains its source URL and fetch timestamp.

`hyperliquid/xyz-equities-recorded-subset.json` keeps three untouched asset/context pairs selected from one recorded `metaAndAssetCtxs` response; the production client still rejects mismatched arrays and parses the complete live response.
