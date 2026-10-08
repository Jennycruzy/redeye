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
      preview: async (input) => ({ valid: true, input })
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
