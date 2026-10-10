import { B402ExactServerScheme, B402FacilitatorClient } from "@bnb-chain/b402/server";
import type { B402ReplayStore, B402Transport } from "@bnb-chain/b402/server";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type RoutesConfig
} from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentOption } from "@x402/core/http";
import type { SchemeNetworkServer } from "@x402/core/types";
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http as httpTransport,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import type { AgentRequest, AgentResponse } from "./types.js";

/** BNB Chain mainnet in x402's network naming. */
export const X402_NETWORK = "eip155:56" as const;
/**
 * U on BNB Chain: 18 decimals, EIP-3009, EIP-712 domain name "United Stables" version "1".
 * Read on chain 2026-10-08: the version is the one whose domain separator equals U's
 * DOMAIN_SEPARATOR(), since U has no eip712Domain().
 */
export const X402_ASSET = getAddress("0xce24439f2d9c6a2289f741120fe202248b666666");
export const X402_ASSET_NAME = "United Stables";
export const X402_ASSET_VERSION = "1";
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

/**
 * How payments are verified and settled.
 * "self": the official x402 EVM facilitator runs inside the agent; the agent wallet submits
 * the buyer's signed U transfer to the token itself and pays the gas.
 * "b402-web3": Binance B402 through the signed Web3 API gateway (/build/api/v2/b402), with the
 * same API key and HMAC signing as the other Web3 API modules.
 * "b402-merchant": Binance B402 through the separate merchant (OnchainPay) facilitator, with
 * merchant credentials and an RSA key from its onboarding.
 */
export type X402Settlement =
  | { kind: "self"; signer: FacilitatorEvmSigner }
  | {
      kind: "b402-web3" | "b402-merchant";
      transport: B402Transport;
      /** Durable store that stops one payment from being settled twice. */
      replayStore: B402ReplayStore;
      /** Called when a settlement may already be on chain but its result was lost. */
      onSettlementUnknown?: (event: unknown) => void;
    };

export interface X402SellerOptions {
  /** Public base URL of the agent, used as the paid resource's address. */
  publicUrl?: string;
  /** Null keeps paid routes off. */
  settlement: X402Settlement | null;
  payTo: Address;
  content: X402Content;
}

export interface X402Seller {
  /** True once a settlement route is ready for U by EIP-3009 on BNB Chain. */
  readonly paid: boolean;
  /** Which route settles payments, or null when paid routes are off. */
  readonly settledBy: X402Settlement["kind"] | null;
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

function adapter(request: AgentRequest, base: string): HTTPAdapter {
  return {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => request.pathname,
    getUrl: () => `${base}${request.pathname}`,
    getAcceptHeader: () => request.headers.get("accept") ?? "application/json",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(request.query.entries())
  };
}

/**
 * Sells the 24/7 price and off-hours history over x402 in U on BNB Chain.
 * Each answer is prepared before the payment is settled, so nobody pays for a missing
 * ticker; the payment is settled before the answer is sent.
 */
export async function createX402Seller(options: X402SellerOptions): Promise<X402Seller> {
  const publicBase = (options.publicUrl ?? "https://api.theredeyed-agent.site").replace(/\/$/, "");
  let http: x402HTTPResourceServer | null = null;
  let reason: string | null = null;
  const settlement = options.settlement;
  if (settlement === null) {
    reason = "No x402 settlement route is configured.";
  } else if (settlement.kind === "self") {
    http = await paidServer(
      selfFacilitator(settlement.signer),
      new ExactEvmScheme(),
      options.payTo
    );
  } else {
    const facilitator = new B402FacilitatorClient({
      client: settlement.transport,
      store: settlement.replayStore,
      ...(settlement.onSettlementUnknown
        ? { onSettlementUnknown: settlement.onSettlementUnknown }
        : {})
    });
    try {
      const supported = await facilitator.getSupported();
      const listed = supported.kinds.some(
        (candidate) =>
          candidate.network === X402_NETWORK &&
          candidate.scheme === "exact" &&
          candidate.extra?.["assetTransferMethod"] === "eip3009" &&
          candidate.extra?.["name"] === X402_ASSET_NAME &&
          candidate.extra?.["version"] === X402_ASSET_VERSION
      );
      if (!listed) {
        reason = `B402 does not list U by EIP-3009 on ${X402_NETWORK}.`;
      } else {
        http = await paidServer(
          facilitator,
          new B402ExactServerScheme({ facilitator }),
          options.payTo
        );
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
    settledBy: http === null ? null : settlement!.kind,
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
        adapter: adapter(request, publicBase),
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

/**
 * The agent wallet as an x402 facilitator signer on BNB Chain: it checks buyer signatures
 * and submits their signed U transfers, paying the gas.
 */
export function agentFacilitatorSigner(rpcUrl: string, privateKey: Hex): FacilitatorEvmSigner {
  const account = privateKeyToAccount(privateKey);
  const transport = httpTransport(rpcUrl, { timeout: 30_000, retryCount: 2 });
  const reader = createPublicClient({ chain: bsc, transport });
  const writer = createWalletClient({ account, chain: bsc, transport });
  return toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => reader.readContract(args as Parameters<typeof reader.readContract>[0]),
    verifyTypedData: (args) =>
      reader.verifyTypedData(args as Parameters<typeof reader.verifyTypedData>[0]),
    writeContract: (args) =>
      writer.writeContract({
        ...(args as Parameters<typeof writer.writeContract>[0]),
        account,
        chain: bsc
      }),
    sendTransaction: (args) => writer.sendTransaction({ ...args, account, chain: bsc }),
    waitForTransactionReceipt: (args) =>
      reader.waitForTransactionReceipt({ ...args, timeout: 120_000 }),
    getCode: (args) => reader.getCode(args)
  });
}

/** The official x402 EVM facilitator for BNB Chain, run in process with the agent's signer. */
function selfFacilitator(signer: FacilitatorEvmSigner): FacilitatorClient {
  const facilitator = registerExactEvmScheme(new x402Facilitator(), {
    signer,
    networks: X402_NETWORK
  });
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // Same data; core types the facilitator's network field as a plain string.
    getSupported: async () =>
      facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>
  };
}

async function paidServer(
  facilitator: FacilitatorClient,
  scheme: SchemeNetworkServer,
  payTo: Address
): Promise<x402HTTPResourceServer> {
  const server = new x402ResourceServer(facilitator).register("eip155:*", scheme);
  const accepts = (usd: string): PaymentOption => ({
    scheme: "exact",
    network: X402_NETWORK,
    payTo,
    price: { amount: usdToAtomic(usd), asset: X402_ASSET },
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: "eip3009",
      name: X402_ASSET_NAME,
      version: X402_ASSET_VERSION
    }
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
