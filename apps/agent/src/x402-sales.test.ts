import { B402ExactClientScheme } from "@bnb-chain/b402/client";
import type { B402Transport } from "@bnb-chain/b402/server";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader
} from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { FakeDatabase } from "./fake-database.js";
import { SqliteAgentStore } from "./sqlite-store.js";
import type { AgentRequest } from "./types.js";
import {
  createX402Seller,
  storeContent,
  usdToAtomic,
  X402_ASSET,
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

function replay() {
  return new SqliteAgentStore(new FakeDatabase()).replayStore();
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
      transport: new FakeB402(),
      payTo: AGENT,
      content,
      replayStore: replay()
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
    const b402 = new FakeB402();
    const seller = await createX402Seller({
      transport: b402,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const paid = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await paymentFor(challenge.headers) })
    );

    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ ticker: "NVDA", real: "237.5" });
    expect(b402.verified).toBe(1);
    expect(b402.settled).toHaveLength(1);
    expect(b402.settled[0]!.paymentRequirements).toMatchObject({
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
      transport: new FakeB402(),
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    const response = await seller.handle(get("/x402/window/NVDA"));
    const required = decodePaymentRequiredHeader(response.headers["PAYMENT-REQUIRED"]!);
    expect(required.accepts[0]!.amount).toBe("10000000000000000");
  });

  it("never charges for a ticker it has nothing on", async () => {
    const b402 = new FakeB402();
    const seller = await createX402Seller({
      transport: b402,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    const response = await seller.handle(get("/x402/price/ZZZZ"));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "NOTHING_TO_SELL" } });
    expect(b402.settled).toHaveLength(0);
  });

  it("refuses a payment that does not verify and settles nothing", async () => {
    const b402 = new FakeB402();
    const seller = await createX402Seller({
      transport: b402,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    b402.valid = false;
    const response = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await paymentFor(challenge.headers) })
    );
    expect(response.status).toBe(402);
    expect(b402.settled).toHaveLength(0);
  });

  it("does not hand over the answer when settlement fails", async () => {
    const b402 = new FakeB402();
    const seller = await createX402Seller({
      transport: b402,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    b402.settles = false;
    const response = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await paymentFor(challenge.headers) })
    );
    expect(response.status).toBe(402);
    expect(response.body).not.toEqual({ ticker: "NVDA", real: "237.5" });
  });

  it("serves the record for free", async () => {
    const seller = await createX402Seller({
      transport: null,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    expect(await seller.handle(get("/x402/record/plan-1"))).toMatchObject({
      status: 200,
      body: { id: "plan-1", outcome: "kept" }
    });
    expect((await seller.handle(get("/x402/record/nope"))).status).toBe(404);
  });

  it("keeps paid routes off, with the reason, until B402 is configured", async () => {
    const seller = await createX402Seller({
      transport: null,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    expect(seller.paid).toBe(false);
    expect(await seller.handle(get("/x402/price/NVDA"))).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "X402_NOT_CONFIGURED",
          reason: "No B402 merchant credentials are configured."
        }
      }
    });
  });

  it("keeps paid routes off when B402 does not list U on BNB Chain", async () => {
    const b402 = new FakeB402();
    b402.listsU = false;
    const seller = await createX402Seller({
      transport: b402,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    expect(seller.paid).toBe(false);
    expect(seller.reason).toBe("B402 does not list U by EIP-3009 on eip155:56.");
  });

  it("settles a payment once even when the same signature is sent again", async () => {
    const b402 = new FakeB402();
    const seller = await createX402Seller({
      transport: b402,
      payTo: AGENT,
      content,
      replayStore: replay()
    });
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const signature = await paymentFor(challenge.headers);
    const first = await seller.handle(get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": signature }));
    const again = await seller.handle(get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": signature }));

    expect(first.status).toBe(200);
    expect(again.status).not.toBe(200);
    expect(b402.settled).toHaveLength(1);
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
