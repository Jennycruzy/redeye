#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { loadRepositoryEnv } from "./load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadRepositoryEnv(root);

const planBook = getAddress(
  process.env.PLANBOOK_ADDRESS ?? "0xC7B860d561f2208c725ac9a873bf4eA5205e9057"
);
const send = process.argv.includes("--send");
const rawKey = process.env.AGENT_PRIVATE_KEY?.trim();
if (send && !rawKey) throw new Error("AGENT_PRIVATE_KEY is required with --send.");
const artifact = JSON.parse(
  await readFile(
    resolve(root, "contracts/out/PasskeyAccountFactory.sol/PasskeyAccountFactory.json"),
    "utf8"
  )
);
const bytecode = artifact.bytecode.object;
if (typeof bytecode !== "string" || !bytecode.startsWith("0x")) {
  throw new Error("Build PasskeyAccountFactory before deployment.");
}
if (!send) {
  console.log(JSON.stringify({ state: "dry_run", chainId: 56, planBook }, null, 2));
  process.exit(0);
}

const key = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
const account = privateKeyToAccount(key);
const transport = http(process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org", {
  timeout: 30_000,
  retryCount: 2
});
const reader = createPublicClient({ chain: bsc, transport });
const writer = createWalletClient({ account, chain: bsc, transport });
const hash = await writer.deployContract({
  account,
  abi: artifact.abi,
  bytecode,
  args: [planBook]
});
const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error("PasskeyAccountFactory deployment failed: " + hash);
}
const code = await reader.getCode({ address: receipt.contractAddress });
const boundPlanBook = await reader.readContract({
  address: receipt.contractAddress,
  abi: artifact.abi,
  functionName: "planBook"
});
if (boundPlanBook.toLowerCase() !== planBook.toLowerCase()) {
  throw new Error("Factory PlanBook mismatch: " + boundPlanBook + " != " + planBook);
}
console.log(
  JSON.stringify(
    {
      state: "deployed",
      address: receipt.contractAddress,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      runtimeBytes: code ? (code.length - 2) / 2 : 0,
      deployer: account.address,
      planBook
    },
    null,
    2
  )
);
