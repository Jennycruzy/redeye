import { readFile } from "node:fs/promises";
import {
  assertUsableXyzPrice,
  fetchBstockList,
  fetchGeckoPool,
  fetchHistoricalPrices,
  fetchGeckoPools,
  fetchXyzEquityPrices,
  parseBstockList,
  parseGeckoPool,
  parseHistoricalPrices,
  parseGeckoPools,
  parseXyzEquityPrices,
  storeRawRecord,
  type NasdaqDailyPrice
} from "@redeye/clients";
import type { GeckoPoolSnapshot, RwaToken, SourceRecord, XyzEquityPrice } from "@redeye/shared";
import Decimal from "decimal.js";

const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_PRICE_AGE_SECONDS = 120;
const TOKEN_UNIT_DEVIATION_PCT = 25;

export interface PoolMapEntry {
  address: string;
  observedLiquidityUsd: string;
  createdAtMs: number;
}

export type PoolMap = Record<string, PoolMapEntry>;

export interface PricePoint {
  value: string;
  source: string;
  fetchedAt: string;
  ageSeconds: number;
  sourceRecordPath: string;
}

export interface PriceSnapshotOk {
  v: 1;
  state: "ok";
  ticker: string;
  at: string;
  close: PricePoint;
  real: PricePoint;
  token: PricePoint;
  gaps: {
    tokenToClosePct: string;
    tokenToRealPct: string;
  };
  pool: {
    address: string;
    reserveUsd: string;
    source: string;
  };
}

export interface PriceSnapshotError {
  v: 1;
  state: "error";
  ticker: string;
  at: string;
  error: {
    code: string;
    reason: string;
    source: string;
  };
}

export type PriceSnapshot = PriceSnapshotOk | PriceSnapshotError;

export interface PriceServiceHealth {
  v: 1;
  state: "ok" | "degraded";
  passes: number;
  longestGapSeconds: number;
  gapsOverMinute: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  priceAgeSeconds: Record<string, number | null>;
  lastError: { code: string; reason: string } | null;
}

export interface PriceServiceSources {
  real: () => Promise<SourceRecord<unknown>>;
  parseReal: (record: SourceRecord<unknown>) => XyzEquityPrice[];
  tokens: () => Promise<SourceRecord<unknown>>;
  parseTokens: (record: SourceRecord<unknown>) => RwaToken[];
  historical: (ticker: string, fromDate: string, toDate: string) => Promise<SourceRecord<unknown>>;
  parseHistorical: (record: SourceRecord<unknown>) => NasdaqDailyPrice[];
  pool: (address: string) => Promise<SourceRecord<unknown>>;
  parsePool: (record: SourceRecord<unknown>) => GeckoPoolSnapshot;
  pools?: (addresses: string[]) => Promise<SourceRecord<unknown>>;
  parsePools?: (record: SourceRecord<unknown>) => GeckoPoolSnapshot[];
}

export interface PriceServiceOptions {
  rawRoot: string;
  poolMap: PoolMap;
  maxPriceAgeSeconds?: number;
  sources?: PriceServiceSources;
  saveSnapshot?: (snapshot: PriceSnapshot) => Promise<void>;
  saveHealth?: (health: PriceServiceHealth) => Promise<void>;
  now?: () => number;
}

interface StoredRecord<T> {
  record: SourceRecord<T>;
  path: string;
}

function assertTicker(ticker: string): string {
  const normalized = ticker.toUpperCase();
  if (!TICKER_PATTERN.test(normalized)) throw new Error(`Invalid ticker: ${ticker}`);
  return normalized;
}

