import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Role, type Message, type Part } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askFromMessage, createA2aHandler, type A2aSources } from "./a2a.js";
import { createAgentServer } from "./server.js";
import type { AgentStore } from "./types.js";

const previews: Record<string, unknown>[] = [];
const sources: A2aSources = {
  prices: async (tickers) => ({ items: [{ ticker: tickers[0], state: "ok" }] }),
  windows: async (ticker) => ({ ticker, items: [{ kind: "overnight" }] }),
  record: async () => ({ items: [{ planId: 1, outcome: null }] }),
  planGet: async (id) => {
    if (id !== "plan-1") throw new Error("The requested plan does not exist.");
    return { id, status: "decided" };
  },
  receipt: async () => {
    throw new Error("RECEIPT_NOT_FOUND");
  },
  preview: async (input) => {
    previews.push(input);
    return { valid: true, issues: [], promise: `checked ${String(input.ticker)}` };
  }
};

function part(content: Part["content"]): Part {
  return { content, metadata: undefined, filename: "", mediaType: "" };
}

function userMessage(...parts: Part[]): Message {
  return {
    messageId: randomUUID(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

const text = (value: string) => part({ $case: "text", value });
const data = (value: unknown) => part({ $case: "data", value });

describe("reading what an A2A caller asks for", () => {
  it("reads short text commands and JSON sent as text", () => {
    expect(askFromMessage(userMessage(text("price nvda")))).toEqual({
      skill: "price",
      ticker: "NVDA"
    });
    expect(askFromMessage(userMessage(text("  record ")))).toEqual({ skill: "record" });
    expect(askFromMessage(userMessage(text('{"skill":"windows","ticker":"tsla"}')))).toEqual({
      skill: "windows",
      ticker: "TSLA"
    });
  });

  it("prefers a data part over text", () => {
    expect(
      askFromMessage(userMessage(text("record"), data({ skill: "run", id: "plan-1" })))
    ).toEqual({ skill: "run", id: "plan-1" });
  });

  it("explains a request it cannot read", () => {
    expect(() => askFromMessage(userMessage(text("buy me NVDA")))).toThrow("Ask for one of:");
    expect(() => askFromMessage(userMessage(text("price")))).toThrow("A ticker such as NVDA");
    expect(() => askFromMessage(userMessage(text("{not json")))).toThrow("does not parse");
    expect(() =>
      askFromMessage(userMessage(data({ skill: "plan_check", plan: { ticker: "NVDA" } })))
    ).toThrow("plan.kind must be one of");
    expect(() => askFromMessage(userMessage())).toThrow("no text or data part");
  });
});

describe("A2A on the agent's HTTP server", () => {
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const health = { state: "ok" };
    // The card must name the address the server really listens on, so it is built after listen.
    let a2a: ReturnType<typeof createA2aHandler> | null = null;
    const server = createAgentServer({ health: async () => health } as unknown as AgentStore, {
      ownerToken: "t",
      siteOrigin: "*",
      a2a: (request, response) => a2a!(request, response)
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    a2a = createA2aHandler(sources, base, "test");
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => close());

  it("serves a v1.0 card that names its JSON-RPC door and every skill", async () => {
    const response = await fetch(`${base}/.well-known/agent-card.json`, {
      headers: { "A2A-Version": "1.0" }
    });
    expect(response.status).toBe(200);
    const card = (await response.json()) as {
      supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
      skills: Array<{ id: string }>;
      capabilities: { streaming: boolean };
    };
    expect(card.supportedInterfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: `${base}/a2a`,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0"
        }),
        expect.objectContaining({
          url: `${base}/a2a`,
          protocolBinding: "JSONRPC",
          protocolVersion: "0.3"
        })
      ])
    );
    expect(card.skills.map((skill) => skill.id)).toEqual([
      "price",
      "windows",
      "record",
      "run",
      "plan_check"
    ]);
    expect(card.capabilities.streaming).toBe(false);
  });

  it("serves a v0.3 card to callers that send no version", async () => {
    const card = (await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as {
      url: string;
      protocolVersion: string;
      skills: unknown[];
    };
    expect(card.url).toBe(`${base}/a2a`);
    expect(card.protocolVersion).toMatch(/^0\.3/);
    expect(card.skills).toHaveLength(5);
  });

  it("answers the official client with a sentence and the data", async () => {
    const client = await new ClientFactory().createFromUrl(base);
    const reply = await client.sendMessage({
      tenant: "",
      message: userMessage(text("price nvda")),
      configuration: undefined,
      metadata: undefined
    });
    expect("parts" in reply).toBe(true);
    const message = reply as Message;
    expect(message.role).toBe(Role.ROLE_AGENT);
    expect(message.metadata).toEqual({ skill: "price", ok: true });
    expect(message.parts.map((p) => p.content)).toEqual([
      { $case: "text", value: "Latest checked prices for NVDA." },
      { $case: "data", value: { items: [{ ticker: "NVDA", state: "ok" }] } }
    ]);
  });

  it("checks a plan sent as a data part without saving it", async () => {
    const client = await new ClientFactory().createFromUrl(base);
    const plan = { ticker: "nvda", kind: "guard", heldShares: "0.5", params: { sellPct: "50" } };
    const reply = (await client.sendMessage({
      tenant: "",
      message: userMessage(data({ skill: "plan_check", plan })),
      configuration: undefined,
      metadata: undefined
    })) as Message;
    expect(previews.at(-1)).toEqual({ ...plan, ticker: "NVDA" });
    expect(reply.parts[1]?.content).toEqual({
      $case: "data",
      value: { valid: true, issues: [], promise: "checked NVDA" }
    });
  });

  it("says plainly when a source fails", async () => {
    const client = await new ClientFactory().createFromUrl(base);
    const reply = (await client.sendMessage({
      tenant: "",
      message: userMessage(text("run missing")),
      configuration: undefined,
      metadata: undefined
    })) as Message;
    expect(reply.metadata).toEqual({ ok: false, reason: "SOURCE_FAILED" });
    expect(reply.parts.map((p) => p.content)).toEqual([
      { $case: "text", value: "The requested plan does not exist." }
    ]);
  });

  it("answers a raw v1.0 SendMessage", async () => {
    const response = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "SendMessage",
        params: {
          message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "windows NVDA" }] }
        }
      })
    });
    const body = (await response.json()) as {
      id: number;
      result: { message: { role: string; parts: Array<{ text?: string; data?: unknown }> } };
    };
    expect(body.id).toBe(7);
    expect(body.result.message.role).toBe("ROLE_AGENT");
    expect(body.result.message.parts).toEqual([
      expect.objectContaining({ text: "Off-hours windows for NVDA." }),
      expect.objectContaining({ data: { ticker: "NVDA", items: [{ kind: "overnight" }] } })
    ]);
  });

  it("answers a raw v0.3 message/send from a caller that sends no version", async () => {
    const response = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "r-1",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "m-2",
            role: "user",
            parts: [{ kind: "text", text: "record" }]
          }
        }
      })
    });
    const body = (await response.json()) as {
      result: { kind: string; role: string; parts: Array<{ kind: string; data?: unknown }> };
    };
    expect(body.result.kind).toBe("message");
    expect(body.result.role).toBe("agent");
    expect(body.result.parts).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "Every plan Redeye has locked, with its result."
      }),
      expect.objectContaining({ kind: "data", data: { items: [{ planId: 1, outcome: null }] } })
    ]);
  });

  it("leaves the rest of the API to the agent's own routes", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ state: "ok" });
  });
});
