import type { IncomingMessage, ServerResponse } from "node:http";
export interface AgentStore {
  health(): Promise<unknown>;
  study(): Promise<unknown>;
  calendar(days: number): Promise<unknown>;
  prices(tickers: string[]): Promise<unknown>;
  windows(ticker: string): Promise<unknown>;
  feed(since: string | null): Promise<unknown>;
  token(ticker: string): Promise<unknown>;
  history(ticker: string): Promise<unknown>;
  record(): Promise<unknown>;
  wallet(): Promise<unknown>;
  planGet(id: string): Promise<unknown>;
  run(runId: string): Promise<unknown>;
  runEvents(runId: string): Promise<unknown>;
  receipt(runId: string): Promise<unknown>;
  replay(body: unknown): Promise<unknown>;
  authSignin(body: unknown): Promise<unknown>;
  authVerify(qrCodeId: string): Promise<unknown>;
  planDraft(body: unknown): Promise<unknown>;
  planAction(id: string, body: unknown): Promise<unknown>;
  standingCreate(body: unknown): Promise<unknown>;
  standingStop(id: string): Promise<unknown>;
  standingGet(id: string): Promise<unknown>;
}

export interface AgentApiConfig {
  ownerToken: string;
  siteOrigin: string;
  /** ERC-8004 registration file; absent until the agent has a public address. */
  identity?: unknown;
  /** A2A: the agent card and JSON-RPC at /a2a, served by the official SDK; absent when off. */
  a2a?: (request: IncomingMessage, response: ServerResponse) => void;
  /** The 24/7 price through one off-hours window, for the site's night strip. */
  night?: (ticker: string, closeTs?: number) => Promise<unknown>;
  /** Checks a plan against the next lockable window; saves nothing. */
  preview?: (input: Record<string, unknown>) => Promise<unknown>;
  /** MCP over streamable HTTP at /mcp; absent when not set up. */
  mcp?: (request: Request, parsedBody: unknown) => Promise<Response>;
  /** x402 sales under /x402/; absent when the seller is not set up. */
  x402?: { handle(request: AgentRequest): Promise<AgentResponse> };
}

export interface AgentRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Headers;
  body?: unknown;
}

export interface AgentResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
