import { describe, expect, it } from "vitest";
import { decodeAbiParameters, hexToBytes } from "viem";
import { encodeAssertion } from "./passkey";
import { assertWithKey } from "./telegram-key";

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value as unknown as BufferSource));
}

describe("Telegram fingerprint key", () => {
  it("signs in the layout PasskeyOwner checks", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify"
    ]);
    const digest = crypto.getRandomValues(new Uint8Array(32));
    const signed = await assertWithKey(
      pair.privateKey,
      digest,
      "theredeyed-agent.site",
      "https://theredeyed-agent.site"
    );
    const encoded = encodeAssertion(
      signed.r,
      signed.s,
      signed.authenticatorData,
      signed.clientDataJSON,
      base64url(digest)
    );

    // The same steps as PasskeyOwner.isValidSignature.
    const [r, s, challengeIndex, typeIndex, authData, client] = decodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes" },
        { type: "string" }
      ],
      encoded
    );
    const auth = hexToBytes(authData);
    expect(auth.length).toBeGreaterThanOrEqual(37);
    expect(auth[32]! & 0x01).toBe(0x01);
    expect(auth[32]! & 0x04).toBe(0x04);
    expect(client.slice(Number(typeIndex)).startsWith('"type":"webauthn.get"')).toBe(true);
    expect(
      client.slice(Number(challengeIndex)).startsWith(`"challenge":"${base64url(digest)}"`)
    ).toBe(true);
    const clientHash = await sha256(new TextEncoder().encode(client));
    const message = new Uint8Array([...auth, ...clientHash]);
    const raw = new Uint8Array([...hexToBytes(r), ...hexToBytes(s)]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      raw,
      message
    );
    expect(ok).toBe(true);
  });
});
