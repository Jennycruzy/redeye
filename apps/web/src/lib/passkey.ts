import {
  encodeAbiParameters,
  hashTypedData,
  hexToBytes,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex
} from "viem";
import {
  PLAN_PERMISSION_TYPES,
  planPermissionDomain,
  type SerializedPlanPermission
} from "@redeye/core";

export interface RegisteredPasskey {
  credentialId: string;
  credentialIdHash: `0x${string}`;
  publicKeyX: `0x${string}`;
  publicKeyY: `0x${string}`;
}

export interface StoredPasskeyAccount extends RegisteredPasskey {
  account: Address;
  owner: Address;
  rpId: string;
}

const STORAGE_KEY = "redeye-passkey-account";

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function coordinate(value: Uint8Array): `0x${string}` {
  if (value.length !== 32) throw new Error("The passkey signature had an invalid coordinate.");
  return toHex(value);
}

function derSignature(value: ArrayBuffer): { r: `0x${string}`; s: `0x${string}` } {
  const bytes = new Uint8Array(value);
  if (bytes.length < 8 || bytes[0] !== 0x30 || bytes[1]! >= 0x80) {
    throw new Error("The passkey returned an invalid ECDSA signature.");
  }
  let index = 2;
  const sequenceLength = bytes[1]!;
  if (sequenceLength !== bytes.length - 2 || bytes[index++] !== 0x02) {
    throw new Error("The passkey returned an invalid ECDSA sequence.");
  }
  const rLength = bytes[index++]!;
  const rStart = index;
  index += rLength;
  if (rLength === 0 || index >= bytes.length || bytes[index++] !== 0x02) {
    throw new Error("The passkey returned an invalid ECDSA r value.");
  }
  const sLength = bytes[index++]!;
  const sStart = index;
  index += sLength;
  if (sLength === 0 || index !== bytes.length) {
    throw new Error("The passkey returned an invalid ECDSA s value.");
  }
  const trim = (start: number, length: number): Uint8Array => {
    const raw = bytes.slice(start, start + length);
    const stripped = raw[0] === 0 ? raw.slice(1) : raw;
    if (stripped.length > 32) throw new Error("The passkey returned an oversized ECDSA value.");
    const padded = new Uint8Array(32);
    padded.set(stripped, 32 - stripped.length);
    return padded;
  };
  return { r: coordinate(trim(rStart, rLength)), s: coordinate(trim(sStart, sLength)) };
}

function storedAccount(value: unknown): StoredPasskeyAccount | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.credentialId !== "string" ||
    typeof input.credentialIdHash !== "string" ||
    typeof input.publicKeyX !== "string" ||
    typeof input.publicKeyY !== "string" ||
    typeof input.rpId !== "string" ||
    typeof input.account !== "string" ||
    typeof input.owner !== "string" ||
    !isAddress(input.account) ||
    !isAddress(input.owner)
  ) {
    return null;
  }
  return {
    credentialId: input.credentialId,
    credentialIdHash: input.credentialIdHash as `0x${string}`,
    publicKeyX: input.publicKeyX as `0x${string}`,
    publicKeyY: input.publicKeyY as `0x${string}`,
    account: input.account,
    owner: input.owner,
    rpId: input.rpId
  };
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
  if (!available) {
    throw new Error("A device passkey, fingerprint, Face ID or screen lock is not available.");
  }
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

export function savePasskeyAccount(value: StoredPasskeyAccount): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    throw new Error("This browser could not save the passkey account on this device.");
  }
}

export function loadPasskeyAccount(): StoredPasskeyAccount | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : storedAccount(JSON.parse(raw));
  } catch {
    return null;
  }
}

function permissionMessage(permission: SerializedPlanPermission) {
  return {
    planHash: permission.planHash,
    standingRunHash: permission.standingRunHash,
    agent: permission.agent,
    tokenIn: permission.tokenIn,
    tokenOut: permission.tokenOut,
    maxAmount: BigInt(permission.maxAmount),
    router: permission.router,
    notBefore: BigInt(permission.notBefore),
    notAfter: BigInt(permission.notAfter),
    maxPriceDeviationBps: BigInt(permission.maxPriceDeviationBps)
  } as const;
}

/** Creates the ABI-encoded WebAuthn assertion accepted by PasskeyOwner. */
export async function signPasskeyPermission(
  account: StoredPasskeyAccount,
  permission: SerializedPlanPermission
): Promise<{ signature: Hex; issuedAt: number }> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("This browser does not support passkey assertions.");
  }
  const digest = hashTypedData({
    domain: planPermissionDomain(account.account),
    types: PLAN_PERMISSION_TYPES,
    primaryType: "PlanPermission",
    message: permissionMessage(permission)
  });
  const challenge = hexToBytes(digest);
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: challenge as unknown as BufferSource,
      rpId: account.rpId,
      allowCredentials: [
        { type: "public-key", id: base64urlBytes(account.credentialId) as unknown as BufferSource }
      ],
      userVerification: "required",
      timeout: 120_000
    }
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("The passkey assertion was cancelled.");
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("The browser returned an invalid passkey assertion.");
  }
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
  const challengeText = base64url(challenge);
  const challengeIndex = clientDataJSON.indexOf(`"challenge":"${challengeText}"`);
  const typeIndex = clientDataJSON.indexOf('"type":"webauthn.get"');
  if (challengeIndex < 0 || typeIndex < 0) {
    throw new Error("The passkey assertion was not bound to this permission.");
  }
  const { r, s } = derSignature(response.signature);
  const signature = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "string" }
    ],
    [
      r,
      s,
      BigInt(challengeIndex),
      BigInt(typeIndex),
      toHex(new Uint8Array(response.authenticatorData)),
      clientDataJSON
    ]
  );
  return { signature, issuedAt: Math.floor(Date.now() / 1000) };
}

export function telegramInitData(): string | null {
  const value = (
    window as unknown as { Telegram?: { WebApp?: { initData?: string; ready?: () => void } } }
  ).Telegram?.WebApp;
  value?.ready?.();
  return value?.initData || null;
}
