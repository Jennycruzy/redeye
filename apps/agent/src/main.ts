import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnvFile } from "node:process";
import type { Address, Hex } from "viem";
import { AgenticWallet, createBawRunner } from "./agentic-wallet.js";
import { buildIdentityCard, identityConfigFromEnv } from "./identity.js";
import { createPlanChain } from "./plan-chain.js";
import { PlanService } from "./plan-service.js";
import { listedBstock, nasdaqOfficialOpen } from "./plan-sources.js";
import { loadPoolMap, PriceService } from "./price-service.js";
import { createSqliteAgentStore } from "./sqlite-store.js";
import { startAgentServer } from "./server.js";
import { WindowService } from "./window-service.js";

if (existsSync(".env")) loadEnvFile(".env");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

const databasePath = process.env.REDEYE_DB_PATH ?? ".redeye/redeye.sqlite";
const port = Number(process.env.AGENT_PORT ?? "8787");
const ownerToken = required("OWNER_API_TOKEN");
const siteOrigin = required("WEB_ORIGIN");
mkdirSync(dirname(databasePath), { recursive: true });
const store = await createSqliteAgentStore(
  databasePath,
  process.env.REDEYE_DERIVED_ROOT ?? "data/derived/offhours"
);
const poolMap = await loadPoolMap(
  process.env.REDEYE_POOL_MAP_PATH ?? "data/raw/offhours/pools.json"
);
const defaultPriceTickers = Object.keys(poolMap).filter(
  (ticker) => ticker !== "AAPL" && ticker !== "SKHY"
);
const priceTickers = process.env.REDEYE_PRICE_TICKERS
  ? process.env.REDEYE_PRICE_TICKERS.split(",")
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker.length > 0)
  : defaultPriceTickers;
if (priceTickers.length === 0 || priceTickers.some((ticker) => poolMap[ticker] === undefined)) {
  throw new Error("REDEYE_PRICE_TICKERS must contain only tickers with configured pools.");
}
const rawRoot = process.env.REDEYE_DATA_ROOT ?? "data";
const priceService = new PriceService({
  rawRoot,
  poolMap,
  maxPriceAgeSeconds: Number(process.env.PRICE_MAX_AGE_S ?? "120"),
  saveSnapshot: (snapshot) => store.recordPriceSnapshot(snapshot),
  saveHealth: (health) => store.recordHealthSnapshot(health)
});
const windowService = new WindowService({
  tickers: Object.keys(poolMap),
  saveWindow: (window) => store.recordWindow(window)
});
const planBookAddress = process.env.PLANBOOK_ADDRESS?.trim();
const agentKey = process.env.AGENT_PRIVATE_KEY?.trim();
const planChain =
  planBookAddress && agentKey
    ? createPlanChain({
        rpcUrl: process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org",
        planBook: planBookAddress as Address,
        privateKey: (agentKey.startsWith("0x") ? agentKey : `0x${agentKey}`) as Hex
      })
    : null;
// Trading stays off unless EXECUTION_ENABLED is exactly "true"; plans that may trade
// are then refused at lock time instead of failing later.
const trader =
  process.env.EXECUTION_ENABLED === "true" ? new AgenticWallet(createBawRunner()) : null;
const planService = new PlanService({
  store,
  chain: planChain,
  trader,
  latestPrice: (ticker) => store.latestPrice(ticker),
  listedToken: (ticker) => listedBstock(rawRoot, ticker),
  officialOpen: (ticker, date) => nasdaqOfficialOpen(rawRoot, ticker, date)
});
store.setPlanActions({
  lock: (id) => planService.lock(id),
  cancel: (id) => planService.cancel(id),
  startStanding: (input) => planService.startStanding(input),
  stopStanding: (id) => planService.stopStanding(id)
});
planService.start();
const identityConfig = identityConfigFromEnv(process.env, planChain?.agentAddress ?? null);
const identity = identityConfig === null ? undefined : buildIdentityCard(identityConfig);
const server = startAgentServer(store, { ownerToken, siteOrigin, identity }, port);
void priceService.start(priceTickers).catch((error: unknown) => {
  console.error(
    JSON.stringify({
      code: "PRICE_SERVICE_START_FAILED",
      reason: error instanceof Error ? error.message : String(error)
    })
  );
});
void windowService.start().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      code: "WINDOW_SERVICE_START_FAILED",
      reason: error instanceof Error ? error.message : String(error)
    })
  );
});

const shutdown = (): void => {
  priceService.stop();
  planService.stop();
  windowService.stop();
  server.close(() => store.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(JSON.stringify({ status: "listening", port, databasePath }));
