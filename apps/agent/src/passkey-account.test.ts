import { describe, expect, it } from "vitest";
import { normalizePasskeyInput, PasskeyAccountError } from "./passkey-account.js";

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
