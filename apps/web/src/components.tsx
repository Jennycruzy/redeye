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

export function RecordRow({ item }: { item: Record<string, unknown> }) {
  return (
    <article className="record-row">
      <div>
        <StatusBadge
          tone={item.verdict === "kept" ? "good" : item.verdict === "broken" ? "bad" : "warn"}
        >
          {displayValue(item.verdict ?? item.status)}
        </StatusBadge>
      </div>
      <div>
        <strong>{displayValue(item.ticker)}</strong>
        <span>{displayValue(item.kind ?? item.event)}</span>
      </div>
      <div>
        <span>Frozen</span>
        <strong>{displayTime(item.freezeBlockTs ?? item.createdAt)}</strong>
      </div>
      <div>
        <span>Release source</span>
        <strong>{displayTime(item.releaseTs ?? item.releaseAt)}</strong>
      </div>
    </article>
  );
}
