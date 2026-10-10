import { Skeleton } from "../components/bits";
import { agent } from "../lib/api";
import { addressUrl, txUrl } from "../lib/format";
import { useAgent } from "../lib/hooks";
import { Link } from "../lib/router";

const REPO = "https://github.com/Jennycruzy/redeye";

const CONTRACTS = [
  {
    name: "Plan book",
    address: "0xC7B860d561f2208c725ac9a873bf4eA5205e9057",
    what: "Holds every plan, decision and result. It refuses a plan locked after the close."
  },
  {
    name: "One-trade permission",
    address: "0x9736a95F6a5c24165Ecf282e3E08016715460AAC",
    what: "Lets the agent make exactly one matching trade from a person's own wallet, and nothing else."
  },
  {
    name: "Job checker",
    address: "0x42a7F449e4950524c13deBC96a0549100b516594",
    what: "Approves a plan's job record only when its receipt checks out."
  },
  {
    name: "Agent wallet",
    address: "0xe201bbf3C736a5d188797974a7e4B9464f707eA8",
    what: "Writes plans and results on chain and receives payments. Holds no one else's money."
  },
  {
    name: "Binance Agentic Wallet",
    address: "0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2",
    what: "The team's own trading wallet. It made the first plan trade, and signed plan #10 in its own name."
  }
];

const FIRST_TRADE = "0x3014f7996e59458934dcd500232fd2674904d183df376daac9c8171770f0e87a";

/** The Binance Web3 API modules Redeye calls, signed with its own key, and what each one does. */
const BINANCE_MODULES = [
  [
    "rwa",
    "RWA data",
    "Every 10 minutes and before each trade: the token's status, shares per token and price. A paused token is refused."
  ],
  [
    "market",
    "Market",
    "Binance's price for the token, kept next to the pool price before each trade."
  ],
  [
    "trading",
    "Trading",
    "Binance's own quote for the same trade. If it is more than 1.5% from the wallet's, the trade waits."
  ],
  [
    "transaction",
    "Transaction",
    "A dry run of the exact transaction for trades from your own wallet. If it fails, nothing is sent."
  ],
  [
    "wallet",
    "Wallet",
    "After each trade, Binance's record of what the wallet sent and received, compared with the chain's."
  ]
] as const;

/** What is live and what is not, stated plainly. */
const REAL = [
  [
    "Prices after hours: the close, the 24/7 price and the token",
    "Live",
    "Checked every minute, each with its source and age"
  ],
  ["Plans locked on BNB Chain before the close", "Live", "Every plan since 7 Oct is in the record"],
  ["Decisions and results written on chain", "Live", "Check them yourself with Check it"],
  [
    "Every trade checked by Binance's Web3 API first",
    "Live",
    "Five modules, signed with Redeye's own key; live counts below"
  ],
  [
    "Trading through the Binance Agentic Wallet",
    "Live",
    "Plan #6 sold CRCL at 02:41 UTC on 10 Oct, after the 24/7 price rose 1%"
  ],
  [
    "Trading from your own wallet, one trade at a time",
    "Live",
    "Plan #8 is locked with a $2 limit; its trigger has not been hit yet"
  ],
  [
    "Phone accounts for newcomers, through Telegram",
    "Testing",
    "Account creation is live; the first real phone account is still being confirmed"
  ],
  ["Paid price feed for other agents (x402)", "Live", "First paid sale on 8 Oct"],
  ["On-chain agent identity (ERC-8004)", "Live", "Redeye is agent #368521"],
  [
    "A job record for each plan (ERC-8183)",
    "Live",
    "Opened and paid for each plan; the first ones close after Monday's open"
  ],
  ["Other AI agents can read Redeye (MCP and A2A)", "Live", "Read-only"]
] as const;

