import { nextWindow } from "@redeye/core";
import type { XyzCandle } from "@redeye/shared";

/** One off-hours window: from the US close to the next official open. */
export interface NightWindow {
  kind: string;
  closeTs: number;
  openTs: number;
}

export interface NightClose {
  value: string;
  /** YYYY-MM-DD, New York date of the session that closed. */
  date: string;
  source: string;
}

/** The 24/7 price through one window, for the site's night strip. */
export interface NightTrace {
  state: "ok";
  ticker: string;
  window: NightWindow;
  /** "live" while the window is running, "finished" once the open has passed. */
  phase: "live" | "finished";
  close: NightClose | null;
  /** [time ms, 24/7 price] at each candle's close, oldest first. */
  points: Array<[number, string]>;
  interval: string;
  source: string;
  fetchedAt: string;
}

export interface NightSources {
  candles(ticker: string, interval: string, startMs: number, endMs: number): Promise<XyzCandle[]>;
  close(ticker: string, nyDate: string): Promise<NightClose | null>;
  now?: () => number;
}

export class NightError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const INTERVAL = "5m";
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;
const LIVE_CACHE_MS = 60_000;
const FINISHED_CACHE_MS = 60 * 60_000;
const TICKER = /^[A-Z][A-Z0-9.-]{0,14}$/;

function nyDate(atMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(atMs));
}

/**
 * The window that is running now, or, while the market is open, the one that ended this
 * morning. A window that starts later than now is never returned.
 */
export function latestWindow(atMs: number): NightWindow {
  const upcoming = nextWindow(atMs);
  if (upcoming.closeTs <= atMs) return upcoming;
  // Seven hours before a close is always before that day's open, so inside the night before.
  return nextWindow(upcoming.closeTs - SEVEN_HOURS_MS);
}

/** The window that closes at `closeTs`, or an error when no window closes then. */
export function windowClosingAt(closeTs: number): NightWindow {
  const window = nextWindow(closeTs);
  if (window.closeTs !== closeTs) {
    throw new NightError(400, "WINDOW_UNKNOWN", "No off-hours window starts at that time.");
  }
  return window;
}

export function createNightService(sources: NightSources) {
  const now = sources.now ?? Date.now;
  const cache = new Map<string, { at: number; value: NightTrace }>();

  return async function trace(tickerInput: string, closeTs?: number): Promise<NightTrace> {
    const ticker = tickerInput.toUpperCase();
    if (!TICKER.test(ticker)) throw new NightError(400, "TICKER_INVALID", "Ticker is invalid.");
    const atMs = now();
    const window = closeTs === undefined ? latestWindow(atMs) : windowClosingAt(closeTs);
    if (window.closeTs > atMs) {
      throw new NightError(400, "WINDOW_NOT_STARTED", "That window has not started yet.");
    }
    const phase = atMs >= window.openTs ? "finished" : "live";
    const key = `${ticker}:${window.closeTs}`;
    const cached = cache.get(key);
    const maxAge = phase === "finished" ? FINISHED_CACHE_MS : LIVE_CACHE_MS;
    if (cached && atMs - cached.at < maxAge) return cached.value;

    const endMs = Math.min(atMs, window.openTs);
    const [candles, close] = await Promise.all([
      sources.candles(ticker, INTERVAL, window.closeTs, endMs),
      sources.close(ticker, nyDate(window.closeTs))
    ]);
    const points = candles
      .filter((candle) => candle.openTimeMs >= window.closeTs && candle.openTimeMs < endMs)
      .sort((a, b) => a.openTimeMs - b.openTimeMs)
      .map((candle): [number, string] => [Math.min(candle.closeTimeMs + 1, endMs), candle.close]);
    const value: NightTrace = {
      state: "ok",
      ticker,
      window,
      phase,
      close,
      points,
      interval: INTERVAL,
      source: `hyperliquid:xyz:${ticker} ${INTERVAL} candles`,
      fetchedAt: new Date(atMs).toISOString()
    };
    cache.set(key, { at: atMs, value });
    return value;
  };
}
