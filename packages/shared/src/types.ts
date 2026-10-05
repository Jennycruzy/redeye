export const wrappers = ["bStock", "Ondo", "xStock"] as const;
export type Wrapper = (typeof wrappers)[number];

export const marketStatuses = [
  "premarket",
  "regular",
  "postmarket",
  "overnight",
  "closed",
  "pause"
] as const;
export type MarketStatusName = (typeof marketStatuses)[number];

export interface SourceRequest {
  method: "GET" | "POST";
  url: string;
}

export interface SourceResponse<T> {
  status: number;
  ok: boolean;
  body: T;
}

export interface SourceRecord<T> {
  v: 1;
  fetchedAt: string;
  completedAt: string;
  request: SourceRequest;
  response: SourceResponse<T>;
}

export interface RwaToken {
  chainId: string;
  contractAddress: string;
  symbol: string;
  ticker: string;
  wrapper: Wrapper;
  multiplier: string;
  decimals: number;
}

export interface RwaMarketStatus {
  openState: boolean;
  marketStatus: MarketStatusName | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  nextOpenTime: number | null;
  nextCloseTime: number | null;
  offhours?: {
    openState: boolean;
    nextOpenTime: number | null;
    nextCloseTime: number | null;
  };
}

export interface NasdaqEarningsRow {
  symbol: string;
  name: string;
  time: string;
  epsForecast: string;
  numberOfEstimates: number;
  fiscalQuarterEnding: string;
}

export interface SecFiling {
  cik: string;
  accessionNumber: string;
  form: "8-K" | "6-K";
  filingDate: string;
  acceptanceDateTime: string;
  primaryDocument: string;
  reportDate: string | null;
  items: string | null;
}

export interface GeckoPoolSnapshot {
  network: "bsc";
  address: string;
  name: string;
  poolCreatedAt: string;
  baseTokenPriceUsd: string;
  quoteTokenPriceUsd: string;
  reserveUsd: string;
  volume24hUsd: string;
}
