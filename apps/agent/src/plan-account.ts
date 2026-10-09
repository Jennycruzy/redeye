import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import type { NormalizedQuote, WalletContext } from "@redeye/core";
import Decimal from "decimal.js";
import type { PermissionTrader, StoredAuthorization, StoredPermission } from "./plan-service.js";
import { type OrderResult, type QuoteRequest } from "./agentic-wallet.js";

export const PANCAKE_SMART_ROUTER_BSC: Address = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
export const PANCAKE_QUOTER_V2_BSC: Address = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const USDT_BSC: Address = "0x55d398326f99059fF775485246999027B3197955";
const ERC20_DECIMALS = 18;

const POOL_ABI = parseAbi(["function fee() view returns (uint24)"]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
]);
const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)"
]);
const PLAN_ACCOUNT_ABI = parseAbi([
  "function executeSwap((bytes32 planHash,bytes32 standingRunHash,address agent,address tokenIn,address tokenOut,uint256 maxAmount,address router,uint64 notBefore,uint64 notAfter,uint256 maxPriceDeviationBps) permission,bytes signature,(bytes32 planHash,bytes32 eventKey,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 referenceAmountOut,uint256 value,bytes data) swap) payable returns (bytes)"
]);
const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

function decimal(value: string, field: string): Decimal {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lt(0))
    throw new Error(`${field} must be a non-negative decimal.`);
  return parsed;
}

function raw(value: string, field: string): bigint {
  try {
    return parseUnits(value, ERC20_DECIMALS);
  } catch {
    throw new Error(`${field} is not representable in ${ERC20_DECIMALS} token decimals.`);
  }
}

function hashId(value: string): string {
  // The quote id only needs to be stable inside the plan receipt; avoid exposing
  // provider-specific order identifiers or secrets.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface PlanAccountTraderOptions {
  rpcUrl: string;
  privateKey: Hex;
  template: Address;
  router?: Address;
  quoter?: Address;
  /** Resolves the configured Pancake V3 pool for a bStock token address. */
  poolForToken(token: Address): Promise<Address | null>;
  now?: () => number;
}

/**
 * Pancake V3 quote/simulation/relay path for a delegated PlanAccount.
 *
 * The relayer owns no user funds: the EIP-7702 transaction targets the user's
 * address, so PlanAccount performs the approval and swap from that address.
 */
export class PlanAccountTrader implements PermissionTrader {
  private readonly reader;
  private readonly writer;
  private readonly account;
  private readonly router: Address;
  private readonly quoter: Address;
  private readonly now: () => number;

  constructor(private readonly options: PlanAccountTraderOptions) {
    this.account = privateKeyToAccount(options.privateKey);
    const transport = http(options.rpcUrl, { timeout: 30_000, retryCount: 2 });
    this.reader = createPublicClient({ chain: bsc, transport });
    this.writer = createWalletClient({ account: this.account, chain: bsc, transport });
    this.router = options.router ?? PANCAKE_SMART_ROUTER_BSC;
    this.quoter = options.quoter ?? PANCAKE_QUOTER_V2_BSC;
    this.now = options.now ?? Date.now;
  }

  async address(): Promise<Address> {
    // The service passes the actual owner to quote/context/swap. This fallback is
    // used only by generic diagnostics and is never a trade recipient.
    return this.account.address;
  }

  async context(
    requiredQuotaUsd: string,
    requiredUntilMs: number,
    account?: Address
  ): Promise<WalletContext> {
    const owner = account ?? this.account.address;
    const code = await this.reader.getCode({ address: owner });
    const delegated =
      code?.toLowerCase() === `0xef0100${this.options.template.slice(2).toLowerCase()}`;
    return {
      connected: delegated,
      tokenAllowed: true,
      quotaLeftUsd: requiredQuotaUsd,
      requiredQuotaUsd,
      sessionExpiresAtMs: delegated ? requiredUntilMs + 1 : this.now(),
      requiredUntilMs
    };
  }

