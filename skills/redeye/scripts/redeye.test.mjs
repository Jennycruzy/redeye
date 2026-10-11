import assert from "node:assert/strict";
import { test } from "node:test";
import { describeChallenge, joinSignature, parsePlan } from "./redeye.mjs";

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

test("reads a B402 challenge as a cost a person can confirm", () => {
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://api.theredeyed-agent.site/x402/price/NVDA" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:56",
          amount: "2000000000000000",
          asset: "0xcE24439F2D9C6a2289F741120FE202248B666666",
          payTo: "0xe201bbf3C736a5d188797974a7e4B9464f707eA8",
          extra: { signerAddress: "0x34F7a661160780Ce1346e6D7B96D2bE244590899" }
        }
      ]
    })
  ).toString("base64");
  assert.deepEqual(describeChallenge(header), {
    resource: "https://api.theredeyed-agent.site/x402/price/NVDA",
    cost: "0.002 U",
    network: "eip155:56",
    payTo: "0xe201bbf3C736a5d188797974a7e4B9464f707eA8",
    settledBy: "0x34F7a661160780Ce1346e6D7B96D2bE244590899"
  });
  const empty = Buffer.from(JSON.stringify({ accepts: [] })).toString("base64");
  assert.throws(() => describeChallenge(empty), /offers no way to pay/);
});
