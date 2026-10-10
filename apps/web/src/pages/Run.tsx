import { useMemo } from "react";
import { OutcomeBadge, Problem, Skeleton, TxLink } from "../components/bits";
import { NightStrip, type StripCheck, type StripMark } from "../components/NightStrip";
import { stockName } from "../components/PriceBoard";
import { PromiseCard } from "../components/PromiseCard";
import { agent, type RunEvent } from "../lib/api";
import {
  changePct,
  kindName,
  localStamp,
  nyClock,
  num,
  nyStamp,
  pct,
  plain,
  reasonWords,
  usd,
  windowName
} from "../lib/format";
import { useAgent, useNow } from "../lib/hooks";
import { triggerLabel, triggerPrice } from "../lib/plans";
import { Link } from "../lib/router";

function eventTime(event: RunEvent): number {
  const fromStep = /^check:(\d+)$/.exec(event.step);
  return fromStep ? Number(fromStep[1]) : Date.parse(event.at);
}

/** The run's log in plain words; the hundreds of checks become one summary line. */
function Log({
  events,
  close,
  closeTs
}: {
  events: RunEvent[];
  close: number | null;
  closeTs: number;
}) {
  const checks = events.filter((e) => e.step.startsWith("check:"));
  const prices = checks.map((e) => Number(e.prices?.P)).filter(Number.isFinite);
  const low = prices.length ? Math.min(...prices) : null;
  const high = prices.length ? Math.max(...prices) : null;
  const first = checks[0] ? eventTime(checks[0]) : null;
  const last = checks[checks.length - 1] ? eventTime(checks[checks.length - 1]!) : null;
  const lines: Array<{ at: number; title: string; body: string; tx?: string | undefined }> = [];
  const traded = events.find((e) => e.step === "decided")?.action;
  for (const event of events) {
    if (event.step.startsWith("check:")) continue;
    const at = eventTime(event);
    if (event.step === "locked")
      lines.push({
        at,
        title: "Locked on chain",
        body: "A sealed copy of the plan was written on BNB Chain.",
        tx: event.txHash
      });
    else if (event.step === "decided")
      lines.push({
        at,
        title: "Decision written on chain",
        body:
          event.action === "none"
            ? reasonWords(String(event.refusal ?? event.reason ?? ""))
            : `The trigger was hit, so the agent will ${event.action === "buy" ? "buy" : "sell"}.`,
        tx: event.txHash
      });
    else if (event.step === "result")
      lines.push({
        at,
        title: "Result published",
        body: `Outcome: ${String(event.outcome ?? "")}.`,
        tx: event.txHash
      });
    else if (event.step.startsWith("trade:")) {
      const status = event.step.slice("trade:".length);
      const received = num(event.received as string | undefined);
      lines.push({
        at,
        title:
          status === "FINISHED"
            ? traded === "buy"
              ? "Bought"
              : "Sold"
            : status === "FAILED"
              ? "Trade failed"
              : "Trade sent, waiting for the wallet",
        body:
          status === "FINISHED" && received !== null
            ? traded === "buy"
              ? `The wallet received ${plain(received, 6)} shares.`
              : `The wallet received ${usd(received)} in USDT.`
            : status === "FAILED"
              ? "The wallet's order failed, so no trade happened."
              : "",
        tx: (event.txHash as string | null | undefined) ?? undefined
      });
    } else
      lines.push({
        at,
        title: event.step.replace(/_/g, " "),
        body: event.reason ? String(event.reason) : "",
        tx: event.txHash
      });
  }
  if (checks.length > 0 && first !== null && last !== null) {
    lines.push({
      at: first,
      title: `${checks.length} price checks logged`,
      body: `From ${nyClock(first)} to ${nyClock(last)} New York. The 24/7 price ranged ${usd(low)} to ${usd(high)}${
        close === null
          ? ""
          : ` (${pct(changePct(low, close))} to ${pct(changePct(high, close))} from the close)`
      }.`
    });
  }
  // Published as promised: any stretch after the close that the agent did not check.
  if (first !== null && first - closeTs > 15 * 60_000) {
    lines.push({
      at: closeTs,
      title: `Not checked from ${nyClock(closeTs)} to ${nyClock(first)} New York`,
      body: "The agent had no official close for this session yet, so it could not measure the trigger. Plans now read the close within minutes of 4 pm."
    });
  }
  lines.sort((a, b) => a.at - b.at);
  return (
    <ol className="log">
      {lines.map((line) => (
        <li key={`${line.title}-${line.at}`}>
          <span className="log__when" title={new Date(line.at).toISOString()}>
            {localStamp(line.at)}
          </span>
          <strong>{line.title}</strong>
          <span className="log__body">{line.body}</span>
          {line.tx && <TxLink hash={line.tx} />}
        </li>
      ))}
    </ol>
  );
}

