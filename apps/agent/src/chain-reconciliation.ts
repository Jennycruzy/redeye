import type {
  EventRecord,
  ReceiptFillTransferCheck,
  ReceiptReconciliation,
  ReceiptTransferExpectation
} from "@redeye/core";
import type { StoredPlan } from "./plan-service.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDT_BSC = "0x55d398326f99059ff775485246999027b3197955";
const LOG_BLOCK_CHUNK = 5_000;

type JsonObject = Record<string, unknown>;

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} is not an object.`);
  }
  return value as JsonObject;
}

function address(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${field} is not an EVM address.`);
  }
  return value.toLowerCase();
}

function txHash(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${field} is not a transaction hash.`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function topicAccount(topic: unknown, field: string): string {
  if (typeof topic !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(topic)) {
    throw new Error(`${field} is not an indexed address.`);
  }
  return address(`0x${topic.slice(-40)}`, field);
}

function rawAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} is not a hexadecimal token amount.`);
  }
  return BigInt(value).toString();
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error(`BSC RPC returned HTTP ${response.status}.`);
  const body = object(await response.json(), `BSC RPC ${method}`);
  if (body.error !== undefined) {
    const detail = object(body.error, `BSC RPC ${method} error`);
    throw new Error(`BSC RPC ${method} failed: ${String(detail.message ?? "unknown error")}.`);
  }
  if (body.result === undefined) throw new Error(`BSC RPC ${method} returned no result.`);
  return body.result;
}

function blockNumber(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("BSC RPC returned an invalid block number.");
  }
  return Number.parseInt(value, 16);
}

function blockTimestamp(value: unknown): number {
  const block = object(value, "BSC block");
  if (typeof block.timestamp !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.timestamp)) {
    throw new Error("BSC RPC returned a block without a valid timestamp.");
  }
  return Number.parseInt(block.timestamp, 16);
}

async function findFirstBlockAtOrAfter(
  rpcUrl: string,
  timestamp: number,
  latest: number
): Promise<number> {
  let low = 0;
  let high = latest;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const block = await rpc(rpcUrl, "eth_getBlockByNumber", [`0x${middle.toString(16)}`, false]);
    if (blockTimestamp(block) < timestamp) low = middle + 1;
    else high = middle;
  }
  const block = await rpc(rpcUrl, "eth_getBlockByNumber", [`0x${low.toString(16)}`, false]);
  if (blockTimestamp(block) < timestamp)
    throw new Error("No block covers the reconciliation start.");
  return low;
}

