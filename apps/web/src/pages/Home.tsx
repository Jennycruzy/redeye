import { useMemo, useState } from "react";
import { MarketClock, OutcomeBadge, Problem, Skeleton, marketState } from "../components/bits";
import { NightStrip, type StripLine } from "../components/NightStrip";
import { PriceBoard, stockName } from "../components/PriceBoard";
import { PromiseCard } from "../components/PromiseCard";
import { agent, type RecordItem } from "../lib/api";
import { changePct, duration, kindName, num, pct, plain, usd, windowName } from "../lib/format";
import { useAgent, useNow } from "../lib/hooks";
import { triggerLabel, triggerPrice } from "../lib/plans";
import { Reveal, Tick } from "../lib/motion";
import { Link } from "../lib/router";

const HERO_TICKERS = ["NVDA", "TSLA", "GOOGL", "MSTR", "META"];

/** The plan the home page leads with: the newest that traded, else graded, else running. */
function leadPlan(items: RecordItem[]): RecordItem | null {
  const real = items.filter((i) => i.planId !== null);
  const newest = (list: RecordItem[]) =>
    [...list].sort((a, b) => (b.planId ?? 0) - (a.planId ?? 0))[0] ?? null;
  return (
    newest(real.filter((i) => i.fillTx)) ??
    newest(real.filter((i) => i.status === "done")) ??
    newest(real.filter((i) => i.status === "decided")) ??
    newest(real)
  );
}

