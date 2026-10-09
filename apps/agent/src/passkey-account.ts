import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
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

  return {
    preview,
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
