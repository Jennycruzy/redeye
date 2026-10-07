import { useCallback, useEffect, useState } from "react";
import { agentClient, asItems, displayTime, displayValue, isObject } from "./api";
import {
  EmptyState,
  ErrorState,
  LiveCounter,
  PriceTriple,
  RecordRow,
  ReplayStamp,
  SourceLink,
  StatusBadge
} from "./components";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: unknown };

function useAgent(load: () => Promise<unknown>): LoadState & { retry: () => void } {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((current) => current + 1), []);
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    load()
      .then((value) => active && setState({ status: "ready", value }))
      .catch((error: unknown) => {
        if (active)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "The request failed."
          });
      });
    return () => {
      active = false;
    };
  }, [load, nonce]);
  return { ...state, retry };
}

function payloadValue(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function Navigation({ path }: { path: string }) {
  return (
    <nav>
      <a className="brand" href="/">
        REDEYE<span>.</span>
      </a>
      <div className="nav-links">
        <a className={path === "/" ? "active" : ""} href="/">
          Proof
        </a>
        <a className={path === "/record" ? "active" : ""} href="/record">
          Record
        </a>
        <a className={path === "/data" ? "active" : ""} href="/data">
          Data
        </a>
        <a className={path === "/replay" ? "active" : ""} href="/replay">
          Replay
        </a>
        <a className={path === "/evidence" ? "active" : ""} href="/evidence">
          Evidence
        </a>
      </div>
    </nav>
  );
}

function LeadCard({ record }: { record: unknown }) {
  const items = asItems(record);
  const live = items[0];
  if (live !== undefined) {
    const verdict = displayValue(live.verdict ?? live.outcome ?? live.status);
    const runId = live.runId ?? live.id;
    return (
      <section className="lead-card live-card">
        <div className="eyebrow">
          Most recent completed plan <StatusBadge tone="good">LIVE RECORD</StatusBadge>
        </div>
        <h2>
          {displayValue(live.ticker)} · {displayValue(live.kind ?? live.event)}
        </h2>
        <div className="proof-grid">
          <div>
            <span>Frozen on chain</span>
            <strong>{displayTime(live.freezeBlockTs ?? live.freezeTs)}</strong>
          </div>
          <div>
            <span>Earliest release source</span>
            <strong>{displayTime(live.releaseTs ?? live.releaseAt)}</strong>
          </div>
          <div>
            <span>Decision</span>
            <strong>{displayValue(live.decision ?? live.action)}</strong>
          </div>
          <div>
            <span>Verdict</span>
            <strong>{verdict}</strong>
          </div>
        </div>
        {typeof runId === "string" && runId.length > 0 ? (
          <a className="button primary" href={`/runs/${runId}`}>
            Open proof
          </a>
        ) : (
          <StatusBadge tone="warn">VERIFY UNAVAILABLE</StatusBadge>
        )}
      </section>
    );
  }
  return (
    <section className="lead-card replay-card">
      <div className="eyebrow">
        Lead story <ReplayStamp />
      </div>
      <h2>NVDA · 26 Aug release night</h2>
      <p>
        No live plan has resolved on this agent yet. The lead story is available as a recorded
        replay; it cannot move money or count in the public record.
      </p>
      <div className="proof-grid">
        <div>
          <span>Freeze proof</span>
          <strong>SIMULATED until a live plan exists</strong>
        </div>
        <div>
          <span>Source</span>
          <strong>Recorded SEC and pool data</strong>
        </div>
        <div>
          <span>Action</span>
          <strong>Modelled only</strong>
        </div>
        <div>
          <span>Verdict</span>
          <strong>REPLAY</strong>
        </div>
      </div>
      <a className="button secondary" href="/replay">
        Open replay
      </a>
    </section>
  );
}

function Landing() {
  const health = useAgent(useCallback(() => agentClient.health(), []));
  const prices = useAgent(useCallback(() => agentClient.prices(), []));
  const record = useAgent(useCallback(() => agentClient.record(), []));
  const feed = useAgent(useCallback(() => agentClient.feed(), []));
  const calendar = useAgent(useCallback(() => agentClient.calendar(), []));
  const healthValue = health.status === "ready" ? health.value : null;
  const priceItems = prices.status === "ready" ? asItems(prices.value) : [];
  const recordValue = record.status === "ready" ? record.value : null;
  const feedItems = feed.status === "ready" ? asItems(feed.value) : [];
  const calendarItems = calendar.status === "ready" ? asItems(calendar.value) : [];
  return (
    <>
      <header className="hero">
        <div className="eyebrow">The agent for when Wall Street is closed</div>
        <h1>
          Wall Street is closed.
          <br />
          <em>Your stock isn&apos;t.</em>
        </h1>
        <p>
          Redeye prices your stock from the market that never shuts, locks its plan on chain before
          the close, and at the next open shows whether it kept its word.
        </p>
        <div className="hero-actions">
          <a className="button primary" href="/data">
            See current prices
          </a>
          <a className="button ghost" href="/holdings">
            Connect a wallet
          </a>
          <a className="button ghost" href="/record">
            See the record
          </a>
        </div>
      </header>
      <main className="container">
        <LeadCard record={recordValue} />
        <section className="counter-grid">
          <LiveCounter
            label="Filings watched today"
            value={payloadValue(healthValue, "filingsSeenToday")}
          />
          <LiveCounter
            label="Agent uptime"
            value={
              payloadValue(healthValue, "uptime") ?? payloadValue(healthValue, "uptimeSeconds")
            }
          />
          <LiveCounter
            label="Plans kept"
            value={payloadValue(recordValue, "kept")}
            source="Agent /record"
          />
          <LiveCounter
            label="Refused / broken"
            value={`${displayValue(payloadValue(recordValue, "refused"))} / ${displayValue(payloadValue(recordValue, "broken"))}`}
            source="Agent /record"
          />
        </section>
        <section className="panel current-prices">
          <div className="section-heading">
            <div>
              <div className="eyebrow">Right now</div>
              <h2>Close · 24/7 · token</h2>
            </div>
            <SourceLink
              source="Agent /prices"
              fetchedAt={payloadValue(healthValue, "lastSuccessAt")}
            />
          </div>
          {prices.status === "loading" ? (
            <div className="skeleton" />
          ) : prices.status === "error" ? (
            <ErrorState message={prices.message} retry={prices.retry} />
          ) : priceItems.length === 0 ? (
            <EmptyState
              title="No source-backed prices yet"
              reason="The price service has not recorded a complete source snapshot."
            />
          ) : (
            <div className="price-grid">
              {[...priceItems]
                .sort((left, right) =>
                  displayValue(left.ticker).localeCompare(displayValue(right.ticker))
                )
                .slice(0, 6)
                .map((item) => (
                  <PriceTriple key={displayValue(item.ticker)} item={item} />
                ))}
            </div>
          )}
        </section>
        <section className="two-column">
          <div className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">Release watch</div>
                <h2>Next releases</h2>
              </div>
              <a href="/data">View data</a>
            </div>
            {calendar.status === "loading" ? (
              <div className="skeleton" />
            ) : calendar.status === "error" ? (
              <ErrorState message={calendar.message} retry={calendar.retry} />
            ) : calendarItems.length === 0 ? (
              <EmptyState
                title="No source-backed releases available"
                reason="The agent has not recorded a calendar snapshot yet."
              />
            ) : (
              <div className="release-list">
                {calendarItems.slice(0, 5).map((item, index) => (
                  <div className="release-row" key={`${displayValue(item.ticker)}-${index}`}>
                    <strong>{displayValue(item.ticker)}</strong>
                    <span>{displayTime(item.releaseTs ?? item.expectedDate)}</span>
                    <StatusBadge>{displayValue(item.kind)}</StatusBadge>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="panel">
            <div className="section-heading">
              <div>
                <div className="eyebrow">Measured evidence</div>
                <h2>Most recent filing</h2>
              </div>
              <a href="/data">Methods</a>
            </div>
            {feed.status === "loading" ? (
              <div className="skeleton" />
            ) : feed.status === "error" ? (
              <ErrorState message={feed.message} retry={feed.retry} />
            ) : feedItems.length === 0 ? (
              <EmptyState
                title="No filing recorded yet"
                reason="The live feed will show the source time and token move after a source record exists."
              />
            ) : (
              <div className="filing-card">
                <h3>
                  {displayValue(feedItems[0]?.ticker)} · {displayValue(feedItems[0]?.form)}
                </h3>
                <p>
                  Source seen{" "}
                  {displayTime(feedItems[0]?.seenAt ?? feedItems[0]?.acceptanceDateTime)}.
                </p>
                <SourceLink
                  source={feedItems[0]?.source ?? "source record"}
                  fetchedAt={feedItems[0]?.fetchedAt}
                  href={feedItems[0]?.url}
                />
              </div>
            )}
          </div>
        </section>
        <section className="truth-strip">
          <div>
            <div className="eyebrow">Honest by construction</div>
            <h2>Every action ends as proof or a refusal.</h2>
          </div>
          <p>
            The LLM extracts filing text. Deterministic code decides. A trade is called executed
            only after terminal order status and chain confirmation.
          </p>
          <a href="/evidence">What is real?</a>
        </section>
      </main>
    </>
  );
}

function RecordPage() {
  const record = useAgent(useCallback(() => agentClient.record(), []));
  return (
    <main className="container page">
      <div className="eyebrow">Public record</div>
      <h1>Every frozen plan stays visible.</h1>
      <p className="lede">
        Kept, refused, broken and cancelled plans remain inspectable. Nothing is quietly dropped.
      </p>
      {record.status === "loading" ? (
        <div className="skeleton tall" />
      ) : record.status === "error" ? (
        <ErrorState message={record.message} retry={record.retry} />
      ) : asItems(record.value).length === 0 ? (
        <EmptyState
          title="No frozen plans yet"
          reason="The record is empty until the first plan is written on chain."
        />
      ) : (
        <div className="record-list">
          {asItems(record.value).map((item, index) => (
            <RecordRow item={item} key={`${displayValue(item.id)}-${index}`} />
          ))}
        </div>
      )}
    </main>
  );
}

function DataPage() {
  const feed = useAgent(useCallback(() => agentClient.feed(), []));
  const health = useAgent(useCallback(() => agentClient.health(), []));
  const prices = useAgent(useCallback(() => agentClient.prices(), []));
  const healthValue = health.status === "ready" ? health.value : null;
  const priceItems = prices.status === "ready" ? asItems(prices.value) : [];
  return (
    <main className="container page">
      <div className="eyebrow">Source-backed data</div>
      <h1>Close to 24/7 to token.</h1>
      <p className="lede">
        Every displayed price has a source, fetch time and age. Historical study data stays separate
        from current snapshots.
      </p>
      <section className="panel current-prices">
        <div className="section-heading">
          <div>
            <div className="eyebrow">Current snapshot</div>
            <h2>Covered stocks</h2>
          </div>
          <SourceLink
            source="Agent /health lastSuccessAt"
            fetchedAt={payloadValue(healthValue, "lastSuccessAt")}
          />
        </div>
        {prices.status === "loading" ? (
          <div className="skeleton" />
        ) : prices.status === "error" ? (
          <ErrorState message={prices.message} retry={prices.retry} />
        ) : priceItems.length === 0 ? (
          <EmptyState
            title="No current prices"
            reason="The service has not recorded a snapshot yet."
          />
        ) : (
          <div className="price-grid">
            {[...priceItems]
              .sort((left, right) =>
                displayValue(left.ticker).localeCompare(displayValue(right.ticker))
              )
              .map((item) => (
                <PriceTriple key={displayValue(item.ticker)} item={item} />
              ))}
          </div>
        )}
      </section>
      {feed.status === "loading" ? (
        <div className="skeleton tall" />
      ) : feed.status === "error" ? (
        <ErrorState message={feed.message} retry={feed.retry} />
      ) : asItems(feed.value).length === 0 ? (
        <EmptyState
          title="No source records yet"
          reason="The data page will populate when the filing watcher records a filing and its price windows."
        />
      ) : (
        <div className="data-table">
          {asItems(feed.value).map((item, index) => (
            <div className="data-row" key={index}>
              <strong>{displayValue(item.ticker)}</strong>
              <span>{displayValue(item.form ?? item.kind)}</span>
              <span>{displayTime(item.seenAt ?? item.acceptanceDateTime)}</span>
              <span>{displayValue(item.r1 ?? item.move1m)}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function ReplayPage() {
  return (
    <main className="container page">
      <div className="eyebrow">
        <ReplayStamp />
      </div>
      <h1>Replay a past release.</h1>
      <p className="lede">
        Replay uses recorded source times, minute bars and pool state. It never writes to PlanBook,
        creates a job or moves money.
      </p>
      <section className="panel replay-choice">
        <h2>NVDA · 26 Aug 2026</h2>
        <p>
          Recorded release-night data is the first judge path. The result stays stamped REPLAY on
          every panel.
        </p>
        <a className="button secondary" href="/replay/nvda-2026-08-26">
          Open recorded run
        </a>
      </section>
    </main>
  );
}

function EvidencePage() {
  return (
    <main className="container page">
      <div className="eyebrow">Evidence</div>
      <h1>What is real and what is not.</h1>
      <p className="lede">
        Claims appear only when their evidence exists. This page is intentionally honest while the
        live integrations are being built.
      </p>
      <div className="evidence-table">
        <div>
          <StatusBadge tone="good">REAL</StatusBadge>
          <strong>Deterministic decision core</strong>
          <span>Covered by offline tests.</span>
        </div>
        <div>
          <StatusBadge tone="good">REAL</StatusBadge>
          <strong>PlanBook lifecycle contract</strong>
          <span>
            Compiled and covered by offline Foundry tests; mainnet deployment is not claimed.
          </span>
        </div>
        <div>
          <StatusBadge tone="warn">REPLAY</StatusBadge>
          <strong>NVDA release-night story</strong>
          <span>Recorded data only until a live plan resolves.</span>
        </div>
        <div>
          <StatusBadge tone="warn">NOT WIRED</StatusBadge>
          <strong>Agentic Wallet execution</strong>
          <span>Startup refuses wallet writes until the executor is configured.</span>
        </div>
        <div>
          <StatusBadge tone="warn">NOT WIRED</StatusBadge>
          <strong>Agent Studio and x402</strong>
          <span>No identity, paid job or settlement is claimed yet.</span>
        </div>
      </div>
    </main>
  );
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <main className="container page">
      <div className="eyebrow">Read-only state</div>
      <h1>{title}</h1>
      <EmptyState
        title="Wallet connection is not configured"
        reason="This path will show source-backed holdings and plan actions after the Agentic Wallet executor is connected."
      />
    </main>
  );
}

export default function App() {
  const path = window.location.pathname;
  const page =
    path === "/" ? (
      <Landing />
    ) : path === "/record" ? (
      <RecordPage />
    ) : path === "/data" ? (
      <DataPage />
    ) : path === "/replay" ? (
      <ReplayPage />
    ) : path === "/evidence" ? (
      <EvidencePage />
    ) : path === "/holdings" ? (
      <PlaceholderPage title="Your tokenized stocks" />
    ) : (
      <PlaceholderPage title="Redeye" />
    );
  return (
    <>
      <Navigation path={path} />
      {page}
      <footer>Not investment advice. Tokenized stocks can lose value.</footer>
    </>
  );
}
