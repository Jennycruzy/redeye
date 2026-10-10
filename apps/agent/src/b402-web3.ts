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

/**
 * B402 through the signed Binance Web3 gateway (/build/api/v2/b402/...), using the same
 * API key and HMAC signing as the RWA, Market, Trading, Transaction and Wallet modules.
 * The SDK's B402FacilitatorClient, exact scheme, replay store and settlement-unknown
 * handling sit on top unchanged; only the transport differs from the merchant route
 * (B402Client, RSA-signed, per-merchant base URL).
 */
export function web3B402Transport(client: B402Calls): B402Transport {
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
      return (await client.b402Settle(request.paymentPayload, request.paymentRequirements))
        .data as Settled;
    }
  };
}
