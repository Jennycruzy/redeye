import { keccak256, toHex } from "viem";

export interface RegisteredPasskey {
  credentialId: string;
  credentialIdHash: `0x${string}`;
  publicKeyX: `0x${string}`;
  publicKeyY: `0x${string}`;
}

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function p256Coordinates(spki: ArrayBuffer): {
  publicKeyX: `0x${string}`;
  publicKeyY: `0x${string}`;
} {
  const encoded = bytes(spki);
  const marker = encoded.length - 65;
  if (marker < 0 || encoded[marker] !== 4) {
    throw new Error("The passkey did not return a P-256 public key.");
  }
  return {
    publicKeyX: toHex(encoded.slice(marker + 1, marker + 33)),
    publicKeyY: toHex(encoded.slice(marker + 33, marker + 65))
  };
}

export async function registerPasskey(rpId: string): Promise<RegisteredPasskey> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("This browser does not support passkeys.");
  }
  const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  if (!available) throw new Error("Face ID, Touch ID or a device passkey is not available.");
  const userId = crypto.getRandomValues(new Uint8Array(32));
  const created = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: rpId, name: "Redeye" },
      user: { id: userId, name: `redeye-${base64url(userId)}`, displayName: "Redeye account" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required"
      },
      attestation: "none",
      timeout: 120_000
    }
  });
  if (!(created instanceof PublicKeyCredential)) throw new Error("Passkey creation was cancelled.");
  const response = created.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("The browser returned an invalid passkey registration.");
  }
  const spki = response.getPublicKey();
  if (!spki) throw new Error("The browser did not expose the P-256 public key.");
  const rawId = bytes(created.rawId);
  return {
    credentialId: base64url(rawId),
    credentialIdHash: keccak256(rawId),
    ...p256Coordinates(spki)
  };
}

export function telegramInitData(): string | null {
  const value = (
    window as unknown as { Telegram?: { WebApp?: { initData?: string; ready?: () => void } } }
  ).Telegram?.WebApp;
  value?.ready?.();
  return value?.initData || null;
}
