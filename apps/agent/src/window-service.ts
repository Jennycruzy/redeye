import {
  createWindowRecord,
  nextWindow,
  type EventRecord,
  type OffHoursWindow
} from "@redeye/core";

const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const DEFAULT_WINDOW_INTERVAL_MS = 60_000;

export interface ScheduledWindow extends EventRecord {
  generatedAt: string;
  scheduleSource: {
    name: "NYSE calendar in @redeye/core";
    fetchedAt: string;
    recordPath: "code:@redeye/core/session";
  };
}

export interface WindowServiceOptions {
  tickers: string[];
  saveWindow: (window: ScheduledWindow) => Promise<void>;
  now?: () => number;
}

function assertTicker(ticker: string): string {
  const normalized = ticker.toUpperCase();
  if (!TICKER_PATTERN.test(normalized)) throw new Error(`Invalid ticker: ${ticker}`);
  return normalized;
}

function uniqueTickers(tickers: string[]): string[] {
  const normalized = [...new Set(tickers.map(assertTicker))];
  if (normalized.length === 0) throw new Error("At least one ticker is required.");
  return normalized;
}

export function buildUpcomingWindows(tickers: string[], atMs: number): ScheduledWindow[] {
  if (!Number.isFinite(atMs)) throw new Error("Window scheduler time must be finite.");
  const normalizedTickers = uniqueTickers(tickers);
  const upcoming: OffHoursWindow = nextWindow(atMs);
  const generatedAt = new Date(atMs).toISOString();
  return normalizedTickers.map((ticker) => ({
    ...createWindowRecord(upcoming.kind, ticker, upcoming.closeTs, upcoming.openTs),
    generatedAt,
    scheduleSource: {
      name: "NYSE calendar in @redeye/core",
      fetchedAt: generatedAt,
      recordPath: "code:@redeye/core/session"
    }
  }));
}

export class WindowService {
  private readonly tickers: string[];
  private readonly saveWindow: (window: ScheduledWindow) => Promise<void>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WindowServiceOptions) {
    this.tickers = uniqueTickers(options.tickers);
    this.saveWindow = options.saveWindow;
    this.now = options.now ?? Date.now;
  }

  async refresh(): Promise<ScheduledWindow[]> {
    const windows = buildUpcomingWindows(this.tickers, this.now());
    await Promise.all(windows.map((window) => this.saveWindow(window)));
    return windows;
  }

  async start(intervalMs = DEFAULT_WINDOW_INTERVAL_MS): Promise<() => void> {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
      throw new Error("Window interval is too short.");
    }
    if (this.timer !== null) throw new Error("Window service is already running.");
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            code: "WINDOW_REFRESH_FAILED",
            reason: error instanceof Error ? error.message : String(error)
          })
        );
      });
    }, intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
