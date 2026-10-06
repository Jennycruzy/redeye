import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { analyzeRows, buildRows, renderSummary } from "./offhours.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");

test("the Node study rebuilds all frozen stock-weekend rows", async () => {
  const raw = JSON.parse(
    await readFile(resolve(repoRoot, "data/raw/offhours/study_raw.json"), "utf8")
  );
  const frozenRows = JSON.parse(
    await readFile(resolve(repoRoot, "data/raw/offhours/study_rows.json"), "utf8")
  );
  const rows = buildRows(raw);

  assert.equal(rows.length, 120);
  assert.deepEqual(rows, frozenRows);
});

test("the Node summary matches the frozen study results", async () => {
  const raw = JSON.parse(
    await readFile(resolve(repoRoot, "data/raw/offhours/study_raw.json"), "utf8")
  );
  const summary = analyzeRows(buildRows(raw));
  const expected = `samples 104 stocks ['AMZN', 'CRCL', 'GOOGL', 'HOOD', 'INTC', 'META', 'MSFT', 'MSTR', 'NFLX', 'NVDA', 'SNDK', 'TSLA', 'TSM']
median |weekend gap| (Fri close→Mon open): 0.89 %

Sat12: n=96 | median error to Monday open: Fri close 0.92% · HL perp 0.83% · BSC token 0.82%
   closer than Fri close: HL 48/96 · BSC 47/96
   BSC vs HL: median |diff| 0.26% · >0.5%: 25 · >1%: 0 · max 0.94%
   trade BSC toward HL if diff>0.3%: n=45 mean +0.56% median +0.36% wins 27/45
   trade BSC toward HL if diff>0.5%: n=25 mean +0.47% median +0.36% wins 15/25
   HL weekend move (>0.5%) had the right direction for Monday: 11/15

Sun23: n=95 | median error to Monday open: Fri close 0.94% · HL perp 1.08% · BSC token 1.07%
   closer than Fri close: HL 49/95 · BSC 42/95
   BSC vs HL: median |diff| 0.28% · >0.5%: 18 · >1%: 1 · max 1.41%
   trade BSC toward HL if diff>0.3%: n=44 mean +0.62% median +0.49% wins 25/44
   trade BSC toward HL if diff>0.5%: n=18 mean +1.01% median +0.99% wins 14/18
   trade BSC toward HL if diff>1.0%: n=1 mean +0.90% median +0.90% wins 1/1
   HL weekend move (>0.5%) had the right direction for Monday: 27/43

Mon07: n=97 | median error to Monday open: Fri close 0.90% · HL perp 0.73% · BSC token 0.70%
   closer than Fri close: HL 59/97 · BSC 57/97
   BSC vs HL: median |diff| 0.26% · >0.5%: 19 · >1%: 0 · max 0.90%
   trade BSC toward HL if diff>0.3%: n=39 mean +0.63% median +0.46% wins 30/39
   trade BSC toward HL if diff>0.5%: n=19 mean +0.75% median +0.46% wins 16/19
   HL weekend move (>0.5%) had the right direction for Monday: 53/65
`;

  assert.equal(renderSummary(summary), expected);
});

test("the study source contains no network client", async () => {
  const source = await readFile(resolve(scriptDirectory, "offhours.mjs"), "utf8");
  assert.equal(/fetch\s*\(/.test(source), false);
  assert.equal(/https?:\/\//.test(source), false);
});
