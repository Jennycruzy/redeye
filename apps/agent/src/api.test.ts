import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentApi } from "./api.js";
import type { AgentRequest, AgentStore } from "./types.js";

function request(pathname: string, overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    method: "GET",
    pathname,
    query: new URLSearchParams(),
    headers: new Headers(),
    ...overrides
  };
}

function store(): AgentStore {
  return {
    health: async () => ({ status: "ok", source: "fixture" }),
    study: async () => ({ state: "ok", source: "fixture" }),
    calendar: async (days) => ({ days }),
    prices: async (tickers) => ({ tickers }),
    windows: async (ticker) => ({ ticker }),
    feed: async (since) => ({ since }),
    token: async (ticker) => ({ ticker }),
    history: async (ticker) => ({ ticker }),
    record: async () => ({ plans: [] }),
    wallet: async () => ({ connected: false }),
    planGet: async (id) => ({ id }),
    run: async (id) => ({ id }),
    runEvents: async (id) => ({ id, events: [] }),
    receipt: async (id) => ({ id }),
    replay: async (body) => ({ body, replay: true }),
    authSignin: async () => ({ pairing: "fixture" }),
    authVerify: async (id) => ({ id, connected: true }),
    planDraft: async (body) => ({ body }),
    planAction: async (id, body) => ({ id, body }),
    standingCreate: async (body) => ({ body }),
    standingStop: async (id) => ({ id, stopped: true }),
    standingGet: async (id) => ({ id })
  };
}

const config = { ownerToken: "owner-secret", siteOrigin: "https://redeye.example" };

function telegramFixture(token: string): string {
  const values = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 7, first_name: "Fixture" })
  });
  const check = [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  values.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return values.toString();
}

