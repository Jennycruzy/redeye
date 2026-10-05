import type { SourceRecord, XyzCandle, XyzEquityPrice } from "@redeye/shared";
import { ClientError } from "./errors.js";
import { requestJson } from "./http.js";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const DEFAULT_REAL_PRICE_MAX_AGE_SECONDS = 120;
export const MAX_REAL_PRICE_CLOSE_DEVIATION_PCT = 25;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientError("shape", `Missing or invalid ${field}.`, { field, value });
  }
  return value;
}

function decimalString(value: unknown, field: string, allowZero = false): string {
  const text = requiredString(value, field);
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new ClientError("shape", `${field} is not an unsigned decimal string.`, { field, value });
  }
  const number = Number(text);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new ClientError(
      "shape",
      `${field} is not a valid ${allowZero ? "non-negative" : "positive"} decimal.`,
      {
        field,
        value
      }
    );
  }
  return text;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ClientError("shape", `${field} is not a non-negative integer.`, { field, value });
  }
  return value;
}

function coinForTicker(ticker: string): string {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) {
    throw new ClientError("shape", "Ticker must be uppercase for the xyz market.", { ticker });
  }
  return `xyz:${ticker}`;
}

export function parseXyzEquityPrices(record: SourceRecord<unknown>): XyzEquityPrice[] {
  const body = record.response.body;
  if (!Array.isArray(body) || body.length !== 2 || !isObject(body[0]) || !Array.isArray(body[1])) {
    throw new ClientError(
      "shape",
      "Hyperliquid metaAndAssetCtxs response must be [meta, contexts]."
    );
  }
  const universe = body[0].universe;
  const contexts = body[1];
  if (!Array.isArray(universe) || universe.length !== contexts.length) {
    throw new ClientError("shape", "Hyperliquid universe and context lengths do not match.", {
      universeLength: Array.isArray(universe) ? universe.length : null,
      contextLength: contexts.length
    });
  }

  return universe.map((asset, index) => {
    const context = contexts[index];
    if (!isObject(asset) || !isObject(context)) {
      throw new ClientError("shape", "Hyperliquid asset or context is not an object.", { index });
    }
    const coin = requiredString(asset.name, `universe[${index}].name`);
    if (!coin.startsWith("xyz:")) {
      throw new ClientError("shape", "Hyperliquid xyz response contains a non-xyz coin.", {
        index,
        coin
      });
    }
    const markPrice = decimalString(context.markPx, `contexts[${index}].markPx`);
    const midPrice =
      context.midPx === null ? null : decimalString(context.midPx, `contexts[${index}].midPx`);
    return {
      ticker: coin.slice(4),
      coin,
      midPrice,
      markPrice,
      price: midPrice ?? markPrice,
      dayNotionalVolumeUsd: decimalString(context.dayNtlVlm, `contexts[${index}].dayNtlVlm`, true),
      fetchedAt: record.fetchedAt,
      source: `hyperliquid:${coin}`
    } satisfies XyzEquityPrice;
  });
}

export function assertUsableXyzPrice(
  price: XyzEquityPrice,
  lastUsClose: string,
  checkedAtMs: number,
  maxAgeSeconds = DEFAULT_REAL_PRICE_MAX_AGE_SECONDS
): XyzEquityPrice {
  const close = Number(decimalString(lastUsClose, "lastUsClose"));
  const current = Number(decimalString(price.price, "price"));
  const fetchedAtMs = Date.parse(price.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    throw new ClientError("shape", "Hyperliquid fetchedAt is not an ISO timestamp.", {
      fetchedAt: price.fetchedAt
    });
  }
  const ageSeconds = (checkedAtMs - fetchedAtMs) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
    throw new ClientError("shape", "Hyperliquid price is missing a valid fresh fetch time.", {
      ageSeconds,
      maxAgeSeconds
    });
  }
  const deviationPct = (Math.abs(current - close) / close) * 100;
  if (deviationPct >= MAX_REAL_PRICE_CLOSE_DEVIATION_PCT) {
    throw new ClientError("shape", "Hyperliquid price failed the US-close unit check.", {
      ticker: price.ticker,
      price: price.price,
      lastUsClose,
      deviationPct
    });
  }
  return price;
}

export function parseXyzCandles(record: SourceRecord<unknown>): XyzCandle[] {
  const body = record.response.body;
  if (!Array.isArray(body)) {
    throw new ClientError("shape", "Hyperliquid candle response is not an array.");
  }
  return body.map((value, index) => {
    if (!isObject(value)) {
      throw new ClientError("shape", "Hyperliquid candle is not an object.", { index });
    }
    const openTimeMs = integer(value.t, `candles[${index}].t`);
    const closeTimeMs = integer(value.T, `candles[${index}].T`);
    if (closeTimeMs <= openTimeMs) {
      throw new ClientError("shape", "Hyperliquid candle close time must follow open time.", {
        index,
        openTimeMs,
        closeTimeMs
      });
    }
    return {
      coin: requiredString(value.s, `candles[${index}].s`),
      interval: requiredString(value.i, `candles[${index}].i`),
      openTimeMs,
      closeTimeMs,
      open: decimalString(value.o, `candles[${index}].o`),
      high: decimalString(value.h, `candles[${index}].h`),
      low: decimalString(value.l, `candles[${index}].l`),
      close: decimalString(value.c, `candles[${index}].c`),
      volume: decimalString(value.v, `candles[${index}].v`, true),
      trades: integer(value.n, `candles[${index}].n`)
    } satisfies XyzCandle;
  });
}

export async function fetchXyzEquityPrices(): Promise<SourceRecord<unknown>> {
  return requestJson<unknown>(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { type: "metaAndAssetCtxs", dex: "xyz" }
  });
}

export async function fetchXyzCandles(
  ticker: string,
  interval: string,
  startTimeMs: number,
  endTimeMs: number
): Promise<SourceRecord<unknown>> {
  if (!/^\d+[mhdwM]$/.test(interval)) {
    throw new ClientError("shape", "Hyperliquid candle interval is invalid.", { interval });
  }
  if (!Number.isInteger(startTimeMs) || !Number.isInteger(endTimeMs) || endTimeMs <= startTimeMs) {
    throw new ClientError("shape", "Hyperliquid candle range is invalid.", {
      startTimeMs,
      endTimeMs
    });
  }
  return requestJson<unknown>(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      type: "candleSnapshot",
      req: { coin: coinForTicker(ticker), interval, startTime: startTimeMs, endTime: endTimeMs }
    }
  });
}
