import type { ReactNode } from "react";
import { displayTime, displayValue, isObject } from "./api";

export function StatusBadge({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ReplayStamp() {
  return <StatusBadge tone="warn">REPLAY</StatusBadge>;
}

export function SourceLink({
  source,
  fetchedAt,
  href
}: {
  source: unknown;
  fetchedAt: unknown;
  href?: unknown;
}) {
  const label = `${displayValue(source)} · fetched ${displayTime(fetchedAt)}`;
  if (typeof href === "string" && href.length > 0) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="source-link">
        {label}
      </a>
    );
  }
  return <span className="source-link">{label}</span>;
}

export function LiveCounter({
  label,
  value,
  source = "Agent /health"
}: {
  label: string;
  value: unknown;
  source?: string;
}) {
  return (
    <div className="counter">
      <span className="counter-value">{displayValue(value)}</span>
      <span className="counter-label">{label}</span>
      <span className="counter-source">{source}</span>
    </div>
  );
}

function pricePoint(item: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = item[field];
  return isObject(value) ? value : {};
}

function priceLabel(point: Record<string, unknown>): string {
  const value = displayValue(point.value);
  return value === "Unavailable" ? value : `$${value}`;
}

function PriceCell({ label, point }: { label: string; point: Record<string, unknown> }) {
  return (
    <div className="price-cell">
      <span>{label}</span>
      <strong>{priceLabel(point)}</strong>
      <small>
        {displayValue(point.source)} · age {displayValue(point.ageSeconds)}s
      </small>
    </div>
  );
}

export function PriceTriple({ item }: { item: Record<string, unknown> }) {
  const ticker = displayValue(item.ticker);
  if (item.state !== "ok") {
    const failure = isObject(item.error) ? item.error : {};
    return (
      <article className="price-card price-card-error">
        <div className="price-card-heading">
          <h3>{ticker}</h3>
          <StatusBadge tone="bad">UNAVAILABLE</StatusBadge>
        </div>
        <p>
          {displayValue(failure.code)}: {displayValue(failure.reason)}
        </p>
      </article>
    );
  }

  return (
    <article className="price-card">
      <div className="price-card-heading">
        <h3>{ticker}</h3>
        <StatusBadge tone="good">SOURCE OK</StatusBadge>
      </div>
      <div className="price-cells">
        <PriceCell label="US close" point={pricePoint(item, "close")} />
        <PriceCell label="24/7 price" point={pricePoint(item, "real")} />
        <PriceCell label="Token / share" point={pricePoint(item, "token")} />
      </div>
      <div className="price-gaps">
        Token vs close {displayValue(isObject(item.gaps) ? item.gaps.tokenToClosePct : undefined)}%
        <span>
          {" "}
          · token vs 24/7 {displayValue(isObject(item.gaps) ? item.gaps.tokenToRealPct : undefined)}
          %
        </span>
      </div>
    </article>
  );
}

export function EmptyState({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{reason}</span>
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="error-state">
      <strong>Could not load this evidence</strong>
      <span>{message}</span>
      <button onClick={retry}>Retry</button>
    </div>
  );
}

const OUTCOME_TONE = { kept: "good", refused: "warn", broken: "bad" } as const;

function txLink(hash: unknown, label: string) {
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return (
    <a href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

/** Minutes between two millisecond timestamps, written for people. */
export function leadTime(earlierMs: unknown, laterMs: unknown): string {
  if (typeof earlierMs !== "number" || typeof laterMs !== "number") return "Unavailable";
  const minutes = Math.round((laterMs - earlierMs) / 60_000);
  if (minutes < 0) return "after the close";
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours} h ${minutes % 60} min before the close`
    : `${minutes} min before the close`;
}

export function OutcomeBadge({ item }: { item: Record<string, unknown> }) {
  const outcome = item.outcome;
  if (outcome === "kept" || outcome === "refused" || outcome === "broken") {
    return <StatusBadge tone={OUTCOME_TONE[outcome]}>{outcome.toUpperCase()}</StatusBadge>;
  }
  if (item.status === "cancelled") return <StatusBadge>CANCELLED</StatusBadge>;
  return <StatusBadge tone="warn">RUNNING</StatusBadge>;
}

export function PlanLinks({ item }: { item: Record<string, unknown> }) {
  return (
    <span className="plan-links">
      {txLink(item.freezeTx, "Lock")}
      {txLink(item.verdictTx, "Result")}
    </span>
  );
}

export function RecordRow({ item }: { item: Record<string, unknown> }) {
  return (
    <article className="record-row">
      <div>
        <OutcomeBadge item={item} />
      </div>
      <div>
        <strong>
          {displayValue(item.ticker)} · {displayValue(item.window)}
        </strong>
        <span>{displayValue(item.promise)}</span>
      </div>
      <div>
        <span>Locked</span>
        <strong>{leadTime(item.lockedAt, item.closeTs)}</strong>
      </div>
      <div>
        <span>Result</span>
        <strong>
          {typeof item.outcome === "string"
            ? `${displayValue(item.reason)}${typeof item.openPrice === "string" ? ` · open $${item.openPrice}` : ""}`
            : `at the open, ${displayTime(item.openTs)}`}
        </strong>
        <PlanLinks item={item} />
      </div>
    </article>
  );
}
