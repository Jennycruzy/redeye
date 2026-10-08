import type { NasdaqEarningsRow, SourceRecord } from "@redeye/shared";
import { ClientError } from "./errors.js";
import { requestJson } from "./http.js";

export const NASDAQ_EARNINGS_URL = "https://api.nasdaq.com/api/calendar/earnings";
export const NASDAQ_HISTORICAL_URL = "https://api.nasdaq.com/api/quote";
export const NASDAQ_CHART_URL = "https://api.nasdaq.com/api/quote";

export interface NasdaqDailyPrice {
  date: string;
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;
}

export interface NasdaqChartPoint {
  sourceX: number;
  atMs: number;
  localDateTime: string;
  price: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredPositivePrice(value: unknown, field: string, index?: number): string {
  if (typeof value !== "string") {
    throw new ClientError("shape", `Nasdaq ${field} is missing or invalid.`, {
      field,
      index,
      value
    });
  }
  const normalized = value.replace(/[ $,]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || Number(normalized) <= 0) {
    throw new ClientError("shape", `Nasdaq ${field} is not a positive price.`, {
      field,
      index,
      value
    });
  }
  return normalized;
}

function requiredText(value: unknown, field: string, index?: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientError("shape", `Nasdaq ${field} is missing or invalid.`, {
      field,
      index,
      value
    });
  }
  return value;
}

function requiredInteger(value: unknown, field: string, index?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ClientError("shape", `Nasdaq ${field} is missing or invalid.`, {
      field,
      index,
      value
    });
  }
  return value;
}

function localWallClockToMs(sourceX: number): number {
  const sourceDate = new Date(sourceX);
  if (!Number.isFinite(sourceDate.getTime())) {
    throw new ClientError("shape", "Nasdaq chart x is not a valid timestamp.", { sourceX });
  }
  const year = sourceDate.getUTCFullYear();
  const month = sourceDate.getUTCMonth();
  const day = sourceDate.getUTCDate();
  const hour = sourceDate.getUTCHours();
  const minute = sourceDate.getUTCMinutes();
  const second = sourceDate.getUTCSeconds();
  const millisecond = sourceDate.getUTCMilliseconds();
  const guess = Date.UTC(year, month, day, hour, minute, second, millisecond);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date(guess))
      .map((part) => [part.type, part.value])
  );
  const displayedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    millisecond
  );
  return guess - (displayedAsUtc - guess);
}

function stringField(row: JsonObject, field: string, index: number): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new ClientError("shape", `Nasdaq row ${field} is missing or invalid.`, {
      field,
      index,
      value
    });
  }
  return value;
}

function integerField(row: JsonObject, field: string, index: number): number {
  const value = stringField(row, field, index);
  if (!/^\d+$/.test(value)) {
    throw new ClientError("shape", `Nasdaq row ${field} is not an integer string.`, {
      field,
      index,
      value
    });
  }
  return Number(value);
}

export function parseEarningsCalendar(record: SourceRecord<unknown>): NasdaqEarningsRow[] {
  const body = record.response.body;
  if (!isObject(body) || !isObject(body.data) || !Array.isArray(body.data.rows)) {
    throw new ClientError("shape", "Nasdaq earnings response is missing data.rows.");
  }

  return body.data.rows.map((value, index) => {
    if (!isObject(value)) {
      throw new ClientError("shape", "Nasdaq earnings row is not an object.", { index });
    }
    return {
      symbol: stringField(value, "symbol", index),
      name: stringField(value, "name", index),
      time: stringField(value, "time", index),
      epsForecast: stringField(value, "epsForecast", index),
      numberOfEstimates: integerField(value, "noOfEsts", index),
      fiscalQuarterEnding: stringField(value, "fiscalQuarterEnding", index)
    } satisfies NasdaqEarningsRow;
  });
}

export function parseHistoricalPrices(record: SourceRecord<unknown>): NasdaqDailyPrice[] {
  const body = record.response.body;
  if (!isObject(body) || !isObject(body.data) || !isObject(body.data.tradesTable)) {
    throw new ClientError("shape", "Nasdaq historical response is missing data.tradesTable.");
  }
  const rows = body.data.tradesTable.rows;
  if (!Array.isArray(rows)) {
    throw new ClientError("shape", "Nasdaq historical response is missing tradesTable.rows.");
  }
  return rows.map((value, index) => {
    if (!isObject(value)) {
      throw new ClientError("shape", "Nasdaq historical row is not an object.", { index });
    }
    const date = requiredText(value.date, `historical[${index}].date`, index);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
      throw new ClientError("shape", "Nasdaq historical date is not MM/DD/YYYY.", { index, date });
    }
    return {
      date,
      open: requiredPositivePrice(value.open, `historical[${index}].open`, index),
      close: requiredPositivePrice(value.close, `historical[${index}].close`, index),
      high: requiredPositivePrice(value.high, `historical[${index}].high`, index),
      low: requiredPositivePrice(value.low, `historical[${index}].low`, index),
      volume: requiredText(value.volume, `historical[${index}].volume`, index)
    } satisfies NasdaqDailyPrice;
  });
}

