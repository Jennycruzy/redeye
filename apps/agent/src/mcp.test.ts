import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type McpSources } from "./mcp.js";
import { createAgentServer } from "./server.js";
import type { AgentStore } from "./types.js";

const calls: string[] = [];
const sources: McpSources = {
  prices: async (tickers) => {
    calls.push(`prices:${tickers.join(",")}`);
    return { items: [{ ticker: tickers[0], state: "ok" }] };
  },
  windows: async (ticker) => ({ ticker, items: [{ kind: "overnight" }] }),
  record: async () => ({ items: [{ planId: 1, outcome: null }] }),
  planGet: async (id) => {
    if (id !== "plan-1") throw new Error("The requested plan does not exist.");
    return { id, status: "locked" };
  },
  receipt: async () => {
    throw new Error("RECEIPT_NOT_FOUND");
  },
  preview: async (input) => ({
    valid: true,
    issues: [],
    promise: `checked ${String(input.ticker)}`
  })
};

async function connect(): Promise<Client> {
  const handle = createMcpHandler(sources, "test");
  const transport = new StreamableHTTPClientTransport(new URL("http://agent.test/mcp"), {
    // Routes the official client's requests straight into the handler.
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const text = await request.clone().text();
      return handle(request, text ? JSON.parse(text) : undefined);
    }
  });
  const client = new Client({ name: "test", version: "1" });
  // The SDK's own transport types its sessionId as optional, which strict optional property
  // checking reads as a mismatch with the Transport interface; the object is the SDK's.
  await client.connect(transport as Transport);
  return client;
}

function result(response: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const [first] = response.content as Array<{ type: string; text: string }>;
  return JSON.parse(first!.text);
}

describe("MCP server", () => {
  it("lists the five tools from the spec, all marked read-only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "redeye_plan_draft",
      "redeye_price",
      "redeye_record",
      "redeye_run",
      "redeye_windows"
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  it("returns the price for an upper-cased ticker", async () => {
    const client = await connect();
    const response = await client.callTool({ name: "redeye_price", arguments: { ticker: "nvda" } });
    expect(result(response)).toEqual({ items: [{ ticker: "NVDA", state: "ok" }] });
    expect(calls).toContain("prices:NVDA");
    await client.close();
  });

  it("returns a plan with no receipt while it is still running", async () => {
    const client = await connect();
    const response = await client.callTool({ name: "redeye_run", arguments: { id: "plan-1" } });
    expect(result(response)).toEqual({ plan: { id: "plan-1", status: "locked" }, receipt: null });
    await client.close();
  });

  it("reports an unknown plan as a tool error", async () => {
    const client = await connect();
    const response = await client.callTool({ name: "redeye_run", arguments: { id: "nope" } });
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: "The requested plan does not exist." }
    ]);
    await client.close();
  });

  it("checks a plan draft without saving it", async () => {
    const client = await connect();
    const response = await client.callTool({
      name: "redeye_plan_draft",
      arguments: { ticker: "nvda", kind: "guard", heldShares: "2", params: { triggerDropPct: "3" } }
    });
    expect(result(response)).toEqual({ valid: true, issues: [], promise: "checked NVDA" });
    await client.close();
  });

  it("rejects a malformed ticker before reading anything", async () => {
    const client = await connect();
    const before = calls.length;
    const response = await client.callTool({
      name: "redeye_price",
      arguments: { ticker: "../etc" }
    });
    expect(response.isError).toBe(true);
    expect(calls.length).toBe(before);
    await client.close();
  });
});

describe("MCP on the agent's HTTP server", () => {
  it("answers the official client over real HTTP at /mcp", async () => {
    const health = { state: "ok" };
    const server = createAgentServer({ health: async () => health } as unknown as AgentStore, {
      ownerToken: "t",
      siteOrigin: "*",
      mcp: createMcpHandler(sources, "test")
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: "test", version: "1" });
      await client.connect(transport as Transport);
      const response = await client.callTool({ name: "redeye_record", arguments: {} });
      expect(result(response)).toEqual({ items: [{ planId: 1, outcome: null }] });
      await client.close();
      const other = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await other.json()).toEqual(health);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
