/**
 * Approvals inside Telegram, where the in-app browser cannot show a passkey prompt.
 *
 * A P-256 key is made on the phone and kept in Telegram's biometric storage, which only
 * releases it after the person's fingerprint or face. Its signatures use the same WebAuthn
 * layout a passkey returns, so the same account contract checks them: flags "user present"
 * and "user verified", type "webauthn.get", the challenge bound to the digest, and the P-256
 * signature over sha256(authenticatorData || sha256(clientDataJSON)).
 */

interface BiometricManager {
  isInited: boolean;
  isBiometricAvailable: boolean;
  biometricType: "finger" | "face" | "unknown";
  isAccessGranted: boolean;
  isBiometricTokenSaved: boolean;
  init(callback?: () => void): void;
  requestAccess(params: { reason?: string }, callback?: (granted: boolean) => void): void;
  authenticate(
    params: { reason?: string },
    callback?: (authenticated: boolean, token?: string) => void
  ): void;
  updateBiometricToken(token: string, callback?: (updated: boolean) => void): void;
}

interface TelegramApp {
  isVersionAtLeast?: (version: string) => boolean;
  BiometricManager?: BiometricManager;
}

function manager(): BiometricManager | null {
  const app = (window as unknown as { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
  if (!app?.BiometricManager || !app.isVersionAtLeast?.("7.2")) return null;
  return app.BiometricManager;
}

function ready(bio: BiometricManager): Promise<BiometricManager> {
  if (bio.isInited) return Promise.resolve(bio);
  return new Promise((resolve) => bio.init(() => resolve(bio)));
}

export type TelegramUnlock = "finger" | "face" | "unknown";

/** Which unlock Telegram offers on this phone, or null when it offers none. */
export async function telegramUnlock(): Promise<TelegramUnlock | null> {
  const bio = manager();
  if (bio === null) return null;
  const inited = await Promise.race([
    ready(bio),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))
  ]);
  return inited?.isBiometricAvailable ? inited.biometricType : null;
}

function unlock(bio: BiometricManager, reason: string): Promise<string> {
  return new Promise((resolve, reject) =>
    bio.authenticate({ reason }, (ok, token) =>
      ok ? resolve(token ?? "") : reject(new Error("The fingerprint or face check was cancelled."))
    )
  );
}

async function access(bio: BiometricManager): Promise<void> {
  if (bio.isAccessGranted) return;
  const granted = await new Promise<boolean>((resolve) =>
    bio.requestAccess({ reason: "Redeye uses it to approve your account." }, resolve)
  );
  if (!granted) {
    throw new Error("Telegram was not allowed to use your fingerprint or face for Redeye.");
  }
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function hex(value: Uint8Array): `0x${string}` {
  return `0x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The stored secret: the key's JWK coordinates and private scalar, nothing else. */
interface StoredKey {
  v: 1;
  d: string;
  x: string;
  y: string;
}

export interface TelegramKey {
  credentialId: string;
  publicKeyX: `0x${string}`;
  publicKeyY: `0x${string}`;
}

/** Makes a key, locks it behind the fingerprint or face, and returns its public half. */
export async function createTelegramKey(): Promise<TelegramKey> {
  const bio = manager();
  if (bio === null) throw new Error("This Telegram app cannot use fingerprint or face for Redeye.");
  await ready(bio);
  await access(bio);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign"
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("The phone could not make a key.");
  const stored: StoredKey = { v: 1, d: jwk.d, x: jwk.x, y: jwk.y };
  const saved = await new Promise<boolean>((resolve) =>
    bio.updateBiometricToken(JSON.stringify(stored), resolve)
  );
  if (!saved) throw new Error("Telegram could not save the key on this phone.");
  return {
    credentialId: base64url(crypto.getRandomValues(new Uint8Array(32))),
    publicKeyX: hex(base64urlBytes(jwk.x)),
    publicKeyY: hex(base64urlBytes(jwk.y))
  };
}

export interface Assertion {
  r: `0x${string}`;
  s: `0x${string}`;
  authenticatorData: Uint8Array;
  clientDataJSON: string;
}

/** Signs `digest` in the WebAuthn layout. Exported for tests; the app goes through Telegram. */
export async function assertWithKey(
  key: CryptoKey,
  digest: Uint8Array,
  rpId: string,
  origin: string
): Promise<Assertion> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId))
  );
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(rpIdHash, 0);
  authenticatorData[32] = 0x05; // user present + user verified (Telegram checked the fingerprint)
  const clientDataJSON = JSON.stringify({
    type: "webauthn.get",
    challenge: base64url(digest),
    origin,
    crossOrigin: false
  });
  const clientHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientDataJSON))
  );
  const message = new Uint8Array(authenticatorData.length + clientHash.length);
  message.set(authenticatorData, 0);
  message.set(clientHash, authenticatorData.length);
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message)
  );
  return {
    r: hex(raw.slice(0, 32)),
    s: hex(raw.slice(32, 64)),
    authenticatorData,
    clientDataJSON
  };
}

/** Asks for the fingerprint or face, then signs `digest` with the key Telegram releases. */
export async function signWithTelegramKey(
  expected: { publicKeyX: `0x${string}`; publicKeyY: `0x${string}` },
  digest: Uint8Array,
  rpId: string
): Promise<Assertion> {
  const bio = manager();
  if (bio === null) {
    throw new Error(
      "This account is approved with your fingerprint inside Redeye's Telegram bot. Open it there."
    );
  }
  await ready(bio);
  if (!bio.isBiometricTokenSaved) {
    throw new Error("The key for this account is not on this phone's Telegram.");
  }
  const token = await unlock(bio, "Confirm it is you to approve this.");
  let stored: StoredKey;
  try {
    stored = JSON.parse(token) as StoredKey;
  } catch {
    throw new Error("Telegram returned an unreadable key.");
  }
  if (
    hex(base64urlBytes(stored.x)) !== expected.publicKeyX.toLowerCase() ||
    hex(base64urlBytes(stored.y)) !== expected.publicKeyY.toLowerCase()
  ) {
    throw new Error("The key in Telegram belongs to a different Redeye account.");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: stored.d, x: stored.x, y: stored.y, ext: false },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return assertWithKey(key, digest, rpId, window.location.origin);
}