export interface NasdaqClosedQuote {
  /** MM/DD/YYYY, the same form as the daily history rows. */
  date: string;
  close: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The last session's close from the quote endpoint, which Nasdaq updates within minutes of
 * the close while the daily history can lag into the next morning. Returns null unless the
 * market is reported closed and the last trade is stamped with a date only ("Oct 7, 2026");
 * while trading, pre-market or after hours the price is not a close.
 */
export function parseClosedQuote(record: SourceRecord<unknown>): NasdaqClosedQuote | null {
  const body = record.response.body;
  if (!isObject(body) || !isObject(body.data) || !isObject(body.data.primaryData)) {
    throw new ClientError("shape", "Nasdaq quote response is missing data.primaryData.");
  }
  if (body.data.marketStatus !== "Closed") return null;
  const stamp = body.data.primaryData.lastTradeTimestamp;
  const match =
    typeof stamp === "string" ? /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(stamp) : null;
  const month = match ? MONTHS.indexOf(match[1]!) + 1 : 0;
  if (!match || month === 0) return null;
  return {
    date: `${String(month).padStart(2, "0")}/${match[2]!.padStart(2, "0")}/${match[3]}`,
    close: requiredPositivePrice(body.data.primaryData.lastSalePrice, "quote.lastSalePrice")
  };
}

export function fetchQuoteInfo(ticker: string): Promise<SourceRecord<unknown>> {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) {
    throw new ClientError("shape", "Nasdaq ticker must be uppercase.", { ticker });
  }
  return requestJson<unknown>(
    `${NASDAQ_HISTORICAL_URL}/${encodeURIComponent(ticker)}/info?assetclass=stocks`,
    { headers: { "user-agent": "Mozilla/5.0 Redeye/0.1" } }
  );
}

export function parseChartPoints(record: SourceRecord<unknown>): NasdaqChartPoint[] {
  const body = record.response.body;
  if (!isObject(body) || !isObject(body.data) || !Array.isArray(body.data.chart)) {
    throw new ClientError("shape", "Nasdaq chart response is missing data.chart.");
  }
  return body.data.chart.map((value, index) => {
    if (!isObject(value) || !isObject(value.z)) {
      throw new ClientError("shape", "Nasdaq chart point is not an object.", { index });
    }
    const sourceX = requiredInteger(value.x, `chart[${index}].x`, index);
    return {
      sourceX,
      atMs: localWallClockToMs(sourceX),
      localDateTime: requiredText(value.z.dateTime, `chart[${index}].z.dateTime`, index),
      price: requiredPositivePrice(value.z.value, `chart[${index}].z.value`, index)
    } satisfies NasdaqChartPoint;
  });
}

export function fetchHistoricalPrices(
  ticker: string,
  fromDate: string,
  toDate: string
): Promise<SourceRecord<unknown>> {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) {
    throw new ClientError("shape", "Nasdaq ticker must be uppercase.", { ticker });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new ClientError("shape", "Nasdaq historical dates must be YYYY-MM-DD.", {
      fromDate,
      toDate
    });
  }
  const query = new URLSearchParams({
    assetclass: "stocks",
    fromdate: fromDate,
    todate: toDate,
    limit: "5000"
  });
  return requestJson<unknown>(
    `${NASDAQ_HISTORICAL_URL}/${encodeURIComponent(ticker)}/historical?${query.toString()}`,
    { headers: { "user-agent": "Mozilla/5.0 Redeye/0.1" } }
  );
}

export function fetchChart(ticker: string): Promise<SourceRecord<unknown>> {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) {
    throw new ClientError("shape", "Nasdaq ticker must be uppercase.", { ticker });
  }
  return requestJson<unknown>(
    `${NASDAQ_CHART_URL}/${encodeURIComponent(ticker)}/chart?assetclass=stocks`,
    { headers: { "user-agent": "Mozilla/5.0 Redeye/0.1" } }
  );
}

export async function fetchEarningsCalendar(date: string): Promise<SourceRecord<unknown>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ClientError("shape", "Nasdaq calendar date must be YYYY-MM-DD.", { date });
  }
  return requestJson<unknown>(`${NASDAQ_EARNINGS_URL}?date=${encodeURIComponent(date)}`, {
    headers: { "user-agent": "Mozilla/5.0 Redeye/0.1" }
  });
}
