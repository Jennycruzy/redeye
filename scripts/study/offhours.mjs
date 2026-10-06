import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const rawDirectory = resolve(repoRoot, "data/raw/offhours");
const derivedDirectory = resolve(repoRoot, "data/derived/offhours");

function near(series, timestampSeconds, maxBackSeconds = 6 * 60 * 60) {
  const keys = Object.keys(series)
    .map(Number)
    .filter((key) => timestampSeconds - maxBackSeconds <= key && key <= timestampSeconds);
  if (keys.length === 0) return null;
  return series[String(Math.max(...keys))] ?? null;
}

function utcSeconds(year, month, day, hour) {
  return Date.UTC(year, month - 1, day, hour) / 1000;
}

function addHours(timestampSeconds, hours) {
  return timestampSeconds + hours * 60 * 60;
}

export function buildRows(raw) {
  const rows = [];
  for (const [ticker, value] of Object.entries(raw)) {
    const days = Object.keys(value.nas).sort();
    for (let index = 0; index < days.length - 1; index += 1) {
      const day = days[index];
      const nextDay = days[index + 1];
      const friday = new Date(`${day}T00:00:00.000Z`);
      if (friday.getUTCDay() !== 5) continue;
      const close = value.nas[day]?.[1];
      const open = value.nas[nextDay]?.[0];
      if (close === undefined || open === undefined) continue;
      const fridayClose = utcSeconds(
        friday.getUTCFullYear(),
        friday.getUTCMonth() + 1,
        friday.getUTCDate(),
        20
      );
      const monday = new Date(`${nextDay}T00:00:00.000Z`);
      const checkpoints = {
        Sat12: addHours(fridayClose, 16),
        Sun23: addHours(fridayClose, 51),
        Mon07: utcSeconds(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 7)
      };
      const row = {
        T: ticker,
        fri: day,
        C: close,
        O: open,
        gap: open / close - 1
      };
      for (const [name, timestampSeconds] of Object.entries(checkpoints)) {
        row[`H_${name}`] = near(value.hl, timestampSeconds);
        row[`B_${name}`] = near(value.gt, timestampSeconds, 24 * 60 * 60);
      }
      rows.push(row);
    }
  }
  return rows;
}

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fixed(value, digits = 2) {
  return value.toFixed(digits);
}

function signedFixed(value, digits = 2) {
  return `${value >= 0 ? "+" : ""}${fixed(value, digits)}`;
}

function windowStats(rows, name) {
  const complete = rows.filter((row) => row[`H_${name}`] && row[`B_${name}`]);
  const errorClose = complete.map((row) => Math.abs(row.O / row.C - 1) * 100);
  const errorHyperliquid = complete.map((row) => Math.abs(row.O / row[`H_${name}`] - 1) * 100);
  const errorToken = complete.map((row) => Math.abs(row.O / row[`B_${name}`] - 1) * 100);
  const differences = complete.map((row) => (row[`B_${name}`] / row[`H_${name}`] - 1) * 100);
  const signal = (threshold) =>
    complete
      .filter((row) => Math.abs(row[`B_${name}`] / row[`H_${name}`] - 1) * 100 > threshold)
      .map(
        (row) =>
          (row[`H_${name}`] > row[`B_${name}`] ? 1 : -1) * (row.O / row[`B_${name}`] - 1) * 100
      );
  const directionRows = complete.filter((row) => Math.abs(row[`H_${name}`] / row.C - 1) > 0.005);
  const directionWins = directionRows.filter(
    (row) => (row[`H_${name}`] - row.C) * (row.O - row.C) > 0
  ).length;
  return {
    n: complete.length,
    closeError: median(errorClose),
    hyperliquidError: median(errorHyperliquid),
    tokenError: median(errorToken),
    hyperliquidCloser: complete.filter((_, index) => errorHyperliquid[index] < errorClose[index])
      .length,
    tokenCloser: complete.filter((_, index) => errorToken[index] < errorClose[index]).length,
    medianAbsDifference: median(differences.map(Math.abs)),
    overHalfPct: differences.filter((value) => Math.abs(value) > 0.5).length,
    overOnePct: differences.filter((value) => Math.abs(value) > 1).length,
    maxAbsDifference: Math.max(...differences.map(Math.abs)),
    trades: Object.fromEntries(
      ["0.3", "0.5", "1.0"].map((threshold) => {
        const values = signal(Number(threshold));
        return [
          String(threshold),
          {
            n: values.length,
            mean: mean(values),
            median: median(values),
            wins: values.filter((value) => value > 0).length
          }
        ];
      })
    ),
    directionWins,
    directionN: directionRows.length
  };
}

