import { describe, expect, it } from "vitest";
import {
  BinanceWeb3Client,
  signWeb3Request,
  Web3ApiError,
  web3Query,
  type Web3CallRecord
} from "./web3api.js";

// Vectors computed with openssl, independently of this code:
// printf '%s' "<prehash>" | openssl dgst -sha256 -hmac test-secret -binary | base64
const TS = "2026-05-11T10:08:57.715Z";

describe("signWeb3Request", () => {
  it("signs a GET with the /build prefix and the query as sent", () => {
    expect(
      signWeb3Request(
        "test-secret",
        TS,
        "get",
        "/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT",
        ""
      )
    ).toBe("+e4H3erFq96IQ1yTqE+vjaHHmLdSy+rOmPqIo2kR5OA=");
  });

  it("signs a POST over the exact body", () => {
    expect(
      signWeb3Request(
        "test-secret",
        TS,
        "POST",
        "/build/api/v1/dex/market/price",
        '[{"binanceChainId":"56","tokenContractAddress":"0xabc"}]'
      )
    ).toBe("3fd4Mk1jN/vpXLqc3QJ2NDeiUOpbEJg8aZR1aqYDDsA=");
  });
});

describe("web3Query", () => {
  it("drops unset values and percent-encodes once", () => {
    expect(web3Query({ a: "x y", b: undefined, c: 56 })).toBe("?a=x%20y&c=56");
    expect(web3Query({})).toBe("");
  });
});

interface Sent {
  url: string;
  init: RequestInit;
}

function harness(
  answers: Array<{ status: number; body: unknown; headers?: Record<string, string> }>
) {
  const sent: Sent[] = [];
  const calls: Web3CallRecord[] = [];
  const sleeps: number[] = [];
  let clock = Date.parse(TS);
  let n = 0;
  const client = new BinanceWeb3Client({
    apiKey: "key",
    secret: "test-secret",
    now: () => clock,
    nonce: () => `nonce-${++n}`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onCall: (call) => calls.push(call),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      clock += 40;
      const answer = answers.shift();
      if (!answer) throw new Error("no answer left");
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: answer.headers ?? {}
      });
    }) as typeof fetch
  });
  return { client, sent, calls, sleeps };
}

const header = (s: Sent, name: string) => (s.init.headers as Record<string, string>)[name];

describe("BinanceWeb3Client", () => {
  it("sends the signed headers and returns data from a code 0 envelope", async () => {
    const h = harness([
      { status: 200, body: { code: 0, msg: "", data: [{ x: 1 }], timestamp: 5, success: true } }
    ]);
    const result = await h.client.get<Array<{ x: number }>>("rwa", "/api/v1/dex/market/rwa/price", {
      binanceChainId: "56",
      tokenContractAddresses: "0xa,0xb"
    });
    expect(result.data).toEqual([{ x: 1 }]);
    const s = h.sent[0]!;
    expect(s.url).toBe(
      "https://web3.binance.com/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xa%2C0xb"
    );
    expect(header(s, "X-OC-APIKEY")).toBe("key");
    expect(header(s, "X-OC-TIMESTAMP")).toBe(TS);
    expect(header(s, "X-OC-NONCE")).toBe("nonce-1");
    expect(header(s, "X-OC-SIGN")).toBe(
      signWeb3Request(
        "test-secret",
        TS,
        "GET",
        "/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xa%2C0xb",
        ""
      )
    );
    expect(h.calls).toEqual([
      expect.objectContaining({
        module: "rwa",
        path: "/api/v1/dex/market/rwa/price",
        code: 0,
        ok: true,
        latencyMs: 40
      })
    ]);
    // Credentials never reach the call record.
    expect(JSON.stringify(h.calls)).not.toContain("test-secret");
    expect(JSON.stringify(h.calls)).not.toContain('key"');
  });

  it("treats a non-zero code on HTTP 200 as a named failure", async () => {
    const h = harness([
      { status: 200, body: { code: 40001, msg: "bad token", data: null, success: false } }
    ]);
    const error = await h.client
      .get("rwa", "/api/v1/dex/market/rwa/tokens")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Web3ApiError);
    expect(error).toMatchObject({ code: 40001, httpStatus: 200 });
    expect(String((error as Error).message)).toContain("code 40001: bad token");
  });

  it("learns the gateway clock once on a stale timestamp and signs again with a new nonce", async () => {
    const serverTime = Date.parse(TS) + 90_000;
    const h = harness([
      {
        status: 401,
        body: { code: 40103, msg: "Timestamp expired", timestamp: serverTime, success: false }
      },
      { status: 200, body: { code: 0, data: { ok: true }, success: true } }
    ]);
    await h.client.post("transaction", "/api/v1/dex/pre-transaction/simulate", { a: 1 });
    expect(h.sent).toHaveLength(2);
    expect(header(h.sent[1]!, "X-OC-NONCE")).toBe("nonce-2");
    const second = Date.parse(header(h.sent[1]!, "X-OC-TIMESTAMP")!);
    expect(Math.abs(second - (serverTime + 40))).toBeLessThan(100);
    expect(h.sent[1]!.init.body).toBe('{"a":1}');
  });

  it("waits Retry-After on a rate limit, then succeeds", async () => {
    const h = harness([
      { status: 429, body: { code: 42900, msg: "slow down" }, headers: { "retry-after": "2" } },
      { status: 200, body: { code: 0, data: 1, success: true } }
    ]);
    expect((await h.client.get<number>("market", "/api/v1/dex/market/price")).data).toBe(1);
    expect(h.sleeps).toEqual([2000]);
  });

  it("does not retry a bad signature", async () => {
    const h = harness([{ status: 401, body: { code: 40102, msg: "Invalid signature" } }]);
    await expect(
      h.client.get("wallet", "/api/v1/dex/balance/supported/chain")
    ).rejects.toMatchObject({
      code: 40102
    });
    expect(h.sent).toHaveLength(1);
  });

  it("refuses to start without credentials", () => {
    expect(() => new BinanceWeb3Client({ apiKey: " ", secret: "s" })).toThrow(/required/);
  });
});