function isoDateInNewYork(atMs: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(new Date(atMs))
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateDaysBefore(date: string, days: number): string {
  if (!DATE_PATTERN.test(date) || !Number.isInteger(days) || days < 0) {
    throw new Error("Historical date range is invalid.");
  }
  const atMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(atMs)) throw new Error(`Historical date is invalid: ${date}`);
  return new Date(atMs - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function ageSeconds(fetchedAt: string, atMs: number): number {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs > atMs) {
    throw new Error("Source fetch time is invalid or in the future.");
  }
  return Math.floor((atMs - fetchedAtMs) / 1000);
}

function decimal(value: string, field: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite() || parsed.isNegative()) throw new Error("not positive");
    return parsed;
  } catch {
    throw new Error(`${field} is not a valid non-negative decimal.`);
  }
}

function decimalString(value: Decimal): string {
  const fixed = value.toFixed(18);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function percentageDifference(value: string, reference: string): string {
  const current = decimal(value, "price");
  const baseline = decimal(reference, "reference price");
  if (baseline.isZero()) throw new Error("Reference price cannot be zero.");
  return decimalString(current.div(baseline).minus(1).mul(100));
}

function latestDailyRow(rows: NasdaqDailyPrice[]): NasdaqDailyPrice {
  if (rows.length === 0) throw new Error("Nasdaq daily history returned no rows.");
  return [...rows].sort((left, right) => {
    const leftDate = left.date.slice(6, 10) + left.date.slice(0, 2) + left.date.slice(3, 5);
    const rightDate = right.date.slice(6, 10) + right.date.slice(0, 2) + right.date.slice(3, 5);
    return rightDate.localeCompare(leftDate);
  })[0] as NasdaqDailyPrice;
}

function sourceError(error: unknown): { code: string; reason: string } {
  const reason = error instanceof Error ? error.message : String(error);
  if (reason.includes("Hyperliquid") && reason.toLowerCase().includes("price")) {
    return { code: "REAL_PRICE_UNAVAILABLE", reason };
  }
  if (reason.includes("token price failed the US-close unit check")) {
    return { code: "TOKEN_PRICE_UNIT_MISMATCH", reason };
  }
  if (error instanceof Error) {
    return { code: "SOURCE_UNAVAILABLE", reason };
  }
  return { code: "SOURCE_UNAVAILABLE", reason };
}

export async function loadPoolMap(path: string): Promise<PoolMap> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Pool map must be an object.");
  }
  const map: PoolMap = {};
  for (const [tickerValue, value] of Object.entries(parsed)) {
    const ticker = assertTicker(tickerValue);
    if (!Array.isArray(value) || value.length !== 3) {
      throw new Error(
        `Pool map entry for ${ticker} must contain address, liquidity and creation time.`
      );
    }
    const [address, liquidity, createdAtMs] = value;
    if (typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error(`Pool map address for ${ticker} is invalid.`);
    }
    if (typeof liquidity !== "number" || !Number.isFinite(liquidity) || liquidity <= 0) {
      throw new Error(`Pool map liquidity for ${ticker} is invalid.`);
    }
    if (typeof createdAtMs !== "number" || !Number.isInteger(createdAtMs) || createdAtMs <= 0) {
      throw new Error(`Pool map creation time for ${ticker} is invalid.`);
    }
    map[ticker] = {
      address,
      observedLiquidityUsd: String(liquidity),
      createdAtMs
    };
  }
  if (Object.keys(map).length === 0) throw new Error("Pool map is empty.");
  return map;
}

const defaultSources: PriceServiceSources = {
  real: fetchXyzEquityPrices,
  parseReal: parseXyzEquityPrices,
  tokens: fetchBstockList,
  parseTokens: parseBstockList,
  historical: fetchHistoricalPrices,
  parseHistorical: parseHistoricalPrices,
  pool: fetchGeckoPool,
  parsePool: parseGeckoPool,
  pools: fetchGeckoPools,
  parsePools: parseGeckoPools
};

interface StoredPool {
  snapshot: GeckoPoolSnapshot;
  record: SourceRecord<unknown>;
  path: string;
}

