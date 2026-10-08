import { B402ExactServerScheme, B402FacilitatorClient } from "@bnb-chain/b402/server";
import type { B402ReplayStore, B402Transport } from "@bnb-chain/b402/server";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPAdapter,
  type RoutesConfig
} from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import { getAddress, type Address } from "viem";
import type { AgentRequest, AgentResponse } from "./types.js";

/** BNB Chain mainnet in x402's network naming. */
export const X402_NETWORK = "eip155:56" as const;
/** U on BNB Chain: 18 decimals, EIP-712 name "United Stables" (read on chain 2026-10-08). */
export const X402_ASSET = getAddress("0xce24439f2d9c6a2289f741120fe202248b666666");
export const X402_ASSET_NAME = "United Stables";
const ASSET_DECIMALS = 18;

/** Paid routes and their prices in US dollars, from the spec. */
export const X402_PRICES = {
  price: "0.002",
  window: "0.01"
} as const;

export interface X402Content {
  /** Returns null when there is nothing to sell, so the buyer is never charged for it. */
  price(ticker: string): Promise<unknown | null>;
  window(ticker: string): Promise<unknown | null>;
  record(id: string): Promise<unknown | null>;
}

export interface X402ContentStore {
  latestPrice(ticker: string): Promise<{ at: string } | null>;
  windows(ticker: string): Promise<unknown>;
  receipt(id: string): Promise<unknown>;
}

/**
 * What the seller sells, read from the agent's store. A price older than `maxAgeMs` is not
 * live, so it is not sold; a ticker with no windows and an unknown receipt give nothing.
 */
export function storeContent(
  store: X402ContentStore,
  maxAgeMs: number,
  now: () => number = Date.now
): X402Content {
  return {
    price: async (ticker) => {
      const price = await store.latestPrice(ticker);
      return price && now() - Date.parse(price.at) <= maxAgeMs ? price : null;
    },
    window: async (ticker) => {
      const windows = (await store.windows(ticker)) as { items?: unknown[] };
      return Array.isArray(windows.items) && windows.items.length > 0 ? windows : null;
    },
    record: async (id) => store.receipt(id).catch(() => null)
  };
}

export interface X402SellerOptions {
  /** Binance B402 transport; null while no merchant credentials are configured. */
  transport: B402Transport | null;
  payTo: Address;
  content: X402Content;
  /** Durable store that stops one payment from being settled twice. */
  replayStore: B402ReplayStore;
  /** Called when a settlement may already be on chain but its result was lost. */
  onSettlementUnknown?: (event: unknown) => void;
}

export interface X402Seller {
  /** True once B402 is configured and its supported list has U by EIP-3009 on BNB Chain. */
  readonly paid: boolean;
  /** Why paid routes are off, or null when they are on. */
  readonly reason: string | null;
  handle(request: AgentRequest): Promise<AgentResponse>;
}

/** Whole dollars to U atomic units, exactly. */
export function usdToAtomic(usd: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(usd);
  if (!match) throw new Error(`Bad price: ${usd}`);
  const fraction = (match[2] ?? "").padEnd(ASSET_DECIMALS, "0");
  if (fraction.length > ASSET_DECIMALS) throw new Error(`Too many decimals: ${usd}`);
  return (BigInt(match[1]!) * 10n ** BigInt(ASSET_DECIMALS) + BigInt(fraction)).toString();
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    ...extra
  };
}

function reply(status: number, body: unknown, extra?: Record<string, string>): AgentResponse {
  return { status, headers: headers(extra), body };
}

function adapter(request: AgentRequest): HTTPAdapter {
  return {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => request.pathname,
    getUrl: () => `https://redeye.local${request.pathname}`,
    getAcceptHeader: () => request.headers.get("accept") ?? "application/json",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(request.query.entries())
  };
}

/**
 * Sells the 24/7 price and off-hours history over x402, settled through Binance B402 in U.
 * Each answer is prepared before the payment is settled, so nobody pays for a missing
 * ticker; the payment is settled before the answer is sent.
 */