export function analyzeRows(allRows) {
  const rows = allRows.filter((row) => row.T !== "AAPL" && row.T !== "SKHY");
  const stocks = [...new Set(rows.map((row) => row.T))].sort();
  const windows = Object.fromEntries(
    ["Sat12", "Sun23", "Mon07"].map((name) => [name, windowStats(rows, name)])
  );
  return {
    samples: rows.length,
    stocks,
    medianWeekendGap: median(rows.map((row) => Math.abs(row.gap) * 100)),
    windows
  };
}

export function renderSummary(summary) {
  const lines = [
    `samples ${summary.samples} stocks ['${summary.stocks.join("', '")}']`,
    `median |weekend gap| (Fri close→Mon open): ${fixed(summary.medianWeekendGap)} %`
  ];
  for (const name of ["Sat12", "Sun23", "Mon07"]) {
    const stats = summary.windows[name];
    lines.push(
      `\n${name}: n=${stats.n} | median error to Monday open: Fri close ${fixed(stats.closeError)}% · HL perp ${fixed(stats.hyperliquidError)}% · BSC token ${fixed(stats.tokenError)}%`
    );
    lines.push(
      `   closer than Fri close: HL ${stats.hyperliquidCloser}/${stats.n} · BSC ${stats.tokenCloser}/${stats.n}`
    );
    lines.push(
      `   BSC vs HL: median |diff| ${fixed(stats.medianAbsDifference)}% · >0.5%: ${stats.overHalfPct} · >1%: ${stats.overOnePct} · max ${fixed(stats.maxAbsDifference)}%`
    );
    for (const threshold of ["0.3", "0.5", "1.0"]) {
      const trade = stats.trades[threshold];
      if (trade.n > 0) {
        lines.push(
          `   trade BSC toward HL if diff>${threshold}%: n=${trade.n} mean ${signedFixed(trade.mean)}% median ${signedFixed(trade.median)}% wins ${trade.wins}/${trade.n}`
        );
      }
    }
    lines.push(
      `   HL weekend move (>0.5%) had the right direction for Monday: ${stats.directionWins}/${stats.directionN}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsCsv(rows) {
  const headers = [
    "T",
    "fri",
    "C",
    "O",
    "gap",
    "H_Sat12",
    "B_Sat12",
    "H_Sun23",
    "B_Sun23",
    "H_Mon07",
    "B_Mon07"
  ];
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((header) => csvValue(row[header])).join(","))
    .join("\n")}\n`;
}

export async function runStudy({ rawDir = rawDirectory, outputDir = derivedDirectory } = {}) {
  const raw = JSON.parse(await readFile(resolve(rawDir, "study_raw.json"), "utf8"));
  const rows = buildRows(raw);
  const summary = analyzeRows(rows);
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "study_rows.csv"), rowsCsv(rows), "utf8");
  await writeFile(resolve(outputDir, "summary.txt"), renderSummary(summary), "utf8");
  await writeFile(
    resolve(outputDir, "summary.json"),
    `${JSON.stringify({ v: 1, source: "data/raw/offhours", ...summary }, null, 2)}\n`,
    "utf8"
  );
  return { rows, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await runStudy();
  process.stdout.write(renderSummary(result.summary));
}
