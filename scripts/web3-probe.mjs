// Read-only check of every Binance Web3 API module Redeye uses.
// Usage: node scripts/web3-probe.mjs   (reads BINANCE_WEB3_API_KEY / _SECRET from .env)
// Prints status, business code and latency per call; never prints credentials.
import { readFileSync } from "node:fs";
import { BinanceWeb3Client, BSC_CHAIN_ID } from "../packages/clients/dist/index.js";

function env(name) {
  if (process.env[name]) return process.env[name];
  const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line
    ? line
        .slice(name.length + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
    : "";
}

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const AGENTIC_WALLET = "0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const calls = [];
const client = new BinanceWeb3Client({
  apiKey: env("BINANCE_WEB3_API_KEY"),
  secret: env("BINANCE_WEB3_API_SECRET"),
  onCall: (c) => calls.push(c)
});

const checks = [
  [
    "rwa tokens",
    () =>
      client.get("rwa", "/api/v1/dex/market/rwa/tokens", {
        binanceChainId: BSC_CHAIN_ID,
        platformId: "bstock"
      })
  ],
  [
    "rwa price",
    () =>
      client.get("rwa", "/api/v1/dex/market/rwa/price", {
        binanceChainId: BSC_CHAIN_ID,
        tokenContractAddresses: NVDAB
      })
  ],
  [
    "rwa underlying market",
    () =>
      client.get("rwa", "/api/v1/dex/market/rwa/underlying-market", {
        binanceChainId: BSC_CHAIN_ID,
        tokenContractAddress: NVDAB
      })
  ],
  [
    "market price",
    () =>
      client.post("market", "/api/v1/dex/market/price", [
        { binanceChainId: BSC_CHAIN_ID, tokenContractAddress: NVDAB }
      ])
  ],
  ["trading chains", () => client.get("trading", "/api/v1/dex/aggregator/supported/chain")],
  [
    "transaction chains",
    () => client.get("transaction", "/api/v1/dex/pre-transaction/supported/chain")
  ],
  [
    "wallet balances",
    () =>
      client.post("wallet", "/api/v1/dex/balance/token-balances-by-address", {
        address: AGENTIC_WALLET,
        tokenContractAddresses: [
          { binanceChainId: BSC_CHAIN_ID, tokenContractAddress: USDT },
          { binanceChainId: BSC_CHAIN_ID, tokenContractAddress: NVDAB }
        ]
      })
  ]
];

for (const [name, run] of checks) {
  try {
    const { data } = await run();
    const sample = JSON.stringify(Array.isArray(data) ? data.slice(0, 1) : data);
    console.log(
      `OK   ${name}: ${Array.isArray(data) ? `${data.length} rows · ` : ""}${sample.slice(0, 400)}`
    );
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
console.log("\ncalls:");
for (const c of calls)
  console.log(
    `  ${c.at} ${c.method} ${c.path} http=${c.httpStatus} code=${c.code} ${c.latencyMs}ms ${c.ok ? "ok" : (c.message ?? "")}`
  );
