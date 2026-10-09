import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramIdentity {
  userId: string;
  authDate: number;
  queryId: string | null;
}

export interface TelegramVerificationOptions {
  /** Maximum age of initData, in seconds. Defaults to one hour. */
  maxAgeSeconds?: number;
  /** Small allowance for clock skew when rejecting a future auth_date. */
  futureSkewSeconds?: number;
  /** Injected clock for deterministic tests. */
  nowSeconds?: number;
}

export class TelegramInitDataError extends Error {
  readonly status = 401;
  readonly code = "TELEGRAM_INIT_DATA_INVALID";

  constructor(reason: string) {
    super(reason);
    this.name = "TelegramInitDataError";
  }
}

function fail(reason: string): never {
  throw new TelegramInitDataError(reason);
}

function dataCheckString(params: URLSearchParams): string {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [key, value] of params.entries()) {
    if (seen.has(key)) fail("Telegram initData contains a duplicate field.");
    seen.add(key);
    if (key !== "hash") entries.push([key, value]);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return entries.map(([key, value]) => `${key}=${value}`).join("\n");
}

function userId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) fail("Telegram user id is invalid.");
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  fail("Telegram user id is missing.");
}

/**
 * Verifies the HMAC form of Telegram Mini App initData.
 *
 * The bot token never leaves the agent. The returned identity contains only
 * the stable Telegram id and timestamps needed by the onboarding boundary.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: TelegramVerificationOptions = {}
): TelegramIdentity {
  if (initData.length === 0 || initData.length > 16_384) {
    fail("Telegram initData is missing or too large.");
  }
  if (botToken.trim().length === 0) fail("Telegram verification is not configured.");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) {
    fail("Telegram initData has no valid hash.");
  }
  const check = dataCheckString(params);
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  const received = Buffer.from(hash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    fail("Telegram initData signature does not match this bot.");
  }

  const authDateText = params.get("auth_date");
  if (authDateText === null || !/^[0-9]+$/.test(authDateText)) {
    fail("Telegram auth_date is missing or invalid.");
  }
  const authDate = Number(authDateText);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) fail("Telegram auth_date is invalid.");
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 3_600;
  const futureSkew = options.futureSkewSeconds ?? 60;
  if (!Number.isFinite(maxAge) || maxAge <= 0 || !Number.isFinite(futureSkew) || futureSkew < 0) {
    throw new Error("Telegram verification time limits are invalid.");
  }
  if (authDate > now + futureSkew) fail("Telegram auth_date is from the future.");
  if (now - authDate > maxAge) fail("Telegram initData has expired.");

  const userText = params.get("user");
  if (userText === null) fail("Telegram user data is missing.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(userText);
  } catch {
    fail("Telegram user data is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("Telegram user data is invalid.");
  }
  const user = parsed as { id?: unknown };
  return {
    userId: userId(user.id),
    authDate,
    queryId: params.get("query_id")
  };
}