export default function Proof() {
  const health = useAgent(() => agent.health(), [], 30_000);
  const binance = useAgent(() => agent.binance(), [], 60_000);

  return (
    <div className="wrap page">
      <header className="page__head">
        <p className="eyebrow">Proof</p>
        <h1 className="display display--sm">
          Check it yourself, <em>in five minutes</em>.
        </h1>
        <p className="lede">
          No wallet needed. Every claim on this site links to BNB Chain or to a public source.
        </p>
      </header>

      <ol className="judge">
        <li>
          <strong>Open the latest promise</strong>
          <span>
            The home page leads with it: locked before the close, watched through the night, graded
            at the open. Press Check it.
          </span>
          <Link to="/" className="arrowlink arrowlink--sm">
            Home
          </Link>
        </li>
        <li>
          <strong>See the first trade</strong>
          <span>
            Plan #6 promised to sell CRCL if it rose 1% over the weekend. It did, at 02:41 UTC on 10
            Oct, and the agent sold through the Binance Agentic Wallet.
          </span>
          <a
            className="arrowlink arrowlink--sm"
            href={txUrl(FIRST_TRADE)}
            target="_blank"
            rel="noreferrer"
          >
            The trade on BscScan
          </a>
        </li>
        <li>
          <strong>Read the whole record</strong>
          <span>
            Every plan, including refused and broken ones, with its lock, decision, trade and
            result.
          </span>
          <Link to="/record" className="arrowlink arrowlink--sm">
            Record
          </Link>
        </li>
        <li>
          <strong>Compare the three prices right now</strong>
          <span>The close, the 24/7 price and the token, each with its source and age.</span>
          <Link to="/t/NVDA" className="arrowlink arrowlink--sm">
            Nvidia
          </Link>
        </li>
        <li>
          <strong>Look at the research</strong>
          <span>104 past weekends: how far each price was from Monday's open.</span>
          <Link to="/data" className="arrowlink arrowlink--sm">
            Data
          </Link>
        </li>
        <li>
          <strong>Replay a past night</strong>
          <span>See where a trigger would have been hit. Nothing is traded.</span>
          <Link to="/replay" className="arrowlink arrowlink--sm">
            Replay
          </Link>
        </li>
      </ol>

      <section className="section--tight" id="binance">
        <h2 className="h2">Built on the Binance Web3 API</h2>
        <p className="muted">
          Redeye signs its own calls to five Binance Web3 API modules. If one doesn't answer, the
          trade waits instead of going ahead unchecked.
        </p>
        <div className="board">
          <table>
            <thead>
              <tr>
                <th scope="col">Module</th>
                <th scope="col">What it does for your plan</th>
                <th scope="col" className="num hide-sm">
                  Calls since restart
                </th>
              </tr>
            </thead>
            <tbody>
              {BINANCE_MODULES.map(([key, name, what]) => {
                const live = binance.status === "ready" ? binance.value.modules[key] : undefined;
                return (
                  <tr key={key}>
                    <td>{name}</td>
                    <td className="muted">{what}</td>
                    <td className="num hide-sm">
                      {live
                        ? `${live.ok}/${live.calls} ok${live.medianLatencyMs === null ? "" : ` · ${live.medianLatencyMs} ms`}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fine">
          RWA data runs every 10 minutes. Market, Trading and Transaction run when a trigger is hit,
          just before the trade. Wallet runs after each trade.
        </p>
        {binance.status === "ready" && binance.value.bstocks.checkedAt && (
          <p className="fine">
            Binance lists {binance.value.bstocks.count} stock tokens on BNB Chain right now, last
            checked {new Date(binance.value.bstocks.checkedAt).toLocaleTimeString()}.
          </p>
        )}
      </section>

      <section className="section--tight">
        <h2 className="h2">What is live and what is not</h2>
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
        <h2 className="h2">Contracts and wallets on BNB Chain</h2>
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

      <section className="section--tight" id="developers">
        <h2 className="h2">For developers and other agents</h2>
        <p className="muted">
          Redeye is agent #368521 in BNB Chain's agent registry (
          <a
            className="tx"
            href={txUrl("0x674625e3d3000b4e748e4fc518763e94693db4d0f28f7ed05b6bf212fe02156f")}
            target="_blank"
            rel="noreferrer"
          >
            registration
          </a>
          ). Other AI agents can read its prices and record, and can pay per call for the 24/7 price
          (
          <a
            className="tx"
            href={txUrl("0x7dd090f39dfa8ba765a50c3dddc547418a9ac8e1d25244e97737cbf072e79a78")}
            target="_blank"
            rel="noreferrer"
          >
            first paid sale
          </a>
          ).
        </p>
        <p>
          <a href={REPO} target="_blank" rel="noreferrer" className="arrowlink arrowlink--sm">
            How to connect: the developer guide on GitHub
          </a>
        </p>
      </section>

      <section className="section--tight">
        <h2 className="h2">Uptime</h2>
        {health.status === "loading" && <Skeleton height={24} />}
        {health.status === "ready" && (
          <p className="muted">
            {health.value.passes} price checks since the last restart. The longest gap between
            checks was {health.value.longestGapSeconds} seconds.
          </p>
        )}
      </section>
    </div>
  );
}
