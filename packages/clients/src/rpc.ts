import { ClientError } from "./errors.js";
import { requestJson } from "./http.js";

export interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export async function callRpc<T>(
  url: string,
  method: string,
  params: readonly unknown[] = []
): Promise<T> {
  const record = await requestJson<JsonRpcSuccess<T> | JsonRpcFailure>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { jsonrpc: "2.0", id: 1, method, params }
  });
  const body = record.response.body;
  if ("error" in body) {
    throw new ClientError("http", `BSC RPC method ${method} failed: ${body.error.message}.`, {
      method,
      error: body.error
    });
  }
  if (!("result" in body)) {
    throw new ClientError("shape", `BSC RPC method ${method} returned no result.`, { method });
  }
  return body.result;
}