describe("agent HTTP boundary", () => {
  it("routes read-only resources without an owner token", async () => {
    const api = createAgentApi(store(), config);
    const response = await api(request("/health"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", source: "fixture" });
    expect(response.headers["access-control-allow-origin"]).toBe(config.siteOrigin);
  });

  it("routes the generated off-hours study without an owner token", async () => {
    const api = createAgentApi(store(), config);
    const response = await api(request("/study"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: "ok", source: "fixture" });
  });

  it("serves night traces and plan checks to anyone, with their own errors", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const api = createAgentApi(store(), {
      ...config,
      night: async (ticker, closeTs) => {
        calls.push([ticker, closeTs]);
        if (ticker === "LATE") {
          throw Object.assign(new Error("That window has not started yet."), {
            status: 400,
            code: "WINDOW_NOT_STARTED"
          });
        }
        return { ticker };
      },
      preview: async (input) => ({ valid: true, input }),
      previewStanding: async (input) => ({ valid: true, standing: true, input })
    });
    expect((await api(request("/night/NVDA"))).body).toEqual({ ticker: "NVDA" });
    const query = new URLSearchParams({ close: "1791576000000" });
    await api(request("/night/TSLA", { query }));
    expect(calls).toEqual([
      ["NVDA", undefined],
      ["TSLA", 1791576000000]
    ]);
    const bad = await api(request("/night/NVDA", { query: new URLSearchParams({ close: "x" }) }));
    expect(bad.status).toBe(400);
    const late = await api(request("/night/LATE"));
    expect(late).toMatchObject({
      status: 400,
      body: { error: { code: "WINDOW_NOT_STARTED", reason: "That window has not started yet." } }
    });
    const checked = await api(request("/preview", { method: "POST", body: { ticker: "NVDA" } }));
    expect(checked).toMatchObject({
      status: 200,
      body: { valid: true, input: { ticker: "NVDA" } }
    });
    const notObject = await api(request("/preview", { method: "POST", body: [1] }));
    expect(notObject.status).toBe(400);
    const standing = await api(
      request("/preview-standing", { method: "POST", body: { ticker: "NVDA", days: 3 } })
    );
    expect(standing).toMatchObject({
      status: 200,
      body: { valid: true, standing: true, input: { ticker: "NVDA", days: 3 } }
    });
  });

  it("verifies Telegram before forwarding passkey preview or creation", async () => {
    const token = "123456:fixture-token";
    const api = createAgentApi(store(), {
      ...config,
      telegramBotToken: token,
      passkeyPreview: async (input, identity) => ({ input, identity }),
      passkeyCreate: async (input, identity) => ({ created: true, input, identity })
    });
    const initData = telegramFixture(token);
    const preview = await api(
      request("/passkey/preview", {
        method: "POST",
        body: { telegramInitData: initData, credentialIdHash: "0x01" }
      })
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      input: { credentialIdHash: "0x01" },
      identity: { userId: "7" }
    });
    const created = await api(
      request("/passkey/create", {
        method: "POST",
        body: { telegramInitData: initData, credentialIdHash: "0x02" }
      })
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ created: true, identity: { userId: "7" } });
    const tampered = await api(
      request("/passkey/preview", {
        method: "POST",
        body: { telegramInitData: `${initData}x`, credentialIdHash: "0x03" }
      })
    );
    expect(tampered.status).toBe(401);
    expect(tampered.body).toMatchObject({ error: { code: "TELEGRAM_INIT_DATA_INVALID" } });
    const missing = await api(
      request("/passkey/preview", { method: "POST", body: { credentialIdHash: "0x04" } })
    );
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: { code: "TELEGRAM_INIT_DATA_REQUIRED" } });
  });

  it("rejects writes without the owner token", async () => {
    const api = createAgentApi(store(), config);
    const response = await api(request("/replay", { method: "POST", body: { event: "NVDA" } }));
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: "OWNER_AUTH_REQUIRED", reason: "This action needs the agent owner token." }
    });
  });

  it("passes an authorized replay request to the store", async () => {
    const headers = new Headers({ "x-owner-token": config.ownerToken });
    const api = createAgentApi(store(), config);
    const response = await api(
      request("/replay", { method: "POST", headers, body: { event: "NVDA" } })
    );
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ body: { event: "NVDA" }, replay: true });
  });

  it("fails invalid calendar limits loudly", async () => {
    const api = createAgentApi(store(), config);
    const response = await api(
      request("/calendar", { query: new URLSearchParams({ days: "99" }) })
    );
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: "INVALID_DAYS", reason: "days must be an integer from 1 to 31." }
    });
  });

  it("routes source-backed prices and rejects malformed ticker filters", async () => {
    const api = createAgentApi(store(), config);
    const response = await api(
      request("/prices", { query: new URLSearchParams({ tickers: "NVDA,TSLA" }) })
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tickers: ["NVDA", "TSLA"] });

    const invalid = await api(
      request("/prices", { query: new URLSearchParams({ tickers: "NVDA,NOT_A_TICKER" }) })
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      error: { code: "INVALID_TICKER", reason: "tickers must contain uppercase stock symbols." }
    });
  });

  it("routes an off-hours window lookup", async () => {
    const api = createAgentApi(store(), config);
    const response = await api(request("/windows/NVDA"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ticker: "NVDA" });
  });

  it("routes standing plans and guards their writes with the owner token", async () => {
    const headers = new Headers({ "x-owner-token": config.ownerToken });
    const api = createAgentApi(store(), config);
    const created = await api(
      request("/standing", { method: "POST", headers, body: { ticker: "NVDA", days: 3 } })
    );
    expect(created.status).toBe(201);
    const stopped = await api(request("/standing/run-1/stop", { method: "POST", headers }));
    expect(stopped.body).toEqual({ id: "run-1", stopped: true });
    expect((await api(request("/standing/run-1"))).body).toEqual({ id: "run-1" });
    expect((await api(request("/standing", { method: "POST" }))).status).toBe(401);
    const signed = await api(
      request("/standing", {
        method: "POST",
        body: { door: "plan_account", owner: "0x0000000000000000000000000000000000000001" }
      })
    );
    expect(signed.status).toBe(201);
    expect((await api(request("/standing/run-1/stop", { method: "POST" }))).status).toBe(401);
  });

  it("routes lock and cancel and rejects other plan actions", async () => {
    const headers = new Headers({ "x-owner-token": config.ownerToken });
    const api = createAgentApi(store(), config);
    const locked = await api(request("/plans/7/lock", { method: "POST", headers }));
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ id: "7", body: { action: "lock" } });
    const unsigned = await api(request("/plans/7/lock", { method: "POST" }));
    expect(unsigned.status).toBe(401);

    const response = await api(request("/plans/7/delete", { method: "POST", headers }));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: "PLAN_ACTION_NOT_FOUND", reason: "The requested plan action does not exist." }
    });
  });
});
