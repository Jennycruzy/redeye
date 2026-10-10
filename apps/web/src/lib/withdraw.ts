import { createPublicClient, fallback, http, parseAbi, type Address } from "viem";
import { bsc } from "viem/chains";

const ACCOUNT_ABI = parseAbi([
  "function withdrawNonce() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)"
]);

/** Public BNB Smart Chain nodes, so the nonce the passkey signs never comes from Redeye. */
const client = createPublicClient({
  chain: bsc,
  transport: fallback([
    http("https://bsc-dataseed.bnbchain.org"),
    http("https://bsc-rpc.publicnode.com")
  ])
});

export function readWithdrawNonce(account: Address): Promise<bigint> {
  return client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "withdrawNonce" });
}

export function readTokenBalance(token: Address, account: Address): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: ACCOUNT_ABI,
    functionName: "balanceOf",
    args: [account]
  });
}
