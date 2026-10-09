import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadRepositoryEnv } from "./load-env.mjs";

loadRepositoryEnv(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LOG_BLOCK_CHUNK = 5_000;

function address(value, field) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${field} must be an EVM address.`);
  }
  return value.toLowerCase();
}

function txHash(value, field) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a transaction hash.`);
  }
  return value.toLowerCase();
}

function amount(value, field) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative raw token amount.`);
  }
  return BigInt(value).toString();
}

function transferShape(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const tokenAddress = address(value.tokenAddress, `${field}.tokenAddress`);
  const account = address(value.account, `${field}.account`);
  if (value.direction !== "in" && value.direction !== "out") {
    throw new Error(`${field}.direction must be in or out.`);
  }
  const parsed = {
    tokenAddress,
    account,
    direction: value.direction,
    amountRaw: amount(value.amountRaw, `${field}.amountRaw`)
  };
  if (value.txHash !== undefined) parsed.txHash = txHash(value.txHash, `${field}.txHash`);
  if (value.logIndex !== undefined) {
    if (!Number.isInteger(value.logIndex) || value.logIndex < 0) {
      throw new Error(`${field}.logIndex must be a non-negative integer.`);
    }
    parsed.logIndex = value.logIndex;
  }
  return parsed;
}

function transferMatches(expected, observed) {
  if (expected.tokenAddress !== observed.tokenAddress) return false;
  if (expected.account !== observed.account) return false;
  if (expected.direction !== observed.direction) return false;
  if (expected.amountRaw !== observed.amountRaw) return false;
  if (expected.txHash !== undefined && expected.txHash !== observed.txHash) return false;
  if (expected.logIndex !== undefined && expected.logIndex !== observed.logIndex) return false;
  return true;
}

export function reconcileTransfers({ expectedTransfers, observedTransfers }) {
  if (!Array.isArray(expectedTransfers) || !Array.isArray(observedTransfers)) {
    throw new Error(
      "Transfer reconciliation needs expectedTransfers and observedTransfers arrays."
    );
  }
  const expected = expectedTransfers.map((value, index) =>
    transferShape(value, `expectedTransfers[${index}]`)
  );
  const observed = observedTransfers.map((value, index) =>
    transferShape(value, `observedTransfers[${index}]`)
  );
  const used = new Set();
  const missingTransfers = [];
  const matchedTransfers = [];

  for (const expectedTransfer of expected) {
    const index = observed.findIndex(
      (candidate, candidateIndex) =>
        !used.has(candidateIndex) && transferMatches(expectedTransfer, candidate)
    );
    if (index === -1) {
      missingTransfers.push(expectedTransfer);
      continue;
    }
    used.add(index);
    matchedTransfers.push({ expected: expectedTransfer, observed: observed[index] });
  }

  const unexpectedTransfers = observed
    .filter((_, index) => !used.has(index))
    .sort((left, right) =>
      `${left.txHash}:${left.logIndex}:${left.tokenAddress}:${left.account}:${left.direction}`.localeCompare(
        `${right.txHash}:${right.logIndex}:${right.tokenAddress}:${right.account}:${right.direction}`
      )
    );
  const errors = [];
  for (const transfer of missingTransfers) {
    errors.push(
      `recorded fill has no matching ${transfer.direction} transfer for ${transfer.tokenAddress} (${transfer.amountRaw}).`
    );
  }
  for (const transfer of unexpectedTransfers) {
    errors.push(
      `unrecorded ${transfer.direction} transfer found for ${transfer.tokenAddress} (${transfer.amountRaw}) in ${transfer.txHash ?? "an unknown transaction"}.`
    );
  }
  return {
    valid: errors.length === 0,
    outcome: errors.length === 0 ? "kept" : "broken",
    errors,
    matchedTransfers,
    missingTransfers,
    unexpectedTransfers
  };
}

function hexNumber(value, field) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value))
    return Number.parseInt(value, 16);
  throw new Error(`${field} must be a block number or hexadecimal block number.`);
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error(`BSC RPC returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body.error)
    throw new Error(`BSC RPC ${method} failed: ${body.error.message ?? "unknown error"}.`);
  if (!("result" in body)) throw new Error(`BSC RPC ${method} returned no result.`);
  return body.result;
}

