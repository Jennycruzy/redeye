import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnvFile } from "node:process";
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
const store = await createSqliteAgentStore(databasePath);
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
const priceService = new PriceService({
  rawRoot: process.env.REDEYE_DATA_ROOT ?? "data",
  poolMap,
  maxPriceAgeSeconds: Number(process.env.PRICE_MAX_AGE_S ?? "120"),
  saveSnapshot: (snapshot) => store.recordPriceSnapshot(snapshot),
  saveHealth: (health) => store.recordHealthSnapshot(health)
});
const windowService = new WindowService({
  tickers: Object.keys(poolMap),
  saveWindow: (window) => store.recordWindow(window)
});
const server = startAgentServer(store, { ownerToken, siteOrigin }, port);
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
  windowService.stop();
  server.close(() => store.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(JSON.stringify({ status: "listening", port, databasePath }));