export async function createX402Seller(options: X402SellerOptions): Promise<X402Seller> {
  let http: x402HTTPResourceServer | null = null;
  let reason: string | null = null;
  if (options.transport === null) {
    reason = "No B402 merchant credentials are configured.";
  } else {
    const facilitator = new B402FacilitatorClient({
      client: options.transport,
      store: options.replayStore,
      ...(options.onSettlementUnknown ? { onSettlementUnknown: options.onSettlementUnknown } : {})
    });
    try {
      const supported = await facilitator.getSupported();
      const kind = supported.kinds.find(
        (candidate) =>
          candidate.network === X402_NETWORK &&
          candidate.scheme === "exact" &&
          candidate.extra?.["assetTransferMethod"] === "eip3009" &&
          candidate.extra?.["name"] === X402_ASSET_NAME
      );
      if (kind === undefined) {
        reason = `B402 does not list U by EIP-3009 on ${X402_NETWORK}.`;
      } else {
        http = await paidServer(facilitator, options.payTo, String(kind.extra!["version"]));
      }
    } catch (error) {
      reason = `B402 is unreachable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function content(kind: string, id: string): Promise<unknown | null> {
    if (kind === "price") return options.content.price(id.toUpperCase());
    if (kind === "window") return options.content.window(id.toUpperCase());
    return null;
  }

  return {
    paid: http !== null,
    reason,
    async handle(request) {
      const [, kind, id, ...rest] = request.pathname.split("/").filter(Boolean);
      if (request.method !== "GET" || id === undefined || rest.length > 0) {
        return reply(404, { error: { code: "NOT_FOUND", reason: "Unknown x402 route." } });
      }
      if (kind === "record") {
        const body = await options.content.record(id);
        return body === null
          ? reply(404, { error: { code: "RECORD_NOT_FOUND", reason: "No such record." } })
          : reply(200, body);
      }
      if (kind !== "price" && kind !== "window") {
        return reply(404, { error: { code: "NOT_FOUND", reason: "Unknown x402 route." } });
      }
      if (http === null) {
        return reply(503, { error: { code: "X402_NOT_CONFIGURED", reason } });
      }
      const body = await content(kind, id);
      if (body === null) {
        return reply(404, { error: { code: "NOTHING_TO_SELL", reason: `No ${kind} for ${id}.` } });
      }
      const context = {
        adapter: adapter(request),
        path: request.pathname,
        method: request.method
      };
      const result = await http.processHTTPRequest(context);
      if (result.type === "payment-error") {
        const { status, headers: extra, body: errorBody } = result.response;
        return reply(status, errorBody ?? {}, extra);
      }
      if (result.type === "no-payment-required") return reply(200, body);
      const settled = await http.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions
      );
      if (!settled.success) {
        const { status, headers: extra, body: errorBody } = settled.response;
        return reply(status, errorBody ?? {}, extra);
      }
      return reply(200, body, settled.headers);
    }
  };
}

async function paidServer(
  facilitator: B402FacilitatorClient,
  payTo: Address,
  version: string
): Promise<x402HTTPResourceServer> {
  const scheme = new B402ExactServerScheme({ facilitator });
  const server = new x402ResourceServer(facilitator).register("eip155:*", scheme);
  const accepts = (usd: string): PaymentOption => ({
    scheme: "exact",
    network: X402_NETWORK,
    payTo,
    price: { amount: usdToAtomic(usd), asset: X402_ASSET },
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009", name: X402_ASSET_NAME, version }
  });
  const routes: RoutesConfig = {
    "GET /x402/price/[ticker]": {
      accepts: accepts(X402_PRICES.price),
      description:
        "Redeye 24/7 price for a tokenized US stock: last close, live 24/7 price, token price, gaps, ages and sources.",
      mimeType: "application/json"
    },
    "GET /x402/window/[ticker]": {
      accepts: accepts(X402_PRICES.window),
      description:
        "Redeye off-hours history for a tokenized US stock against the next official open.",
      mimeType: "application/json"
    }
  };
  const http = new x402HTTPResourceServer(server, routes);
  await http.initialize();
  return http;
}
