import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { PlanPreview } from "./plan-service.js";

/** What the MCP tools read. Every tool is read-only; the draft tool saves nothing. */
export interface McpSources {
  prices(tickers: string[]): Promise<unknown>;
  windows(ticker: string): Promise<unknown>;
  record(): Promise<unknown>;
  planGet(id: string): Promise<unknown>;
  receipt(id: string): Promise<unknown>;
  preview(input: Record<string, unknown>): Promise<PlanPreview>;
}

const ticker = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9.-]{0,14}$/, "A US stock ticker such as NVDA.")
  .transform((value) => value.toUpperCase());

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { result: value }
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) }
    ]
  };
}

function server(sources: McpSources, version: string): McpServer {
  const mcp = new McpServer({ name: "redeye", version });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  mcp.registerTool(
    "redeye_price",
    {
      title: "24/7 price",
      description:
        "Latest checked prices for a tokenized US stock on BNB Chain: the last official close, the 24/7 price, the token price, the gaps between them, their ages and sources.",
      inputSchema: { ticker },
      annotations: readOnly
    },
    async (args) => {
      try {
        return json(await sources.prices([args.ticker]));
      } catch (error) {
        return failure(error);
      }
    }
  );

  mcp.registerTool(
    "redeye_windows",
    {
      title: "Off-hours windows",
      description:
        "Off-hours windows (overnight, weekend, holiday) for a stock, each with its close time and the next official open.",
      inputSchema: { ticker },
      annotations: readOnly
    },
    async (args) => {
      try {
        return json(await sources.windows(args.ticker));
      } catch (error) {
        return failure(error);
      }
    }
  );

  mcp.registerTool(
    "redeye_record",
    {
      title: "Public record",
      description:
        "Every plan Redeye has locked: the promise, when it was locked before the close, its result at the open, and the chain transactions.",
      annotations: readOnly
    },
    async () => {
      try {
        return json(await sources.record());
      } catch (error) {
        return failure(error);
      }
    }
  );

  mcp.registerTool(
    "redeye_run",
    {
      title: "One plan",
      description:
        "One plan by id with its receipt when finished. The receipt can be checked by anyone with `npm run verify`.",
      inputSchema: { id: z.string().min(1).max(64) },
      annotations: readOnly
    },
    async (args) => {
      try {
        const plan = await sources.planGet(args.id);
        const receipt = await sources.receipt(args.id).catch(() => null);
        return json({ plan, receipt });
      } catch (error) {
        return failure(error);
      }
    }
  );

  mcp.registerTool(
    "redeye_plan_draft",
    {
      title: "Check a plan",
      description:
        "Checks an off-hours plan against tonight's window and returns the promise it would make, its fingerprint and the lock deadline. Nothing is saved or locked.",
      inputSchema: {
        ticker,
        kind: z.enum(["guard", "buy_dip", "sell_rise", "hold"]),
        heldShares: z.string().regex(/^\d+(\.\d+)?$/, "A share count such as 0.5."),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.null()]))
      },
      annotations: readOnly
    },
    async (args) => {
      try {
        return json(await sources.preview({ ...args }));
      } catch (error) {
        return failure(error);
      }
    }
  );

  return mcp;
}

/**
 * MCP over streamable HTTP, stateless: each request gets its own server and transport, and
 * answers are plain JSON, so nothing is held between requests.
 */
export function createMcpHandler(sources: McpSources, version: string) {
  return async function handle(request: Request, parsedBody: unknown): Promise<Response> {
    // No session id generator means stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = server(sources, version);
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody });
    } finally {
      await mcp.close();
    }
  };
}