  async quote(request: QuoteRequest): Promise<NormalizedQuote> {
    const token = request.tokenAddress as Address;
    const tokenIn = (request.side === "buy" ? USDT_BSC : token) as Address;
    const tokenOut = (request.side === "buy" ? token : USDT_BSC) as Address;
    const pool = await this.options.poolForToken(token);
    if (pool === null) throw new Error(`No Pancake V3 pool is configured for ${token}.`);
    const fee = Number(
      await this.reader.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" })
    );
    const amountInRaw = raw(request.amount, "quote amount");
    const simulated = await this.reader.simulateContract({
      address: this.quoter,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn: amountInRaw, fee, sqrtPriceLimitX96: 0n }]
    });
    const amountOutRaw = (simulated.result as readonly [bigint, ...unknown[]])[0];
    if (amountOutRaw <= 0n) throw new Error("Pancake V3 returned a zero-output quote.");
    const outputAmount = formatUnits(amountOutRaw, ERC20_DECIMALS);
    const inputAmount = request.amount;
    const tokens = new Decimal(request.side === "sell" ? inputAmount : outputAmount);
    const cash = new Decimal(request.side === "sell" ? outputAmount : inputAmount);
    const displayed = decimal(request.displayedPricePerShare, "displayed price");
    const implied = cash.div(tokens.mul(request.multiplier));
    const impactPct = implied.minus(displayed).abs().div(displayed).mul(100);
    const recipient = request.account ?? this.account.address;
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient,
          amountIn: amountInRaw,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n
        }
      ]
    });
    const quotedAtMs = this.now();
    const id = hashId(
      JSON.stringify({
        tokenIn,
        tokenOut,
        amountInRaw: amountInRaw.toString(),
        amountOutRaw: amountOutRaw.toString(),
        fee,
        quotedAtMs
      })
    );
    return {
      id,
      success: true,
      side: request.side,
      wrapper: "bStock",
      tokenAddress: request.tokenAddress,
      routeTokenAddress: request.tokenAddress,
      inputAmount,
      inputUnit: request.side === "sell" ? "TOKEN" : "USD",
      outputAmount,
      outputUnit: request.side === "sell" ? "USD" : "TOKEN",
      multiplier: request.multiplier,
      priceImpactPct: impactPct.toSignificantDigits(12).toString(),
      feeUsd: "0",
      quotedAtMs,
      execution: {
        router: this.router,
        data,
        value: "0",
        amountInRaw: amountInRaw.toString(),
        referenceAmountOutRaw: amountOutRaw.toString(),
        fee
      }
    };
  }

  async ensureAccount(owner: Address, permission: StoredPermission): Promise<Hex | null> {
    const code = await this.reader.getCode({ address: owner });
    const expected = `0xef0100${this.options.template.slice(2).toLowerCase()}`;
    if (code?.toLowerCase() === expected) return null;
    const authorization = permission.authorization;
    if (!authorization) {
      throw new Error(
        "PLAN_ACCOUNT_DELEGATION_REQUIRED: this wallet has not delegated to Redeye's PlanAccount template."
      );
    }
    if (authorization.contractAddress.toLowerCase() !== this.options.template.toLowerCase()) {
      throw new Error(
        "AUTHORIZATION_MISMATCH: delegation template does not match the configured account."
      );
    }
    const txHash = await this.writer.sendTransaction({
      to: owner,
      data: "0x",
      value: 0n,
      authorizationList: [
        {
          address: authorization.contractAddress,
          chainId: authorization.chainId,
          nonce: authorization.nonce,
          yParity: authorization.yParity,
          r: authorization.r,
          s: authorization.s
        }
      ]
    } as never);
    const receipt = await this.reader.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`PlanAccount delegation failed: ${txHash}`);
    return txHash;
  }

  async swap(
    quote: NormalizedQuote,
    slippagePct: string,
    stored: StoredPermission
  ): Promise<OrderResult> {
    const execution = quote.execution;
    if (!execution)
      throw new Error("PLAN_ACCOUNT_QUOTE_DATA_MISSING: quote has no router calldata.");
    const permission = stored.permission;
    const owner = stored.owner;
    if (execution.router.toLowerCase() !== permission.router.toLowerCase()) {
      throw new Error(
        "PLAN_ACCOUNT_ROUTER_MISMATCH: quote router is outside the signed permission."
      );
    }
    if (BigInt(execution.amountInRaw) > BigInt(permission.maxAmount)) {
      throw new Error("PLAN_ACCOUNT_AMOUNT_EXCEEDED: quote amount exceeds the signed permission.");
    }
    const slippageBps = decimal(slippagePct, "slippage").mul(100).ceil().toNumber();
    if (slippageBps > Number(permission.maxPriceDeviationBps)) {
      throw new Error("PLAN_ACCOUNT_PRICE_BAND: slippage exceeds the signed price band.");
    }
    const reference = BigInt(execution.referenceAmountOutRaw);
    const minimum = (reference * BigInt(Math.max(0, 10_000 - slippageBps))) / 10_000n;
    const tokenIn = permission.tokenIn as Address;
    const tokenOut = permission.tokenOut as Address;
    const fee = execution.fee;
    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient: owner,
          amountIn: BigInt(execution.amountInRaw),
          amountOutMinimum: minimum,
          sqrtPriceLimitX96: 0n
        }
      ]
    });
    const swap = {
      planHash: stored.planHash ?? permission.planHash,
      eventKey: stored.eventKey ?? ZERO_HASH,
      tokenIn,
      tokenOut,
      amountIn: BigInt(execution.amountInRaw),
      minAmountOut: minimum,
      referenceAmountOut: reference,
      value: BigInt(execution.value),
      data
    };
    const callData = encodeFunctionData({
      abi: PLAN_ACCOUNT_ABI,
      functionName: "executeSwap",
      args: [
        {
          planHash: permission.planHash,
          standingRunHash: permission.standingRunHash,
          agent: permission.agent,
          tokenIn: permission.tokenIn,
          tokenOut: permission.tokenOut,
          maxAmount: BigInt(permission.maxAmount),
          router: permission.router,
          notBefore: BigInt(permission.notBefore),
          notAfter: BigInt(permission.notAfter),
          maxPriceDeviationBps: BigInt(permission.maxPriceDeviationBps)
        },
        stored.signature,
        swap
      ]
    });
    // A prior ensureAccount call installed the code. Simulate the exact calldata
    // with the relayer as msg.sender before paying gas.
    await this.reader.call({ account: this.account.address, to: owner, data: callData });
    const txHash = await this.writer.sendTransaction({
      to: owner,
      data: callData,
      value: swap.value
    });
    const receipt = await this.reader.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    return {
      orderId: txHash,
      status: receipt.status === "success" ? "FINISHED" : "FAILED",
      txHash
    };
  }

  async waitForOrder(orderId: string): Promise<OrderResult> {
    const receipt = await this.reader.waitForTransactionReceipt({
      hash: orderId as Hex,
      timeout: 120_000
    });
    return {
      orderId,
      status: receipt.status === "success" ? "FINISHED" : "FAILED",
      txHash: orderId as Hex
    };
  }

  async findOrder(
    _quote: NormalizedQuote,
    _sinceMs: number,
    replyId?: string
  ): Promise<OrderResult | null> {
    if (replyId === undefined || !/^0x[0-9a-fA-F]{64}$/.test(replyId)) return null;
    return this.waitForOrder(replyId);
  }
}

export function authorizationObject(value: StoredAuthorization): StoredAuthorization {
  return { ...value };
}
