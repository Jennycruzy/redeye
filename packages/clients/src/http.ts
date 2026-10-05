import type { SourceRecord } from "@redeye/shared";
import { ClientError } from "./errors.js";

export interface JsonRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export async function requestJson<T>(
  url: string,
  options: JsonRequestOptions = {}
): Promise<SourceRecord<T>> {
  const method = options.method ?? "GET";
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const request: RequestInit = {
      method,
      headers: {
        accept: "application/json",
        "user-agent": "Redeye/0.1 (+public-source-client)",
        ...options.headers
      },
      signal: controller.signal
    };
    if (options.body !== undefined) request.body = JSON.stringify(options.body);

    const response = await fetch(url, request);

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ClientError("shape", "Source response was not valid JSON.", {
        url,
        status: response.status,
        bodyPreview: text.slice(0, 200)
      });
    }

    if (!response.ok) {
      throw new ClientError("http", `Source returned HTTP ${response.status}.`, {
        url,
        status: response.status,
        body
      });
    }

    return {
      v: 1,
      fetchedAt,
      completedAt: new Date().toISOString(),
      request: { method, url },
      response: { status: response.status, ok: response.ok, body: body as T }
    };
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError("transport", "Source request failed.", {
      url,
      method,
      reason: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timeout);
  }
}
