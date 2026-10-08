import { describe, expect, it } from "vitest";
import { createAgentApi } from "./api.js";
import {
  buildIdentityCard,
  identityConfigFromEnv,
  IDENTITY_REGISTRY,
  REGISTRATION_TYPE,
  type IdentityConfig
} from "./identity.js";
import type { AgentStore } from "./types.js";

const agent = "0xe201bbf3C736a5d188797974a7e4B9464f707eA8";
const planBook = "0xc7b860d561f2208c725ac9a873bf4ea5205e9057";
const planAccount = "0x141B2a28895c12FD17209eC621496f0F9f1F1048";

function config(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    agentUrl: "https://agent.example.org/",
    siteUrl: null,
    agentId: null,
    agentAddress: agent,
    planBook,
    planAccount,
    repoUrl: null,
    ...overrides
  };
}

describe("buildIdentityCard", () => {
  it("builds an ERC-8004 registration file that lists only live services", () => {
    const card = buildIdentityCard(config());
    expect(card.type).toBe(REGISTRATION_TYPE);
    expect(card.name).toBe("Redeye");
    expect(card.services).toEqual([
      { name: "record", endpoint: "https://agent.example.org/record" },
      { name: "health", endpoint: "https://agent.example.org/health" },
      { name: "MCP", endpoint: "https://agent.example.org/mcp" }
    ]);
    expect(card.x402Support).toBe(false);
    expect(card.registrations).toEqual([]);
    expect(card.supportedTrust).toEqual(["reputation"]);
  });

  it("lists the A2A card and x402 support only when they are live", () => {
    const card = buildIdentityCard(config({ a2a: true, x402Support: true }));
    expect(card.services.at(-1)).toEqual({
      name: "A2A",
      endpoint: "https://agent.example.org/.well-known/agent-card.json",
      version: "1.0"
    });
    expect(card.x402Support).toBe(true);
    const off = buildIdentityCard(config({ a2a: false, x402Support: false }));
    expect(off.services.map((service) => service.name)).not.toContain("A2A");
    expect(off.x402Support).toBe(false);
  });

  it("checksums contract addresses and lists both contracts", () => {
    const card = buildIdentityCard(config());
    expect(card.contracts).toEqual([
      { name: "PlanBook", chainId: 56, address: "0xC7B860d561f2208c725ac9a873bf4eA5205e9057" },
      { name: "PlanAccount", chainId: 56, address: planAccount }
    ]);
  });

  it("adds the site, the source and the registry entry once they exist", () => {
    const card = buildIdentityCard(
      config({
        siteUrl: "https://redeye.example.org",
        repoUrl: "https://github.com/jennycruzy/redeye",
        agentId: "42"
      })
    );
    expect(card.services[0]).toEqual({ name: "web", endpoint: "https://redeye.example.org" });
    expect(card.services.at(-1)).toEqual({
      name: "source",
      endpoint: "https://github.com/jennycruzy/redeye"
    });
    expect(card.registrations).toEqual([
      { agentId: 42, agentRegistry: `eip155:56:${IDENTITY_REGISTRY}` }
    ]);
  });

  it("refuses addresses that are not https", () => {
    expect(() => buildIdentityCard(config({ agentUrl: "http://1.2.3.4:8787" }))).toThrow(
      "agentUrl must use https."
    );
    expect(() => buildIdentityCard(config({ siteUrl: "not a url" }))).toThrow(
      "siteUrl must be a full URL."
    );
  });

  it("refuses a bad agent id or contract address", () => {
    expect(() => buildIdentityCard(config({ agentId: "7a" }))).toThrow(
      "agentId must be a whole number."
    );
    expect(() => buildIdentityCard(config({ planBook: "0x123" }))).toThrow(
      "planBook must be an address."
    );
  });
});

describe("identityConfigFromEnv", () => {
  it("returns null until the agent has a public address", () => {
    expect(identityConfigFromEnv({ PLANBOOK_ADDRESS: planBook }, agent)).toBeNull();
    expect(
      identityConfigFromEnv(
        { PUBLIC_AGENT_URL: "https://a.example.org", PLANBOOK_ADDRESS: planBook },
        null
      )
    ).toBeNull();
  });

  it("reads optional settings and treats blanks as missing", () => {
    expect(
      identityConfigFromEnv(
        {
          PUBLIC_AGENT_URL: "https://a.example.org",
          PUBLIC_SITE_URL: " ",
          PLANBOOK_ADDRESS: planBook,
          ERC8004_AGENT_ID: "9"
        },
        agent
      )
    ).toEqual({
      agentUrl: "https://a.example.org",
      siteUrl: null,
      agentId: "9",
      agentAddress: agent,
      planBook,
      planAccount: null,
      repoUrl: null
    });
  });
});

describe("identity and x402 routes", () => {
  const store = {} as AgentStore;
  const get = (pathname: string) => ({
    method: "GET",
    pathname,
    query: new URLSearchParams(),
    headers: new Headers()
  });

  it("serves the registration file at the well-known path and at /identity", async () => {
    const card = buildIdentityCard(config());
    const api = createAgentApi(store, { ownerToken: "t", siteOrigin: "*", identity: card });
    for (const path of ["/.well-known/agent-registration.json", "/identity"]) {
      const response = await api(get(path));
      expect(response.status).toBe(200);
      expect(response.body).toEqual(card);
    }
  });

  it("says plainly when no identity is published", async () => {
    const api = createAgentApi(store, { ownerToken: "t", siteOrigin: "*" });
    const response = await api(get("/identity"));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: "IDENTITY_NOT_PUBLISHED", reason: "This agent has no public identity yet." }
    });
  });

  it("hands /x402/ requests to the seller and adds the site's CORS headers", async () => {
    const seen: string[] = [];
    const api = createAgentApi(store, {
      ownerToken: "t",
      siteOrigin: "https://site.example",
      x402: {
        handle: async (request) => {
          seen.push(request.pathname);
          return { status: 402, headers: { "PAYMENT-REQUIRED": "abc" }, body: {} };
        }
      }
    });
    const response = await api(get("/x402/price/NVDA"));
    expect(seen).toEqual(["/x402/price/NVDA"]);
    expect(response.status).toBe(402);
    expect(response.headers).toMatchObject({
      "PAYMENT-REQUIRED": "abc",
      "access-control-allow-origin": "https://site.example"
    });
    expect(response.headers["access-control-allow-headers"]).toContain("payment-signature");
  });

  it("answers not found for /x402/ when no seller is set up", async () => {
    const api = createAgentApi(store, { ownerToken: "t", siteOrigin: "*" });
    expect((await api(get("/x402/price/NVDA"))).status).toBe(404);
  });
});
