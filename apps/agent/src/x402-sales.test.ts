import { B402ExactClientScheme } from "@bnb-chain/b402/client";
import type { B402Transport } from "@bnb-chain/b402/server";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader
} from "@x402/core/http";
import { toClientEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { FakeDatabase } from "./fake-database.js";
import { SqliteAgentStore } from "./sqlite-store.js";
import type { AgentRequest } from "./types.js";
import { web3B402Transport } from "./b402-web3.js";
import { BinanceWeb3Client, signWeb3Request } from "@redeye/clients";
import {
  createX402Seller,
  storeContent,
  usdToAtomic,
  X402_ASSET,
  X402_ASSET_VERSION,
  X402_NETWORK,
  type X402Content
} from "./x402-sales.js";

const AGENT = "0xe201bbf3C736a5d188797974a7e4B9464f707eA8";
const SIGNER = "0x5f77eE41BaffDAe61830eF9be76541444FAE5D11";
const TX = `0x${"ab".repeat(32)}`;

type SettleRequest = Parameters<B402Transport["settle"]>[0];

function payerOf(request: SettleRequest): string {
  const payload = request.paymentPayload.payload as { authorization?: { from?: string } };
  return payload.authorization?.from ?? "";
}

/** Stands in for Binance B402, answering in the shapes the official package uses. */
class FakeB402 implements B402Transport {
  readonly settled: SettleRequest[] = [];
  verified = 0;
  valid = true;
  settles = true;
  listsU = true;

  async supported() {
    return {
      extensions: [],
      kinds: this.listsU
        ? [
            {
              x402Version: 2,
              scheme: "exact",
              network: X402_NETWORK,
              extra: {
                assetTransferMethod: "eip3009",
                name: "United Stables",
                version: "1",
                signerAddress: SIGNER
              }
            }
          ]
        : [],
      signers: { "eip155:*": [SIGNER] }
    } as Awaited<ReturnType<B402Transport["supported"]>>;
  }

  async verify(request: SettleRequest) {
    this.verified += 1;
    const payer = payerOf(request);
    return this.valid
      ? { isValid: true, payer }
      : { isValid: false, invalidReason: "invalid_signature", payer };
  }

  async settle(request: SettleRequest) {
    this.settled.push(request);
    if (!this.settles) {
      return {
        success: false,
        errorReason: "insufficient_funds",
        network: request.paymentRequirements.network,
        transaction: ""
      } as Awaited<ReturnType<B402Transport["settle"]>>;
    }
    return {
      success: true,
      amount: request.paymentRequirements.amount,
      network: request.paymentRequirements.network,
      payer: payerOf(request),
      transaction: TX
    } as Awaited<ReturnType<B402Transport["settle"]>>;
  }
}

const content: X402Content = {
  price: async (ticker) => (ticker === "NVDA" ? { ticker, real: "237.5" } : null),
  window: async (ticker) => (ticker === "NVDA" ? { ticker, windows: [] } : null),
  record: async (id) => (id === "plan-1" ? { id, outcome: "kept" } : null)
};

function get(pathname: string, headers: Record<string, string> = {}): AgentRequest {
  return { method: "GET", pathname, query: new URLSearchParams(), headers: new Headers(headers) };
}

function b402(transport: FakeB402) {
  return {
    kind: "b402-merchant" as const,
    transport,
    replayStore: new SqliteAgentStore(new FakeDatabase()).replayStore()
  };
}

const buyer = privateKeyToAccount(generatePrivateKey());
const wallet = new x402Client().register(
  "eip155:*",
  new B402ExactClientScheme({ account: buyer, methods: ["eip3009"] })
);

async function paymentFor(challenge: Record<string, string>): Promise<string> {
  const required = decodePaymentRequiredHeader(challenge["PAYMENT-REQUIRED"]!);
  return encodePaymentSignatureHeader(await wallet.createPaymentPayload(required));
}

describe("usdToAtomic", () => {
  it("converts dollar prices to U atomic units exactly", () => {
    expect(usdToAtomic("0.002")).toBe("2000000000000000");
    expect(usdToAtomic("0.01")).toBe("10000000000000000");
    expect(usdToAtomic("1")).toBe("1000000000000000000");
    expect(() => usdToAtomic("-1")).toThrow("Bad price");
  });
});

describe("x402 seller", () => {
  it("asks for 0.002 U on BNB Chain, paid to the agent, before selling a price", async () => {
    const seller = await createX402Seller({
      settlement: b402(new FakeB402()),
      payTo: AGENT,
      content
    });
    expect(seller.paid).toBe(true);
    const response = await seller.handle(get("/x402/price/nvda"));
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers["PAYMENT-REQUIRED"]!);
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: X402_NETWORK,
        asset: X402_ASSET,
        amount: "2000000000000000",
        payTo: AGENT,
        extra: expect.objectContaining({ assetTransferMethod: "eip3009", name: "United Stables" })
      })
    ]);
    expect(response.headers["access-control-expose-headers"]).toContain("PAYMENT-REQUIRED");
  });

  it("verifies, settles, then answers with the settlement in PAYMENT-RESPONSE", async () => {
    const fake = new FakeB402();
    const seller = await createX402Seller({
      settlement: b402(fake),
      payTo: AGENT,
      content
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const paid = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await paymentFor(challenge.headers) })
    );

    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ ticker: "NVDA", real: "237.5" });
    expect(fake.verified).toBe(1);
    expect(fake.settled).toHaveLength(1);
    expect(fake.settled[0]!.paymentRequirements).toMatchObject({
      amount: "2000000000000000",
      payTo: AGENT
    });
    expect(decodePaymentResponseHeader(paid.headers["PAYMENT-RESPONSE"]!)).toMatchObject({
      success: true,
      transaction: TX
    });
  });

  it("prices the off-hours history at 0.01 U", async () => {
    const seller = await createX402Seller({
      settlement: b402(new FakeB402()),
      payTo: AGENT,
      content
    });
    const response = await seller.handle(get("/x402/window/NVDA"));
    const required = decodePaymentRequiredHeader(response.headers["PAYMENT-REQUIRED"]!);
    expect(required.accepts[0]!.amount).toBe("10000000000000000");
  });

  it("never charges for a ticker it has nothing on", async () => {
    const fake = new FakeB402();
    const seller = await createX402Seller({
      settlement: b402(fake),
      payTo: AGENT,
      content
    });
    const response = await seller.handle(get("/x402/price/ZZZZ"));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "NOTHING_TO_SELL" } });
    expect(fake.settled).toHaveLength(0);
  });

  it("refuses a payment that does not verify and settles nothing", async () => {
    const fake = new FakeB402();
    const seller = await createX402Seller({
      settlement: b402(fake),
      payTo: AGENT,
      content
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    fake.valid = false;
    const response = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await paymentFor(challenge.headers) })
    );
    expect(response.status).toBe(402);
    expect(fake.settled).toHaveLength(0);
  });

  it("does not hand over the answer when settlement fails", async () => {
    const fake = new FakeB402();
    const seller = await createX402Seller({
      settlement: b402(fake),
      payTo: AGENT,
      content
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    fake.settles = false;
    const response = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await paymentFor(challenge.headers) })
    );
    expect(response.status).toBe(402);
    expect(response.body).not.toEqual({ ticker: "NVDA", real: "237.5" });
  });

  it("serves the record for free", async () => {
    const seller = await createX402Seller({ settlement: null, payTo: AGENT, content });
    expect(await seller.handle(get("/x402/record/plan-1"))).toMatchObject({
      status: 200,
      body: { id: "plan-1", outcome: "kept" }
    });
    expect((await seller.handle(get("/x402/record/nope"))).status).toBe(404);
  });

  it("keeps paid routes off, with the reason, until B402 is configured", async () => {
    const seller = await createX402Seller({ settlement: null, payTo: AGENT, content });
    expect(seller.paid).toBe(false);
    expect(await seller.handle(get("/x402/price/NVDA"))).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "X402_NOT_CONFIGURED",
          reason: "No x402 settlement route is configured."
        }
      }
    });
  });

  it("keeps paid routes off when B402 does not list U on BNB Chain", async () => {
    const fake = new FakeB402();
    fake.listsU = false;
    const seller = await createX402Seller({
      settlement: b402(fake),
      payTo: AGENT,
      content
    });
    expect(seller.paid).toBe(false);
    expect(seller.reason).toBe("B402 does not list U by EIP-3009 on eip155:56.");
  });

  it("settles a payment once even when the same signature is sent again", async () => {
    const fake = new FakeB402();
    const seller = await createX402Seller({
      settlement: b402(fake),
      payTo: AGENT,
      content
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const signature = await paymentFor(challenge.headers);
    const first = await seller.handle(get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": signature }));
    const again = await seller.handle(get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": signature }));

    expect(first.status).toBe(200);
    expect(again.status).not.toBe(200);
    expect(fake.settled).toHaveLength(1);
  });
});

describe("storeContent", () => {
  const NOW = Date.parse("2026-10-08T03:00:00.000Z");
  const store = {
    latestPrice: async (ticker: string) =>
      ticker === "NVDA"
        ? { at: "2026-10-08T02:59:00.000Z" }
        : ticker === "TSLA"
          ? { at: "2026-10-08T02:50:00.000Z" }
          : null,
    windows: async (ticker: string) => ({
      ticker,
      items: ticker === "NVDA" ? [{ kind: "overnight" }] : []
    }),
    receipt: async (id: string) => {
      if (id !== "plan-1") throw new Error("RECEIPT_NOT_FOUND");
      return { id };
    }
  };
  const content = storeContent(store, 120_000, () => NOW);

  it("sells only a price from the last two minutes", async () => {
    expect(await content.price("NVDA")).toEqual({ at: "2026-10-08T02:59:00.000Z" });
    expect(await content.price("TSLA")).toBeNull();
    expect(await content.price("ZZZZ")).toBeNull();
  });

  it("sells windows only when there are some, and gives receipts that exist", async () => {
    expect(await content.window("NVDA")).toMatchObject({ items: [{ kind: "overnight" }] });
    expect(await content.window("TSLA")).toBeNull();
    expect(await content.record("plan-1")).toEqual({ id: "plan-1" });
    expect(await content.record("nope")).toBeNull();
  });
});

/**
 * Stands in for BNB Chain under the official x402 EVM facilitator, for the checks that run
 * before any chain call. Settling for real is covered by x402-fork.test.ts.
 */
class FakeChainSigner {
  readonly writes: Array<{ address: string; functionName: string; args: readonly unknown[] }> = [];
  readonly reads: string[] = [];
  balance = 10n ** 18n;
  nonceUsed = false;
  receiptStatus = "success";

  signer(): FacilitatorEvmSigner {
    return {
      getAddresses: () => [AGENT],
      readContract: async (args) => {
        this.reads.push(args.functionName);
        if (args.functionName === "balanceOf") return this.balance;
        if (args.functionName === "authorizationState") return this.nonceUsed;
        throw new Error(`unexpected read ${args.functionName}`);
      },
      verifyTypedData: async (args) =>
        verifyTypedData(args as unknown as Parameters<typeof verifyTypedData>[0]),
      writeContract: async (args) => {
        this.writes.push(args);
        return `0x${"cd".repeat(32)}` as Hex;
      },
      sendTransaction: async () => {
        throw new Error("unexpected sendTransaction");
      },
      waitForTransactionReceipt: async () => ({ status: this.receiptStatus }),
      // U is a deployed contract; the buyer is a plain wallet with no code.
      getCode: async ({ address }) => (address === X402_ASSET ? "0x6080" : undefined)
    };
  }
}

describe("x402 seller settling with the agent's own facilitator", () => {
  const selfBuyer = new x402Client().register(
    "eip155:*",
    new ExactEvmClient(toClientEvmSigner(buyer))
  );
  async function pay(challenge: Record<string, string>): Promise<string> {
    const required = decodePaymentRequiredHeader(challenge["PAYMENT-REQUIRED"]!);
    return encodePaymentSignatureHeader(await selfBuyer.createPaymentPayload(required));
  }
  function refusal(response: { headers: Record<string, string> }): string | undefined {
    const header = response.headers["PAYMENT-REQUIRED"];
    return header ? decodePaymentRequiredHeader(header).error : undefined;
  }
  async function sellerWith(chain: FakeChainSigner) {
    return createX402Seller({
      settlement: { kind: "self", signer: chain.signer() },
      payTo: AGENT,
      content
    });
  }

  it("asks for U by EIP-3009 with U's own domain name and version", async () => {
    const seller = await sellerWith(new FakeChainSigner());
    expect(seller).toMatchObject({ paid: true, settledBy: "self", reason: null });
    const response = await seller.handle(get("/x402/price/NVDA"));
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers["PAYMENT-REQUIRED"]!);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: X402_NETWORK,
      asset: X402_ASSET,
      amount: "2000000000000000",
      payTo: AGENT,
      extra: { assetTransferMethod: "eip3009", name: "United Stables", version: X402_ASSET_VERSION }
    });
  });

  it("refuses a signature that was not made by the payer", async () => {
    const chain = new FakeChainSigner();
    const seller = await sellerWith(chain);
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const header = await pay(challenge.headers);
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload: { authorization: { from: string } };
    };
    payload.payload.authorization.from = "0x000000000000000000000000000000000000dEaD";
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64");
    const response = await seller.handle(get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": forged }));
    expect(response.status).toBe(402);
    expect(refusal(response)).toBe("invalid_exact_evm_signature");
    expect(chain.writes).toHaveLength(0);
  });
});

