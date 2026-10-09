import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnvFile } from "node:process";
import type { Address, Hex } from "viem";
import { fetchRwaList, parseRwaList, storeRawRecord } from "@redeye/clients";
import { AgenticWallet, createBawRunner, walletStatus } from "./agentic-wallet.js";
import { PANCAKE_SMART_ROUTER_BSC, PlanAccountTrader } from "./plan-account.js";
import { buildIdentityCard, identityConfigFromEnv } from "./identity.js";
import { B402Client } from "@bnb-chain/b402/server";
import { createJobBook } from "./job-chain.js";
import { createA2aHandler } from "./a2a.js";
import { createMcpHandler } from "./mcp.js";
import { createPlanChain } from "./plan-chain.js";
import { reconcilePlanWindow } from "./chain-reconciliation.js";
import { PlanService } from "./plan-service.js";
import { createNightService } from "./night.js";
import { createPasskeyAccountPreview, createPasskeyAccountService } from "./passkey-account.js";
import { listedBstock, nasdaqCloseOn, nasdaqOfficialOpen, xyzCandles } from "./plan-sources.js";
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
const asKey = (key: string) => (key.startsWith("0x") ? key : `0x${key}`) as Hex;
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
const planAccountTemplate = process.env.PLANACCOUNT_ADDRESS?.trim();
const planAccountRouter = (process.env.PLAN_ACCOUNT_ROUTER_ADDRESS?.trim() ||
  PANCAKE_SMART_ROUTER_BSC) as Address;
const planAccount =
  planAccountTemplate && agentKey
    ? { template: planAccountTemplate as Address, router: planAccountRouter }
    : null;
const passkeyFactoryAddress = process.env.PASSKEY_FACTORY_ADDRESS?.trim();
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const passkeyFactoryPreview =
  passkeyFactoryAddress && planBookAddress
    ? createPasskeyAccountPreview({
        rpcUrl: process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org",
        factory: passkeyFactoryAddress as Address,
        planBook: planBookAddress as Address
      })
    : null;
const passkeyDailyLimit = Number(process.env.PASSKEY_SPONSOR_DAILY_LIMIT ?? "0");
const maxFeeText = process.env.PASSKEY_SPONSOR_MAX_FEE_WEI?.trim() ?? "";
const passkeyMaxFeeWei = /^[0-9]+$/.test(maxFeeText) ? BigInt(maxFeeText) : 0n;
const passkeyService =
  passkeyFactoryAddress &&
  planBookAddress &&
  agentKey &&
  telegramBotToken &&
  passkeyDailyLimit > 0 &&
  passkeyMaxFeeWei > 0n
    ? createPasskeyAccountService({
        rpcUrl: process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org",
        factory: passkeyFactoryAddress as Address,
        planBook: planBookAddress as Address,
        sponsorKey: asKey(agentKey),
        dailyLimit: passkeyDailyLimit,
        maxFeeWei: passkeyMaxFeeWei,
        ledger: store
      })
    : null;
const passkeyPreview = passkeyService?.preview ?? passkeyFactoryPreview;
const tokenPoolCache = new Map<string, Address | null>();
const permissionTrader =
  process.env.EXECUTION_ENABLED === "true" && planAccount && agentKey
    ? new PlanAccountTrader({
        rpcUrl: process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org",
        privateKey: asKey(agentKey),
        template: planAccount.template,
        router: planAccount.router,
        poolForToken: async (token) => {
          const key = token.toLowerCase();
          if (tokenPoolCache.has(key)) return tokenPoolCache.get(key)!;
          let found: Address | null = null;
          for (const ticker of Object.keys(poolMap)) {
            const listed = await listedBstock(rawRoot, ticker);
            if (listed?.address.toLowerCase() === key) {
              found = (poolMap[ticker]?.address as Address | undefined) ?? null;
              break;
            }
          }
          tokenPoolCache.set(key, found);
          return found;
        }
      })
    : null;
