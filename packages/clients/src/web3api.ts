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
  /** B402 only: the business code exactly as returned ("000000000" is success). */
  businessCode?: string | null;
}

export type Web3Module = "rwa" | "market" | "trading" | "transaction" | "wallet" | "b402";

/**
 * B402, Binance's x402 facilitator, reached through the same signed /build gateway as the
 * other modules. Its bodies are wrapped as {"body": inner}, and success is the business
 * code "000000000" rather than 0. This is not the merchant (OnchainPay) facilitator that
 * @bnb-chain/b402's B402Client signs with an RSA key at a per-merchant /papi base URL.
 */
export const B402_SUCCESS_CODE = "000000000";
export const B402_PATHS = {
  supported: "/api/v2/b402/supported",
  verify: "/api/v2/b402/verify",
  settle: "/api/v2/b402/settle"
} as const;

export interface B402SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra: Record<string, unknown>;
}

export interface B402Supported {
  kinds: B402SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

export interface B402Verify {
  isValid: boolean;
  payer: string;
  invalidReason?: string;
  invalidMessage?: string;
}

export interface B402Settle {
  success: boolean;
  /** On-chain transaction hash; "" when nothing was broadcast. */
  transaction: string;
  payer: string;
  network: string;
  amount?: string;
  errorReason?: string;
  errorMessage?: string;
}

interface RequestOptions {
  listener?: ((call: Web3CallRecord) => void) | undefined;
  /** "b402" accepts only the business code "000000000" as success. */
  expect?: "web3" | "b402";
  /**
   * False: never resend after the request may have been processed (timeouts, 5xx, rate
   * limits). A stale-timestamp refusal is still re-signed, since the gateway rejected it
   * before doing anything.
   */
  retry?: boolean;
}

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
  ): Promise<Web3Result<T>> {
    return this.request<T>(module, "GET", `${path}${web3Query(query)}`, undefined);
  }

  post<T>(module: Web3Module, path: string, body: unknown): Promise<Web3Result<T>> {
    return this.request<T>(module, "POST", path, body);
  }

  /** The payment kinds and signer addresses B402 offers to this key. */
  async b402Supported(): Promise<Web3Result<B402Supported>> {
    const result = await this.request<unknown>(
      "b402",
      "POST",
      B402_PATHS.supported,
      { body: {} },
      {
        expect: "b402"
      }
    );
    return { ...result, data: parseB402Supported(result.data) };
  }

  /** Off-chain check of a signed payment. Moves nothing. */
  async b402Verify(
    paymentPayload: unknown,
    paymentRequirements: unknown
  ): Promise<Web3Result<B402Verify>> {
    const result = await this.request<unknown>(
      "b402",
      "POST",
      B402_PATHS.verify,
      { body: { x402Version: 2, paymentPayload, paymentRequirements } },
      { expect: "b402" }
    );
    return { ...result, data: parseB402Verify(result.data) };
  }

  /** Settles a signed payment on chain. Irreversible, so it is never resent blindly. */
  async b402Settle(
    paymentPayload: unknown,
    paymentRequirements: unknown
  ): Promise<Web3Result<B402Settle>> {
    const result = await this.request<unknown>(
      "b402",
      "POST",
      B402_PATHS.settle,
      { body: { x402Version: 2, paymentPayload, paymentRequirements } },
      { expect: "b402", retry: false }
    );
    return { ...result, data: parseB402Settle(result.data) };
  }

  /** The same client, also reporting each call to `listener` (one trade's own calls). */
  withRecorder(listener: (call: Web3CallRecord) => void): Pick<BinanceWeb3Client, "get" | "post"> {
    return {
      get: <T>(
        module: Web3Module,
        path: string,
        query: Record<string, string | number | boolean | undefined> = {}
      ) => this.request<T>(module, "GET", `${path}${web3Query(query)}`, undefined, { listener }),
      post: <T>(module: Web3Module, path: string, body: unknown) =>
        this.request<T>(module, "POST", path, body, { listener })
    } as Pick<BinanceWeb3Client, "get" | "post">;
  }

  private async request<T>(
    module: Web3Module,
    method: "GET" | "POST",
    pathAndQuery: string,
    payload: unknown,
    options: RequestOptions = {}
  ): Promise<Web3Result<T>> {
    const { listener } = options;
    const b402 = options.expect === "b402";
    const mayRetry = options.retry !== false;
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
        listener?.(call);
        if (mayRetry && attempt < this.options.maxAttempts) {
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
      if (b402) {
        // Gateway refusals keep the numeric code (40104 and so on); B402's own answers carry a
        // string business code, and only the exact success string counts.
        const raw = envelope?.code;
        call.businessCode = raw === undefined || raw === null ? null : String(raw);
        if (call.message === null && envelope && typeof envelope.message === "string") {
          call.message = envelope.message;
        }
        call.ok = response.ok && raw === B402_SUCCESS_CODE && envelope?.success !== false;
      } else {
        // The gateway wraps answers: a non-zero code is a failure even on HTTP 200.
        call.ok = response.ok && call.code === 0 && envelope?.success !== false;
      }
      this.options.onCall?.(call);
      listener?.(call);
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
      if (mayRetry && retryable && attempt < this.options.maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await this.options.sleep(Math.min(delay, MAX_RETRY_DELAY_MS));
        continue;
      }
      const shownCode = b402 ? call.businessCode : call.code;
      throw new Web3ApiError(
        `Binance Web3 API ${path} answered ${call.httpStatus}` +
          `${shownCode === null || shownCode === undefined ? "" : ` code ${shownCode}`}` +
          `${call.message ? `: ${call.message}` : ""}`,
        call
      );
    }
    throw new Error("unreachable");
  }
}

