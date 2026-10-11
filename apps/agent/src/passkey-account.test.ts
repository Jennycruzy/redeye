import { describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import {
  PASSKEY_FACTORY_ABI,
  createPasskeyAccountService,
  normalizePasskeyInput,
  PasskeyAccountError
} from "./passkey-account.js";

const valid = {
  credentialIdHash: `0x${"11".repeat(32)}`,
  publicKeyX: `0x${"22".repeat(32)}`,
  publicKeyY: `0x${"33".repeat(32)}`
};

describe("passkey account input", () => {
  it("normalizes the three CREATE2 inputs without changing their bytes", () => {
    expect(
      normalizePasskeyInput({
        credentialIdHash: `0x${valid.credentialIdHash.slice(2).toUpperCase()}`,
        publicKeyX: `0x${valid.publicKeyX.slice(2).toUpperCase()}`,
        publicKeyY: `0x${valid.publicKeyY.slice(2).toUpperCase()}`
      })
    ).toEqual(valid);
  });

  it("rejects short, malformed and zero values before any RPC call", () => {
    expect(() => normalizePasskeyInput({ ...valid, publicKeyX: "0x01" })).toThrow(
      PasskeyAccountError
    );
    expect(() => normalizePasskeyInput({ ...valid, publicKeyY: `0x${"00".repeat(32)}` })).toThrow(
      "must not be zero"
    );
    expect(() => normalizePasskeyInput({ ...valid, credentialIdHash: "not-hex" })).toThrow(
      "32-byte hex"
    );
  });
});

describe("passkey factory ABI", () => {
  it("can encode every factory call the sponsor makes", () => {
    // createAccount was once missing here, so every account creation failed before any gas.
    const data = encodeFunctionData({
      abi: PASSKEY_FACTORY_ABI,
      functionName: "createAccount",
      args: [valid.credentialIdHash, valid.publicKeyX, valid.publicKeyY] as [
        `0x${string}`,
        `0x${string}`,
        `0x${string}`
      ]
    });
    expect(data.slice(0, 10)).toBe(toFunctionSelector("createAccount(bytes32,bytes32,bytes32)"));
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector("function createAccount(bytes32,bytes32,bytes32)")
    );
  });
});

describe("passkey withdrawal relay", () => {
  const service = createPasskeyAccountService({
    rpcUrl: "http://127.0.0.1:9",
    factory: "0x5065d3395d365d88870a5a6799c48e8f59f0e9e9",
    planBook: "0xC7B860d561f2208c725ac9a873bf4eA5205e9057",
    sponsorKey: `0x${"55".repeat(32)}`,
    dailyLimit: 1,
    maxFeeWei: 1n,
    ledger: {
      claimPasskeySponsor: () => true,
      releasePasskeySponsor: () => undefined,
      claimPasskeyWithdrawal: () => true
    }
  });
  const identity = { userId: "7", authDate: 1, queryId: null };
  const good = {
    account: "0x000000000000000000000000000000000000c0de",
    token: "0x55d398326f99059fF775485246999027B3197955",
    to: "0x000000000000000000000000000000000000beef",
    amount: "1000",
    deadline: Math.floor(Date.now() / 1000) + 600,
    signature: "0x1234"
  };

  it("refuses malformed requests before any RPC call", async () => {
    for (const [change, message] of [
      [{ to: "nope" }, "to must be an address"],
      [{ to: "0x0000000000000000000000000000000000000000" }, "to must not be zero"],
      [{ amount: "0" }, "positive whole number"],
      [{ amount: "1.5" }, "positive whole number"],
      [{ deadline: Math.floor(Date.now() / 1000) + 7_200 }, "within the next hour"],
      [{ deadline: Math.floor(Date.now() / 1000) - 1 }, "within the next hour"],
      [{ signature: "abc" }, "signature must be hex"]
    ] as const) {
      await expect(service.withdraw({ ...good, ...change }, identity)).rejects.toThrow(message);
    }
  });

  it("refuses an address that is not a Redeye account", async () => {
    await expect(service.withdraw(good, identity)).rejects.toMatchObject({
      code: "PASSKEY_WITHDRAW_ACCOUNT"
    });
  });
});
