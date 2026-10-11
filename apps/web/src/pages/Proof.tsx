import { Skeleton } from "../components/bits";
import { agent } from "../lib/api";
import { addressUrl, txUrl } from "../lib/format";
import { useAgent, useNow } from "../lib/hooks";
import { Reveal } from "../lib/motion";
import { Link } from "../lib/router";

const REPO = "https://github.com/Jennycruzy/redeye";
const DOC = (path: string) => `${REPO}/blob/main/${path}`;

/** The weekend CRCL sale (plan #6 in the record), step by step. Every time is from the chain. */
const PLAN6_OPEN = Date.parse("2026-10-12T13:30:00Z");
const STORY = [
  {
    at: "Fri 9 Oct · 5:14 am New York",
    title: "Locked before the bell",
    body: "The promise went on BNB Chain 10 h 45 min before the close: if the 24/7 price rises 1% above Friday's close, sell all 0.0605 CRCL. After this it cannot be changed.",
    tx: "0xc20089b42d0b848d1dd689411449c2005ce529676a639c6f70a79b281c1a2c7b",
    link: "Lock"
  },
  {
    at: "Fri 9 Oct · 4:00 pm New York",
    title: "4pm in New York. The price freezes",
    body: "Wall Street closes for the weekend. The official CRCL price stops at the close; the CRCL token on BNB Chain keeps trading."
  },
  {
    at: "All weekend, every minute",
    title: "Watched against the 24/7 price",
    body: "Redeye compares the token with the 24/7 price from Hyperliquid's equity market, each with its source and age. It reads that price only; it never trades there."
  },
  {
    at: "Fri 9 Oct · 10:41 pm New York",
    title: "The trigger is hit: +1.002%",
    body: "The decision, with the prices that caused it, is written on chain before any money moves.",
    tx: "0x4a25f64a1bb47ef302ef5dfb978bcf0ce27bd583f797217e954ef6687ab8a62a",
    link: "Decision"
  },
  {
    at: "Fri 9 Oct · 10:41 pm New York",
    title: "Sold through the Binance Agentic Wallet",
    body: "0.0605 CRCL sold for 5.156 USDT, three seconds after the decision.",
    tx: "0x3014f7996e59458934dcd500232fd2674904d183df376daac9c8171770f0e87a",
    link: "Sale"
  },
  {
    at: "Fri 9 Oct · 10:41 pm New York",
    title: "The fill is recorded with the promise",
    body: "The plan book stores what was actually received. Checked afterwards with Binance's Wallet API: Binance and the chain agree to the last digit, 5.156123572686825706 USDT.",
    tx: "0xcea26956f4a1053b9cf6f4feee049781addc82a4082b9ff0b4645d95243e683e",
    link: "Fill"
  },
  {
    at: "Mon 12 Oct · 9:30 am New York",
    title: "Graded at the open",
    body: "When Wall Street opens, the result is published on chain next to the promise. Anyone can re-check it in their browser with Check it.",
    pendingUntil: PLAN6_OPEN
  }
] as const;

/** Each first, in order, with the transaction that proves it. */
const FIRSTS = [
  {
    at: "7 Oct · 14:32",
    what: "First promise locked on chain",
    note: "Protect half an Nvidia holding overnight. Graded at the open: kept.",
    tx: "0x759ead4af86268d4015ab4074a58f2dc866ff8ee96dd077f85a5cd6ad2902092"
  },
  {
    at: "8 Oct · 04:04",
    what: "First paid x402 sale",
    note: "An agent paid 0.002 U for the 24/7 price.",
    tx: "0x7dd090f39dfa8ba765a50c3dddc547418a9ac8e1d25244e97737cbf072e79a78"
  },
  {
    at: "9 Oct · 00:39",
    what: "Registered as agent #368521",
    note: "BNB Chain's ERC-8004 agent registry.",
    tx: "0x674625e3d3000b4e748e4fc518763e94693db4d0f28f7ed05b6bf212fe02156f"
  },
  {
    at: "10 Oct · 02:41",
    what: "First trade made by a promise",
    note: "Friday 10:41 pm in New York, 6 h 41 min after the bell: CRCL was up 1%, and the agent sold through the Binance Agentic Wallet.",
    tx: "0x3014f7996e59458934dcd500232fd2674904d183df376daac9c8171770f0e87a"
  },
  {
    at: "10 Oct · 18:47",
    what: "A promise signed by the Agentic Wallet itself",
    note: "Hold Nvidia through Monday night, signed through the Redeye skill and stored under the wallet's own address.",
    tx: "0x76a339440af84130637f97cc68420fa574011dbe0e709f1bb6e77ab19f4decb5"
  },
  {
    at: "10 Oct · 21:07",
    what: "First sale settled by Binance B402",
    note: "The Agentic Wallet paid; Binance's own facilitator settled it on chain.",
    tx: "0x967e61768d815efc4642a5ba2ba0e8e7ffdfebcdff76e2ec9593ef951a663173",
    b402: true
  },
  {
    at: "11 Oct · 01:57",
    what: "B402 live on the agent",
    note: "Bought with one command of the Redeye skill: buy price NVDA.",
    tx: "0x6f195cebdf27795c63ebc4add95f1ced16105bbc9f71b5cb2f96d126c4c9cb9e",
    b402: true
  },
  {
    at: "11 Oct · 05:35",
    what: "First phone account, no seed phrase",
    note: "Made inside Telegram and approved with a fingerprint. Redeye paid the fee.",
    tx: "0x3ce352638a95caa276a88c674b37866b07f608c2e19555ad6556eed57b6c6a9f"
  }
] as const;

