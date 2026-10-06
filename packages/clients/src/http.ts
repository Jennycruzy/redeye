import type { SourceRecord } from "@redeye/shared";
import { ClientError } from "./errors.js";

export interface JsonRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_DELAY_MS = 15_000;

function retryDelayMs(response: Response, attempt: number, retryBaseMs: number): number {
  const fallback = retryBaseMs * 2 ** attempt;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return Math.min(fallback, MAX_RETRY_DELAY_MS);

  const seconds = Number(retryAfter);
  const parsedDate = Date.parse(retryAfter);
  const retryAfterMs = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Number.isFinite(parsedDate)
      ? Math.max(0, parsedDate - Date.now())
      : 0;
  return Math.min(Math.max(fallback, retryAfterMs), MAX_RETRY_DELAY_MS);
}

function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function requestJson<T>(
  url: string,
  options: JsonRequestOptions = {}
): Promise<SourceRecord<T>> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("HTTP max attempts must be a positive integer.");
  }
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0) {
    throw new Error("HTTP retry base must be a non-negative number.");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const fetchedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < maxAttempts) {
          await sleep(retryDelayMs(response, attempt, retryBaseMs));
          continue;
        }
        throw new ClientError("shape", "Source response was not valid JSON.", {
          url,
          status: response.status,
          bodyPreview: text.slice(0, 200)
        });
      }

      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < maxAttempts) {
          await sleep(retryDelayMs(response, attempt, retryBaseMs));
          continue;
        }
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
      if (attempt + 1 < maxAttempts) {
        await sleep(retryBaseMs * 2 ** attempt);
        continue;
      }
      throw new ClientError("transport", "Source request failed.", {
        url,
        method,
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ClientError("transport", "Source request exhausted its attempts.", { url, method });
}
