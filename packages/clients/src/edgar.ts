import type { SecFiling, SourceRecord } from "@redeye/shared";
import { ClientError } from "./errors.js";
import { requestJson } from "./http.js";

export const SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayField(recent: JsonObject, field: string): unknown[] {
  const value = recent[field];
  if (!Array.isArray(value)) {
    throw new ClientError("shape", `SEC recent filings field ${field} is missing or invalid.`, {
      field
    });
  }
  return value;
}

function stringAt(values: unknown[], index: number, field: string): string {
  const value = values[index];
  if (typeof value !== "string") {
    throw new ClientError("shape", `SEC recent filings field ${field} is missing or invalid.`, {
      field,
      index,
      value
    });
  }
  return value;
}

function nullableStringAt(values: unknown[], index: number, field: string): string | null {
  const value = values[index];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ClientError("shape", `SEC recent filings field ${field} is invalid.`, {
      field,
      index,
      value
    });
  }
  return value;
}

export function normalizeCik(cik: string): string {
  if (!/^\d{1,10}$/.test(cik)) {
    throw new ClientError("shape", "SEC CIK must contain one to ten digits.", { cik });
  }
  return cik.padStart(10, "0");
}

export function parseSecSubmissions(record: SourceRecord<unknown>, cik: string): SecFiling[] {
  const body = record.response.body;
  if (!isObject(body) || !isObject(body.filings) || !isObject(body.filings.recent)) {
    throw new ClientError("shape", "SEC submissions response is missing filings.recent.");
  }

  const recent = body.filings.recent;
  const forms = arrayField(recent, "form");
  const accessions = arrayField(recent, "accessionNumber");
  const filingDates = arrayField(recent, "filingDate");
  const acceptanceTimes = arrayField(recent, "acceptanceDateTime");
  const primaryDocuments = arrayField(recent, "primaryDocument");
  const reportDates = arrayField(recent, "reportDate");
  const items = arrayField(recent, "items");
  const lengths = [
    forms.length,
    accessions.length,
    filingDates.length,
    acceptanceTimes.length,
    primaryDocuments.length,
    reportDates.length,
    items.length
  ];
  if (new Set(lengths).size !== 1) {
    throw new ClientError("shape", "SEC recent filing arrays have different lengths.", { lengths });
  }

  const normalizedCik = normalizeCik(cik);
  return forms.flatMap((form, index) => {
    if (form !== "8-K" && form !== "6-K") return [];
    return [
      {
        cik: normalizedCik,
        accessionNumber: stringAt(accessions, index, "accessionNumber"),
        form,
        filingDate: stringAt(filingDates, index, "filingDate"),
        acceptanceDateTime: stringAt(acceptanceTimes, index, "acceptanceDateTime"),
        primaryDocument: stringAt(primaryDocuments, index, "primaryDocument"),
        reportDate: nullableStringAt(reportDates, index, "reportDate"),
        items: nullableStringAt(items, index, "items")
      } satisfies SecFiling
    ];
  });
}

export async function fetchSecSubmissions(
  cik: string,
  userAgent: string
): Promise<SourceRecord<unknown>> {
  if (userAgent.trim().length === 0) {
    throw new ClientError(
      "shape",
      "SEC requests require a descriptive user agent with contact information."
    );
  }
  const normalizedCik = normalizeCik(cik);
  return requestJson<unknown>(`${SEC_SUBMISSIONS_URL}${normalizedCik}.json`, {
    headers: { "user-agent": userAgent }
  });
}
