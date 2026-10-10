import { createHmac, randomUUID } from "node:crypto";
import { ClientError } from "./errors.js";

/**
 * Signed client for the Binance Web3 API (https://web3.binance.com/build).
 *
 * Signing follows the published authentication page: the pre-hash is
 * timestamp + METHOD + requestPath + body, where requestPath keeps the /build
 * prefix and the query string exactly as sent, and the signature is the Base64
 * HMAC-SHA256 of that string under the secret key. Every attempt is signed
 * again with a fresh timestamp and nonce, because the gateway rejects replays.
 */
export const BINANCE_WEB3_BASE_URL = "https://web3.binance.com/build";
export const BSC_CHAIN_ID = "56";

const PATH_PREFIX = "/build";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RECV_WINDOW_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;

/** Gateway codes from the authentication and error-code pages. */
export const WEB3_CODE = {
  invalidParams: 40001,
  badKey: 40101,
  badSignature: 40102,
  staleOrReplayed: 40103,
  noPermission: 40104,
  rateLimited: 42900,
  internal: 50000,
  unavailable: 50001
} as const;

export interface Web3Credentials {
  apiKey: string;
  secret: string;
}

/** One call as it went over the wire, without credentials, for the DX log and receipts. */
export interface Web3CallRecord {
  module: Web3Module;
  method: "GET" | "POST";
  path: string;
  at: string;
  attempt: number;
  httpStatus: number | null;
  code: number | null;
  message: string | null;
  latencyMs: number;
  ok: boolean;
}

export type Web3Module = "rwa" | "market" | "trading" | "transaction" | "wallet";

export interface Web3Result<T> {
  data: T;
  serverTime: number | null;
  call: Web3CallRecord;
}

export class Web3ApiError extends ClientError {
  readonly code: number | null;
  readonly httpStatus: number | null;
  constructor(message: string, call: Web3CallRecord) {
    super(call.httpStatus === null ? "transport" : "http", message, { ...call });
    this.name = "Web3ApiError";
    this.code = call.code;
    this.httpStatus = call.httpStatus;
  }
}

export interface BinanceWeb3ClientOptions extends Web3Credentials {
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  sleep?: (ms: number) => Promise<void>;
  recvWindowMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  onCall?: (call: Web3CallRecord) => void;
}

export function signWeb3Request(
  secret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body: string
): string {
  return createHmac("sha256", secret)
    .update(timestamp + method.toUpperCase() + requestPath + body, "utf8")
    .digest("base64");
}

/** Encodes a query once, so the signed path and the sent URL are byte-for-byte the same. */
export function web3Query(params: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export class BinanceWeb3Client {
  private readonly options: Required<
    Omit<BinanceWeb3ClientOptions, "onCall" | "apiKey" | "secret">
  > & { onCall?: (call: Web3CallRecord) => void };
  private readonly credentials: Web3Credentials;
  /** Server time minus local time, learned from a stale-timestamp answer. */
  private clockOffsetMs = 0;

  constructor(options: BinanceWeb3ClientOptions) {
    if (options.apiKey.trim() === "" || options.secret.trim() === "") {
      throw new Error("Binance Web3 API key and secret are required.");
    }
    this.credentials = { apiKey: options.apiKey.trim(), secret: options.secret.trim() };
    this.options = {
      baseUrl: options.baseUrl ?? BINANCE_WEB3_BASE_URL,
      fetch: options.fetch ?? fetch,
      now: options.now ?? Date.now,
      nonce: options.nonce ?? randomUUID,
      sleep: options.sleep ?? defaultSleep,
      recvWindowMs: options.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      ...(options.onCall ? { onCall: options.onCall } : {})
    };
  }

  get<T>(
    module: Web3Module,
    path: string,
    query: Record<string, string | number | boolean | undefined> = {}
  ) {
    return this.request<T>(module, "GET", `${path}${web3Query(query)}`, undefined);
  }

  post<T>(module: Web3Module, path: string, body: unknown) {
    return this.request<T>(module, "POST", path, body);
  }

  private async request<T>(
    module: Web3Module,
    method: "GET" | "POST",
    pathAndQuery: string,
    payload: unknown
  ): Promise<Web3Result<T>> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const requestPath = `${PATH_PREFIX}${pathAndQuery}`;
    const url = `${this.options.baseUrl}${pathAndQuery}`;
    const path = pathAndQuery.split("?")[0]!;
    let skewRetried = false;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const started = this.options.now();
      const timestamp = new Date(started + this.clockOffsetMs).toISOString();
      const headers: Record<string, string> = {
        accept: "application/json",
        "X-OC-APIKEY": this.credentials.apiKey,
        "X-OC-TIMESTAMP": timestamp,
        "X-OC-SIGN": signWeb3Request(this.credentials.secret, timestamp, method, requestPath, body),
        "X-OC-NONCE": this.options.nonce(),
        "X-OC-RECV-WINDOW": String(this.options.recvWindowMs)
      };
      if (body !== "") headers["content-type"] = "application/json";

      const call: Web3CallRecord = {
        module,
        method,
        path,
        at: new Date(started).toISOString(),
        attempt,
        httpStatus: null,
        code: null,
        message: null,
        latencyMs: 0,
        ok: false
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await this.options.fetch(url, {
          method,
          headers,
          ...(body === "" ? {} : { body }),
          signal: controller.signal
        });
        text = await response.text();
      } catch (caught) {
        call.latencyMs = this.options.now() - started;
        call.message = caught instanceof Error ? caught.message : String(caught);
        this.options.onCall?.(call);
        if (attempt < this.options.maxAttempts) {
          await this.options.sleep(500 * attempt);
          continue;
        }
        throw new Web3ApiError(
          `Binance Web3 API ${path} could not be reached: ${call.message}`,
          call
        );
      } finally {
        clearTimeout(timer);
      }

      call.latencyMs = this.options.now() - started;
      call.httpStatus = response.status;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const envelope = isObject(parsed) ? parsed : null;
      const code =
        envelope && typeof envelope.code === "number"
          ? envelope.code
          : envelope
            ? Number(envelope.code)
            : NaN;
      call.code = Number.isFinite(code) ? code : null;
      call.message = envelope && typeof envelope.msg === "string" ? envelope.msg : null;
      const serverTime =
        envelope && typeof envelope.timestamp === "number" ? envelope.timestamp : null;
      // The gateway wraps answers: a non-zero code is a failure even on HTTP 200.
      call.ok = response.ok && call.code === 0 && envelope?.success !== false;
      this.options.onCall?.(call);
      if (call.ok) return { data: envelope!.data as T, serverTime, call };

      if (call.code === WEB3_CODE.staleOrReplayed && !skewRetried && serverTime !== null) {
        // Learn the gateway's clock once and sign again; a fresh nonce avoids the replay check.
        skewRetried = true;
        this.clockOffsetMs = serverTime - this.options.now();
        attempt -= 1;
        continue;
      }
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        call.code === WEB3_CODE.rateLimited ||
        call.code === WEB3_CODE.internal ||
        call.code === WEB3_CODE.unavailable;
      if (retryable && attempt < this.options.maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await this.options.sleep(Math.min(delay, MAX_RETRY_DELAY_MS));
        continue;
      }
      throw new Web3ApiError(
        `Binance Web3 API ${path} answered ${call.httpStatus}` +
          `${call.code === null ? "" : ` code ${call.code}`}${call.message ? `: ${call.message}` : ""}`,
        call
      );
    }
    throw new Error("unreachable");
  }
}
