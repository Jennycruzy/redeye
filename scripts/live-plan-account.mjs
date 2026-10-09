#!/usr/bin/env node
// Produces the exact EIP-7702 authorization + bounded PlanPermission used by the
// browser flow. Dry-run by default; --send submits it to the running agent.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { signAuthorization } from "viem/experimental";
import { loadRepositoryEnv } from "./load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadRepositoryEnv(root);

function fail(message) {
  console.error(JSON.stringify({ code: "PLAN_ACCOUNT_LIVE_TEST_FAILED", reason: message }));
  process.exit(1);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) fail(`${name} needs a value.`);
  return value;
}

async function json(url, init) {
  const response = await fetch(url, init).catch((error) => fail(`${url}: ${error.message}`));
  const body = await response.json().catch(() => fail(`${url} returned non-JSON.`));
  if (!response.ok) fail(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const send = process.argv.includes("--send");
const teamTest = process.argv.includes("--team-test");
const rawKey = teamTest
  ? process.env.JOB_BUYER_PRIVATE_KEY?.trim()
  : process.env.PLAN_ACCOUNT_TEST_PRIVATE_KEY?.trim();
if (!rawKey) {
  fail(
    teamTest
      ? "JOB_BUYER_PRIVATE_KEY is not set."
      : "PLAN_ACCOUNT_TEST_PRIVATE_KEY is not set; use --team-test only for the isolated team wallet."
  );
}
const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(key);
const api = argument("--api", "http://127.0.0.1:8787").replace(/\/$/, "");
const ticker = argument("--ticker", "INTC").toUpperCase();
const amount = argument("--amount", "2");
const trigger = argument("--trigger", "1");
const plan = {
  ticker,
  kind: "buy_dip",
  heldShares: "0",
  params: {
    triggerDropPct: trigger,
    maxUsd: amount,
    maxPriceImpactPct: "1",
    minPoolDepthUsd: "100000",
    maxGapToRealPricePct: "1"
  },
  door: "plan_account",
  auditNoDataAccepted: true
};
const preview = await json(`${api}/preview`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...plan, owner: account.address })
});
if (!preview.valid || !preview.permission || !preview.planHash) {
  fail(`preview refused: ${JSON.stringify(preview.issues ?? preview)}`);
}
const { template, ...permission } = preview.permission;
const templateAddress = getAddress(template);
const rpcUrl = process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org";
const transport = http(rpcUrl, { timeout: 30_000, retryCount: 2 });
const reader = createPublicClient({ chain: bsc, transport });
const signer = createWalletClient({ account, chain: bsc, transport });
const code = await reader.getCode({ address: account.address });
const expectedCode = `0xef0100${templateAddress.slice(2).toLowerCase()}`;
const delegated = code?.toLowerCase() === expectedCode;
const nonce = await reader.getTransactionCount({ address: account.address, blockTag: "pending" });
const authorization = delegated
  ? undefined
  : await signAuthorization(signer, {
      account,
      contractAddress: templateAddress,
      chainId: 56,
      nonce
    });
const permissionSignature = await account.signTypedData({
  domain: {
    name: "Redeye PlanAccount",
    version: "1",
    chainId: 56,
    verifyingContract: account.address
  },
  types: {
    PlanPermission: [
      { name: "planHash", type: "bytes32" },
      { name: "standingRunHash", type: "bytes32" },
      { name: "agent", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "maxAmount", type: "uint256" },
      { name: "router", type: "address" },
      { name: "notBefore", type: "uint64" },
      { name: "notAfter", type: "uint64" },
      { name: "maxPriceDeviationBps", type: "uint256" }
    ]
  },
  primaryType: "PlanPermission",
  message: {
    ...permission,
    maxAmount: BigInt(permission.maxAmount),
    notBefore: BigInt(permission.notBefore),
    notAfter: BigInt(permission.notAfter),
    maxPriceDeviationBps: BigInt(permission.maxPriceDeviationBps)
  }
});
const summary = {
  owner: account.address,
  ticker,
  amountUsd: amount,
  triggerDropPct: trigger,
  planHash: preview.planHash,
  template: templateAddress,
  alreadyDelegated: delegated,
  authorizationNonce: authorization?.nonce ?? null,
  window: preview.window
};
if (!send) {
  console.log(JSON.stringify({ state: "dry_run", ...summary }, null, 2));
  process.exit(0);
}
const locked = await json(`${api}/signed-plans`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(
    {
      plan,
      owner: account.address,
      issuedAt: Math.floor(Date.now() / 1000),
      permission,
      permissionSignature,
      ...(authorization ? { authorization } : {})
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value)
  )
});
console.log(
  JSON.stringify(
    {
      state: "locked",
      ...summary,
      planId: locked.id,
      onchainPlanId: locked.freeze?.planId,
      delegationTx: locked.signedPermission?.delegationTx,
      freezeTx: locked.freeze?.txHash
    },
    null,
    2
  )
);
