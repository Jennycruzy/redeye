import { useState } from "react";
import { agent, type RecordItem } from "../lib/api";
import {
  duration,
  kindName,
  localStamp,
  nyStamp,
  reasonWords,
  usd,
  windowName
} from "../lib/format";
import { Link } from "../lib/router";
import type { CheckStep, PublishedRun } from "../lib/verify";
import { OutcomeBadge, TxLink, When } from "./bits";
import { stockName } from "./PriceBoard";

function CheckIt({ item }: { item: RecordItem }) {
  const [steps, setSteps] = useState<CheckStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setRunning(true);
    setError(null);
    setSteps([]);
    try {
      // The chain client loads only when someone asks for the check.
      const [{ checkRun }, published] = await Promise.all([
        import("../lib/verify"),
        agent.run(item.id)
      ]);
      await checkRun(published as unknown as PublishedRun, setSteps);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The check could not finish.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="checkit">
      <button className="button button--ghost" type="button" onClick={run} disabled={running}>
        {running ? "Checking against the chain…" : steps ? "Check it again" : "Check it"}
      </button>
      <p className="fine">
        Your browser recomputes every fingerprint with Redeye's own code and checks PlanBook and
        wallet transfers against public BNB Smart Chain nodes.
      </p>
      {steps && steps.length > 0 && (
        <ol className="checks" aria-live="polite">
          {steps.map((step) => (
            <li key={step.label} className={`checks__item checks__item--${step.state}`}>
              <span className="checks__mark" aria-hidden="true">
                {step.state === "pass" ? "✓" : step.state === "fail" ? "✕" : "…"}
              </span>
              <span>
                <strong>{step.label}</strong>
                <span className="checks__detail">{step.detail}</span>
              </span>
              <span className="sr-only">
                {step.state === "pass" ? "passed" : step.state === "fail" ? "failed" : "not yet"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="problem">{error}</p>}
    </div>
  );
}

/** One plan told as three moments: locked before the close, the night, the open. */
export function PromiseCard({ item, now }: { item: RecordItem; now: number }) {
  const lead = item.lockedAt === null ? null : item.closeTs - item.lockedAt;
  const nightOver = now >= item.openTs;
  const decided = item.decisionTx !== null && item.decisionTx !== undefined;
  return (
    <article className="promise">
      <header className="promise__head">
        <div>
          <p className="eyebrow">
            Plan #{item.planId} · {kindName(item.kind)} · {stockName(item.ticker)} ·{" "}
            {windowName(item.window).toLowerCase()}
          </p>
          <h3 className="promise__text">“{item.promise}”</h3>
        </div>
        <OutcomeBadge item={item} />
      </header>
      <ol className="moments">
        <li className="moment moment--done">
          <span className="moment__when">
            <When at={item.lockedAt ?? item.closeTs}>
              {item.lockedAt ? nyStamp(item.lockedAt) : "—"}
            </When>
          </span>
          <strong className="moment__title">Locked on chain</strong>
          <span className="moment__body">
            {lead !== null && lead > 0
              ? `${duration(lead)} before the 4 pm close. From here it cannot be changed.`
              : "Locked before the close."}
          </span>
          <TxLink hash={item.freezeTx}>lock transaction</TxLink>
        </li>
        <li className={`moment${decided || nightOver ? " moment--done" : " moment--now"}`}>
          <span className="moment__when">
            <When at={item.closeTs}>{nyStamp(item.closeTs)}</When>
          </span>
          <strong className="moment__title">{windowName(item.window)}: watched every minute</strong>
          <span className="moment__body">
            {item.action === "sell" || item.action === "buy"
              ? `The trigger was hit and the agent ${item.action === "sell" ? "sold" : "bought"} inside the plan.`
              : decided
                ? reasonWords(item.reason ?? "CONDITION_NOT_MET")
                : "Checking the 24/7 price against the trigger right now."}
          </span>
          {decided && <TxLink hash={item.decisionTx}>decision transaction</TxLink>}
          {item.fillTx && <TxLink hash={item.fillTx}>trade</TxLink>}
        </li>
        <li className={`moment${item.outcome ? " moment--done" : nightOver ? " moment--now" : ""}`}>
          <span className="moment__when">
            <When at={item.openTs}>{nyStamp(item.openTs)}</When>
          </span>
          <strong className="moment__title">Graded at the open</strong>
          <span className="moment__body">
            {item.outcome
              ? `${item.outcome === "kept" ? "Promise kept." : item.outcome === "refused" ? "Refused, with its reason." : "Broken."}${
                  item.openPrice ? ` Official open ${usd(item.openPrice)}.` : ""
                }`
              : nightOver
                ? "Waiting for Nasdaq to post the official open, then the result goes on chain."
                : `Opens ${localStamp(item.openTs)} your time.`}
          </span>
          {item.verdictTx && <TxLink hash={item.verdictTx}>result transaction</TxLink>}
        </li>
      </ol>
      <footer className="promise__foot">
        <CheckIt item={item} />
        <Link to={`/runs/${item.id}`} className="arrowlink">
          The whole night, minute by minute
        </Link>
      </footer>
    </article>
  );
}