export class PriceService {
  private readonly sources: PriceServiceSources;
  private readonly maxPriceAgeSeconds: number;
  private readonly saveSnapshot: (snapshot: PriceSnapshot) => Promise<void>;
  private readonly saveHealth: (health: PriceServiceHealth) => Promise<void>;
  private readonly now: () => number;
  private readonly closeCache = new Map<string, StoredRecord<NasdaqDailyPrice>>();
  private readonly tokensCache = new Map<string, RwaToken>();
  private health: PriceServiceHealth = {
    v: 1,
    state: "degraded",
    passes: 0,
    longestGapSeconds: 0,
    gapsOverMinute: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    priceAgeSeconds: {},
    lastError: null
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(private readonly options: PriceServiceOptions) {
    this.sources = options.sources ?? defaultSources;
    this.maxPriceAgeSeconds = options.maxPriceAgeSeconds ?? DEFAULT_MAX_PRICE_AGE_SECONDS;
    if (!Number.isInteger(this.maxPriceAgeSeconds) || this.maxPriceAgeSeconds <= 0) {
      throw new Error("Price max age must be a positive integer.");
    }
    this.saveSnapshot = options.saveSnapshot ?? (async () => undefined);
    this.saveHealth = options.saveHealth ?? (async () => undefined);
    this.now = options.now ?? Date.now;
  }

  getHealth(): PriceServiceHealth {
    return structuredClone(this.health);
  }

  async refresh(tickers: string[] = Object.keys(this.options.poolMap)): Promise<PriceSnapshot[]> {
    if (this.refreshing) throw new Error("A price refresh is already in progress.");
    const normalizedTickers = [...new Set(tickers.map(assertTicker))];
    if (normalizedTickers.length === 0) throw new Error("At least one ticker is required.");
    const atMs = this.now();
    const at = new Date(atMs).toISOString();
    const previousAttemptAt = this.health.lastAttemptAt;
    this.refreshing = true;
    this.health.lastAttemptAt = at;
    try {
      const [realResult, tokensResult] = await Promise.allSettled([
        this.fetchAndStore("hyperliquid", this.sources.real()),
        this.fetchAndStore("binance-rwa-bstock-list", this.sources.tokens())
      ]);

      if (realResult.status === "rejected" || tokensResult.status === "rejected") {
        const failure =
          realResult.status === "rejected"
            ? realResult.reason
            : tokensResult.status === "rejected"
              ? tokensResult.reason
              : new Error("Price input status was incomplete.");
        const error = sourceError(failure);
        const snapshots = await Promise.all(
          normalizedTickers.map((ticker) =>
            this.persistError({
              v: 1,
              state: "error",
              ticker,
              at,
              error: { ...error, source: "price inputs" }
            })
          )
        );
        this.recordFailure(error, at, previousAttemptAt);
        return snapshots;
      }

      const realPrices = this.sources.parseReal(realResult.value.record);
      for (const token of this.sources.parseTokens(tokensResult.value.record)) {
        this.tokensCache.set(token.ticker, token);
      }
      const realByTicker = new Map(
        realPrices.map((price) => [price.ticker, { price, path: realResult.value.path }])
      );
      const pools = await this.fetchPools(normalizedTickers);
      const snapshots = await Promise.all(
        normalizedTickers.map((ticker) => this.buildSnapshot(ticker, atMs, at, realByTicker, pools))
      );
      const successful = snapshots.filter(
        (snapshot): snapshot is PriceSnapshotOk => snapshot.state === "ok"
      );
      this.health.state = successful.length === snapshots.length ? "ok" : "degraded";
      if (successful.length === snapshots.length) {
        this.health.passes += 1;
        this.health.lastSuccessAt = at;
        this.health.lastError = null;
      } else {
        this.health.lastError = {
          code: "PRICE_SNAPSHOT_INCOMPLETE",
          reason: "One or more required prices were unavailable."
        };
      }
      this.recordGap(previousAttemptAt, at);
      this.health.priceAgeSeconds = Object.fromEntries(
        successful.map((snapshot) => [snapshot.ticker, snapshot.real.ageSeconds])
      );
      await this.saveHealth(this.getHealth());
      return snapshots;
    } catch (error) {
      const failure = sourceError(error);
      this.recordFailure(failure, at, previousAttemptAt);
      const snapshots = await Promise.all(
        normalizedTickers.map((ticker) =>
          this.persistError({
            v: 1,
            state: "error",
            ticker,
            at,
            error: { ...failure, source: "price service" }
          })
        )
      );
      return snapshots;
    } finally {
      this.refreshing = false;
    }
  }

  async start(
    tickers: string[] = Object.keys(this.options.poolMap),
    intervalMs = 60_000
  ): Promise<() => void> {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000)
      throw new Error("Price interval is too short.");
    if (this.timer !== null) throw new Error("Price service is already running.");
    await this.refresh(tickers);
    this.timer = setInterval(() => {
      void this.refresh(tickers).catch((error: unknown) => {
        const failure = sourceError(error);
        const at = new Date(this.now()).toISOString();
        this.recordFailure(failure, at, this.health.lastAttemptAt);
      });
    }, intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async buildSnapshot(
    ticker: string,
    atMs: number,
    at: string,
    realByTicker: Map<string, { price: XyzEquityPrice; path: string }>,
    pools: Map<string, StoredPool>
  ): Promise<PriceSnapshot> {
    try {
      const token = this.tokensCache.get(ticker);
      if (!token) throw new Error(`Binance RWA list has no bStock token for ${ticker}.`);
      const pool = this.options.poolMap[ticker];
      if (!pool) throw new Error(`No source-backed pool mapping exists for ${ticker}.`);
      const real = realByTicker.get(ticker);
      if (!real) throw new Error(`Hyperliquid has no xyz price for ${ticker}.`);

      const close = await this.fetchClose(ticker, atMs);
      const poolResult = pools.get(pool.address.toLowerCase());
      if (!poolResult) {
        throw new Error(`${ticker} pool was not returned by GeckoTerminal.`);
      }
      const poolSnapshot = poolResult.snapshot;
      if (poolSnapshot.address.toLowerCase() !== pool.address.toLowerCase()) {
        throw new Error(`${ticker} pool response address does not match the configured pool.`);
      }
      const checkedAtMs = this.now();
      const usableReal = assertUsableXyzPrice(
        real.price,
        close.record.response.body.close,
        checkedAtMs,
        this.maxPriceAgeSeconds
      );
      const tokenValue = decimalString(
        decimal(poolSnapshot.baseTokenPriceUsd, `${ticker} token price`).div(
          decimal(token.multiplier, `${ticker} multiplier`)
        )
      );
      const closeAge = ageSeconds(close.record.fetchedAt, checkedAtMs);
      const realAge = ageSeconds(usableReal.fetchedAt, checkedAtMs);
      const tokenAge = ageSeconds(poolResult.record.fetchedAt, checkedAtMs);
      if (
        Math.abs(Number(percentageDifference(tokenValue, close.record.response.body.close))) >=
        TOKEN_UNIT_DEVIATION_PCT
      ) {
        throw new Error(`${ticker} token price failed the US-close unit check.`);
      }
      const snapshot: PriceSnapshotOk = {
        v: 1,
        state: "ok",
        ticker,
        at,
        close: {
          value: close.record.response.body.close,
          source: `nasdaq:${ticker}:daily-history`,
          fetchedAt: close.record.fetchedAt,
          ageSeconds: closeAge,
          sourceRecordPath: close.path
        },
        real: {
          value: usableReal.price,
          source: usableReal.source,
          fetchedAt: usableReal.fetchedAt,
          ageSeconds: realAge,
          sourceRecordPath: real.path
        },
        token: {
          value: tokenValue,
          source: `geckoterminal:bsc:pool:${poolSnapshot.address}:base-per-real-share`,
          fetchedAt: poolResult.record.fetchedAt,
          ageSeconds: tokenAge,
          sourceRecordPath: poolResult.path
        },
        gaps: {
          tokenToClosePct: percentageDifference(tokenValue, close.record.response.body.close),
          tokenToRealPct: percentageDifference(tokenValue, usableReal.price)
        },
        pool: {
          address: poolSnapshot.address,
          reserveUsd: poolSnapshot.reserveUsd,
          source: poolResult.record.request.url
        }
      };
      await this.saveSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const failure = sourceError(error);
      return this.persistError({
        v: 1,
        state: "error",
        ticker,
        at,
        error: { ...failure, source: `price:${ticker}` }
      });
    }
  }

  private async fetchPools(tickers: string[]): Promise<Map<string, StoredPool>> {
    const addresses = tickers.map((ticker) => {
      const pool = this.options.poolMap[ticker];
      if (!pool) throw new Error(`No source-backed pool mapping exists for ${ticker}.`);
      return pool.address;
    });

    if (this.sources.pools && this.sources.parsePools) {
      const result = await this.fetchAndStore("gecko-pools", this.sources.pools(addresses));
      const map = new Map<string, StoredPool>();
      for (const snapshot of this.sources.parsePools(result.record)) {
        map.set(snapshot.address.toLowerCase(), {
          snapshot,
          record: result.record,
          path: result.path
        });
      }
      return map;
    }

    const map = new Map<string, StoredPool>();
    for (const ticker of tickers) {
      const pool = this.options.poolMap[ticker];
      if (!pool) throw new Error(`No source-backed pool mapping exists for ${ticker}.`);
      const result = await this.fetchAndStore(`gecko-${ticker}`, this.sources.pool(pool.address));
      map.set(pool.address.toLowerCase(), {
        snapshot: this.sources.parsePool(result.record),
        record: result.record,
        path: result.path
      });
    }
    return map;
  }

  private async fetchClose(ticker: string, atMs: number): Promise<StoredRecord<NasdaqDailyPrice>> {
    const toDate = isoDateInNewYork(atMs);
    const cacheKey = `${ticker}:${toDate}`;
    const cached = this.closeCache.get(cacheKey);
    if (cached) return cached;
    const result = await this.fetchAndStore(
      `nasdaq-${ticker}`,
      this.sources.historical(ticker, dateDaysBefore(toDate, 7), toDate)
    );
    const row = latestDailyRow(this.sources.parseHistorical(result.record));
    const stored = {
      record: { ...result.record, response: { ...result.record.response, body: row } },
      path: result.path
    };
    this.closeCache.set(cacheKey, stored);
    return stored;
  }

  private async fetchAndStore<T>(
    source: string,
    pending: Promise<SourceRecord<T>>
  ): Promise<StoredRecord<T>> {
    const record = await pending;
    const path = await storeRawRecord(this.options.rawRoot, source, record);
    return { record, path };
  }

  private async persistError(snapshot: PriceSnapshotError): Promise<PriceSnapshotError> {
    await this.saveSnapshot(snapshot);
    return snapshot;
  }

  private recordFailure(
    failure: { code: string; reason: string },
    at: string,
    previousAttemptAt: string | null
  ): void {
    this.recordGap(previousAttemptAt, at);
    this.health.state = "degraded";
    this.health.lastError = failure;
    this.health.lastAttemptAt = at;
    void this.saveHealth(this.getHealth());
  }

  private recordGap(previousAttemptAt: string | null, at: string): void {
    const previousAttempt = previousAttemptAt ? Date.parse(previousAttemptAt) : NaN;
    const currentAttempt = Date.parse(at);
    if (Number.isFinite(previousAttempt) && Number.isFinite(currentAttempt)) {
      const gapSeconds = Math.max(0, Math.floor((currentAttempt - previousAttempt) / 1000));
      this.health.longestGapSeconds = Math.max(this.health.longestGapSeconds, gapSeconds);
      if (gapSeconds > 60) this.health.gapsOverMinute += 1;
    }
  }
}