export default function Run({ id }: { id: string }) {
  const now = useNow(1000);
  const record = useAgent(() => agent.record(), [], 30_000);
  const events = useAgent(() => agent.runEvents(id), [id], 60_000);
  const item = record.status === "ready" ? record.value.items.find((i) => i.id === id) : undefined;
  const trace = useAgent(
    () => (item ? agent.night(item.ticker, item.closeTs) : Promise.reject(new Error("waiting"))),
    [item?.ticker, item?.closeTs],
    item && now < item.openTs ? 60_000 : undefined
  );

  const close =
    trace.status === "ready" && trace.value.close ? Number(trace.value.close.value) : null;
  const checks: StripCheck[] = useMemo(
    () =>
      events.status === "ready"
        ? events.value.items
            .filter((e) => e.step.startsWith("check:") && e.prices)
            .map((e) => ({ at: eventTime(e), price: Number(e.prices!.P) }))
            .filter((c) => Number.isFinite(c.price))
        : [],
    [events]
  );
  const marks: StripMark[] = [];
  if (item?.decidedAt && item.decidedAt < item.openTs) {
    marks.push({
      at: item.decidedAt,
      label: item.action === "none" || !item.action ? "decision" : item.action,
      tone: item.fillTx ? "trade" : "decision"
    });
  }
  const trigger = item && close !== null ? triggerPrice(item, close) : null;

  if (record.status === "loading")
    return (
      <div className="wrap page">
        <Skeleton height={400} />
      </div>
    );
  if (record.status === "error")
    return (
      <div className="wrap page">
        <Problem message={record.message} retry={record.retry} />
      </div>
    );
  if (!item) {
    return (
      <div className="wrap page">
        <h1 className="title">No plan with this id.</h1>
        <Link to="/record" className="arrowlink">
          Back to the record
        </Link>
      </div>
    );
  }

  return (
    <div className="wrap page">
      <header className="page__head page__head--row">
        <div>
          <p className="eyebrow">
            <Link to="/record">Record</Link> / plan #{item.planId} · {kindName(item.kind)} ·{" "}
            {stockName(item.ticker)}
          </p>
          <h1 className="title title--wide">
            The whole {windowName(item.window).toLowerCase()} of plan #{item.planId},{" "}
            <em>check by check</em>.
          </h1>
        </div>
        <OutcomeBadge item={item} />
      </header>

      <section className="runchart">
        <div className="runchart__head">
          <p className="label">
            {windowName(item.window)} · {nyStamp(item.closeTs)} to {nyStamp(item.openTs)}
          </p>
          {checks.length > 0 && (
            <p className="fine">Each dot is a check the agent logged, with the price it saw.</p>
          )}
        </div>
        {trace.status === "loading" && <Skeleton height={300} />}
        {trace.status === "error" && (
          <Problem
            message={now < item.closeTs ? "This window has not started yet." : trace.message}
          />
        )}
        {trace.status === "ready" && (
          <NightStrip
            trace={trace.value}
            now={now}
            height={300}
            checks={checks}
            marks={marks}
            lines={
              trigger === null
                ? []
                : [{ value: trigger, label: triggerLabel(item, trigger), tone: "trigger" }]
            }
            title={`${stockName(item.ticker)} during plan #${item.planId}`}
          />
        )}
      </section>

      <PromiseCard item={item} now={now} />

      <section className="section--tight">
        <h2 className="h2">What the agent logged</h2>
        {events.status === "loading" && <Skeleton height={200} />}
        {events.status === "error" && <Problem message={events.message} retry={events.retry} />}
        {events.status === "ready" && (
          <Log events={events.value.items} close={close} closeTs={item.closeTs} />
        )}
        <p className="fine">
          Raw data for developers: <a href={`/api/runs/${id}`}>plan</a> ·{" "}
          <a href={`/api/runs/${id}/events`}>log</a>
          {item.outcome && (
            <>
              {" "}
              · <a href={`/api/runs/${id}/receipt`}>receipt</a>
            </>
          )}
        </p>
      </section>
    </div>
  );
}
