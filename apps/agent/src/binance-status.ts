import type { BinanceWeb3Client, Web3CallRecord } from "@redeye/clients";
import { BSC_CHAIN_ID } from "@redeye/clients";

const KEEP = 500;

interface RwaRow {
  tokenContractAddress?: string;
  underlyingTicker?: string;
  tokenSymbol?: string;
  tokenToShareRatio?: string;
  tokenPrice?: string;
  referencePrice?: string;
  statusInfo?: {
    openState?: boolean;
    marketStatus?: string | null;
    reasonCode?: string | null;
    reasonMsg?: string | null;
    nextOpenTime?: number | null;
  };
}

/**
 * Keeps a public tally of every signed Binance Web3 API call and refreshes the
 * bStock list from the RWA module, so anyone can see which modules Redeye uses,
 * how they answered and what Binance reports for each token right now.
 */
export function createBinanceStatus(client: BinanceWeb3Client, now: () => number = Date.now) {
  const calls: Web3CallRecord[] = [];
  let tokens: Array<Record<string, unknown>> = [];
  let tokensAt: string | null = null;
  let lastError: string | null = null;

  const record = (call: Web3CallRecord) => {
    calls.push(call);
    if (calls.length > KEEP) calls.splice(0, calls.length - KEEP);
  };

  const refresh = async () => {
    try {
      const { data } = await client
        .withRecorder(() => undefined)
        .get<RwaRow[]>("rwa", "/api/v1/dex/market/rwa/tokens", {
          binanceChainId: BSC_CHAIN_ID,
          platformId: "bstock"
        });
      tokens = (Array.isArray(data) ? data : []).map((row) => ({
        ticker: row.underlyingTicker ?? null,
        symbol: row.tokenSymbol ?? null,
        tokenAddress: row.tokenContractAddress ?? null,
        tokenToShareRatio: row.tokenToShareRatio ?? null,
        tokenPrice: row.tokenPrice ?? null,
        referencePrice: row.referencePrice ?? null,
        openState: row.statusInfo?.openState ?? null,
        marketStatus: row.statusInfo?.marketStatus ?? null,
        reasonCode: row.statusInfo?.reasonCode ?? null,
        reasonMsg: row.statusInfo?.reasonMsg ?? null,
        nextOpenTime: row.statusInfo?.nextOpenTime ?? null
      }));
      tokensAt = new Date(now()).toISOString();
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  };

  const status = () => {
    const modules: Record<string, unknown> = {};
    for (const name of ["rwa", "market", "trading", "transaction", "wallet", "b402"]) {
      const mine = calls.filter((c) => c.module === name);
      const last = mine[mine.length - 1];
      const latencies = mine.map((c) => c.latencyMs).sort((a, b) => a - b);
      modules[name] = {
        calls: mine.length,
        ok: mine.filter((c) => c.ok).length,
        medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
        last: last
          ? {
              at: last.at,
              path: last.path,
              httpStatus: last.httpStatus,
              code: last.code,
              ok: last.ok
            }
          : null
      };
    }
    return {
      state: lastError === null ? "ok" : "degraded",
      lastError,
      since: calls[0]?.at ?? null,
      modules,
      bstocks: { checkedAt: tokensAt, count: tokens.length, items: tokens }
    };
  };

  return { record, refresh, status };
}
