import { describe, expect, it } from "vitest";
import {
  B402_SUCCESS_CODE,
  BinanceWeb3Client,
  parseB402Settle,
  parseB402Supported,
  parseB402Verify,
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

// B402 vectors, also computed with openssl over the exact wrapped body.
const SUPPORTED_BODY = '{"body":{}}';
const SETTLE_BODY =
  '{"body":{"x402Version":2,"paymentPayload":{"p":1},"paymentRequirements":{"r":2}}}';

const SUPPORTED_DATA = {
  kinds: [
    {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      extra: {
        name: "United Stables",
        version: "1",
        assetTransferMethod: "eip3009",
        signerAddress: "0x1111111111111111111111111111111111111111"
      }
    }
  ],
  extensions: ["bazaar"],
  signers: { "eip155:*": ["0x1111111111111111111111111111111111111111"] }
};

describe("B402 through the Web3 gateway", () => {
  it("signs the exact /build/api/v2/b402 path over the exact wrapped body it sends", async () => {
    expect(
      signWeb3Request("test-secret", TS, "POST", "/build/api/v2/b402/supported", SUPPORTED_BODY)
    ).toBe("n8/XsoVDf1U3fkJFYzpRUaTaEww6J+JYz331EK9Sioc=");
    const h = harness([
      { status: 200, body: { code: B402_SUCCESS_CODE, message: "success", data: SUPPORTED_DATA } }
    ]);
    const result = await h.client.b402Supported();
    const s = h.sent[0]!;
    expect(s.url).toBe("https://web3.binance.com/build/api/v2/b402/supported");
    expect(s.init.method).toBe("POST");
    expect(s.init.body).toBe(SUPPORTED_BODY);
    expect(header(s, "X-OC-SIGN")).toBe("n8/XsoVDf1U3fkJFYzpRUaTaEww6J+JYz331EK9Sioc=");
    expect(header(s, "X-OC-NONCE")).toBe("nonce-1");
    expect(header(s, "X-OC-TIMESTAMP")).toBe(TS);
    expect(result.data.kinds[0]).toMatchObject({ network: "eip155:56", scheme: "exact" });
    expect(result.call).toMatchObject({
      module: "b402",
      path: "/api/v2/b402/supported",
      businessCode: "000000000",
      ok: true
    });
  });

  it("wraps verify and settle bodies as {body: {x402Version: 2, ...}}", async () => {
    expect(
      signWeb3Request("test-secret", TS, "POST", "/build/api/v2/b402/settle", SETTLE_BODY)
    ).toBe("1Fi8DW8z1GFhWYpHY4xBN9S02PcAkw/WAsRC8xvG504=");
    const h = harness([
      {
        status: 200,
        body: { code: B402_SUCCESS_CODE, data: { isValid: true, payer: "0xpayer" } }
      },
      {
        status: 200,
        body: {
          code: B402_SUCCESS_CODE,
          data: {
            success: true,
            transaction: "0xtx",
            payer: "0xpayer",
            network: "eip155:56",
            amount: "2000000000000000"
          }
        }
      }
    ]);
    const verify = await h.client.b402Verify({ p: 1 }, { r: 2 });
    const settle = await h.client.b402Settle({ p: 1 }, { r: 2 });
    expect(h.sent[0]!.url).toBe("https://web3.binance.com/build/api/v2/b402/verify");
    expect(h.sent[0]!.init.body).toBe(SETTLE_BODY);
    expect(h.sent[1]!.url).toBe("https://web3.binance.com/build/api/v2/b402/settle");
    expect(h.sent[1]!.init.body).toBe(SETTLE_BODY);
    expect(header(h.sent[1]!, "X-OC-SIGN")).toBe(
      signWeb3Request(
        "test-secret",
        header(h.sent[1]!, "X-OC-TIMESTAMP")!,
        "POST",
        "/build/api/v2/b402/settle",
        SETTLE_BODY
      )
    );
    expect(header(h.sent[1]!, "X-OC-NONCE")).toBe("nonce-2");
    expect(verify.data).toEqual({ isValid: true, payer: "0xpayer" });
    expect(settle.data).toMatchObject({
      success: true,
      transaction: "0xtx",
      amount: "2000000000000000"
    });
  });

  it("accepts only the string 000000000 as B402 success", async () => {
    for (const code of [0, "0", "000000", "100001"]) {
      const h = harness([{ status: 200, body: { code, message: "nope", data: SUPPORTED_DATA } }]);
      const error = await h.client.b402Supported().catch((e: unknown) => e);
      expect(error, `code ${JSON.stringify(code)}`).toBeInstanceOf(Web3ApiError);
      expect(h.calls[0]).toMatchObject({ ok: false, businessCode: String(code) });
    }
  });

  it("fails loudly on a gateway refusal and names the code", async () => {
    const h = harness([
      { status: 403, body: { msg: "No permission: B402", data: "", code: 40104, timestamp: 1 } }
    ]);
    const error = await h.client.b402Supported().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Web3ApiError);
    expect(error).toMatchObject({ code: 40104, httpStatus: 403 });
    expect(String((error as Error).message)).toContain("code 40104: No permission: B402");
    expect(h.sent).toHaveLength(1);
  });

  it("reads the error text from errorData when there is no msg", async () => {
    const h = harness([
      {
        status: 200,
        body: { status: "FAIL", code: "100002", errorData: "invalid payTo", data: null }
      }
    ]);
    const error = await h.client.b402Supported().catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain("code 100002: invalid payTo");
  });

  it("re-signs a stale timestamp with a fresh nonce, the same as the other modules", async () => {
    const serverTime = Date.parse(TS) + 90_000;
    const h = harness([
      { status: 401, body: { code: 40103, msg: "Timestamp expired", timestamp: serverTime } },
      { status: 200, body: { code: B402_SUCCESS_CODE, data: SUPPORTED_DATA } }
    ]);
    await h.client.b402Supported();
    expect(h.sent).toHaveLength(2);
    expect(header(h.sent[0]!, "X-OC-NONCE")).toBe("nonce-1");
    expect(header(h.sent[1]!, "X-OC-NONCE")).toBe("nonce-2");
    expect(header(h.sent[1]!, "X-OC-TIMESTAMP")).not.toBe(header(h.sent[0]!, "X-OC-TIMESTAMP"));
    expect(h.sent[1]!.init.body).toBe(SUPPORTED_BODY);
  });

  it("never resends a settle that may have been processed", async () => {
    const busy = harness([{ status: 503, body: { code: 50001, msg: "unavailable" } }]);
    await expect(busy.client.b402Settle({ p: 1 }, { r: 2 })).rejects.toBeInstanceOf(Web3ApiError);
    expect(busy.sent).toHaveLength(1);
    const lost = harness([]);
    await expect(lost.client.b402Settle({ p: 1 }, { r: 2 })).rejects.toBeInstanceOf(Web3ApiError);
    expect(lost.sent).toHaveLength(1);
    expect(lost.sleeps).toEqual([]);
  });

  it("still retries supported, which moves nothing", async () => {
    const h = harness([
      { status: 503, body: { code: 50001, msg: "unavailable" } },
      { status: 200, body: { code: B402_SUCCESS_CODE, data: SUPPORTED_DATA } }
    ]);
    await h.client.b402Supported();
    expect(h.sent).toHaveLength(2);
  });

  it("keeps the key and secret out of every call record and error", async () => {
    const h = harness([{ status: 403, body: { code: 40104, msg: "No permission: B402" } }]);
    const error = await h.client.b402Supported().catch((e: unknown) => e);
    const seen =
      JSON.stringify(h.calls) + String(error) + JSON.stringify((error as Web3ApiError).context);
    expect(seen).not.toContain("test-secret");
    expect(seen).not.toContain('"key"');
  });
});