function Hero({ now, record }: { now: number; record: RecordItem[] }) {
  const market = marketState(now);
  const [ticker, setTicker] = useState("NVDA");
  const night = useAgent(() => agent.night(ticker), [ticker], 60_000);
  const live = useAgent(() => agent.prices([ticker]), [ticker], 15_000);

  const trace = night.status === "ready" ? night.value : null;
  const close = trace?.close ? Number(trace.close.value) : null;
  const realNow = live.status === "ready" ? num(live.value.items[0]?.real?.value) : null;
  const realAge = live.status === "ready" ? live.value.items[0]?.real?.ageSeconds : undefined;
  const move = changePct(realNow, close);

  const lines: StripLine[] = useMemo(() => {
    if (!trace || close === null) return [];
    return record
      .filter((i) => i.ticker === ticker && i.closeTs === trace.window.closeTs && i.planId !== null)
      .flatMap((i) => {
        const price = triggerPrice(i, close);
        return price === null
          ? []
          : [
              {
                value: price,
                label: `Plan #${i.planId}: ${triggerLabel(i, price)}`,
                tone: "trigger" as const
              }
            ];
      });
  }, [record, trace, close, ticker]);

  return (
    <section className="hero">
      <div className="wrap hero__grid">
        <div className="hero__copy">
          <p className="eyebrow">
            {market.open
              ? "Market hours"
              : `${windowName(trace?.window.kind ?? "overnight")} window`}{" "}
            · tokenized US stocks on BNB Chain
          </p>
          <h1 className="display">
            {market.open ? (
              <>
                Wall Street is <em>open</em>.<br />
                Redeye waits for 4 pm.
              </>
            ) : (
              <>
                Wall Street is <em>closed</em>.<br />
                Your stock isn't.
              </>
            )}
          </h1>
          <p className="lede">
            Redeye prices your stock from the market that never shuts, locks its plan on chain
            before the close, and at the next open shows whether it kept its word.
          </p>
          <div className="hero__actions">
            <Link to="/start" className="button button--primary">
              Make your first plan
            </Link>
            <Link to="/record" className="arrowlink">
              See every promise it made
            </Link>
          </div>
          <div className="hero__clock-sm">
            <MarketClock now={now} />
          </div>
        </div>

        <div className="tonight">
          <div className="tonight__head">
            <div className="tabs" role="tablist" aria-label="Stock">
              {HERO_TICKERS.map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={t === ticker}
                  className={`tab${t === ticker ? " tab--on" : ""}`}
                  onClick={() => setTicker(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <Link to={`/t/${ticker}`} className="arrowlink arrowlink--sm">
              {stockName(ticker)}
            </Link>
          </div>
          <div className="tonight__figure">
            <div>
              <p className="label">{market.open ? "Price now" : "24/7 price now"}</p>
              <p className="figure">
                <Tick value={realNow}>{realNow === null ? "—" : usd(realNow)}</Tick>
              </p>
            </div>
            <div className="tonight__delta">
              <p className="label">Since the {close === null ? "close" : `${usd(close)} close`}</p>
              <p
                className={`delta ${move === null ? "" : move >= 0 ? "delta--up" : "delta--down"}`}
              >
                {pct(move)}
              </p>
            </div>
            <p className="tonight__source">
              24/7 market · {realAge === undefined ? "—" : `${realAge}s old`}
            </p>
          </div>
          {night.status === "loading" && <Skeleton height={240} />}
          {night.status === "error" && <Problem message={night.message} retry={night.retry} />}
          {trace && (
            <NightStrip
              trace={trace}
              lines={lines}
              now={now}
              height={240}
              title={`${stockName(ticker)} 24/7 price since the close`}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function Running({ items, now }: { items: RecordItem[]; now: number }) {
  if (items.length === 0) return null;
  return (
    <div className="running">
      <h3 className="running__title">Also running</h3>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <Link to={`/runs/${i.id}`} className="running__row">
              <span className="ticker">{i.ticker}</span>
              <span className="running__promise">{i.promise}</span>
              <span className="running__when">
                {now < i.closeTs
                  ? `starts in ${duration(i.closeTs - now)}`
                  : `${windowName(i.window).toLowerCase()}`}
              </span>
              <OutcomeBadge item={i} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STEPS = [
  {
    title: "Priced from the market that never shuts",
    body: "When New York closes, the stock keeps trading on a 24/7 futures market. Redeye reads that price every minute, next to the token's own pool and the frozen close, each with its source and age."
  },
  {
    title: "Your plan is locked before 4 pm",
    body: "Guard, Buy the dip, Sell the rise or Hold. A sealed copy of the plan is written on BNB Chain before the close. After that nobody, Redeye included, can change it."
  },
  {
    title: "Graded at the 9:30 open",
    body: "If the trigger is hit, the agent trades inside your limits through your Binance Agentic Wallet. At the open it publishes what it promised, what it did and the official price: kept, refused or broken."
  }
];

export default function Home() {
  const now = useNow(1000);
  const record = useAgent(() => agent.record(), [], 30_000);
  const prices = useAgent(() => agent.prices(), [], 20_000);
  const health = useAgent(() => agent.health(), [], 30_000);
  const study = useAgent(() => agent.study(), []);
  const items = record.status === "ready" ? record.value.items : [];
  const lead = leadPlan(items);
  const others = items.filter(
    (i) => i !== lead && (i.status === "locked" || i.status === "decided")
  );
  const market = marketState(now);
  const sat = study.status === "ready" ? study.value.summary?.windows.Sat12 : undefined;

  return (
    <>
      <Hero now={now} record={items} />

      <section className="section">
        <Reveal className="wrap">
          <div className="section__head">
            <p className="eyebrow">The latest promise</p>
            <h2 className="title">
              Every plan is written down <em>before</em> the night starts, and graded after it ends.
            </h2>
          </div>
          {record.status === "loading" && <Skeleton height={320} />}
          {record.status === "error" && <Problem message={record.message} retry={record.retry} />}
          {lead && <PromiseCard item={lead} now={now} />}
          {record.status === "ready" && !lead && (
            <p className="empty">
              No plan has been locked yet. The first one appears here the moment it is.
            </p>
          )}
          <Running items={others} now={now} />
        </Reveal>
      </section>

      <section className="section section--sunk">
        <Reveal className="wrap">
          <div className="section__head section__head--row">
            <div>
              <p className="eyebrow">Right now</p>
              <h2 className="title">
                {market.open ? "The market is open." : "Three prices, one stock."}{" "}
                <span className="title__soft">
                  {market.open
                    ? "Off-hours checks resume at 4 pm New York."
                    : "The close is frozen. The 24/7 price and the token keep moving."}
                </span>
              </h2>
            </div>
            {prices.status === "ready" && (
              <p className="fine">
                Updates every 20 seconds{prices.stale ? " · reconnecting" : ""}
              </p>
            )}
          </div>
          {prices.status === "loading" && <Skeleton height={420} />}
          {prices.status === "error" && <Problem message={prices.message} retry={prices.retry} />}
          {prices.status === "ready" && (
            <PriceBoard items={prices.value.items} marketOpen={market.open} />
          )}
          <p className="fine board__note">
            Close: the official Nasdaq close. 24/7 price: a market where the stock keeps trading
            around the clock. Token: the stock token's price on BNB Chain, per real share. Ages in
            seconds.
          </p>
        </Reveal>
      </section>

      <section className="section">
        <Reveal className="wrap">
          <div className="section__head">
            <p className="eyebrow">How it works</p>
            <h2 className="title">One promise a night, kept in public.</h2>
          </div>
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className="step">
                <span className="step__n" aria-hidden="true">
                  {index + 1}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <section className="section section--sunk">
        <Reveal className="wrap">
          <div className="section__head">
            <p className="eyebrow">The numbers behind it</p>
            <h2 className="title">Measured, not claimed.</h2>
          </div>
          <dl className="stats">
            <div className="stat">
              <dt>Stock-weekends studied</dt>
              <dd>{study.status === "ready" ? (study.value.summary?.samples ?? "—") : "—"}</dd>
              <p>Token vs 24/7 price vs the frozen close, across 13 stocks since July.</p>
            </div>
            <div className="stat">
              <dt>Median token vs 24/7 gap</dt>
              <dd>{sat ? `${plain(sat.medianAbsDifference)}%` : "—"}</dd>
              <p>Saturday noon. The gap people fear is a stale close, not a broken token.</p>
            </div>
            <div className="stat">
              <dt>Plans in the record</dt>
              <dd>
                {record.status === "ready"
                  ? record.value.items.filter((i) => i.planId !== null).length
                  : "—"}
              </dd>
              <p>
                {record.status === "ready"
                  ? `${record.value.kept} kept · ${record.value.refused} refused · ${record.value.broken} broken · ${record.value.open} running`
                  : "Kept, refused, broken and running."}
              </p>
            </div>
            <div className="stat">
              <dt>Longest gap in price checks</dt>
              <dd>{health.status === "ready" ? `${health.value.longestGapSeconds}s` : "—"}</dd>
              <p>
                {health.status === "ready"
                  ? `${health.value.passes} checks since the last restart, every price under two minutes old.`
                  : "Every price is checked every minute."}
              </p>
            </div>
          </dl>
        </Reveal>
      </section>

      <section className="section">
        <Reveal className="wrap closing">
          <h2 className="display display--sm">
            Lock a plan <em>before</em> tonight's close.
          </h2>
          <p className="lede">
            Pick a stock, say what should happen if it moves, and see last night replayed against
            your rule. Two minutes, no account needed to try it.
          </p>
          <Link to="/start" className="button button--primary">
            Start here
          </Link>
          {lead && (
            <p className="fine">
              Latest: plan #{lead.planId}, {kindName(lead.kind).toLowerCase()} on{" "}
              {stockName(lead.ticker)}.
            </p>
          )}
        </Reveal>
      </section>
    </>
  );
}
