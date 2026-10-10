import { nextWindow } from "@redeye/core";
import { useMemo, useState } from "react";
import { OutcomeBadge, Problem, Skeleton, marketState } from "../components/bits";
import { NightStrip, type StripLine } from "../components/NightStrip";
import { stockName } from "../components/PriceBoard";
import { agent } from "../lib/api";
import { changePct, nyStamp, num, pct, usd, windowName } from "../lib/format";
import { useAgent, useNow } from "../lib/hooks";
import { triggerLabel, triggerPrice } from "../lib/plans";
import { Link } from "../lib/router";

/** The running (or last) window and the four before it, newest first. */
function recentWindows(now: number): Array<{ kind: string; closeTs: number; openTs: number }> {
  const upcoming = nextWindow(now);
  let current = upcoming.closeTs <= now ? upcoming : nextWindow(upcoming.closeTs - 7 * 3600e3);
  const list = [current];
  for (let i = 0; i < 4; i += 1) {
    current = nextWindow(current.closeTs - 7 * 3600e3);
    list.push(current);
  }
  return list;
}

function Price({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="triple__cell">
      <p className="label">{label}</p>
      <p className="triple__value">{value}</p>
      <p className="fine">{sub}</p>
    </div>
  );
}

export default function Stock({ ticker }: { ticker: string }) {
  const now = useNow(1000);
  const windows = useMemo(() => recentWindows(now), [Math.floor(now / 600_000)]);
  const [closeTs, setCloseTs] = useState<number | null>(null);
  const chosen = closeTs ?? windows[0]!.closeTs;
  const prices = useAgent(() => agent.prices([ticker]), [ticker], 15_000);
  const trace = useAgent(() => agent.night(ticker, chosen), [ticker, chosen], 60_000);
  const record = useAgent(() => agent.record(), [], 60_000);

  const item = prices.status === "ready" ? prices.value.items[0] : undefined;
  const close = num(item?.close?.value);
  const real = num(item?.real?.value);
  const plans =
    record.status === "ready"
      ? record.value.items.filter((i) => i.ticker === ticker && i.planId !== null)
      : [];
  const traceClose =
    trace.status === "ready" && trace.value.close ? Number(trace.value.close.value) : null;
  const lines: StripLine[] =
    traceClose === null
      ? []
      : plans
          .filter((p) => p.closeTs === chosen)
          .flatMap((p) => {
            const price = triggerPrice(p, traceClose);
            return price === null
              ? []
              : [
                  {
                    value: price,
                    label: `#${p.planId}: ${triggerLabel(p, price)}`,
                    tone: "trigger" as const
                  }
                ];
          });
  const market = marketState(now);

  return (
    <div className="wrap page">
      <header className="page__head page__head--row">
        <div>
          <p className="eyebrow">{ticker} · stock token on BNB Chain</p>
          <h1 className="display display--sm">{stockName(ticker)}</h1>
        </div>
        <Link to={`/start?ticker=${ticker}`} className="button button--primary">
          Make a plan for {stockName(ticker)}
        </Link>
      </header>

      {prices.status === "loading" && <Skeleton height={120} />}
      {prices.status === "error" && <Problem message={prices.message} retry={prices.retry} />}
      {item && item.state !== "ok" && (
        <Problem message="This stock is not priced right now: one of its sources did not answer." />
      )}
      {item && item.state === "ok" && (
        <div className="triple">
          <Price
            label="Last US close"
            value={usd(close)}
            sub={`${item.close?.date ?? ""} · ${item.close?.source ?? ""}`}
          />
          <Price
            label={market.open ? "Live" : "24/7 price"}
            value={usd(real)}
            sub={`${pct(changePct(real, close))} since the close · ${item.real?.ageSeconds ?? "—"}s old`}
          />
          <Price
            label="Token, per real share"
            value={usd(item.token?.value)}
            sub={`${pct(num(item.gaps?.tokenToRealPct))} vs 24/7 · pool ${usd(item.pool?.reserveUsd, 0)}`}
          />
        </div>
      )}

      <section className="runchart">
        <div className="runchart__head">
          <div className="tabs" role="tablist" aria-label="Window">
            {windows.map((w, index) => (
              <button
                key={w.closeTs}
                role="tab"
                type="button"
                aria-selected={w.closeTs === chosen}
                className={`tab${w.closeTs === chosen ? " tab--on" : ""}`}
                onClick={() => setCloseTs(w.closeTs)}
              >
                {index === 0 && now < w.openTs
                  ? "Now"
                  : new Intl.DateTimeFormat("en-US", {
                      weekday: "short",
                      day: "numeric",
                      timeZone: "America/New_York"
                    }).format(w.closeTs)}
              </button>
            ))}
          </div>
          {trace.status === "ready" && (
            <p className="fine">
              {windowName(trace.value.window.kind)} from {nyStamp(trace.value.window.closeTs)}
            </p>
          )}
        </div>
        {trace.status === "loading" && <Skeleton height={300} />}
        {trace.status === "error" && <Problem message={trace.message} retry={trace.retry} />}
        {trace.status === "ready" && (
          <NightStrip
            trace={trace.value}
            now={now}
            height={300}
            lines={lines}
            title={`${stockName(ticker)} 24/7 price`}
          />
        )}
      </section>

      <section className="section--tight">
        <h2 className="h2">Plans on {stockName(ticker)}</h2>
        {plans.length === 0 ? (
          <p className="empty">No plan on {stockName(ticker)} yet. Yours could be the first.</p>
        ) : (
          <ul className="minilist">
            {plans.map((p) => (
              <li key={p.id}>
                <Link to={`/runs/${p.id}`}>
                  <span>#{p.planId}</span>
                  <span>{p.promise}</span>
                  <OutcomeBadge item={p} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