/** What building on Binance's tools taught us, from the log we kept as it happened. */
const FINDINGS = [
  {
    tag: "B402",
    title: "An undocumented refusal, traced to one second",
    body: "Binance refused four settlements with invalid_transaction_state. A dry run that never settled showed why: the Agentic Wallet signs the payment as valid from the signing second, and settling 0.3 s later is too early. Redeye now waits for a block past that second.",
    doc: "docs/b402-investigation.md"
  },
  {
    tag: "Telegram",
    title: "Passkeys don't open inside Telegram",
    body: "Telegram's in-app browser on Android cannot show a passkey prompt. Redeye keeps the account key behind Telegram's own fingerprint check and signs in the same format a passkey uses, so the same contract checks it."
  },
  {
    tag: "Trading",
    title: "The docs and the live route differ",
    body: "The docs describe stock tokens as an RFQ trade; the live answer is a swap routed through LiquidMesh. The Agentic Wallet's quotes matched the Trading API exactly.",
    doc: "docs/dx-log.md"
  },
  {
    tag: "RWA data",
    title: "Saturday says TRADING",
    body: "On a Saturday the market status said TRADING with no market state. Redeye keeps its own clock of when Wall Street is open and uses Binance's status only to refuse paused tokens.",
    doc: "docs/dx-log.md"
  },
  {
    tag: "Agentic Wallet",
    title: "A signature in two pieces",
    body: "EIP-712 signatures come back as 64 bytes plus a separate recovery byte. The Redeye skill joins them and checks both recovery values before it sends a plan.",
    doc: "docs/dx-log.md"
  },
  {
    tag: "Security audit",
    title: "No data is an answer too",
    body: "The token audit returned no data for all 15 stock tokens Redeye trades. Redeye shows that as AUDIT_NO_DATA instead of pretending a token passed.",
    doc: "docs/dx-log.md"
  }
] as const;

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
    name: "Phone account factory",
    address: "0x5065d3395d365d88870a5a6799c48e8f59f0e9e9",
    what: "Makes a seedless account that only the owner's phone can approve, including moving money out."
  },
  {
    name: "First phone account",
    address: "0xe40D7AEA0860FC87B0352a3e83BeEcB7409F069F",
    what: "Made from Telegram on 11 Oct and approved with a fingerprint."
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
    what: "The team's own trading wallet. It made the weekend CRCL sale, signed a promise in its own name, and pays for B402 sales."
  }
];

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
  ],
  [
    "b402",
    "B402 payments",
    "Other agents pay 0.002 U for the 24/7 price; Binance's facilitator settles each payment on chain."
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
    "Trades checked by Binance's Web3 API",
    "Live",
    "Five modules, signed with Redeye's own key; which ones run depends on the route"
  ],
  [
    "Trading through the Binance Agentic Wallet",
    "Live",
    "Sold CRCL at 10:41 pm New York time on Friday 9 Oct (02:41 UTC), after its 24/7 price rose 1%"
  ],
  [
    "Trading from your own wallet, one trade at a time",
    "Locked, no trade yet",
    "A $2 buy-the-dip on Intel is locked this way; its price has not fallen far enough yet"
  ],
  [
    "Phone accounts for newcomers, through Telegram",
    "Live",
    "First account made on 11 Oct with a fingerprint; Redeye paid the fee"
  ],
  [
    "Paid price feed for other agents, settled by Binance B402",
    "Live",
    "Since 11 Oct 01:49 UTC; every sale so far was bought by our own wallets"
  ],
  ["On-chain agent identity (ERC-8004)", "Live", "Redeye is agent #368521"],
  [
    "A job record for each plan (ERC-8183)",
    "Live",
    "Opened and paid for each plan; the first ones close after Monday's open"
  ],
  ["Other AI agents can read Redeye (MCP and A2A)", "Live", "Read-only"]
] as const;

