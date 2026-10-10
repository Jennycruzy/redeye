import type { B402Transport } from "@bnb-chain/b402/server";
import type { BinanceWeb3Client } from "@redeye/clients";

type B402Calls = Pick<BinanceWeb3Client, "b402Supported" | "b402Verify" | "b402Settle">;
type Supported = Awaited<ReturnType<B402Transport["supported"]>>;
type Verified = Awaited<ReturnType<B402Transport["verify"]>>;
type Settled = Awaited<ReturnType<B402Transport["settle"]>>;
type FacilitatorRequest = Parameters<B402Transport["verify"]>[0];

function version2(request: FacilitatorRequest): void {
  if (request.x402Version !== 2) {
    throw new Error(`B402 over the Web3 gateway takes x402 version 2, not ${request.x402Version}.`);
  }
}

export interface Web3B402Options {
  /** Wait between settle checks while B402 reports a broadcast that has not confirmed. */
  pollMs?: number;
  /** Give up waiting after this long; the SDK then records the settlement as unknown. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * B402 through the signed Binance Web3 gateway (/build/api/v2/b402/...), using the same
 * API key and HMAC signing as the RWA, Market, Trading, Transaction and Wallet modules.
 * The SDK's B402FacilitatorClient, exact scheme, replay store and settlement-unknown
 * handling sit on top unchanged; only the transport differs from the merchant route
 * (B402Client, RSA-signed, per-merchant base URL).
 */
export function web3B402Transport(client: B402Calls, options: Web3B402Options = {}): B402Transport {
  const pollMs = options.pollMs ?? 3_000;
  const maxWaitMs = options.maxWaitMs ?? 45_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  return {
    // Parsed for shape by the client; the SDK filters kinds it does not support.
    supported: async () => (await client.b402Supported()).data as unknown as Supported,
    verify: async (request) => {
      version2(request);
      return (await client.b402Verify(request.paymentPayload, request.paymentRequirements))
        .data as Verified;
    },
    settle: async (request) => {
      version2(request);
      const started = now();
      let result = (await client.b402Settle(request.paymentPayload, request.paymentRequirements))
        .data;
      // success=false with a transaction hash means broadcast but not yet confirmed. Asking
      // again for the same signed payment cannot move money twice: the token's EIP-3009 or
      // Permit2 nonce is spent once. An empty hash is a final refusal, so it is not asked again.
      while (!result.success && result.transaction !== "" && now() - started < maxWaitMs) {
        await sleep(pollMs);
        result = (await client.b402Settle(request.paymentPayload, request.paymentRequirements))
          .data;
      }
      return result as Settled;
    }
  };
}