async function findLastBlockAtOrBefore(
  rpcUrl: string,
  timestamp: number,
  latest: number
): Promise<number> {
  let low = 0;
  let high = latest + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (middle > latest) {
      high = middle;
      continue;
    }
    const block = await rpc(rpcUrl, "eth_getBlockByNumber", [`0x${middle.toString(16)}`, false]);
    if (blockTimestamp(block) <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function transferFromLog(
  value: unknown,
  accountSet: Set<string>,
  tokenSet: Set<string>
): ReceiptTransferExpectation[] {
  const log = object(value, "Transfer log");
  if (!Array.isArray(log.topics) || log.topics.length < 3) {
    throw new Error("Transfer log is missing indexed topics.");
  }
  const tokenAddress = address(log.address, "Transfer token address");
  if (!tokenSet.has(tokenAddress)) return [];
  const from = topicAccount(log.topics[1], "Transfer from");
  const to = topicAccount(log.topics[2], "Transfer to");
  const hash = txHash(log.transactionHash, "Transfer transaction hash");
  const logIndex = blockNumber(log.logIndex);
  const amountRaw = rawAmount(log.data, "Transfer data");
  const transfers: ReceiptTransferExpectation[] = [];
  if (accountSet.has(from)) {
    transfers.push({
      tokenAddress,
      account: from,
      direction: "out",
      amountRaw,
      txHash: hash,
      logIndex
    });
  }
  if (accountSet.has(to)) {
    transfers.push({
      tokenAddress,
      account: to,
      direction: "in",
      amountRaw,
      txHash: hash,
      logIndex
    });
  }
  return transfers;
}

function sameTransfer(
  expected: ReceiptTransferExpectation,
  observed: ReceiptTransferExpectation
): boolean {
  return (
    expected.tokenAddress.toLowerCase() === observed.tokenAddress.toLowerCase() &&
    expected.account.toLowerCase() === observed.account.toLowerCase() &&
    expected.direction === observed.direction &&
    expected.amountRaw === observed.amountRaw &&
    expected.txHash?.toLowerCase() === observed.txHash?.toLowerCase() &&
    expected.logIndex === observed.logIndex
  );
}

function evaluate(
  expectedTransfers: ReceiptTransferExpectation[],
  observedTransfers: ReceiptTransferExpectation[],
  fillChecks: ReceiptFillTransferCheck[]
): ReceiptReconciliation["result"] {
  const used = new Set<number>();
  const matchedTransfers: ReceiptReconciliation["result"]["matchedTransfers"] = [];
  const missingTransfers: ReceiptTransferExpectation[] = [];
  for (const expected of expectedTransfers) {
    const matchIndex = observedTransfers.findIndex(
      (observed, index) => !used.has(index) && sameTransfer(expected, observed)
    );
    if (matchIndex < 0) missingTransfers.push(expected);
    else {
      used.add(matchIndex);
      matchedTransfers.push({ expected, observed: observedTransfers[matchIndex]! });
    }
  }
  const unexpectedTransfers = observedTransfers.filter((_, index) => !used.has(index));
  const missingFillTransfers = fillChecks
    .filter((fill) => {
      const cashDirection = fill.side === "buy" ? "out" : "in";
      const stockDirection = fill.side === "buy" ? "in" : "out";
      const hasCash = observedTransfers.some(
        (transfer) =>
          transfer.txHash?.toLowerCase() === fill.txHash.toLowerCase() &&
          transfer.account.toLowerCase() === fill.account.toLowerCase() &&
          transfer.tokenAddress.toLowerCase() === USDT_BSC &&
          transfer.direction === cashDirection
      );
      const hasStock = observedTransfers.some(
        (transfer) =>
          transfer.txHash?.toLowerCase() === fill.txHash.toLowerCase() &&
          transfer.account.toLowerCase() === fill.account.toLowerCase() &&
          transfer.tokenAddress.toLowerCase() === fill.stockTokenAddress.toLowerCase() &&
          transfer.direction === stockDirection
      );
      return !hasCash || !hasStock;
    })
    .map((fill) => fill.txHash);
  const errors: string[] = [];
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
  for (const fillTx of missingFillTransfers) {
    errors.push(`recorded fill ${fillTx} is missing its stock or USDT transfer.`);
  }
  return {
    valid: errors.length === 0,
    outcome: errors.length === 0 ? "kept" : "broken",
    errors,
    matchedTransfers,
    missingTransfers,
    unexpectedTransfers,
    missingFillTransfers
  };
}

export async function reconcilePlanWindow(
  plans: StoredPlan[],
  event: EventRecord,
  options: { rpcUrl: string; walletAddress: string; stockTokenAddresses: string[] }
): Promise<ReceiptReconciliation> {
  if (event.lockTs === null || event.openTs === null) {
    throw new Error("Window reconciliation needs close and open timestamps.");
  }
  const tradablePlans = plans.filter(
    (plan) =>
      (plan.plan?.door === "agentic_wallet" || plan.plan?.door === "plan_account") &&
      plan.event?.openTs === event.openTs
  );
  const accounts = [
    ...new Set(
      tradablePlans
        .map(
          (plan) =>
            plan.trade?.wallet ??
            (plan.plan?.door === "plan_account"
              ? plan.signedPermission?.owner
              : options.walletAddress)
        )
        .filter((value): value is string => value !== undefined)
        .map((value) => address(value, "reconciliation account"))
    )
  ];
  const tokenAddresses = [
    ...new Set(
      [
        USDT_BSC,
        ...options.stockTokenAddresses,
        ...tradablePlans.map((plan) => plan.plan!.tokenAddress)
      ].map((value) => address(value, "reconciliation token"))
    )
  ];
  const accountSet = new Set(accounts);
  const tokenSet = new Set(tokenAddresses);
  const fillChecks: ReceiptFillTransferCheck[] = tradablePlans.flatMap((plan) => {
    const trade = plan.trade;
    const fillHash = trade?.order?.txHash;
    if (
      !trade ||
      trade.order?.status !== "FINISHED" ||
      fillHash === null ||
      fillHash === undefined ||
      trade.fillChain === null
    ) {
      return [];
    }
    return [
      {
        txHash: txHash(fillHash, "recorded fill transaction"),
        account: address(trade.wallet, "fill account"),
        stockTokenAddress: address(plan.plan!.tokenAddress, "fill stock token"),
        side: plan.plan!.kind === "buy_dip" ? "buy" : "sell"
      }
    ];
  });

  const latestHex = await rpc(options.rpcUrl, "eth_blockNumber", []);
  const latest = blockNumber(latestHex);
  const startSeconds = Math.floor(event.lockTs / 1000);
  const endSeconds = Math.floor(event.openTs / 1000);
  const latestBlock = await rpc(options.rpcUrl, "eth_getBlockByNumber", [latestHex, false]);
  if (blockTimestamp(latestBlock) <= endSeconds) {
    throw new Error("BSC has not produced a block after the open; reconciliation is waiting.");
  }
  const from = await findFirstBlockAtOrAfter(options.rpcUrl, startSeconds, latest);
  const to = await findLastBlockAtOrBefore(options.rpcUrl, endSeconds, latest);
  if (to < from) throw new Error("No BSC blocks cover the plan window.");
  const accountTopics = accounts.map((value) => `0x${"0".repeat(24)}${value.slice(2)}`);
  const query = async (
    fromBlock: number,
    toBlock: number,
    topics: Array<string | string[] | null>
  ) => {
    const rows = await rpc(options.rpcUrl, "eth_getLogs", [
      {
        address: tokenAddresses,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        topics: [TRANSFER_TOPIC, ...topics]
      }
    ]);
    if (!Array.isArray(rows)) throw new Error("BSC RPC returned invalid transfer logs.");
    return rows.flatMap((row) => transferFromLog(row, accountSet, tokenSet));
  };
  const outgoing: ReceiptTransferExpectation[] = [];
  const incoming: ReceiptTransferExpectation[] = [];
  for (let chunkStart = from; chunkStart <= to; chunkStart += LOG_BLOCK_CHUNK) {
    const chunkEnd = Math.min(to, chunkStart + LOG_BLOCK_CHUNK - 1);
    const [outChunk, inChunk] = await Promise.all([
      query(chunkStart, chunkEnd, [accountTopics, null]),
      query(chunkStart, chunkEnd, [null, accountTopics])
    ]);
    outgoing.push(...outChunk);
    incoming.push(...inChunk);
  }
  const uniqueTransfers = new Map<string, ReceiptTransferExpectation>();
  for (const transfer of [...outgoing, ...incoming]) {
    const key = `${transfer.txHash}:${transfer.logIndex}:${transfer.account}:${transfer.direction}`;
    uniqueTransfers.set(key, transfer);
  }
  const observedTransfers = [...uniqueTransfers.values()].sort((left, right) =>
    `${left.txHash}:${left.logIndex}:${left.tokenAddress}:${left.account}:${left.direction}`.localeCompare(
      `${right.txHash}:${right.logIndex}:${right.tokenAddress}:${right.account}:${right.direction}`
    )
  );

  const fillHashes = new Set(fillChecks.map((fill) => fill.txHash.toLowerCase()));
  const expectedTransfers = observedTransfers.filter((transfer) =>
    fillHashes.has((transfer.txHash ?? "").toLowerCase())
  );
  const result = evaluate(expectedTransfers, observedTransfers, fillChecks);
  return {
    v: 1,
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${to.toString(16)}`,
    accounts,
    tokenAddresses,
    expectedTransfers,
    fillChecks,
    result
  };
}
