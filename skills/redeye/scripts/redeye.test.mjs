import assert from "node:assert/strict";
import { test } from "node:test";
import { joinSignature, parsePlan } from "./redeye.mjs";

const rs = "a".repeat(64) + "b".repeat(64);

test("joins baw's r||s and recovery byte into a 65-byte signature", () => {
  assert.equal(joinSignature(rs, 27), `0x${rs}1b`);
  assert.equal(joinSignature(`0x${rs}`, 28), `0x${rs}1c`);
  // Already 65 bytes: used as given.
  assert.equal(joinSignature(`${rs}1c`, 27), `0x${rs}1c`);
  assert.throws(() => joinSignature("abcd", 27), /Unexpected signature length/);
});

test("fills safe limits, upper-cases the ticker and rejects non-objects", () => {
  const plan = parsePlan(
    '{"ticker":"nvda","kind":"guard","heldShares":"2","params":{"triggerDropPct":"5","sellPct":"50"}}'
  );
  assert.equal(plan.ticker, "NVDA");
  assert.deepEqual(plan.params, {
    maxPriceImpactPct: "1",
    minPoolDepthUsd: "100000",
    maxGapToRealPricePct: "1",
    triggerDropPct: "5",
    sellPct: "50"
  });
  // The plan's own limits win over the defaults.
  assert.equal(
    parsePlan('{"ticker":"TSLA","params":{"maxPriceImpactPct":"0.5"}}').params.maxPriceImpactPct,
    "0.5"
  );
  assert.throws(() => parsePlan("[1]"), /JSON object/);
  assert.throws(() => parsePlan("not json"), /must be JSON/);
});