const WORDS = [
  [
    "Plan number",
    "The record numbers promises in the order they were locked (the CRCL sale is plan #6). Only needed to find one in the record."
  ],
  ["Promise", "What a plan says it will do, in plain words, fixed before the close."],
  [
    "24/7 price",
    "The stock's price from Hyperliquid's equity market, which never closes. Used as a reference only."
  ],
  ["Window", "The hours Wall Street is shut: overnight, the weekend or a holiday."],
  ["Kept", "At the open, the record shows the plan did exactly what it promised."],
  ["Refused", "A check failed, so Redeye did not trade, and says which check and why."]
] as const;

function hours(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export default function Proof() {
  const now = useNow(30_000);
  const health = useAgent(() => agent.health(), [], 30_000);
  const binance = useAgent(() => agent.binance(), [], 60_000);
  const record = useAgent(() => agent.record(), [], 60_000);

  const items = record.status === "ready" ? record.value.items : [];
  const locked = items.filter((i) => i.freezeTx).length;
  const trades = items.filter((i) => i.fillTx).length;

  const stats: Array<[string, string]> = [
    [record.status === "ready" ? String(locked) : "—", "promises locked on BNB Chain"],
    [record.status === "ready" ? String(trades) : "—", "trades made by a promise"],
    ["6", "Binance Web3 API modules, B402 included"],
    ["8", "firsts, each with its transaction"],
    ["80", "developer-log entries, written as it happened"]
  ];

  return (
    <div className="wrap page proof">
      <header className="page__head proof__head">
        <p className="eyebrow">Proof</p>
        <blockquote className="gapquote">
          <p>
            Friday, 4pm, New York. The closing bell rings and every stock price in the country
            freezes until Monday. On-chain, nothing stops. Tokenized stocks trade straight through
            the weekend, priced off a reference that has not updated in two days.
          </p>
          <p>Anyone can see the gap. Almost nobody has built anything that acts on it.</p>
        </blockquote>
        <h1 className="display display--sm">
          We built Redeye <em>to act on this gap</em>.
        </h1>
        <p className="lede">
          It reads the 24/7 price while Wall Street sleeps, locks its promise on BNB Chain before
          the bell, and at the next open shows whether it kept its word. Every claim on this page
          links to the chain. No wallet needed to check.
        </p>
      </header>

      <ul className="proofstats" aria-label="Redeye in numbers">
        {stats.map(([n, label]) => (
          <li key={label}>
            <span className="proofstats__n">{n}</span>
            <span className="proofstats__l">{label}</span>
          </li>
        ))}
      </ul>

      <section className="section--tight" id="story">
        <p className="eyebrow">One promise, start to finish</p>
        <h2 className="h2">
          "If CRCL rises 1% while Wall Street is closed, sell it." At 10:41 pm that Friday, it did.
        </h2>
        <ol className="story">
          {STORY.map((step) => {
            const pending = "pendingUntil" in step && now < step.pendingUntil;
            return (
              <li
                key={step.title}
                className={pending ? "story__step story__step--pending" : "story__step"}
              >
                <span className="story__at">{step.at}</span>
                <strong className="story__title">{step.title}</strong>
                <span className="story__body">{step.body}</span>
                {"tx" in step && (
                  <a
                    className="tx story__tx"
                    href={txUrl(step.tx)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {step.link} on BscScan · {step.tx.slice(0, 10)}…{step.tx.slice(-4)}
                  </a>
                )}
                {"pendingUntil" in step && (
                  <span className="story__wait">
                    {pending ? `Result in ${hours(step.pendingUntil - now)}` : "See the record"}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        <p className="fine">
          <Link to="/runs/61d44225-d48b-4af2-9a56-5d0e0c99bcaf" className="arrowlink arrowlink--sm">
            Open this promise and press Check it
          </Link>
        </p>
      </section>

      <section className="section--tight" id="firsts">
        <p className="eyebrow">Firsts on BNB Chain</p>
        <h2 className="h2">Eight things that happened for real, in order</h2>
        <ol className="firsts">
          {FIRSTS.map((f) => (
            <li
              key={f.tx}
              className={"b402" in f ? "firsts__row firsts__row--b402" : "firsts__row"}
            >
              <span className="firsts__at">{f.at} UTC</span>
              <span className="firsts__what">
                <strong>{f.what}</strong>
                <span className="muted">{f.note}</span>
              </span>
              <a className="tx" href={txUrl(f.tx)} target="_blank" rel="noreferrer">
                {f.tx.slice(0, 10)}…{f.tx.slice(-4)}
              </a>
            </li>
          ))}
        </ol>
        <p className="fine">
          Every x402 and B402 buyer so far is one of our own wallets; the table says so rather than
          counting them as customers.
        </p>
      </section>

      <section className="section--tight b402" id="b402">
        <div className="b402__text">
          <p className="eyebrow">Binance B402</p>
          <h2 className="h2">Agents pay Redeye. Binance settles it.</h2>
          <p className="muted">
            Any AI agent can buy Redeye's 24/7 price for 0.002 U. Since 11 Oct 01:49 UTC, Binance's
            own B402 facilitator settles every payment on BNB Chain; Redeye hands over the price
            only after the settlement lands. Getting there took a root cause Binance's docs did not
            have, written up in full.
          </p>
          <p>
            <a
              className="arrowlink arrowlink--sm"
              href={DOC("docs/b402-investigation.md")}
              target="_blank"
              rel="noreferrer"
            >
              The B402 investigation
            </a>
          </p>
        </div>
        <div className="code b402__code">
          <pre>
            {`curl -i https://api.theredeyed-agent.site/x402/price/NVDA
# 402 Payment Required: 0.002 U

node skills/redeye/scripts/redeye.mjs buy price NVDA --yes
# Agentic Wallet pays, Binance settles`}
          </pre>
        </div>
      </section>

      <section className="section--tight" id="binance">
        <p className="eyebrow">Built on the Binance Web3 API</p>
        <h2 className="h2">Six modules, signed with Redeye's own key</h2>
        <p className="muted">
          Agentic Wallet trades are checked by RWA Data, Market and Trading first, then by Wallet
          after the trade. Trades from your own wallet also get a Transaction dry run of the exact
          transaction. If a required module doesn't answer, the trade waits instead of going ahead
          unchecked.
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
                const modules =
                  binance.status === "ready"
                    ? (binance.value.modules as Record<
                        string,
                        { ok: number; calls: number; medianLatencyMs: number | null } | undefined
                      >)
                    : undefined;
                const live = modules?.[key];
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

      <section className="section--tight" id="found">
        <p className="eyebrow">What we found building it</p>
        <h2 className="h2">86 log entries, 1,090 minutes lost, every one written down</h2>
        <p className="muted">
          We logged each snag the moment it happened: the page, the exact error, the time lost and
          the fix. Some of what we found:
        </p>
        <div className="finds">
          {FINDINGS.map((f) => (
            <Reveal key={f.title} className="finds__card">
              <span className="finds__tag">{f.tag}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              {"doc" in f && (
                <a
                  className="arrowlink arrowlink--sm"
                  href={DOC(f.doc)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the entry
                </a>
              )}
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section--tight">
        <p className="eyebrow">Check it in five minutes</p>
        <h2 className="h2">Where to click</h2>
        <ol className="judge">
          <li>
            <strong>Open the record</strong>
            <span>
              Every plan, including refused and broken ones, with its lock, decision, trade and
              result.
            </span>
            <Link to="/record" className="arrowlink arrowlink--sm">
              Record
            </Link>
          </li>
          <li>
            <strong>Press Check it on the CRCL sale</strong>
            <span>
              Your browser re-hashes the plan and the decision and compares them with BNB Chain. No
              trust in our server.
            </span>
            <Link
              to="/runs/61d44225-d48b-4af2-9a56-5d0e0c99bcaf"
              className="arrowlink arrowlink--sm"
            >
              The CRCL sale
            </Link>
          </li>
          <li>
            <strong>Compare the three prices now</strong>
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
        </ol>
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

      <section className="section--tight" id="words">
        <h2 className="h2">Words used on this site</h2>
        <dl className="words">
          {WORDS.map(([word, meaning]) => (
            <div key={word}>
              <dt>{word}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="section--tight" id="developers">
        <h2 className="h2">For developers and other agents</h2>
        <p className="muted">
          Redeye is agent #368521 in BNB Chain's agent registry. Other AI agents can read its prices
          and record over MCP and A2A, and pay per call for the 24/7 price. The Binance Agentic
          Wallet can use it through the Redeye skill.
        </p>
        <p>
          <a href={REPO} target="_blank" rel="noreferrer" className="arrowlink arrowlink--sm">
            The code and developer guide on GitHub
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