function topicAddress(topic, field) {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error(`${field} must be a 32-byte topic.`);
  }
  return address(`0x${topic.slice(-40)}`, field);
}

function logTransfer(log, accountSet) {
  if (!Array.isArray(log.topics) || log.topics.length < 3) {
    throw new Error("Transfer log is missing indexed topics.");
  }
  const from = topicAddress(log.topics[1], "Transfer from topic");
  const to = topicAddress(log.topics[2], "Transfer to topic");
  const tokenAddress = address(log.address, "Transfer token address");
  const txHashValue = txHash(log.transactionHash, "Transfer transaction hash");
  const logIndex = hexNumber(log.logIndex, "Transfer log index");
  const rawAmount =
    typeof log.data === "string" && /^0x[0-9a-fA-F]+$/.test(log.data)
      ? BigInt(log.data).toString()
      : amount(log.data, "Transfer data");
  const transfers = [];
  if (accountSet.has(from)) {
    transfers.push({
      tokenAddress,
      account: from,
      direction: "out",
      amountRaw: rawAmount,
      txHash: txHashValue,
      logIndex
    });
  }
  if (accountSet.has(to)) {
    transfers.push({
      tokenAddress,
      account: to,
      direction: "in",
      amountRaw: rawAmount,
      txHash: txHashValue,
      logIndex
    });
  }
  return transfers;
}

export async function fetchAccountTransfers({
  rpcUrl,
  fromBlock,
  toBlock,
  accounts,
  tokenAddresses
}) {
  if (typeof rpcUrl !== "string" || rpcUrl.trim().length === 0)
    throw new Error("BSC RPC URL is required.");
  const accountSet = new Set(accounts.map((value, index) => address(value, `accounts[${index}]`)));
  const tokens = [
    ...new Set(tokenAddresses.map((value, index) => address(value, `tokenAddresses[${index}]`)))
  ];
  if (accountSet.size === 0 || tokens.length === 0)
    throw new Error("Accounts and token addresses are required.");
  const start = hexNumber(fromBlock, "fromBlock");
  const end = hexNumber(toBlock, "toBlock");
  if (end < start) throw new Error("toBlock must not be before fromBlock.");
  const accountTopics = [...accountSet].map((value) => `0x${"0".repeat(24)}${value.slice(2)}`);
  const transfers = new Map();
  for (let chunkStart = start; chunkStart <= end; chunkStart += LOG_BLOCK_CHUNK) {
    const chunkEnd = Math.min(end, chunkStart + LOG_BLOCK_CHUNK - 1);
    for (const topics of [
      [accountTopics, null],
      [null, accountTopics]
    ]) {
      const result = await rpc(rpcUrl, "eth_getLogs", [
        {
          address: tokens,
          fromBlock: `0x${chunkStart.toString(16)}`,
          toBlock: `0x${chunkEnd.toString(16)}`,
          topics: [TRANSFER_TOPIC, ...topics]
        }
      ]);
      if (!Array.isArray(result)) throw new Error("BSC RPC returned invalid logs.");
      for (const log of result) {
        for (const transfer of logTransfer(log, accountSet)) {
          const key = `${transfer.txHash}:${transfer.logIndex}:${transfer.account}:${transfer.direction}`;
          transfers.set(key, transfer);
        }
      }
    }
  }
  return [...transfers.values()].sort((left, right) =>
    `${left.txHash}:${left.logIndex}:${left.tokenAddress}:${left.account}:${left.direction}`.localeCompare(
      `${right.txHash}:${right.logIndex}:${right.tokenAddress}:${right.account}:${right.direction}`
    )
  );
}

