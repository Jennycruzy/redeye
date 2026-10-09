import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TelegramInitDataError, verifyTelegramInitData } from "./telegram.js";

const botToken = "123456:fixture-token";
const now = 1_800_000_000;

function fixture(overrides: Record<string, string> = {}): string {
  const values = new URLSearchParams({
    auth_date: String(now - 30),
    query_id: "AAEAAAE",
    user: JSON.stringify({ id: 42, first_name: "Redeye" }),
    ...overrides
  });
  const entries = [...values.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
  const dataCheck = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheck).digest("hex");
  values.set("hash", hash);
  return values.toString();
}

describe("Telegram Mini App initData", () => {
  it("verifies the bot-token HMAC and returns only the stable identity", () => {
    expect(verifyTelegramInitData(fixture(), botToken, { nowSeconds: now })).toEqual({
      userId: "42",
      authDate: now - 30,
      queryId: "AAEAAAE"
    });
  });

  it("rejects tampering, duplicate fields and missing hashes", () => {
    const tampered = fixture().replace("first_name%22%3A%22Redeye", "first_name%22%3A%22Attacker");
    expect(() => verifyTelegramInitData(tampered, botToken, { nowSeconds: now })).toThrow(
      TelegramInitDataError
    );
    expect(() =>
      verifyTelegramInitData(`${fixture()}&auth_date=${now - 30}`, botToken, {
        nowSeconds: now
      })
    ).toThrow("duplicate field");
    expect(() =>
      verifyTelegramInitData(fixture().replace(/&hash=[^&]+$/, ""), botToken, {
        nowSeconds: now
      })
    ).toThrow("valid hash");
  });

  it("rejects stale and future initData after signature verification", () => {
    const stale = fixture({ auth_date: String(now - 3_601) });
    expect(() => verifyTelegramInitData(stale, botToken, { nowSeconds: now })).toThrow("expired");
    const future = fixture({ auth_date: String(now + 61) });
    expect(() => verifyTelegramInitData(future, botToken, { nowSeconds: now })).toThrow("future");
  });

  it("rejects malformed user identities", () => {
    const missingId = fixture({ user: JSON.stringify({ first_name: "No id" }) });
    expect(() => verifyTelegramInitData(missingId, botToken, { nowSeconds: now })).toThrow(
      "user id"
    );
  });
});
