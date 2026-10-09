import { useState } from "react";
import { Problem, Skeleton } from "../components/bits";
import { agent } from "../lib/api";
import { addressUrl, plain, txUrl } from "../lib/format";
import { useAgent } from "../lib/hooks";
import { Link } from "../lib/router";

const CONTRACTS = [
  {
    name: "PlanBook",
    address: "0xC7B860d561f2208c725ac9a873bf4eA5205e9057",
    what: "Holds every plan's fingerprint, decision and result. Refuses a lock after the close."
  },
  {
    name: "PlanAccount",
    address: "0x141B2a28895c12FD17209eC621496f0F9f1F1048",
    what: "Per-plan permission for wallets: the agent may make exactly one matching trade."
  },
  {
    name: "PlanJobHook",
    address: "0x42a7F449e4950524c13deBC96a0549100b516594",
    what: "ERC-8183 hook for team jobs, approved only when the receipt checks out."
  },
  {
    name: "Agent wallet",
    address: "0xe201bbf3C736a5d188797974a7e4B9464f707eA8",
    what: "Writes to PlanBook and receives x402 payments. Holds no user funds."
  },
  {
    name: "Agentic Wallet",
    address: "0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2",
    what: "The Binance Agentic Wallet the team's trading plans use."
  }
];

/** What is live and what is not, stated plainly (spec §21, §24). */
const REAL = [
  [
    "Off-hours prices: close, 24/7 futures price, token per real share",
    "Live",
    "Every minute, with source and age"
  ],
  ["Plans locked on BNB Chain before the close", "Live", "PlanBook on mainnet"],
  ["Decisions and results written on chain", "Live", "Recomputable in your browser with Check it"],
  [
    "Trading through the Binance Agentic Wallet",
    "Live",
    "Test trades filled on 8 Oct; plans #2 and #3 trade this weekend"
  ],
  [
    "ERC-8183 job for each locked plan",
    "Live",
    "Jobs open and funded; first completions after Monday's open"
  ],
  ["x402 sales of the 24/7 price", "Live", "First settled sale on 8 Oct"],
  ["MCP and A2A doors for other agents", "Live", "Read-only; a plan check saves nothing"],
  ["ERC-8004 identity", "Live", "Agent #368521 on BNB Chain's identity registry"],
  ["Wallet door through PlanAccount", "Contract live", "Signing page in progress"],
  ["Telegram and Face ID for newcomers", "In progress", "Not live yet"]
] as const;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="textbutton"
      type="button"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => (setDone(true), window.setTimeout(() => setDone(false), 1500)),
          () => setDone(false)
        )
      }
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className="code">
      <pre>{text}</pre>
      <Copy text={text} />
    </div>
  );
}