export async function reconcileReceipt(receipt, options = {}) {
  const configuration = receipt?.reconciliation;
  if (configuration === undefined || configuration === null) {
    if (
      options.required === true &&
      (receipt?.plan?.door === "agentic_wallet" || (receipt?.fills?.length ?? 0) > 0)
    ) {
      return {
        state: "not_configured",
        valid: false,
        outcome: "broken",
        errors: ["receipt has no transfer reconciliation evidence."]
      };
    }
    return { state: "not_configured", valid: true, outcome: null, errors: [] };
  }
  if (typeof configuration !== "object" || Array.isArray(configuration)) {
    return {
      state: "invalid",
      valid: false,
      outcome: "broken",
      errors: ["reconciliation must be an object."]
    };
  }
  const expectedTransfers = configuration.expectedTransfers;
  const fillChecks = configuration.fillChecks;
  if (!Array.isArray(expectedTransfers) || !Array.isArray(fillChecks)) {
    if (options.required === true) {
      return {
        state: "not_configured",
        valid: false,
        outcome: "broken",
        errors: ["receipt has incomplete transfer reconciliation evidence."]
      };
    }
    return { state: "not_configured", valid: true, outcome: null, errors: [] };
  }
  let observedTransfers = configuration.observedTransfers;
  if (!Array.isArray(observedTransfers)) {
    const rpcUrl =
      options.rpcUrl ??
      configuration.rpcUrl ??
      (process.env.BSC_RPC_URL_LOGS?.trim() ||
        process.env.BSC_RPC_URL_ARCHIVE?.trim() ||
        process.env.BSC_RPC_URL_LIVE?.trim());
    observedTransfers = await fetchAccountTransfers({
      rpcUrl,
      fromBlock: configuration.fromBlock,
      toBlock: configuration.toBlock,
      accounts: configuration.accounts ?? [],
      tokenAddresses: configuration.tokenAddresses ?? []
    });
  }
  return {
    state: "checked",
    ...reconcileReceiptTransfers({
      expectedTransfers,
      observedTransfers,
      fillChecks,
      storedResult: configuration.result
    })
  };
}

function reconcileReceiptTransfers({
  expectedTransfers,
  observedTransfers,
  fillChecks,
  storedResult
}) {
  const base = reconcileTransfers({ expectedTransfers, observedTransfers });
  const missingFillTransfers = [];
  for (const fill of fillChecks) {
    const account = address(fill.account, "fillChecks.account");
    const token = address(fill.stockTokenAddress, "fillChecks.stockTokenAddress");
    const hash = txHash(fill.txHash, "fillChecks.txHash");
    if (fill.side !== "buy" && fill.side !== "sell") {
      throw new Error("fillChecks.side must be buy or sell.");
    }
    const cashDirection = fill.side === "buy" ? "out" : "in";
    const stockDirection = fill.side === "buy" ? "in" : "out";
    const hasCash = observedTransfers.some(
      (transfer) =>
        transfer.txHash === hash &&
        transfer.account === account &&
        transfer.tokenAddress === address("0x55d398326f99059ff775485246999027b3197955", "USDT") &&
        transfer.direction === cashDirection
    );
    const hasStock = observedTransfers.some(
      (transfer) =>
        transfer.txHash === hash &&
        transfer.account === account &&
        transfer.tokenAddress === token &&
        transfer.direction === stockDirection
    );
    if (!hasCash || !hasStock) missingFillTransfers.push(hash);
  }
  const errors = [...base.errors];
  for (const fillHash of missingFillTransfers) {
    errors.push(`recorded fill ${fillHash} is missing its stock or USDT transfer.`);
  }
  const result = {
    ...base,
    valid: errors.length === 0,
    outcome: errors.length === 0 ? "kept" : "broken",
    errors,
    missingFillTransfers
  };
  if (storedResult === undefined || !isDeepStrictEqual(storedResult, result)) {
    return {
      ...result,
      valid: false,
      outcome: "broken",
      errors: [
        ...result.errors,
        "stored reconciliation result does not match current chain transfers."
      ]
    };
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node scripts/reconcile.mjs <receipt.json>");
    process.exitCode = 2;
  } else {
    try {
      const receipt = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
      const result = await reconcileReceipt(receipt);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.valid ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
