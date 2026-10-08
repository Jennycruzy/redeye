import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnvFile } from "node:process";
import type { Address, Hex } from "viem";
import { AgenticWallet, createBawRunner } from "./agentic-wallet.js";
import { buildIdentityCard, identityConfigFromEnv } from "./identity.js";
import { B402Client } from "@bnb-chain/b402/server";
import { createJobBook } from "./job-chain.js";
import { createMcpHandler } from "./mcp.js";
import { createPlanChain } from "./plan-chain.js";
import { PlanService } from "./plan-service.js";
import { listedBstock, nasdaqOfficialOpen } from "./plan-sources.js";
import { loadPoolMap, PriceService } from "./price-service.js";
import { createSqliteAgentStore } from "./sqlite-store.js";
import { startAgentServer } from "./server.js";
import { WindowService } from "./window-service.js";
import {
  agentFacilitatorSigner,
  createX402Seller,
  storeContent,
  type X402Settlement
} from "./x402-sales.js";

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
// Each locked plan becomes an ERC-8183 job only when a separate team buyer wallet is set.
const buyerKey = process.env.JOB_BUYER_PRIVATE_KEY?.trim();
const asKey = (key: string) => (key.startsWith("0x") ? key : `0x${key}`) as Hex;
const jobs =
  buyerKey && agentKey && planChain
    ? createJobBook({
        rpcUrl: process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org",
        buyerKey: asKey(buyerKey),
        agentKey: asKey(agentKey),
        teamHook: (process.env.PLAN_JOB_HOOK_ADDRESS?.trim() || null) as Address | null
      })
    : null;
const planService = new PlanService({
  store,
  chain: planChain,
  trader,
  jobs,
  teamJobLimit: Number(process.env.TEAM_JOB_LIMIT ?? "0"),
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
// x402 sales. X402_SETTLEMENT picks the route: "self" settles through the official x402
// EVM facilitator run by the agent wallet, "b402" through Binance B402 once its merchant
// credentials are set, and anything else keeps paid routes off. Bad B402 settings only
// turn paid sales off; they never stop the agent.
function x402Settlement(): X402Settlement | null {
  const route = process.env.X402_SETTLEMENT?.trim();
  if (route === "self" && agentKey) {
    return {
      kind: "self",
      signer: agentFacilitatorSigner(
        process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org",
        (agentKey.startsWith("0x") ? agentKey : `0x${agentKey}`) as Hex
      )
    };
  }
  if (route !== "b402") return null;
  try {
    const transport = B402Client.fromEnv(process.env);
    if (!transport) return null;
    return {
      kind: "b402",
      transport,
      replayStore: store.replayStore(),
      onSettlementUnknown: (event: unknown) => {
        console.error(JSON.stringify({ code: "X402_SETTLEMENT_UNKNOWN", event }));
        void store.saveRunEvent("x402", "settlement_unknown", { event });
      }
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        code: "B402_CONFIG_INVALID",
        reason: error instanceof Error ? error.message : String(error)
      })
    );
    return null;
  }
}
const x402 = planChain
  ? await createX402Seller({
      settlement: x402Settlement(),
      payTo: planChain.agentAddress,
      content: storeContent(store, Number(process.env.PRICE_MAX_AGE_S ?? "120") * 1000)
    })
  : null;
if (x402) {
  console.log(
    JSON.stringify(
      x402.paid
        ? { status: "x402_paid_routes_on", settledBy: x402.settledBy }
        : { status: "x402_paid_routes_off", reason: x402.reason }
    )
  );
}
const server = startAgentServer(
  store,
  {
    ownerToken,
    siteOrigin,
    identity,
    ...(x402 ? { x402 } : {}),
    mcp: createMcpHandler(
      {
        prices: (tickers) => store.prices(tickers),
        windows: (ticker) => store.windows(ticker),
        record: () => store.record(),
        planGet: (id) => store.planGet(id),
        receipt: (id) => store.receipt(id),
        preview: (input) => planService.preview(input)
      },
      "0.1.0"
    )
  },
  port
);
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
