import { readFile } from "node:fs/promises";
import { encodePacked, keccak256, toBytes } from "viem";

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON cannot contain a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (value[key] === undefined)
          throw new Error(`Canonical JSON cannot contain undefined at ${key}.`);
        return `${JSON.stringify(key)}:${canonical(value[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
}

function hash(value) {
  return keccak256(toBytes(canonical(value)));
}

function txHash(value, field) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a 32-byte transaction hash.`);
  }
}

const path = process.argv[2];
if (!path) {
  console.error("Usage: pnpm verify -- <receipt.json>");
  process.exitCode = 2;
} else {
  try {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const errors = [];
    const computedEventKey = keccak256(
      encodePacked(
        ["string", "string", "string"],
        [receipt.event.ticker, receipt.event.kind, receipt.event.expectedDate]
      )
    );
    if (computedEventKey !== receipt.event.eventKey) errors.push("eventKey mismatch");
    const computedPlanHash = hash({ ...receipt.plan, planId: null });
    if (computedPlanHash !== receipt.planHash) errors.push("planHash mismatch");
    if (receipt.event.lockTs === null || receipt.event.lockTs === undefined) {
      errors.push("event lockTs is missing");
    } else if (receipt.freezeBlockTs >= receipt.event.lockTs) {
      errors.push("freeze block time is not before the event lock time");
    }
    txHash(receipt.freezeTx, "freezeTx");
    for (const [index, entry] of receipt.decisions.entries()) {
      if (hash({ decision: entry.decision, input: entry.input }) !== entry.decisionHash) {
        errors.push(`decision ${index} hash mismatch`);
      }
    }
    for (const [index, fill] of receipt.fills.entries())
      txHash(fill.txHash, `fills[${index}].txHash`);
    const computedVerdictHash = hash(receipt.verdict);
    if (computedVerdictHash !== receipt.verdictHash) errors.push("verdictHash mismatch");
    const hasTradeDecision = receipt.decisions.some(
      ({ decision }) => decision.action === "buy" || decision.action === "sell"
    );
    if (receipt.verdict.outcome === "kept" && hasTradeDecision && receipt.fills.length === 0) {
      errors.push("kept trade receipt has no fill");
    }
    const result = {
      valid: errors.length === 0,
      errors,
      computed: {
        eventKey: computedEventKey,
        planHash: computedPlanHash,
        verdictHash: computedVerdictHash
      }
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
