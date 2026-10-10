import { execFileSync } from "node:child_process";
import { BinanceWeb3Client } from "@redeye/clients";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { web3B402Transport } from "./b402-web3.js";
import { FakeDatabase } from "./fake-database.js";
import { SqliteAgentStore } from "./sqlite-store.js";
import type { AgentRequest } from "./types.js";
import { createX402Seller } from "./x402-sales.js";

// Live B402 sale through the signed Web3 gateway, with the Binance Agentic Wallet as buyer.
// Off unless REDEYE_B402_LIVE is set:
//   preview  builds the 402, asks the Agentic Wallet to preview it; signs and moves nothing
//   pay      also signs with the Agentic Wallet and sends verify and settle to Binance
// It runs the seller in this process only; the running agent is not touched.
const MODE = process.env.REDEYE_B402_LIVE;
const AGENT = "0xe201bbf3C736a5d188797974a7e4B9464f707eA8";
const API = "https://api.theredeyed-agent.site";

function get(pathname: string, headers: Record<string, string> = {}): AgentRequest {
  return { method: "GET", pathname, query: new URLSearchParams(), headers: new Headers(headers) };
}

function baw(args: string[]): Record<string, unknown> {
  const out = execFileSync("baw", [...args, "--json"], { encoding: "utf8", timeout: 120_000 });
  const parsed = JSON.parse(out) as { success?: boolean; data?: Record<string, unknown> };
  if (parsed.success === false) throw new Error(`baw ${args[1]} failed: ${out.slice(0, 500)}`);
  return parsed.data ?? (parsed as Record<string, unknown>);
}

describe.skipIf(MODE !== "preview" && MODE !== "pay")("live B402 sale (REDEYE_B402_LIVE)", () => {
  it("sells the NVDA 24/7 price to the Agentic Wallet through Binance B402", async () => {
    const client = new BinanceWeb3Client({
      apiKey: process.env.BINANCE_WEB3_API_KEY ?? "",
      secret: process.env.BINANCE_WEB3_API_SECRET ?? "",
      onCall: (call) => console.log(JSON.stringify({ b402Call: call }))
    });
    // Print every answer Binance gives, in full, so a live run leaves its own evidence.
    const inner = web3B402Transport(client);
    const transport: typeof inner = {
      supported: inner.supported,
      verify: async (request) => {
        const answer = await inner.verify(request);
        console.log(JSON.stringify({ verifyAnswer: answer }));
        return answer;
      },
      settle: async (request) => {
        let answer = await inner.settle(request);
        console.log(JSON.stringify({ at: new Date().toISOString(), settleAnswer: answer }));
        // Diagnostic only: an empty transaction means nothing was broadcast, and the payment's
        // own EIP-3009 nonce stops it moving twice, so one later retry is safe to try.
        if (
          process.env.REDEYE_B402_RETRY === "1" &&
          !answer.success &&
          answer.transaction === "" &&
          answer.errorReason === "invalid_transaction_state"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          answer = await inner.settle(request);
          console.log(JSON.stringify({ at: new Date().toISOString(), settleRetryAnswer: answer }));
        }
        return answer;
      }
    };
    const seller = await createX402Seller({
      settlement: {
        kind: "b402-web3",
        transport,
        replayStore: new SqliteAgentStore(new FakeDatabase()).replayStore(),
        onSettlementUnknown: (event) => console.log(JSON.stringify({ settlementUnknown: event }))
      },
      payTo: AGENT,
      publicUrl: API,
      content: {
        // The real public price snapshot, read from the live agent's free endpoint.
        price: async (ticker) => {
          const response = await fetch(`${API}/prices?tickers=${ticker}`);
          return response.ok ? ((await response.json()) as unknown) : null;
        },
        window: async () => null,
        record: async () => null
      }
    });
    expect(seller).toMatchObject({ paid: true, settledBy: "b402-web3" });

    const challenge = await seller.handle(get("/x402/price/NVDA"));
    expect(challenge.status).toBe(402);
    const header = challenge.headers["PAYMENT-REQUIRED"]!;
    console.log(JSON.stringify({ paymentRequired: decodePaymentRequiredHeader(header) }, null, 2));

    const preview = baw(["x402-payment", "preview", "--paymentRequirements", header]);
    console.log(JSON.stringify({ preview }, null, 2));
    if (MODE !== "pay") return;

    const options = (preview.options ?? []) as Array<Record<string, unknown>>;
    const index = options.findIndex((o) => o.status === "READY_TO_SIGN");
    expect(index).toBeGreaterThanOrEqual(0);
    const signed = baw([
      "x402-payment",
      "sign",
      "--paymentId",
      String(preview.paymentId),
      "--selectedIndex",
      String(options[index]!.index ?? index)
    ]);
    // What the wallet signed: the EIP-3009 window and nonce, against the local clock.
    const signedPayload = JSON.parse(
      Buffer.from(String(signed.paymentHeaderValue), "base64").toString("utf8")
    ) as { payload?: { authorization?: Record<string, string> } };
    const auth = signedPayload.payload?.authorization ?? {};
    console.log(
      JSON.stringify({
        signedAt: new Date().toISOString(),
        nowSeconds: Math.floor(Date.now() / 1000),
        authorization: {
          from: auth.from,
          to: auth.to,
          value: auth.value,
          validAfter: auth.validAfter,
          validBefore: auth.validBefore,
          nonce: auth.nonce
        }
      })
    );
    const paid = await seller.handle(
      get("/x402/price/NVDA", {
        [String(signed.paymentHeaderName ?? "PAYMENT-SIGNATURE")]: String(signed.paymentHeaderValue)
      })
    );
    console.log(JSON.stringify({ status: paid.status, body: paid.body }, null, 2));
    expect(paid.status).toBe(200);
    const settlement = decodePaymentResponseHeader(paid.headers["PAYMENT-RESPONSE"]!);
    console.log(JSON.stringify({ settlement }, null, 2));
    expect(settlement).toMatchObject({ success: true });
  }, 180_000);
});
