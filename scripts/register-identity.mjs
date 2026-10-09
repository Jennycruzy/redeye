#!/usr/bin/env node
// Registers the agent in the ERC-8004 identity registry on BNB Chain, or points an existing
// registration at a new card. Dry run unless "--send" is given.
//
//   node scripts/register-identity.mjs            check the card and simulate
//   node scripts/register-identity.mjs --send     register (or update, if ERC8004_AGENT_ID is set)
//   --check-at http://127.0.0.1:8787               read the card from this agent instead, for when
//                                                  the public address is not answering yet
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbi
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { loadRepositoryEnv } from "./load-env.mjs";

const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
const abi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"
]);

function fail(message) {
  console.error(JSON.stringify({ code: "IDENTITY_REGISTER_FAILED", reason: message }));
  process.exit(1);
}

loadRepositoryEnv(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const send = process.argv.includes("--send");
const agentUrl = process.env.PUBLIC_AGENT_URL?.trim().replace(/\/$/, "");
const key = process.env.AGENT_PRIVATE_KEY?.trim();
const existingId = process.env.ERC8004_AGENT_ID?.trim() || null;
if (!agentUrl) fail("PUBLIC_AGENT_URL is not set.");
if (!key) fail("AGENT_PRIVATE_KEY is not set.");

// The registry stores only the link, so the card it points to is checked first: at the public
// address, or with --check-at at the agent itself, which must already name that address.
const cardUrl = `${agentUrl}/.well-known/agent-registration.json`;
const checkAtIndex = process.argv.indexOf("--check-at");
const checkAt = checkAtIndex === -1 ? null : process.argv[checkAtIndex + 1]?.replace(/\/$/, "");
if (checkAtIndex !== -1 && !checkAt) fail("--check-at needs an address.");
const readFrom = checkAt ? `${checkAt}/.well-known/agent-registration.json` : cardUrl;
const response = await fetch(readFrom).catch((error) => fail(`${readFrom}: ${error.message}`));
if (!response.ok) fail(`${readFrom} returned HTTP ${response.status}.`);
const card = await response.json();
if (card.type !== REGISTRATION_TYPE) fail("The served card is not an ERC-8004 registration file.");
const serviceUrl = (name) => card.services.find((service) => service.name === name)?.endpoint;
if (!serviceUrl("record")?.startsWith(agentUrl)) {
  fail(
    `The card at ${readFrom} does not name ${agentUrl}; restart the agent with PUBLIC_AGENT_URL set.`
  );
}

const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const rpc = http(process.env.BSC_RPC_URL_LIVE ?? "https://bsc-dataseed.bnbchain.org");
const client = createPublicClient({ chain: bsc, transport: rpc });
const wallet = createWalletClient({ account, chain: bsc, transport: rpc });

if (existingId !== null) {
  const owner = await client.readContract({
    address: IDENTITY_REGISTRY,
    abi,
    functionName: "ownerOf",
    args: [BigInt(existingId)]
  });
  if (getAddress(owner) !== account.address) fail(`Agent ${existingId} is owned by ${owner}.`);
  const current = await client.readContract({
    address: IDENTITY_REGISTRY,
    abi,
    functionName: "tokenURI",
    args: [BigInt(existingId)]
  });
  if (current === cardUrl) {
    console.log(JSON.stringify({ state: "unchanged", agentId: existingId, cardUrl }));
    process.exit(0);
  }
}

const call =
  existingId === null
    ? { functionName: "register", args: [cardUrl] }
    : { functionName: "setAgentURI", args: [BigInt(existingId), cardUrl] };
const { request, result } = await client.simulateContract({
  address: IDENTITY_REGISTRY,
  abi,
  account,
  ...call
});
const gas = await client.estimateContractGas({ address: IDENTITY_REGISTRY, abi, account, ...call });
const gasPrice = await client.getGasPrice();
const summary = {
  action: call.functionName,
  owner: account.address,
  cardUrl,
  services: card.services.map((service) => service.name),
  ...(existingId === null ? { expectedAgentId: result.toString() } : { agentId: existingId }),
  estimatedFeeBnb: Number(gas * gasPrice) / 1e18
};
if (!send) {
  console.log(JSON.stringify({ state: "dry_run", ...summary }, null, 2));
  process.exit(0);
}

const hash = await wallet.writeContract(request);
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`Transaction ${hash} reverted.`);
let agentId = existingId;
for (const log of receipt.logs) {
  if (getAddress(log.address) !== IDENTITY_REGISTRY) continue;
  try {
    const event = decodeEventLog({ abi, data: log.data, topics: log.topics });
    if (event.eventName === "Registered") agentId = event.args.agentId.toString();
  } catch {
    // Other registry events, such as the token transfer, are not needed here.
  }
}
console.log(JSON.stringify({ state: "sent", ...summary, agentId, txHash: hash }, null, 2));
if (existingId === null)
  console.log(`Set ERC8004_AGENT_ID=${agentId} in .env and restart the agent.`);
