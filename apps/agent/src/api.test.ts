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
    planAction: async (id, body) => ({ id, body })
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

  it("allows only the two defined plan actions", async () => {
    const headers = new Headers({ "x-owner-token": config.ownerToken });
    const api = createAgentApi(store(), config);
    const response = await api(request("/plans/7/delete", { method: "POST", headers }));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: "PLAN_ACTION_NOT_FOUND", reason: "The requested plan action does not exist." }
    });
  });
});
