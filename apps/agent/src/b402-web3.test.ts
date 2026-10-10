import { describe, expect, it } from "vitest";
import { web3B402Transport } from "./b402-web3.js";

type Settle = {
  success: boolean;
  transaction: string;
  payer: string;
  network: string;
  amount?: string;
  errorReason?: string;
};

const TX = `0x${"cd".repeat(32)}`;
const request = {
  x402Version: 2,
  paymentPayload: { p: 1 },
  paymentRequirements: { r: 2 }
} as unknown as Parameters<ReturnType<typeof web3B402Transport>["settle"]>[0];

function fakeClient(answers: Settle[]) {
  const asked: unknown[] = [];
  const client = {
    b402Supported: async () => ({ data: { kinds: [], extensions: [], signers: {} } }),
    b402Verify: async () => ({ data: { isValid: true, payer: "0xp" } }),
    b402Settle: async (payload: unknown, requirements: unknown) => {
      asked.push({ payload, requirements });
      const next = answers.shift();
      if (!next) throw new Error("no answer left");
      return { data: next };
    }
  };
  return { client: client as never, asked };
}

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps
  };
}

const pending: Settle = { success: false, transaction: TX, payer: "0xp", network: "eip155:56" };
const done: Settle = {
  success: true,
  transaction: TX,
  payer: "0xp",
  network: "eip155:56",
  amount: "2000000000000000"
};

describe("web3B402Transport settle", () => {
  it("waits for a block past the authorization's validAfter before settling", async () => {
    const { client, asked } = fakeClient([done]);
    const c = clock();
    const times = [999, 1000, 1000, 1001];
    const timed = {
      ...request,
      paymentPayload: { payload: { authorization: { validAfter: "1000" } } }
    } as typeof request;
    const result = await web3B402Transport(client, {
      now: c.now,
      sleep: c.sleep,
      chainTime: async () => times.shift() ?? 1001
    }).settle(timed);
    expect(result).toEqual(done);
    expect(asked).toHaveLength(1);
    expect(c.sleeps).toEqual([500, 500, 500]);
  });

  it("settles anyway after the longest wait, so a stuck clock cannot hang a sale", async () => {
    const { client, asked } = fakeClient([done]);
    const c = clock();
    const timed = {
      ...request,
      paymentPayload: { payload: { authorization: { validAfter: "1000" } } }
    } as typeof request;
    await web3B402Transport(client, {
      now: c.now,
      sleep: c.sleep,
      chainTime: async () => 900,
      maxValidAfterWaitMs: 2000
    }).settle(timed);
    expect(asked).toHaveLength(1);
    expect(c.sleeps).toHaveLength(4);
  });

  it("does not wait when the payment has no validAfter (Permit2)", async () => {
    const { client } = fakeClient([done]);
    const c = clock();
    await web3B402Transport(client, {
      now: c.now,
      sleep: c.sleep,
      chainTime: async () => 0
    }).settle(request);
    expect(c.sleeps).toEqual([]);
  });

  it("asks again while B402 reports a broadcast that has not confirmed, then returns it", async () => {
    const { client, asked } = fakeClient([pending, pending, done]);
    const c = clock();
    const result = await web3B402Transport(client, {
      pollMs: 3000,
      now: c.now,
      sleep: c.sleep
    }).settle(request);
    expect(result).toEqual(done);
    expect(asked).toHaveLength(3);
    expect(asked.every((a) => JSON.stringify(a) === JSON.stringify(asked[0]))).toBe(true);
    expect(c.sleeps).toEqual([3000, 3000]);
  });

  it("does not ask again after a refusal with nothing broadcast", async () => {
    const refused: Settle = {
      success: false,
      transaction: "",
      payer: "0xp",
      network: "eip155:56",
      errorReason: "insufficient_funds"
    };
    const { client, asked } = fakeClient([refused]);
    const c = clock();
    expect(await web3B402Transport(client, { now: c.now, sleep: c.sleep }).settle(request)).toEqual(
      refused
    );
    expect(asked).toHaveLength(1);
    expect(c.sleeps).toEqual([]);
  });

  it("stops waiting at the deadline and hands back the pending answer", async () => {
    const { client, asked } = fakeClient(Array.from({ length: 20 }, () => ({ ...pending })));
    const c = clock();
    const result = await web3B402Transport(client, {
      pollMs: 3000,
      maxWaitMs: 9000,
      now: c.now,
      sleep: c.sleep
    }).settle(request);
    expect(result).toMatchObject({ success: false, transaction: TX });
    expect(asked).toHaveLength(4);
  });

  it("refuses anything but x402 version 2", async () => {
    const { client, asked } = fakeClient([done]);
    await expect(
      web3B402Transport(client).settle({ ...request, x402Version: 1 } as typeof request)
    ).rejects.toThrow(/version 2/);
    expect(asked).toHaveLength(0);
  });
});
