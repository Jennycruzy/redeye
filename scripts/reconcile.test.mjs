import test from "node:test";
import assert from "node:assert/strict";
import { reconcileReceipt, reconcileTransfers } from "./reconcile.mjs";

const account = "0x0000000000000000000000000000000000000001";
const token = "0x0000000000000000000000000000000000000002";
const transaction = `0x${"1".repeat(64)}`;

const expected = {
  tokenAddress: token,
  account,
  direction: "out",
  amountRaw: "100",
  txHash: transaction,
  logIndex: 0
};

test("reconciliation accepts a transfer that matches the recorded fill", () => {
  const result = reconcileTransfers({
    expectedTransfers: [expected],
    observedTransfers: [{ ...expected }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.outcome, "kept");
  assert.deepEqual(result.errors, []);
});

test("reconciliation marks an extra transfer as broken", () => {
  const result = reconcileTransfers({
    expectedTransfers: [expected],
    observedTransfers: [
      { ...expected },
      {
        ...expected,
        amountRaw: "101",
        txHash: `0x${"2".repeat(64)}`,
        logIndex: 1
      }
    ]
  });
  assert.equal(result.valid, false);
  assert.equal(result.outcome, "broken");
  assert.match(result.errors[0], /unrecorded out transfer/);
});

test("reconciliation marks a fill without its transfer as broken", async () => {
  const result = await reconcileReceipt({
    fills: [
      {
        step: 1,
        txHash: transaction,
        confirmedAt: "2026-10-06T00:00:00.000Z",
        transfers: [expected]
      }
    ],
    reconciliation: { observedTransfers: [] }
  });
  assert.equal(result.valid, false);
  assert.equal(result.outcome, "broken");
  assert.match(result.errors[0], /recorded fill has no matching/);
});

test("required reconciliation refuses a receipt that omits its evidence", async () => {
  const result = await reconcileReceipt({ fills: [] }, { required: true });
  assert.equal(result.valid, false);
  assert.equal(result.outcome, "broken");
  assert.match(result.errors[0], /no transfer reconciliation evidence/);
});