let rwaTokenAddresses: Promise<string[]> | null = null;
const allBscRwaTokenAddresses = (): Promise<string[]> => {
  if (rwaTokenAddresses !== null) return rwaTokenAddresses;
  const loading = Promise.all(
    ([1, 2, 3] as const).map(async (type) => {
      const record = await fetchRwaList(type);
      await storeRawRecord(rawRoot, `binance-rwa-list-type-${type}`, record);
      return parseRwaList(record, type)
        .filter((token) => token.chainId === "56")
        .map((token) => token.contractAddress);
    })
  ).then((lists) => [...new Set(lists.flat())]);
  rwaTokenAddresses = loading.catch((error: unknown) => {
    rwaTokenAddresses = null;
    throw error;
  });
  return rwaTokenAddresses;
};
// Each locked plan becomes an ERC-8183 job only when a separate team buyer wallet is set.
const buyerKey = process.env.JOB_BUYER_PRIVATE_KEY?.trim();
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
  permissionTrader,
  ...(planAccount === null ? {} : { planAccount }),
  jobs,
  teamJobLimit: Number(process.env.TEAM_JOB_LIMIT ?? "0"),
  signedDailyCap: Number(process.env.SIGNED_PLAN_DAILY_CAP ?? "20"),
  latestPrice: (ticker) => store.latestPrice(ticker),
  listedToken: (ticker) => listedBstock(rawRoot, ticker),
  officialOpen: (ticker, date) => nasdaqOfficialOpen(rawRoot, ticker, date),
  ...(planChain && (trader || permissionTrader)
    ? {
        reconcileWindow: async (plans, event) =>
          reconcilePlanWindow(plans, event, {
            rpcUrl:
              process.env.BSC_RPC_URL_LOGS?.trim() ||
              process.env.BSC_RPC_URL_ARCHIVE?.trim() ||
              process.env.BSC_RPC_URL_LIVE?.trim() ||
              "https://bsc-dataseed.bnbchain.org",
            walletAddress: trader ? await trader.address() : planChain.agentAddress,
            stockTokenAddresses: await allBscRwaTokenAddresses()
          })
      }
    : {})
});
store.setPlanActions({
  lock: (id) => planService.lock(id),
  cancel: (id) => planService.cancel(id),
  startStanding: (input) => planService.startStanding(input),
  stopStanding: (id) => planService.stopStanding(id)
});
planService.start();
// /wallet shows the Agentic Wallet as the wallet tool reports it, checked every 5 minutes.
if (trader) {
  const refreshWallet = async () => store.recordWallet(await walletStatus(trader));
  void refreshWallet();
  setInterval(() => void refreshWallet(), 5 * 60 * 1000).unref();
}
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
// The MCP tools and the A2A skills read the same sources; none of them writes anything.
const readSources = {
  prices: (tickers: string[]) => store.prices(tickers),
  windows: (ticker: string) => store.windows(ticker),
  record: () => store.record(),
  planGet: (id: string) => store.planGet(id),
  receipt: (id: string) => store.receipt(id),
  preview: (input: Record<string, unknown>) => planService.preview(input)
};
const AGENT_VERSION = "0.1.0";
// The A2A card names the public address when there is one; until then, this server.
const a2a = createA2aHandler(
  readSources,
  process.env.PUBLIC_AGENT_URL?.trim() || `http://localhost:${port}`,
  AGENT_VERSION
);
// The site's night strip: the 24/7 price through one window, with that session's close.
const night = createNightService({
  candles: (ticker, interval, startMs, endMs) =>
    xyzCandles(rawRoot, ticker, interval, startMs, endMs),
  close: async (ticker, nyDate) => {
    // The price service already holds tonight's close, often before the daily history has it.
    const latest = await store.latestPrice(ticker);
    if (latest?.close.date === nyDate) {
      return { value: latest.close.value, date: nyDate, source: latest.close.source };
    }
    return nasdaqCloseOn(rawRoot, ticker, nyDate);
  }
});
// Built after x402 starts, so the card states what is actually live.
const identityConfig = identityConfigFromEnv(process.env, planChain?.agentAddress ?? null);
const identity =
  identityConfig === null
    ? undefined
    : buildIdentityCard({ ...identityConfig, x402Support: x402?.paid === true, a2a: true });
const server = startAgentServer(
  store,
  {
    ownerToken,
    siteOrigin,
    identity,
    ...(x402 ? { x402 } : {}),
    a2a,
    night,
    preview: (input) => planService.preview(input),
    previewStanding: (input) => planService.previewStanding(input),
    passkeyStatus: () => {
      const rpId = process.env.PASSKEY_RP_ID?.trim() ?? "";
      const factory = process.env.PASSKEY_FACTORY_ADDRESS?.trim() ?? "";
      const telegram = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
      const available =
        rpId.length > 0 &&
        factory.length > 0 &&
        telegram.length > 0 &&
        passkeyPreview !== null &&
        passkeyService !== null;
      return {
        available,
        rpId,
        factory: factory || null,
        reason: available
          ? null
          : "RP ID, factory deployment, PlanBook binding, Telegram verification, sponsor key and explicit fee/daily caps must all be configured."
      };
    },
    ...(passkeyPreview && telegramBotToken
      ? {
          passkeyPreview,
          telegramBotToken,
          telegramInitDataMaxAgeSeconds: Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_S ?? "3600")
        }
      : {}),
    ...(passkeyService && telegramBotToken ? { passkeyCreate: passkeyService.create } : {}),
    lockSigned: (body) => planService.lockSigned(body),
    mcp: createMcpHandler(readSources, AGENT_VERSION)
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
