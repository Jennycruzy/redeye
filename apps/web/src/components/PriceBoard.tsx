import type { PriceItem } from "../lib/api";
import { changePct, num, pct, usd } from "../lib/format";
import { Link } from "../lib/router";

const NAMES: Record<string, string> = {
  NVDA: "Nvidia",
  TSLA: "Tesla",
  GOOGL: "Alphabet",
  MSFT: "Microsoft",
  META: "Meta",
  AMZN: "Amazon",
  AAPL: "Apple",
  INTC: "Intel",
  TSM: "TSMC",
  NFLX: "Netflix",
  HOOD: "Robinhood",
  MSTR: "Strategy",
  SNDK: "SanDisk",
  CRCL: "Circle",
  SKHY: "SK Hynix"
};

export function stockName(ticker: string): string {
  return NAMES[ticker] ?? ticker;
}

function Age({ seconds }: { seconds: number | undefined }) {
  if (seconds === undefined) return null;
  const stale = seconds > 120;
  return (
    <span
      className={`age${stale ? " age--stale" : ""}`}
      title={stale ? "Older than two minutes" : undefined}
    >
      {seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}
    </span>
  );
}

/**
 * Close, 24/7 price and token price per real share for every listed stock, each with its
 * age. Rows link to the stock page. Stocks whose sources failed say so instead of a number.
 */
export function PriceBoard({ items, marketOpen }: { items: PriceItem[]; marketOpen: boolean }) {
  const rows = [...items].sort((a, b) => {
    const okA = a.state === "ok" ? 0 : 1;
    const okB = b.state === "ok" ? 0 : 1;
    return okA - okB || Number(b.pool?.reserveUsd ?? 0) - Number(a.pool?.reserveUsd ?? 0);
  });
  return (
    <div className="board" role="region" aria-label="Prices right now" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">Stock</th>
            <th scope="col" className="num">
              Last close
            </th>
            <th scope="col" className="num">
              {marketOpen ? "Live" : "24/7 price"}
            </th>
            <th scope="col" className="num">
              Since close
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
          {rows.map((item) => {
            const close = num(item.close?.value);
            const real = num(item.real?.value);
            const move = changePct(real, close);
            const tokenGap = num(item.gaps?.tokenToRealPct);
            if (item.state !== "ok") {
              return (
                <tr key={item.ticker} className="board__row board__row--down">
                  <th scope="row">
                    <span className="ticker">{item.ticker}</span>
                    <span className="name">{stockName(item.ticker)}</span>
                  </th>
                  <td colSpan={5} className="muted">
                    Not priced right now: a source did not answer.
                  </td>
                </tr>
              );
            }
            return (
              <tr key={item.ticker} className="board__row">
                <th scope="row">
                  <Link to={`/t/${item.ticker}`} className="board__link">
                    <span className="ticker">{item.ticker}</span>
                    <span className="name">{stockName(item.ticker)}</span>
                  </Link>
                </th>
                <td className="num">
                  {usd(close)}
                  <span className="sub">{item.close?.date.slice(5).replace("-", "/")}</span>
                </td>
                <td className="num strong">
                  {usd(real)} <Age seconds={item.real?.ageSeconds} />
                </td>
                <td
                  className={`num move ${move === null ? "" : move >= 0 ? "move--up" : "move--down"}`}
                >
                  {pct(move)}
                </td>
                <td className="num">
                  {usd(item.token?.value)} <Age seconds={item.token?.ageSeconds} />
                </td>
                <td className="num hide-sm">{pct(tokenGap)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
