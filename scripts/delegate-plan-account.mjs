#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { signAuthorization } from "viem/experimental";
import { loadRepositoryEnv } from "./load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadRepositoryEnv(root);

const send = process.argv.includes("--send");
const teamTest = process.argv.includes("--team-test");
if (!teamTest) throw new Error("Only the isolated --team-test wallet is supported.");
const ownerKeyRaw = process.env.JOB_BUYER_PRIVATE_KEY?.trim();
const relayerKeyRaw = process.env.AGENT_PRIVATE_KEY?.trim();
if (!ownerKeyRaw || !relayerKeyRaw) throw new Error("Team owner and relayer keys are required.");
const owner = privateKeyToAccount(ownerKeyRaw.startsWith("0x") ? ownerKeyRaw : `0x${ownerKeyRaw}`);
const relayer = privateKeyToAccount(
  relayerKeyRaw.startsWith("0x") ? relayerKeyRaw : `0x${relayerKeyRaw}`
);
const template = getAddress(process.env.PLANACCOUNT_ADDRESS ?? "");
const transport = http(process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org", {
  timeout: 30_000,
  retryCount: 2
});
const reader = createPublicClient({ chain: bsc, transport });
const ownerWallet = createWalletClient({ account: owner, chain: bsc, transport });
const relayerWallet = createWalletClient({ account: relayer, chain: bsc, transport });
const nonce = await reader.getTransactionCount({ address: owner.address, blockTag: "pending" });
const authorization = await signAuthorization(ownerWallet, {
  account: owner,
  contractAddress: template,
  chainId: 56,
  nonce
});
if (!send) {
  console.log(JSON.stringify({ state: "dry_run", owner: owner.address, template, nonce }, null, 2));
  process.exit(0);
}
const hash = await relayerWallet.sendTransaction({
  account: relayer,
  to: relayer.address,
  data: "0x",
  value: 0n,
  authorizationList: [authorization]
});
const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== "success") throw new Error(`Delegation failed: ${hash}`);
const code = await reader.getCode({ address: owner.address });
const expected = `0xef0100${template.slice(2).toLowerCase()}`;
if (code?.toLowerCase() !== expected)
  throw new Error("Delegation bytecode does not match template.");
console.log(
  JSON.stringify({ state: "delegated", owner: owner.address, template, txHash: hash }, null, 2)
);
