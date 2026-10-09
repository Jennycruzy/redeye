import { SIGNED_PLAN_DOMAIN, SIGNED_PLAN_TYPES } from "@redeye/core";

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
