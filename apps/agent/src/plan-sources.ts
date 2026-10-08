import {
  fetchBstockList,
  fetchHistoricalPrices,
  fetchXyzCandles,
  parseBstockList,
  parseHistoricalPrices,
  parseXyzCandles,
  storeRawRecord
} from "@redeye/clients";
import type { XyzCandle } from "@redeye/shared";
import type { NightClose } from "./night.js";
import type { ListedToken, OfficialOpen } from "./plan-service.js";

const BSC_CHAIN_ID = "56";

/** The calendar day after a YYYY-MM-DD date. */
function nextIsoDate(isoDate: string): string {
  const atMs = Date.parse(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(atMs)) throw new Error(`Date is invalid: ${isoDate}`);
  return new Date(atMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function usDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}

/**
 * The bStock for a ticker on BNB Chain, from Binance's official list. Exactly one
 * row must match; the share count is compared across sources by the daily probe.
 */
export async function listedBstock(rawRoot: string, ticker: string): Promise<ListedToken | null> {
  const record = await fetchBstockList();
  await storeRawRecord(rawRoot, "binance-rwa-bstock-list", record);
  const rows = parseBstockList(record).filter(
    (row) => row.chainId === BSC_CHAIN_ID && row.ticker === ticker
  );
  const [row] = rows;
  if (row === undefined) return null;
  return {
    address: row.contractAddress,
    multiplier: row.multiplier,
    multiplierAgreement: rows.every((other) => other.multiplier === row.multiplier)
  };
}

/** The official opening price from Nasdaq's daily history, or null until that row exists. */
export async function nasdaqOfficialOpen(
  rawRoot: string,
  ticker: string,
  isoDate: string
): Promise<OfficialOpen | null> {
  // Nasdaq refuses a range that starts and ends on the same day, so ask up to the next day.
  const record = await fetchHistoricalPrices(ticker, isoDate, nextIsoDate(isoDate));
  const path = await storeRawRecord(rawRoot, `nasdaq-${ticker}`, record);
  const row = parseHistoricalPrices(record).find((candidate) => candidate.date === usDate(isoDate));
  if (row === undefined) return null;
  return { value: row.open, source: `nasdaq:${ticker}:daily-history`, sourceRecordPath: path };
}

/** The official close of one session from Nasdaq's daily history, or null until it is posted. */
export async function nasdaqCloseOn(
  rawRoot: string,
  ticker: string,
  isoDate: string
): Promise<NightClose | null> {
  const record = await fetchHistoricalPrices(ticker, isoDate, nextIsoDate(isoDate));
  await storeRawRecord(rawRoot, `nasdaq-${ticker}`, record);
  const row = parseHistoricalPrices(record).find((candidate) => candidate.date === usDate(isoDate));
  return row === undefined
    ? null
    : { value: row.close, date: isoDate, source: `nasdaq:${ticker}:daily-history` };
}

/** 24/7 price candles from Hyperliquid's xyz market, stored as raw records. */
export async function xyzCandles(
  rawRoot: string,
  ticker: string,
  interval: string,
  startMs: number,
  endMs: number
): Promise<XyzCandle[]> {
  const record = await fetchXyzCandles(ticker, interval, startMs, endMs);
  await storeRawRecord(rawRoot, `hyperliquid-candles-${ticker}`, record);
  return parseXyzCandles(record);
}
