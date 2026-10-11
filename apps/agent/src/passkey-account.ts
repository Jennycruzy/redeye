import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import type { TelegramIdentity } from "./telegram.js";

export const PASSKEY_FACTORY_ABI = [
  {
    type: "function",
    name: "predictAccount",
    stateMutability: "view",
    inputs: [
      { name: "credentialIdHash", type: "bytes32" },
      { name: "qx", type: "bytes32" },
      { name: "qy", type: "bytes32" }
    ],
    outputs: [
      { name: "account", type: "address" },
      { name: "owner", type: "address" }
    ]
  },
  {
    type: "function",
    name: "planBook",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  }
] as const;

export interface PasskeyAccountPreviewConfig {
  rpcUrl: string;
  factory: Address;
  planBook: Address;
}

export interface PasskeySponsorLedger {
  claimPasskeySponsor(userId: string, day: string, account: string, dailyLimit: number): boolean;
  releasePasskeySponsor(userId: string, day: string, account: string): void;
  claimPasskeyWithdrawal(userId: string, day: string, dailyLimit: number): boolean;
}

export interface PasskeyAccountServiceConfig extends PasskeyAccountPreviewConfig {
  sponsorKey: Hex;
  dailyLimit: number;
  maxFeeWei: bigint;
  ledger: PasskeySponsorLedger;
}

export interface NormalizedPasskeyInput {
  credentialIdHash: `0x${string}`;
  publicKeyX: `0x${string}`;
  publicKeyY: `0x${string}`;
}

const PLAN_ACCOUNT_WITHDRAW_ABI = parseAbi([
  "function withdraw(address token, address to, uint256 amount, uint64 deadline, bytes signature)",
  "function planBook() view returns (address)"
]);
/** Withdrawals the agent relays per Telegram user per day. */
export const WITHDRAW_DAILY_PER_USER = 5;
/** A signed withdrawal must expire within this many seconds. */
const WITHDRAW_MAX_DEADLINE_S = 3_600;

export class PasskeyAccountError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, reason: string) {
    super(reason);
    this.name = "PasskeyAccountError";
    this.status = status;
    this.code = code;
  }
}

function bytes32(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new PasskeyAccountError(
      400,
      "PASSKEY_INPUT_INVALID",
      `${field} must be a 32-byte hex value.`
    );
  }
  if (/^0x0{64}$/.test(value)) {
    throw new PasskeyAccountError(400, "PASSKEY_INPUT_INVALID", `${field} must not be zero.`);
  }
  return value.toLowerCase() as `0x${string}`;
}

export function normalizePasskeyInput(input: Record<string, unknown>): NormalizedPasskeyInput {
  return {
    credentialIdHash: bytes32(input.credentialIdHash, "credentialIdHash"),
    publicKeyX: bytes32(input.publicKeyX, "publicKeyX"),
    publicKeyY: bytes32(input.publicKeyY, "publicKeyY")
  };
}

async function factoryPrediction(
  client: ReturnType<typeof createPublicClient>,
  factory: Address,
  planBook: Address,
  normalized: NormalizedPasskeyInput
): Promise<{ account: Address; owner: Address }> {
  let predicted: readonly [Address, Address];
  let deployedPlanBook: Address;
  try {
    predicted = await client.readContract({
      address: factory,
      abi: PASSKEY_FACTORY_ABI,
      functionName: "predictAccount",
      args: [normalized.credentialIdHash, normalized.publicKeyX, normalized.publicKeyY]
    });
    deployedPlanBook = await client.readContract({
      address: factory,
      abi: PASSKEY_FACTORY_ABI,
      functionName: "planBook"
    });
  } catch {
    throw new PasskeyAccountError(
      503,
      "PASSKEY_FACTORY_UNAVAILABLE",
      "The passkey factory could not be read on BNB Chain."
    );
  }
  if (deployedPlanBook.toLowerCase() !== planBook.toLowerCase()) {
    throw new PasskeyAccountError(
      503,
      "PASSKEY_FACTORY_MISMATCH",
      "The configured passkey factory is bound to a different PlanBook."
    );
  }
  return { account: predicted[0], owner: predicted[1] };
}

/**
 * Reads the factory's CREATE2 prediction without spending gas. The create route
 * is intentionally separate so a browser can show the final addresses before
 * a sponsor transaction is ever considered.
 */