describe("B402 answer parsers", () => {
  it("reads a supported answer and drops junk safely", () => {
    expect(parseB402Supported(SUPPORTED_DATA)).toEqual(SUPPORTED_DATA);
    expect(
      parseB402Supported({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:56" }],
        signers: { a: ["0x1", 7] }
      })
    ).toEqual({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:56", extra: {} }],
      extensions: [],
      signers: { a: ["0x1"] }
    });
    expect(() => parseB402Supported(null)).toThrow(/supported/);
    expect(() => parseB402Supported({ kinds: "x" })).toThrow(/kinds is not a list/);
    expect(() => parseB402Supported({ kinds: [{ scheme: "exact" }] })).toThrow(/x402Version/);
  });

  it("reads verify and settle answers and refuses missing outcomes", () => {
    expect(parseB402Verify({ isValid: false, payer: "0xp", invalidReason: "expired" })).toEqual({
      isValid: false,
      payer: "0xp",
      invalidReason: "expired"
    });
    expect(() => parseB402Verify({ payer: "0xp" })).toThrow(/isValid/);
    expect(() => parseB402Verify({ isValid: true, payer: 5 })).toThrow(/payer/);
    expect(parseB402Settle({ success: false, errorReason: "revert" })).toEqual({
      success: false,
      transaction: "",
      payer: "",
      network: "",
      errorReason: "revert"
    });
    expect(() => parseB402Settle({ transaction: "0x" })).toThrow(/success/);
  });
});
