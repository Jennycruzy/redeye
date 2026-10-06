import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadPoolMap, PriceService } from "./price-service.js";
import { createSqliteAgentStore } from "./sqlite-store.js";
import { startAgentServer } from "./server.js";

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
const priceService = new PriceService({
  rawRoot: process.env.REDEYE_DATA_ROOT ?? "data",
  poolMap,
  maxPriceAgeSeconds: Number(process.env.PRICE_MAX_AGE_S ?? "120"),
  saveSnapshot: (snapshot) => store.recordPriceSnapshot(snapshot),
  saveHealth: (health) => store.recordHealthSnapshot(health)
});
const server = startAgentServer(store, { ownerToken, siteOrigin }, port);
void priceService.start(Object.keys(poolMap)).catch((error: unknown) => {
  console.error(
    JSON.stringify({
      code: "PRICE_SERVICE_START_FAILED",
      reason: error instanceof Error ? error.message : String(error)
    })
  );
});

const shutdown = (): void => {
  priceService.stop();
  server.close(() => store.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(JSON.stringify({ status: "listening", port, databasePath }));
