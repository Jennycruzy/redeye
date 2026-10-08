import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAgentApi } from "./api.js";
import type { AgentApiConfig, AgentStore } from "./types.js";

const MAX_BODY_BYTES = 1_048_576;

function requestHeaders(request: IncomingMessage): Headers {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") entries.push([name, value]);
    if (Array.isArray(value)) entries.push([name, value.join(",")]);
  }
  return new Headers(entries);
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS")
    return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds the 1 MiB limit.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function send(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown
): void {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.statusCode = status;
  if (status === 204) {
    response.end();
    return;
  }
  const encoded = JSON.stringify(body);
  if (encoded === undefined) {
    response.statusCode = 500;
    response.end(
      JSON.stringify({
        error: { code: "EMPTY_RESPONSE", reason: "The agent returned no JSON body." }
      })
    );
    return;
  }
  response.end(encoded);
}

export function createAgentServer(store: AgentStore, config: AgentApiConfig) {
  const handle = createAgentApi(store, config);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/mcp" && config.mcp) {
        const headers = requestHeaders(request);
        const body = await requestBody(request);
        const answer = await config.mcp(
          new Request(url, { method: request.method ?? "GET", headers }),
          body
        );
        response.statusCode = answer.status;
        answer.headers.forEach((value, name) => response.setHeader(name, value));
        response.end(await answer.text());
        return;
      }
      const result = await handle({
        method: request.method ?? "GET",
        pathname: url.pathname,
        query: url.searchParams,
        headers: requestHeaders(request),
        body: await requestBody(request)
      });
      send(response, result.status, result.headers, result.body);
    } catch (caught) {
      const reason =
        caught instanceof Error ? caught.message : "The request failed without a reason.";
      send(
        response,
        400,
        { "content-type": "application/json; charset=utf-8" },
        {
          error: { code: "INVALID_REQUEST", reason }
        }
      );
    }
  });
}

export function startAgentServer(
  store: AgentStore,
  config: AgentApiConfig,
  port: number
): ReturnType<typeof createServer> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Agent port must be a valid TCP port.");
  const server = createAgentServer(store, config);
  server.listen(port);
  return server;
}