function b402Shape(what: string, problem: string): Error {
  return new Error(`B402 ${what} answer is not the expected shape: ${problem}.`);
}

function optionalText(value: unknown, field: string, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw b402Shape(what, `${field} is not text`);
  return value;
}

export function parseB402Supported(data: unknown): B402Supported {
  if (!isObject(data)) throw b402Shape("supported", "data is not an object");
  if (!Array.isArray(data.kinds)) throw b402Shape("supported", "kinds is not a list");
  const kinds = data.kinds.map((kind, index): B402SupportedKind => {
    if (!isObject(kind)) throw b402Shape("supported", `kinds[${index}] is not an object`);
    if (typeof kind.x402Version !== "number") {
      throw b402Shape("supported", `kinds[${index}].x402Version is not a number`);
    }
    if (typeof kind.scheme !== "string" || typeof kind.network !== "string") {
      throw b402Shape("supported", `kinds[${index}] has no scheme or network`);
    }
    return {
      x402Version: kind.x402Version,
      scheme: kind.scheme,
      network: kind.network,
      extra: isObject(kind.extra) ? kind.extra : {}
    };
  });
  const extensions = Array.isArray(data.extensions)
    ? data.extensions.filter((e): e is string => typeof e === "string")
    : [];
  const signers: Record<string, string[]> = {};
  if (isObject(data.signers)) {
    for (const [key, list] of Object.entries(data.signers)) {
      if (Array.isArray(list))
        signers[key] = list.filter((a): a is string => typeof a === "string");
    }
  }
  return { kinds, extensions, signers };
}

export function parseB402Verify(data: unknown): B402Verify {
  if (!isObject(data)) throw b402Shape("verify", "data is not an object");
  if (typeof data.isValid !== "boolean") throw b402Shape("verify", "isValid is not true or false");
  const invalidReason = optionalText(data.invalidReason, "invalidReason", "verify");
  const invalidMessage = optionalText(data.invalidMessage, "invalidMessage", "verify");
  return {
    isValid: data.isValid,
    payer: optionalText(data.payer, "payer", "verify") ?? "",
    ...(invalidReason === undefined ? {} : { invalidReason }),
    ...(invalidMessage === undefined ? {} : { invalidMessage })
  };
}

export function parseB402Settle(data: unknown): B402Settle {
  if (!isObject(data)) throw b402Shape("settle", "data is not an object");
  if (typeof data.success !== "boolean") throw b402Shape("settle", "success is not true or false");
  const amount = optionalText(data.amount, "amount", "settle");
  const errorReason = optionalText(data.errorReason, "errorReason", "settle");
  const errorMessage = optionalText(data.errorMessage, "errorMessage", "settle");
  return {
    success: data.success,
    transaction: optionalText(data.transaction, "transaction", "settle") ?? "",
    payer: optionalText(data.payer, "payer", "settle") ?? "",
    network: optionalText(data.network, "network", "settle") ?? "",
    ...(amount === undefined ? {} : { amount }),
    ...(errorReason === undefined ? {} : { errorReason }),
    ...(errorMessage === undefined ? {} : { errorMessage })
  };
}
