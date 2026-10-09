import {
  PLAN_PERMISSION_TYPES,
  SIGNED_PLAN_DOMAIN,
  SIGNED_PLAN_TYPES,
  planPermissionDomain,
  type SerializedPlanPermission
} from "@redeye/core";

/** The minimal EIP-1193 surface the site uses: a signature, never a transaction. */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletChoice {
  id: string;
  name: string;
  icon: string | null;
  provider: Eip1193;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193;
}

/**
 * Every wallet the browser offers. EIP-6963 lets several extensions announce themselves side
 * by side; older wallets only set window.ethereum, which is used when nothing announces.
 */
export function discoverWallets(timeoutMs = 400): Promise<WalletChoice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletChoice>();
    const announce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.provider || !detail.info) return;
      found.set(detail.info.rdns || detail.info.uuid, {
        id: detail.info.rdns || detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon || null,
        provider: detail.provider
      });
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", announce);
      const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      if (found.size === 0 && legacy) {
        found.set("injected", {
          id: "injected",
          name: "Browser wallet",
          icon: null,
          provider: legacy
        });
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

export class WalletRefused extends Error {}

function readable(error: unknown): string {
  const e = error as { code?: number; message?: string };
  if (e?.code === 4001) return "You declined in your wallet. Nothing was signed.";
  return e?.message ?? "The wallet did not answer.";
}

export async function connect(wallet: WalletChoice): Promise<`0x${string}`> {
  try {
    const accounts = (await wallet.provider.request({ method: "eth_requestAccounts" })) as string[];
    const first = accounts[0];
    if (!first) throw new WalletRefused("The wallet shared no address.");
    return first as `0x${string}`;
  } catch (error) {
    throw new WalletRefused(readable(error));
  }
}

const BSC = {
  chainId: "0x38",
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: ["https://bsc-dataseed.bnbchain.org"],
  blockExplorerUrls: ["https://bscscan.com"]
};

/** Typed-data signatures name the chain, so the wallet must be on BNB Smart Chain first. */
async function onBsc(provider: Eip1193): Promise<void> {
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === BSC.chainId) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BSC.chainId }]
    });
  } catch (error) {
    if ((error as { code?: number }).code === 4902) {
      await provider.request({ method: "wallet_addEthereumChain", params: [BSC] });
    } else {
      throw new WalletRefused(readable(error));
    }
  }
}

export interface SignedAuthorization {
  contractAddress: `0x${string}`;
  chainId: number;
  nonce: number;
  yParity: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

function hexNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return Number(BigInt(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new WalletRefused(`The wallet returned an invalid ${field}.`);
}

function authorizationResult(value: unknown, template: `0x${string}`): SignedAuthorization {
  const raw = (value as { authorization?: unknown })?.authorization ?? value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WalletRefused("The wallet did not return an EIP-7702 authorization.");
  }
  const item = raw as Record<string, unknown>;
  const contract = (item.contractAddress ?? item.address ?? item.contract) as unknown;
  const yParity = item.yParity ?? item.v;
  if (typeof contract !== "string" || contract.toLowerCase() !== template.toLowerCase()) {
    throw new WalletRefused("The wallet authorized a different account template.");
  }
  if (typeof item.r !== "string" || typeof item.s !== "string") {
    throw new WalletRefused("The wallet returned an incomplete EIP-7702 authorization.");
  }
  const parity = hexNumber(yParity, "authorization parity");
  return {
    contractAddress: template,
    chainId: hexNumber(item.chainId, "authorization chain"),
    nonce: hexNumber(item.nonce, "authorization nonce"),
    yParity: parity > 1 ? parity - 27 : parity,
    r: item.r as `0x${string}`,
    s: item.s as `0x${string}`
  };
}

/** Requests the EIP-7702 delegation signature used by the agent relayer. */
export async function signDelegation(
  wallet: WalletChoice,
  owner: `0x${string}`,
  template: `0x${string}`
): Promise<SignedAuthorization> {
  await onBsc(wallet.provider);
  const nonceRaw = await wallet.provider.request({
    method: "eth_getTransactionCount",
    params: [owner, "pending"]
  });
  const nonce = hexNumber(nonceRaw, "account nonce");
  const requests: Array<{ method: string; params: unknown[] }> = [
    {
      method: "wallet_signAuthorization",
      params: [
        {
          contractAddress: template,
          chainId: 56,
          nonce
        }
      ]
    },
    {
      method: "eth_signAuthorization",
      params: [
        {
          address: template,
          chainId: "0x38",
          nonce: `0x${nonce.toString(16)}`
        }
      ]
    }
  ];
  let last: unknown = null;
  for (const request of requests) {
    try {
      const result = await wallet.provider.request(request);
      return authorizationResult(result, template);
    } catch (error) {
      last = error;
      if ((error as { code?: number }).code === 4001) throw new WalletRefused(readable(error));
    }
  }
  throw new WalletRefused(
    last instanceof Error
      ? `This wallet does not expose EIP-7702 signing yet: ${last.message}`
      : "This wallet does not expose EIP-7702 signing yet."
  );
}

/** Signs the bounded permission, not live swap calldata. */
export async function signPlanPermission(
  wallet: WalletChoice,
  owner: `0x${string}`,
  fields: SerializedPlanPermission
): Promise<{ signature: `0x${string}`; issuedAt: number }> {
  await onBsc(wallet.provider);
  const issuedAt = Math.floor(Date.now() / 1000);
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ],
      ...PLAN_PERMISSION_TYPES
    },
    domain: planPermissionDomain(owner),
    primaryType: "PlanPermission",
    message: {
      planHash: fields.planHash,
      standingRunHash: fields.standingRunHash,
      agent: fields.agent,
      tokenIn: fields.tokenIn,
      tokenOut: fields.tokenOut,
      maxAmount: fields.maxAmount,
      router: fields.router,
      notBefore: fields.notBefore,
      notAfter: fields.notAfter,
      maxPriceDeviationBps: fields.maxPriceDeviationBps
    }
  };
  try {
    const signature = (await wallet.provider.request({
      method: "eth_signTypedData_v4",
      params: [owner, JSON.stringify(typed)]
    })) as `0x${string}`;
    return { signature, issuedAt };
  } catch (error) {
    throw new WalletRefused(readable(error));
  }
}

/** Asks the wallet to sign the plan; the wallet shows the promise word for word. */
export async function signPlan(
  wallet: WalletChoice,
  fields: {
    promise: string;
    owner: `0x${string}`;
    ticker: string;
    planHash: string;
    windowCloseMs: number;
  }
): Promise<{ signature: `0x${string}`; issuedAt: number }> {
  await onBsc(wallet.provider);
  const issuedAt = Math.floor(Date.now() / 1000);
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ],
      ...SIGNED_PLAN_TYPES
    },
    domain: SIGNED_PLAN_DOMAIN,
    primaryType: "Plan",
    message: {
      promise: fields.promise,
      owner: fields.owner,
      ticker: fields.ticker,
      planHash: fields.planHash,
      windowClose: String(Math.floor(fields.windowCloseMs / 1000)),
      issuedAt: String(issuedAt)
    }
  };
  try {
    const signature = (await wallet.provider.request({
      method: "eth_signTypedData_v4",
      params: [fields.owner, JSON.stringify(typed)]
    })) as `0x${string}`;
    return { signature, issuedAt };
  } catch (error) {
    throw new WalletRefused(readable(error));
  }
}
