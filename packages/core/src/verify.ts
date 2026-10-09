import { hashCanonical } from "./canonical.js";
import { makeEventKey, hashDecision, hashVerdict, type ReceiptBundle } from "./receipt.js";

export interface ReceiptVerification {
  valid: boolean;
  errors: string[];
  computed: {
    eventKey: `0x${string}`;
    planHash: `0x${string}`;
    decisionHashes: `0x${string}`[];
    verdictHash: `0x${string}`;
  };
}

function transactionHash(value: string, field: string): `0x${string}` {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value))
    throw new Error(`${field} must be a 32-byte transaction hash.`);
  return value as `0x${string}`;
}

export function verifyReceipt(receipt: ReceiptBundle): ReceiptVerification {
  const errors: string[] = [];
  const eventKey = makeEventKey(
    receipt.event.ticker,
    receipt.event.kind,
    receipt.event.expectedDate
  );
  if (eventKey !== receipt.event.eventKey)
    errors.push("eventKey does not match ticker, kind and expected date.");
  if (receipt.event.lockTs === null) errors.push("event lockTs is missing.");
  if (receipt.event.lockTs !== null && receipt.freezeBlockTs >= receipt.event.lockTs) {
    errors.push("freeze block time is not before the event lock time.");
  }
  const planForHash = { ...receipt.plan, planId: null };
  const planHash = hashCanonical(planForHash);
  if (planHash !== receipt.planHash) errors.push("planHash does not match the canonical plan.");
  try {
    transactionHash(receipt.freezeTx, "freezeTx");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (receipt.permissionTx !== undefined) {
    try {
      transactionHash(receipt.permissionTx, "permissionTx");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const decisionHashes = receipt.decisions.map((entry, index) => {
    const hash = hashDecision(entry.input, entry.decision);
    if (hash !== entry.decisionHash)
      errors.push(`decision ${index} hash does not match its input.`);
    if (!Number.isFinite(entry.at)) errors.push(`decision ${index} timestamp is not finite.`);
    return hash;
  });

  const verdictHash = hashVerdict(receipt.verdict);
  if (verdictHash !== receipt.verdictHash)
    errors.push("verdictHash does not match the canonical verdict.");
  for (const [index, fill] of receipt.fills.entries()) {
    try {
      transactionHash(fill.txHash, `fills[${index}].txHash`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const hasTradeDecision = receipt.decisions.some(
    ({ decision }) => decision.action === "buy" || decision.action === "sell"
  );
  if (receipt.verdict.outcome === "kept" && hasTradeDecision && receipt.fills.length === 0) {
    errors.push("a kept trade receipt must include at least one confirmed fill.");
  }
  const needsReconciliation =
    receipt.plan.door === "agentic_wallet" ||
    receipt.plan.door === "plan_account" ||
    receipt.fills.length > 0;
  const reconciliation = receipt.reconciliation;
  if (needsReconciliation && reconciliation === undefined) {
    errors.push("a trading receipt must include transfer reconciliation evidence.");
  } else if (reconciliation !== undefined) {
    const reconciliationHash = hashCanonical(reconciliation);
    if (receipt.verdict.reconciliationHash !== reconciliationHash) {
      errors.push("reconciliationHash does not match the published reconciliation.");
    }
    if (reconciliation.result.valid !== (reconciliation.result.outcome === "kept")) {
      errors.push("reconciliation outcome does not match its validity.");
    }
    if (!reconciliation.result.valid && receipt.verdict.outcome !== "broken") {
      errors.push("a failed reconciliation must publish a broken result.");
    }
  } else if (receipt.verdict.reconciliationHash !== undefined) {
    errors.push("verdict has a reconciliationHash but the reconciliation is missing.");
  }
  return {
    valid: errors.length === 0,
    errors,
    computed: { eventKey, planHash, decisionHashes, verdictHash }
  };
}
