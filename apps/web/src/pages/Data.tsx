import { Problem, Skeleton } from "../components/bits";
import { agent } from "../lib/api";
import { plain } from "../lib/format";
import { useAgent } from "../lib/hooks";

const WINDOW_LABELS: Record<string, string> = {
  Sat12: "Saturday · 12:00 UTC",
  Sun23: "Sunday · 23:00 UTC",
  Mon07: "Monday · 07:00 UTC"
};

function downloadCsv(csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "redeye-offhours-study.csv";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Data() {
  const study = useAgent(() => agent.study(), []);
  const summary = study.status === "ready" ? study.value.summary : undefined;
  const csv = study.status === "ready" ? study.value.csv : undefined;

  return (
    <div className="wrap page">
      <header className="page__head">
        <p className="eyebrow">Data and method</p>
        <h1 className="display display--sm">
          The off-hours study, <em>open for inspection</em>.
        </h1>
        <p className="lede">
          A historical comparison of the frozen Friday close, a 24/7 market price and tokenized
          stock prices over weekends.
        </p>
      </header>

      {study.status === "loading" && <Skeleton height={260} />}
      {study.status === "error" && <Problem message={study.message} retry={study.retry} />}
      {study.status === "ready" && !summary && (
        <Problem message="The study summary is not available." retry={study.retry} />
      )}

      {summary && (
        <>
          <dl className="stats">
            <div className="stat">
              <dt>Stock-weekends</dt>
              <dd>{summary.samples}</dd>
              <p>Included in the summary</p>
            </div>
            <div className="stat">
              <dt>Stocks</dt>
              <dd>{summary.stocks.length}</dd>
              <p>{summary.stocks.join(" · ")}</p>
            </div>
            <div className="stat">
              <dt>Median weekend gap</dt>
              <dd>{plain(summary.medianWeekendGap)}%</dd>
              <p>Across the included sample</p>
            </div>
            <div className="stat">
              <dt>Snapshot date</dt>
              <dd>5 Oct</dd>
              <p>2026 · frozen source data</p>
            </div>
          </dl>

          <section className="section--tight">
            <div className="page__head page__head--row">
              <div>
                <h2 className="h2">Distance from Monday’s official open</h2>
                <p className="muted">
                  How far each price was from Monday's official open, in percent (the middle value).
                  Lower is closer. “Token” is the price on BNB Chain.
                </p>
              </div>
              <button
                className="button button--primary"
                type="button"
                onClick={() => csv && downloadCsv(csv)}
                disabled={!csv}
              >
                Download the CSV
              </button>
            </div>
            <div className="board">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Moment</th>
                    <th scope="col" className="num">
                      Weekends
                    </th>
                    <th scope="col" className="num">
                      Friday close
                    </th>
                    <th scope="col" className="num">
                      24/7 reference
                    </th>
                    <th scope="col" className="num">
                      Token
                    </th>
                    <th scope="col" className="num hide-sm">
                      Token vs 24/7
                    </th>
                    <th scope="col" className="num hide-sm">
                      Off by over 0.5%
                    </th>
                    <th scope="col" className="num hide-sm">
                      Off by over 1%
                    </th>
                    <th scope="col" className="num hide-sm">
                      Right direction
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.windows).map(([key, window]) => (
                    <tr key={key}>
                      <td>{WINDOW_LABELS[key] ?? key}</td>
                      <td className="num">{window.n}</td>
                      <td className="num">{plain(window.closeError)}%</td>
                      <td className="num">{plain(window.hyperliquidError)}%</td>
                      <td className="num">{plain(window.tokenError)}%</td>
                      <td className="num hide-sm">{plain(window.medianAbsDifference)}%</td>
                      <td className="num hide-sm">{window.overHalfPct}</td>
                      <td className="num hide-sm">{window.overOnePct}</td>
                      <td className="num hide-sm">
                        {window.directionWins}/{window.directionN}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="section--tight">
            <h2 className="h2">How to read this</h2>
            <p className="muted">
              The data was captured on 5 October 2026 and is kept frozen, so the numbers can be
              checked later. It covers 104 weekends across 13 stocks. Each row compares the Friday
              close, the 24/7 price and the token with Monday's official open. “Right direction”
              counts how often the 24/7 price moved the same way as Monday's open.
            </p>
            <p className="muted">
              The full method, including the two stocks left out and why, is in the{" "}
              <a
                href="https://github.com/Jennycruzy/redeye/blob/main/docs/data.md"
                target="_blank"
                rel="noreferrer"
              >
                data notes on GitHub
              </a>
              .
            </p>
            <p className="fine">
              These are descriptive historical measurements, not a forecast, trading signal or
              investment advice.
            </p>
          </section>

          <section className="section--tight">
            <h2 className="h2">Earnings-night data</h2>
            <p className="muted">
              No source-backed earnings-night sample is currently available here. It will appear as
              a separate dataset when collected; it is not mixed into this weekend study.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
