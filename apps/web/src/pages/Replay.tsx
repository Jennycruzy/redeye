import { nextWindow, type OffHoursWindow } from "@redeye/core";
import { useMemo, useState } from "react";
import { Problem, Skeleton } from "../components/bits";
import { NightStrip, type StripLine } from "../components/NightStrip";
import { stockName } from "../components/PriceBoard";
import { agent } from "../lib/api";
import { nyStamp, plain, usd, utcStamp, windowName } from "../lib/format";
import { useAgent, useNow } from "../lib/hooks";
import { lastFinishedClose, replayResult, type ReplayKind } from "../lib/replay";

const WINDOW_MARGIN_MS = 7 * 60 * 60 * 1000;

function recentFinishedWindows(now: number, count = 8): OffHoursWindow[] {
  let current = nextWindow(lastFinishedClose(now) + WINDOW_MARGIN_MS);
  const windows: OffHoursWindow[] = [];
  for (let index = 0; index < count; index += 1) {
    windows.push(current);
    current = nextWindow(current.closeTs - WINDOW_MARGIN_MS);
  }
  return windows;
}

const KIND_LABELS: Record<ReplayKind, string> = {
  guard: "Guard · price falls",
  buy_dip: "Buy the dip · price falls",
  sell_rise: "Sell the rise · price rises"
};

export default function Replay() {
  const now = useNow(1000);
  const windows = useMemo(() => recentFinishedWindows(now), [Math.floor(now / 600_000)]);
  const prices = useAgent(() => agent.prices(), [], 60_000);
  const [ticker, setTicker] = useState("NVDA");
  const [closeTs, setCloseTs] = useState<number | null>(null);
  const [kind, setKind] = useState<ReplayKind>("guard");
  const [trigger, setTrigger] = useState(3);
  const selectedWindow = windows.find((window) => window.closeTs === closeTs) ?? windows[0]!;
  const trace = useAgent(
    () => agent.night(ticker, selectedWindow.closeTs),
    [ticker, selectedWindow.closeTs]
  );
  const result = trace.status === "ready" ? replayResult(trace.value, kind, trigger) : null;
  const triggerLine: StripLine[] =
    result === null
      ? []
      : [
          {
            value: result.level,
            label: (kind === "sell_rise" ? "Rise" : "Drop") + " trigger " + usd(result.level),
            tone: "trigger"
          }
        ];
  const noTrace = trace.status === "ready" && result === null;
  const tickerItems = prices.status === "ready" ? prices.value.items : [];

  return (
    <div className="wrap page">
      <header className="page__head">
        <p className="eyebrow">Replay · no transactions</p>
        <h1 className="display display--sm">
          Put a trigger through <em>a past window</em>.
        </h1>
        <p className="lede">
          Replay the 24/7 five-minute price candles for one of the eight latest completed NYSE
          windows. This checks trigger crossings only; it does not simulate Binance quotes,
          liquidity, fees or a trade.
        </p>
      </header>

      <div className="controls">
        <label className="field">
          <span>Stock</span>
          <select value={ticker} onChange={(event) => setTicker(event.target.value)}>
            {tickerItems.map((item) => (
              <option key={item.ticker} value={item.ticker}>
                {item.ticker} · {stockName(item.ticker)}
              </option>
            ))}
            {!tickerItems.some((item) => item.ticker === ticker) && (
              <option value={ticker}>{ticker}</option>
            )}
          </select>
        </label>
        <label className="field">
          <span>Completed window</span>
          <select
            value={selectedWindow.closeTs}
            onChange={(event) => setCloseTs(Number(event.target.value))}
          >
            {windows.map((window) => (
              <option key={window.closeTs} value={window.closeTs}>
                {windowName(window.kind)} · {nyStamp(window.closeTs)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Trigger type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as ReplayKind)}>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="slider">
          <span className="slider__top">
            <span>
              {kind === "sell_rise" ? "Rise above Friday close" : "Drop below Friday close"}
            </span>
            <output className="slider__value">{trigger}%</output>
          </span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={trigger}
            onChange={(event) => setTrigger(Number(event.target.value))}
            style={{ ["--fill" as string]: String(((trigger - 1) / 9) * 100) + "%" }}
          />
          <span className="slider__hint">
            The trigger is compared with the official session close.
          </span>
        </label>
      </div>

      <section className="runchart">
        <div className="runchart__head">
          <p className="label">
            {windowName(selectedWindow.kind)} · {nyStamp(selectedWindow.closeTs)}
          </p>
          {trace.status === "ready" && (
            <p className="fine">
              {trace.value.points.length} {trace.value.interval} price points · {trace.value.source}{" "}
              · fetched {utcStamp(Date.parse(trace.value.fetchedAt))}
            </p>
          )}
        </div>
        {trace.status === "loading" && <Skeleton height={300} />}
        {trace.status === "error" && <Problem message={trace.message} retry={trace.retry} />}
        {noTrace && (
          <Problem message="The close or historical price candles are unavailable for this window." />
        )}
        {trace.status === "ready" && result !== null && (
          <NightStrip
            trace={trace.value}
            now={now}
            height={300}
            replay
            lines={triggerLine}
            title={stockName(ticker) + " replay"}
          />
        )}
      </section>

      {trace.status === "ready" && result !== null && (
        <section className="replay">
          <div className="replay__head">
            <p className="label">Trigger-only result · no trade was sent</p>
          </div>
          <p className="replay__verdict">
            {result.hit ? (
              <>
                The {kind === "sell_rise" ? "rise" : "drop"} trigger was first crossed at{" "}
                <strong>{utcStamp(result.hit.at)}</strong>, when the 24/7 reference was{" "}
                <strong>{usd(result.hit.price)}</strong>.
              </>
            ) : (
              <>
                No {kind === "sell_rise" ? "rise" : "drop"} trigger crossing appears in the
                available candles. The window’s most {kind === "sell_rise" ? "elevated" : "dipped"}{" "}
                price was <strong>{usd(result.extreme)}</strong>; the close was{" "}
                <strong>{usd(result.close)}</strong>.
              </>
            )}
          </p>
          <p className="fine">
            Trigger level {usd(result.level)} ({plain(trigger)}% from the official close). This
            historical chart is source data, not an execution record or a prediction.
          </p>
        </section>
      )}
    </div>
  );
}