export function createPasskeyAccountPreview(config: PasskeyAccountPreviewConfig) {
  const factory = getAddress(config.factory);
  const planBook = getAddress(config.planBook);
  const client = createPublicClient({ chain: bsc, transport: http(config.rpcUrl) });
  return async (input: Record<string, unknown>, identity: TelegramIdentity): Promise<unknown> => {
    void identity;
    const normalized = normalizePasskeyInput(input);
    const predicted = await factoryPrediction(client, factory, planBook, normalized);
    return {
      state: "ready",
      chainId: 56,
      factory,
      planBook,
      account: predicted.account,
      owner: predicted.owner,
      ...normalized
    };
  };
}

/**
 * Builds the server-side sponsor. It is only constructed when the agent has a
 * dedicated key, a fee ceiling and a durable claim ledger. The browser never
 * receives the sponsor key and cannot call this function directly.
 */
export function createPasskeyAccountService(config: PasskeyAccountServiceConfig) {
  if (!Number.isInteger(config.dailyLimit) || config.dailyLimit < 1)
    throw new Error("Passkey sponsor dailyLimit must be a positive integer.");
  if (config.maxFeeWei <= 0n) throw new Error("Passkey sponsor maxFeeWei must be positive.");
  const factory = getAddress(config.factory);
  const planBook = getAddress(config.planBook);
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain: bsc, transport });
  const account = privateKeyToAccount(config.sponsorKey);
  const walletClient = createWalletClient({ account, chain: bsc, transport });
  const preview = createPasskeyAccountPreview(config);

  /**
   * Relays a withdrawal the account owner signed with their passkey. The account
   * checks the signature, nonce and deadline itself; the agent only refuses
   * accounts that are not Redeye PlanAccounts, dry-runs the call before paying,
   * and keeps the same fee cap and a per-user daily limit.
   */
  const withdraw = async (
    input: Record<string, unknown>,
    identity: TelegramIdentity
  ): Promise<unknown> => {
    const field = (name: string): Address => {
      const value = input[name];
      if (typeof value !== "string" || !isAddress(value, { strict: false })) {
        throw new PasskeyAccountError(
          400,
          "PASSKEY_WITHDRAW_INVALID",
          `${name} must be an address.`
        );
      }
      return getAddress(value);
    };
    const target = field("account");
    const token = field("token");
    const to = field("to");
    if (to === "0x0000000000000000000000000000000000000000")
      throw new PasskeyAccountError(400, "PASSKEY_WITHDRAW_INVALID", "to must not be zero.");
    if (typeof input.amount !== "string" || !/^[1-9][0-9]{0,77}$/.test(input.amount))
      throw new PasskeyAccountError(
        400,
        "PASSKEY_WITHDRAW_INVALID",
        "amount must be a positive whole number of raw units."
      );
    const amount = BigInt(input.amount);
    const nowS = Math.floor(Date.now() / 1000);
    const deadline = Number(input.deadline);
    if (
      !Number.isInteger(deadline) ||
      deadline <= nowS ||
      deadline > nowS + WITHDRAW_MAX_DEADLINE_S
    )
      throw new PasskeyAccountError(
        400,
        "PASSKEY_WITHDRAW_INVALID",
        "deadline must be within the next hour."
      );
    if (typeof input.signature !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(input.signature))
      throw new PasskeyAccountError(400, "PASSKEY_WITHDRAW_INVALID", "signature must be hex.");
    const signature = input.signature as Hex;

    const book = await publicClient
      .readContract({ address: target, abi: PLAN_ACCOUNT_WITHDRAW_ABI, functionName: "planBook" })
      .catch(() => null);
    if (book === null || getAddress(book) !== planBook)
      throw new PasskeyAccountError(
        400,
        "PASSKEY_WITHDRAW_ACCOUNT",
        "This is not a Redeye account, or BNB Chain could not be reached."
      );

    const day = new Date().toISOString().slice(0, 10);
    if (!config.ledger.claimPasskeyWithdrawal(identity.userId, day, WITHDRAW_DAILY_PER_USER))
      throw new PasskeyAccountError(
        429,
        "PASSKEY_WITHDRAW_LIMIT",
        "Today's withdrawal limit for this Telegram user is reached."
      );

    const args = [token, to, amount, BigInt(deadline), signature] as const;
    let gas: bigint;
    let gasPrice: bigint;
    try {
      [gas, gasPrice] = await Promise.all([
        publicClient.estimateContractGas({
          address: target,
          abi: PLAN_ACCOUNT_WITHDRAW_ABI,
          functionName: "withdraw",
          args,
          account: account.address
        }),
        publicClient.getGasPrice()
      ]);
    } catch {
      // The dry run reverted: wrong signature, used nonce, past deadline or too little balance.
      throw new PasskeyAccountError(
        400,
        "PASSKEY_WITHDRAW_REFUSED",
        "The account refused this withdrawal; nothing was sent."
      );
    }
    if (gas * gasPrice > config.maxFeeWei)
      throw new PasskeyAccountError(
        503,
        "PASSKEY_SPONSOR_CAP",
        "The withdrawal fee exceeds the sponsor cap."
      );
    const hash = await walletClient.writeContract({
      address: target,
      abi: PLAN_ACCOUNT_WITHDRAW_ABI,
      functionName: "withdraw",
      args,
      account,
      chain: bsc
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return { state: receipt.status === "success" ? "sent" : "reverted", txHash: hash };
  };

  return {
    preview,
    withdraw,
    create: async (
      input: Record<string, unknown>,
      identity: TelegramIdentity
    ): Promise<unknown> => {
      const normalized = normalizePasskeyInput(input);
      const predicted = await factoryPrediction(publicClient, factory, planBook, normalized);
      const [accountCode, ownerCode] = await Promise.all([
        publicClient.getCode({ address: predicted.account }),
        publicClient.getCode({ address: predicted.owner })
      ]);
      if (accountCode !== undefined && accountCode !== "0x") {
        return {
          state: "existing",
          chainId: 56,
          factory,
          planBook,
          account: predicted.account,
          owner: predicted.owner,
          ...normalized
        };
      }
      if (ownerCode !== undefined && ownerCode !== "0x") {
        throw new PasskeyAccountError(
          409,
          "PASSKEY_ACCOUNT_CONFLICT",
          "The deterministic passkey owner exists without its PlanAccount."
        );
      }

      let gas: bigint;
      let gasPrice: bigint;
      try {
        [gas, gasPrice] = await Promise.all([
          publicClient.estimateContractGas({
            address: factory,
            abi: PASSKEY_FACTORY_ABI,
            functionName: "createAccount",
            args: [normalized.credentialIdHash, normalized.publicKeyX, normalized.publicKeyY],
            account: account.address
          }),
          publicClient.getGasPrice()
        ]);
      } catch {
        throw new PasskeyAccountError(
          503,
          "PASSKEY_SPONSOR_UNAVAILABLE",
          "The passkey deployment could not be estimated on BNB Chain."
        );
      }
      const estimatedFeeWei = gas * gasPrice;
      if (estimatedFeeWei > config.maxFeeWei) {
        throw new PasskeyAccountError(
          503,
          "PASSKEY_SPONSOR_CAP",
          "The estimated account-deployment fee exceeds the sponsor cap."
        );
      }

      const day = new Date().toISOString().slice(0, 10);
      if (
        !config.ledger.claimPasskeySponsor(
          identity.userId,
          day,
          predicted.account,
          config.dailyLimit
        )
      ) {
        throw new PasskeyAccountError(
          429,
          "PASSKEY_SPONSOR_LIMIT",
          "The passkey sponsor limit for this Telegram user or day has been reached."
        );
      }
      try {
        const hash = await walletClient.writeContract({
          address: factory,
          abi: PASSKEY_FACTORY_ABI,
          functionName: "createAccount",
          args: [normalized.credentialIdHash, normalized.publicKeyX, normalized.publicKeyY],
          account,
          chain: bsc
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== "success") throw new Error("deployment transaction reverted");
        const [createdAccountCode, createdOwnerCode] = await Promise.all([
          publicClient.getCode({ address: predicted.account }),
          publicClient.getCode({ address: predicted.owner })
        ]);
        if (
          createdAccountCode === undefined ||
          createdAccountCode === "0x" ||
          createdOwnerCode === undefined ||
          createdOwnerCode === "0x"
        ) {
          throw new Error("deployment receipt did not produce both account contracts");
        }
        return {
          state: "created",
          chainId: 56,
          factory,
          planBook,
          account: predicted.account,
          owner: predicted.owner,
          txHash: hash,
          estimatedFeeWei: estimatedFeeWei.toString(),
          ...normalized
        };
      } catch (caught) {
        config.ledger.releasePasskeySponsor(identity.userId, day, predicted.account);
        if (caught instanceof PasskeyAccountError) throw caught;
        throw new PasskeyAccountError(
          503,
          "PASSKEY_SPONSOR_FAILED",
          "The sponsored passkey deployment did not complete."
        );
      }
    }
  };
}
