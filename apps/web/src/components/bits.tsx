import { nyseSessionAt } from "@redeye/core";
import type { ReactNode } from "react";
import type { Outcome, RecordItem } from "../lib/api";
import { duration, nyClock, shortHash, txUrl, utcStamp } from "../lib/format";

/** Whether Wall Street's regular session is running, and how long until it changes. */
export function marketState(now: number): {
  open: boolean;
  label: string;
  next: number;
  nextLabel: string;
} {
  const session = nyseSessionAt(now);
  if (session.period === "regular") {
    return { open: true, label: "open", next: session.regularCloseMs, nextLabel: "closes" };
  }
  return { open: false, label: "closed", next: session.nextRegularOpenMs, nextLabel: "opens" };
}

export function MarketClock({ now }: { now: number }) {
  const state = marketState(now);
  return (
    <div className="clock" aria-live="off">
      <span className={`clock__dot${state.open ? "" : " clock__dot--live"}`} aria-hidden="true" />
      <span className="clock__city">New York</span>
      <time className="clock__time">{nyClock(now)}</time>
      <span className="clock__state">
        {state.label} · {state.nextLabel} in {duration(state.next - now)}
      </span>
    </div>
  );
}

const OUTCOME_WORD: Record<Outcome, string> = {
  kept: "Kept",
  refused: "Refused",
  broken: "Broken"
};

/** Outcome or status, always as icon + word + colour, never colour alone. */
export function OutcomeBadge({
  item
}: {
  item: Pick<RecordItem, "outcome" | "status"> & {
    closeTs?: number;
    action?: string | null;
    fillTx?: string | null;
  };
}) {
  if (item.outcome) {
    return (
      <span className={`badge badge--${item.outcome}`}>
        <OutcomeIcon outcome={item.outcome} />
        {OUTCOME_WORD[item.outcome]}
      </span>
    );
  }
  const word =
    item.status === "locked"
      ? item.closeTs !== undefined && Date.now() < item.closeTs
        ? "Locked · starts at the close"
        : "Watching"
      : item.status === "decided"
        ? item.fillTx
          ? `${item.action === "buy" ? "Bought" : "Sold"} · graded at the open`
          : "Waiting for the open"
        : item.status === "missed"
          ? "Lock missed"
          : item.status === "cancelled"
            ? "Cancelled"
            : item.status;
  return (
    <span className="badge badge--running">
      <span className="badge__pulse" aria-hidden="true" />
      {word}
    </span>
  );
}

function OutcomeIcon({ outcome }: { outcome: Outcome }) {
  if (outcome === "kept")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="badge__icon">
        <path
          d="M3.5 8.5l3 3 6-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (outcome === "refused")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="badge__icon">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4.2 11.8l7.6-7.6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="badge__icon">
      <path
        d="M8 2.5l6 11H2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.8v3.2M8 11.6v.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TxLink({
  hash,
  children
}: {
  hash: string | null | undefined;
  children?: ReactNode;
}) {
  if (!hash) return <span className="muted">—</span>;
  return (
    <a className="tx" href={txUrl(hash)} target="_blank" rel="noreferrer">
      {children ?? shortHash(hash)}
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4 2h6v6M10 2L3 9" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </a>
  );
}

/** A time shown in New York and in the reader's zone, with UTC on hover (spec §6). */
export function When({ at, children }: { at: number; children?: ReactNode }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={utcStamp(at)}>
      {children ?? `${nyClock(at)} New York`}
    </time>
  );
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-hidden="true" />;
}

export function Problem({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="problem" role="alert">
      <p>{message}</p>
      {retry && (
        <button className="textbutton" type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}
