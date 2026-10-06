const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

  const unexpectedTransfers = observed.filter((_, index) => !used.has(index));
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
  const logs = [];
  for (const token of tokens) {
    const result = await rpc(rpcUrl, "eth_getLogs", [
      {
        address: token,
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
        topics: [TRANSFER_TOPIC]
      }
    ]);
    if (!Array.isArray(result)) throw new Error("BSC RPC returned invalid logs.");
    for (const log of result) logs.push(...logTransfer(log, accountSet));
  }
  return logs;
}

export async function reconcileReceipt(receipt, options = {}) {
  const configuration = receipt?.reconciliation;
  if (configuration === undefined || configuration === null) {
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
  const expectedTransfers =
    configuration.expectedTransfers ??
    (Array.isArray(receipt.fills)
      ? receipt.fills.flatMap((fill) => (Array.isArray(fill.transfers) ? fill.transfers : []))
      : []);
  if (!Array.isArray(expectedTransfers) || expectedTransfers.length === 0) {
    return { state: "not_configured", valid: true, outcome: null, errors: [] };
  }
  let observedTransfers = configuration.observedTransfers;
  if (!Array.isArray(observedTransfers)) {
    const rpcUrl =
      options.rpcUrl ??
      configuration.rpcUrl ??
      process.env.BSC_RPC_URL_ARCHIVE ??
      process.env.BSC_RPC_URL_LIVE;
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
    ...reconcileTransfers({ expectedTransfers, observedTransfers })
  };
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
