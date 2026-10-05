import type { NasdaqEarningsRow, SourceRecord } from "@redeye/shared";
import { ClientError } from "./errors.js";
import { requestJson } from "./http.js";

export const NASDAQ_EARNINGS_URL = "https://api.nasdaq.com/api/calendar/earnings";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export async function fetchEarningsCalendar(date: string): Promise<SourceRecord<unknown>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ClientError("shape", "Nasdaq calendar date must be YYYY-MM-DD.", { date });
  }
  return requestJson<unknown>(`${NASDAQ_EARNINGS_URL}?date=${encodeURIComponent(date)}`, {
    headers: { "user-agent": "Mozilla/5.0 Redeye/0.1" }
  });
}
