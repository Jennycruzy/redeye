import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader
} from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  type Hex
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentRequest } from "./types.js";
import {
  agentFacilitatorSigner,
  createX402Seller,
  X402_ASSET,
  type X402Seller
} from "./x402-sales.js";

/**
 * Settles real x402 payments against a local fork of BNB Chain with the agent's own
 * facilitator and the real U contract. Runs only when REDEYE_FORK_RPC points at a fork, e.g.
 *   anvil --fork-url https://bsc-mainnet.public.blastapi.io --port 8599
 *   REDEYE_FORK_RPC=http://127.0.0.1:8599 pnpm --filter @redeye/agent test x402-fork
 */
const FORK_RPC = process.env.REDEYE_FORK_RPC;
/** PancakeSwap v3 U/USDT 0.01% pool, which holds U to lend the test buyer on the fork. */
const U_POOL = "0xA0909f81785f87f3e79309F0E73A7d82208094E4";
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)"
]);

function get(pathname: string, headers: Record<string, string> = {}): AgentRequest {
  return { method: "GET", pathname, query: new URLSearchParams(), headers: new Headers(headers) };
}

describe.skipIf(!FORK_RPC)("x402 sale settled on a BNB Chain fork", () => {
  const transport = http(FORK_RPC);
  const chain = createPublicClient({ chain: bsc, transport });
  const fork = createTestClient({ chain: bsc, mode: "anvil", transport });
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  const buyer = privateKeyToAccount(generatePrivateKey());
  const balance = (address: Hex) =>
    chain.readContract({
      address: X402_ASSET,
      abi: ERC20,
      functionName: "balanceOf",
      args: [address]
    });
  let seller: X402Seller;

  async function pay(account: typeof buyer, challenge: Record<string, string>) {
    const wallet = new x402Client().register(
      "eip155:*",
      new ExactEvmClient(toClientEvmSigner(account))
    );
    const required = decodePaymentRequiredHeader(challenge["PAYMENT-REQUIRED"]!);
    return encodePaymentSignatureHeader(await wallet.createPaymentPayload(required));
  }

  beforeAll(async () => {
    await fork.setBalance({ address: agent.address, value: parseEther("1") });
    await fork.setBalance({ address: U_POOL, value: parseEther("1") });
    await fork.impersonateAccount({ address: U_POOL });
    const lender = createWalletClient({ account: U_POOL, chain: bsc, transport });
    const hash = await lender.writeContract({
      address: X402_ASSET,
      abi: ERC20,
      functionName: "transfer",
      args: [buyer.address, parseEther("0.05")]
    });
    await chain.waitForTransactionReceipt({ hash });
    await fork.stopImpersonatingAccount({ address: U_POOL });
    seller = await createX402Seller({
      settlement: { kind: "self", signer: agentFacilitatorSigner(FORK_RPC!, agentKey) },
      payTo: agent.address,
      content: {
        price: async (ticker) => ({ ticker, real: "237.5" }),
        window: async () => null,
        record: async () => null
      }
    });
  }, 120_000);

  it("moves exactly 0.002 U from the buyer to the agent, then answers", async () => {
    const [buyerBefore, agentBefore] = [await balance(buyer.address), await balance(agent.address)];
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    expect(challenge.status).toBe(402);
    const paid = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await pay(buyer, challenge.headers) })
    );

    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ ticker: "NVDA", real: "237.5" });
    const settlement = decodePaymentResponseHeader(paid.headers["PAYMENT-RESPONSE"]!);
    expect(settlement).toMatchObject({ success: true, network: "eip155:56", payer: buyer.address });
    const receipt = await chain.getTransactionReceipt({ hash: settlement.transaction as Hex });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(agent.address.toLowerCase());
    expect(buyerBefore - (await balance(buyer.address))).toBe(2_000_000_000_000_000n);
    expect((await balance(agent.address)) - agentBefore).toBe(2_000_000_000_000_000n);
  }, 120_000);

  it("refuses the same signed payment a second time and moves nothing", async () => {
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const signature = await pay(buyer, challenge.headers);
    expect(
      (await seller.handle(get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": signature }))).status
    ).toBe(200);
    const before = await balance(buyer.address);
    const again = await seller.handle(get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": signature }));
    expect(again.status).toBe(402);
    expect(await balance(buyer.address)).toBe(before);
  }, 120_000);

  it("refuses a buyer with no U and moves nothing", async () => {
    const empty = privateKeyToAccount(generatePrivateKey());
    const agentBefore = await balance(agent.address);
    const challenge = await seller.handle(get("/x402/price/NVDA"));
    const response = await seller.handle(
      get("/x402/price/NVDA", { "PAYMENT-SIGNATURE": await pay(empty, challenge.headers) })
    );
    expect(response.status).toBe(402);
    expect(await balance(agent.address)).toBe(agentBefore);
  }, 120_000);
});