export default function Proof() {
  const health = useAgent(() => agent.health(), [], 30_000);
  const study = useAgent(() => agent.study(), []);
  const record = useAgent(() => agent.record(), [], 60_000);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const jobs =
    record.status === "ready"
      ? record.value.items.filter((i) => i.jobId !== null || i.teamJobId !== null)
      : [];

  return (
    <div className="wrap page">
      <header className="page__head">
        <p className="eyebrow">Proof</p>
        <h1 className="display display--sm">
          Check it yourself, <em>in five minutes</em>.
        </h1>
        <p className="lede">
          No wallet needed. Every claim on this site links to the chain or to a source you can call.
        </p>
      </header>

      <ol className="judge">
        <li>
          <strong>Open the latest promise</strong>
          <span>
            The home page leads with it: locked before the close, watched overnight, graded at the
            open. Press Check it.
          </span>
          <Link to="/" className="arrowlink arrowlink--sm">
            Home
          </Link>
        </li>
        <li>
          <strong>Read the whole record</strong>
          <span>
            Every plan, including refused and broken ones, with its lock, decision, trade and result
            transactions.
          </span>
          <Link to="/record" className="arrowlink arrowlink--sm">
            Record
          </Link>
        </li>
        <li>
          <strong>Compare the three prices right now</strong>
          <span>
            The frozen close, the 24/7 futures price and the token, each with its source and age.
          </span>
          <Link to="/t/NVDA" className="arrowlink arrowlink--sm">
            Nvidia
          </Link>
        </li>
        <li>
          <strong>Call the agent</strong>
          <span>Uptime, a plan check, or the A2A card, straight from your terminal.</span>
        </li>
      </ol>
      <Code text={`curl -s ${origin}/api/health\ncurl -s ${origin}/api/record`} />

      <section className="section--tight">
        <h2 className="h2">What is real and what is not</h2>
        <div className="board">
          <table>
            <thead>
              <tr>
                <th scope="col">Piece</th>
                <th scope="col">State</th>
                <th scope="col" className="hide-sm">
                  Evidence
                </th>
              </tr>
            </thead>
            <tbody>
              {REAL.map(([piece, state, evidence]) => (
                <tr key={piece}>
                  <td>{piece}</td>
                  <td>
                    <span
                      className={`door__state door__state--${state === "Live" ? "live" : "soon"}`}
                    >
                      {state}
                    </span>
                  </td>
                  <td className="hide-sm muted">{evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section--tight">
        <h2 className="h2">Contracts and wallets on BNB Smart Chain</h2>
        <ul className="contracts">
          {CONTRACTS.map((c) => (
            <li key={c.address}>
              <strong>{c.name}</strong>
              <a className="tx" href={addressUrl(c.address)} target="_blank" rel="noreferrer">
                {c.address}
              </a>
              <span className="muted">{c.what}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section--tight">
        <h2 className="h2">Identity</h2>
        <p className="muted">
          Redeye is agent #368521 in the ERC-8004 identity registry on BNB Chain. The registry links
          to its registration file, which lists the site, the record, uptime, MCP and A2A.
        </p>
        <p>
          <a
            className="tx"
            href={txUrl("0x674625e3d3000b4e748e4fc518763e94693db4d0f28f7ed05b6bf212fe02156f")}
            target="_blank"
            rel="noreferrer"
          >
            registration transaction
          </a>{" "}
          · <a href="/.well-known/agent-registration.json">registration file</a>
        </p>
      </section>

      <section className="section--tight" id="agents">
        <h2 className="h2">For other agents</h2>
        <div className="agents">
          <div>
            <h3>A2A</h3>
            <p className="muted">
              Agent card and JSON-RPC, protocol 1.0 and 0.3. Skills: price, windows, record, run,
              plan check.
            </p>
            <Code text={`curl -s ${origin}/.well-known/agent-card.json`} />
          </div>
          <div>
            <h3>MCP</h3>
            <p className="muted">Streamable HTTP at /mcp with five read-only tools.</p>
            <Code text={`${origin}/api/mcp`} />
          </div>
          <div>
            <h3>x402</h3>
            <p className="muted">Pay $0.002 per call for the 24/7 price, settled on BNB Chain.</p>
            <Code text={`curl -i ${origin}/api/x402/price/NVDA`} />
            <a
              className="tx"
              href={txUrl("0x7dd090f39dfa8ba765a50c3dddc547418a9ac8e1d25244e97737cbf072e79a78")}
              target="_blank"
              rel="noreferrer"
            >
              first settled sale
            </a>
          </div>
        </div>
      </section>

      <section className="section--tight">
        <h2 className="h2">ERC-8183 jobs</h2>
        {record.status === "loading" && <Skeleton height={120} />}
        {jobs.length > 0 && (
          <ul className="minilist">
            {jobs.map((p) => (
              <li key={p.id}>
                <Link to={`/runs/${p.id}`}>
                  <span>#{p.planId}</span>
                  <span>
                    {p.jobId !== null && `job ${p.jobId} ${p.jobState ?? ""}`}
                    {p.teamJobId !== null && ` · team job ${p.teamJobId} ${p.teamJobState ?? ""}`}
                  </span>
                  <span className="muted">{p.ticker}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section--tight">
        <h2 className="h2">The off-hours study</h2>
        {study.status === "error" && <Problem message={study.message} retry={study.retry} />}
        {study.status === "ready" && study.value.summary && (
          <>
            <p className="muted">
              {study.value.summary.samples} stock-weekends across{" "}
              {study.value.summary.stocks.length} stocks. Error is the distance from Monday's
              official open, in percent.
            </p>
            <div className="board">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Moment</th>
                    <th scope="col" className="num">
                      n
                    </th>
                    <th scope="col" className="num">
                      Frozen close
                    </th>
                    <th scope="col" className="num">
                      24/7 price
                    </th>
                    <th scope="col" className="num">
                      Token
                    </th>
                    <th scope="col" className="num hide-sm">
                      Token vs 24/7
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(study.value.summary.windows).map(([name, w]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="num">{w.n}</td>
                      <td className="num">{plain(w.closeError)}%</td>
                      <td className="num">{plain(w.hyperliquidError)}%</td>
                      <td className="num">{plain(w.tokenError)}%</td>
                      <td className="num hide-sm">{plain(w.medianAbsDifference)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="section--tight">
        <h2 className="h2">Uptime</h2>
        {health.status === "ready" && (
          <p className="muted">
            {health.value.passes} price passes since the last restart; longest gap{" "}
            {health.value.longestGapSeconds}s; last success{" "}
            {health.value.lastSuccessAt
              ? new Date(health.value.lastSuccessAt).toLocaleTimeString()
              : "—"}
            .
          </p>
        )}
      </section>
    </div>
  );
}