describe("x402 seller settling through B402 on the signed Web3 gateway", () => {
  /** Plays the /build gateway: checks each request is signed, unwraps {body}, answers B402. */
  function gateway(fake: FakeB402) {
    const seen: Array<{ path: string; body: Record<string, unknown>; signed: boolean }> = [];
    const client = new BinanceWeb3Client({
      apiKey: "key",
      secret: "test-secret",
      fetch: (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        const raw = String(init.body);
        const headers = new Headers(init.headers);
        const signed =
          headers.get("X-OC-SIGN") ===
          signWeb3Request("test-secret", headers.get("X-OC-TIMESTAMP")!, "POST", path, raw);
        const body = JSON.parse(raw) as { body: Record<string, unknown> };
        seen.push({ path, body: body.body, signed });
        const inner = body.body as unknown as SettleRequest;
        const data = path.endsWith("/supported")
          ? await fake.supported()
          : path.endsWith("/verify")
            ? await fake.verify(inner)
            : await fake.settle(inner);
        return new Response(JSON.stringify({ code: "000000000", message: "success", data }), {
          status: 200
        });
      }) as typeof fetch
    });
    return { client, seen };
  }

  it("sells a price with supported, verify and settle all signed by the Web3 key", async () => {
    const fake = new FakeB402();
    const { client, seen } = gateway(fake);
    const seller = await createX402Seller({
      settlement: {
        kind: "b402-web3",
        transport: web3B402Transport(client),
        replayStore: new SqliteAgentStore(new FakeDatabase()).replayStore()
      },
      payTo: AGENT,
      content
    });
    expect(seller).toMatchObject({ paid: true, settledBy: "b402-web3", reason: null });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const paid = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await paymentFor(challenge.headers) })
    );
    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ ticker: "NVDA", real: "237.5" });
    expect(seen.map((s) => s.path)).toEqual([
      "/build/api/v2/b402/supported",
      "/build/api/v2/b402/verify",
      "/build/api/v2/b402/settle"
    ]);
    expect(seen.every((s) => s.signed)).toBe(true);
    expect(seen[0]!.body).toEqual({});
    expect(seen[2]!.body).toMatchObject({
      x402Version: 2,
      paymentRequirements: { amount: "2000000000000000", payTo: AGENT }
    });
    expect(fake.settled).toHaveLength(1);
  });

  it("keeps paid routes off, with the reason, when the key has no B402 permission", async () => {
    const client = new BinanceWeb3Client({
      apiKey: "key",
      secret: "test-secret",
      sleep: async () => undefined,
      fetch: (async () =>
        new Response(JSON.stringify({ msg: "No permission: B402", data: "", code: 40104 }), {
          status: 403
        })) as typeof fetch
    });
    const seller = await createX402Seller({
      settlement: {
        kind: "b402-web3",
        transport: web3B402Transport(client),
        replayStore: new SqliteAgentStore(new FakeDatabase()).replayStore()
      },
      payTo: AGENT,
      content
    });
    expect(seller.paid).toBe(false);
    expect(seller.reason).toContain("40104");
  });
});
