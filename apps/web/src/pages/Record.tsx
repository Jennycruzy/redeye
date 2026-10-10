import { useState } from "react";
import { OutcomeBadge, Problem, Skeleton, TxLink, When } from "../components/bits";
import { stockName } from "../components/PriceBoard";
import { agent, type RecordItem } from "../lib/api";
import { duration, kindName, nyStamp, windowName } from "../lib/format";
import { useAgent } from "../lib/hooks";
import { Link } from "../lib/router";

/** The agent's own wallet; plans it owns are the team's and are labelled so. */
const TEAM = "0xe201bbf3c736a5d188797974a7e4b9464f707ea8";
const AGENTIC_WALLET = "0xda11faba6da586c4eee689b3387af0b0fd00aae2";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "kept", label: "Kept" },
  { id: "refused", label: "Refused" },
  { id: "broken", label: "Broken" }
] as const;

type Filter = (typeof FILTERS)[number]["id"];

function matches(item: RecordItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return item.status === "locked" || item.status === "decided";
  return item.outcome === filter;
}

function Row({ item }: { item: RecordItem }) {
  const lead = item.lockedAt === null ? null : item.closeTs - item.lockedAt;
  return (
    <li className="rrow">
      <Link to={`/runs/${item.id}`} className="rrow__main">
        <span className="rrow__id">{item.planId === null ? "—" : `#${item.planId}`}</span>
        <span className="rrow__stock">
          <span className="ticker">{item.ticker}</span>
          <span className="name">{stockName(item.ticker)}</span>
        </span>
        <span className="rrow__promise">{item.promise}</span>
        <OutcomeBadge item={item} />
      </Link>
      <div className="rrow__meta">
        <span>
          {kindName(item.kind)} · {windowName(item.window).toLowerCase()} from{" "}
          <When at={item.closeTs}>{nyStamp(item.closeTs)}</When>
        </span>
        {lead !== null && lead > 0 && <span>locked {duration(lead)} before the close</span>}
        <span>
          {item.door === "agentic_wallet"
            ? "trades through the Agentic Wallet"
            : item.door === "plan_account"
              ? "trades from the owner's wallet, with a one-trade permission"
              : item.door === "signed" && item.owner.toLowerCase() === AGENTIC_WALLET
                ? "signed by the Binance Agentic Wallet itself · promise only"
                : item.door === "signed"
                  ? `signed in ${item.owner.slice(0, 6)}…${item.owner.slice(-4)}'s wallet · promise only`
                  : "promise only, no trading"}
        </span>
        {item.owner.toLowerCase() === TEAM && <span className="tag">team</span>}
        {item.standingRunId && <span className="tag">repeats nightly</span>}
        <span className="rrow__links">
          <TxLink hash={item.freezeTx}>lock</TxLink>
          {item.decisionTx && <TxLink hash={item.decisionTx}>decision</TxLink>}
          {item.fillTx && <TxLink hash={item.fillTx}>trade</TxLink>}
          {item.verdictTx && <TxLink hash={item.verdictTx}>result</TxLink>}
        </span>
      </div>
    </li>
  );
}

export default function Record() {
  const record = useAgent(() => agent.record(), [], 30_000);
  const [filter, setFilter] = useState<Filter>("all");
  const items =
    record.status === "ready"
      ? [...record.value.items].sort(
          (a, b) => b.closeTs - a.closeTs || (b.planId ?? 0) - (a.planId ?? 0)
        )
      : [];
  const shown = items.filter((i) => matches(i, filter));
  return (
    <div className="wrap page">
      <header className="page__head">
        <p className="eyebrow">The record</p>
        <h1 className="display display--sm">
          Every promise, <em>kept or not</em>.
        </h1>
        <p className="lede">
          Each plan Redeye has locked, newest first. Refused and broken plans stay here too. Nothing
          is removed.
        </p>
      </header>
      {record.status === "ready" && (
        <dl className="totals">
          {(
            [
              ["kept", record.value.kept],
              ["refused", record.value.refused],
              ["broken", record.value.broken],
              ["running", record.value.open],
              ["missed", record.value.missed]
            ] as const
          ).map(([label, value]) => (
            <div key={label} className={`total total--${label}`}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="filters" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            role="tab"
            type="button"
            aria-selected={filter === f.id}
            className={`tab${filter === f.id ? " tab--on" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {record.status === "loading" && <Skeleton height={300} />}
      {record.status === "error" && <Problem message={record.message} retry={record.retry} />}
      {record.status === "ready" && shown.length === 0 && (
        <p className="empty">No plans here yet. They appear the moment one is locked or graded.</p>
      )}
      <ul className="rlist">
        {shown.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
