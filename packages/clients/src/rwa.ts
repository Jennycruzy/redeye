import {
  marketStatuses,
  type RwaAssetMarketStatus,
  type RwaMarketStatus,
  type RwaToken,
  type SourceRecord,
  type Wrapper
} from "@redeye/shared";
import { ClientError } from "./errors.js";
import { requestJson } from "./http.js";

export const BINANCE_RWA_LIST_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";
export const BINANCE_RWA_BSTOCK_LIST_URL = `${BINANCE_RWA_LIST_URL}?type=3`;
export const BINANCE_RWA_MARKET_STATUS_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai";
export const BINANCE_RWA_ASSET_STATUS_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai";

export type RwaListType = 1 | 2 | 3;

function wrapperForType(type: RwaListType): Wrapper {
  if (type === 1) return "Ondo";
  if (type === 2) return "xStock";
  return "bStock";
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientError("shape", `Missing or invalid ${field}.`, { field, value });
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ClientError("shape", `Missing or invalid ${field}.`, { field, value });
  }
  return value;
}

function assertBusinessSuccess(body: unknown, source: string): asserts body is JsonObject {
  if (!isObject(body)) {
    throw new ClientError("shape", `${source} response is not an object.`, { source });
  }
  if (body.success !== true || body.code !== "000000") {
    throw new ClientError("shape", `${source} response was not successful.`, {
      source,
      code: body.code,
      success: body.success,
      message: body.message
    });
  }
}

function parseAddress(value: unknown, field: string): string {
  const address = requiredString(value, field);
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new ClientError("shape", `Invalid EVM address in ${field}.`, { field, value });
  }
  return address;
}

function parseMultiplier(value: unknown, field: string): string {
  const multiplier = requiredString(value, field);
  if (!/^\d+(?:\.\d+)?$/.test(multiplier) || Number(multiplier) <= 0) {
    throw new ClientError("shape", `Invalid positive decimal in ${field}.`, { field, value });
  }
  return multiplier;
}

function parseMarketStatusName(value: unknown, field: string): RwaMarketStatus["marketStatus"] {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !marketStatuses.includes(value as (typeof marketStatuses)[number])
  ) {
    throw new ClientError("shape", `Invalid market status in ${field}.`, { field, value });
  }
  return value as RwaMarketStatus["marketStatus"];
}

export function parseRwaList(record: SourceRecord<unknown>, type: RwaListType): RwaToken[] {
  if (type !== 1 && type !== 2 && type !== 3) {
    throw new ClientError("shape", "Binance RWA list type must be 1, 2 or 3.", { type });
  }
  const body = record.response.body;
  assertBusinessSuccess(body, `Binance ${wrapperForType(type)} list`);
  if (!Array.isArray(body.data)) {
    throw new ClientError("shape", "Binance bStock list data is not an array.");
  }

  return body.data.map((value, index) => {
    if (!isObject(value)) {
      throw new ClientError("shape", "Binance bStock row is not an object.", { index });
    }
    const rowType = requiredNumber(value.type, `data[${index}].type`);
    if (rowType !== type) {
      throw new ClientError("shape", "Binance RWA row has an unexpected type.", {
        index,
        rowType,
        expectedType: type
      });
    }
    const decimals = requiredNumber(value.d, `data[${index}].d`);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ClientError("shape", "Binance bStock decimals must be a non-negative integer.", {
        index,
        decimals
      });
    }
    return {
      chainId: requiredString(value.chainId, `data[${index}].chainId`),
      contractAddress: parseAddress(value.contractAddress, `data[${index}].contractAddress`),
      symbol: requiredString(value.symbol, `data[${index}].symbol`),
      ticker: requiredString(value.ticker, `data[${index}].ticker`),
      wrapper: wrapperForType(type),
      multiplier: parseMultiplier(value.multiplier, `data[${index}].multiplier`),
      decimals
    } satisfies RwaToken;
  });
}

export function parseBstockList(record: SourceRecord<unknown>): RwaToken[] {
  return parseRwaList(record, 3);
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function parseNullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requiredNumber(value, field);
}

export function parseMarketStatus(record: SourceRecord<unknown>): RwaMarketStatus {
  const body = record.response.body;
  assertBusinessSuccess(body, "Binance RWA market status");
  if (!isObject(body.data)) {
    throw new ClientError("shape", "Binance RWA market status data is not an object.");
  }
  const data = body.data;
  if (typeof data.openState !== "boolean") {
    throw new ClientError("shape", "Binance RWA market status openState is missing or invalid.");
  }
  const parsed: RwaMarketStatus = {
    openState: data.openState,
    marketStatus: parseMarketStatusName(data.marketStatus, "data.marketStatus"),
    reasonCode: parseNullableString(data.reasonCode, "data.reasonCode"),
    reasonMsg: parseNullableString(data.reasonMsg, "data.reasonMsg"),
    nextOpenTime: parseNullableNumber(data.nextOpenTime, "data.nextOpenTime"),
    nextCloseTime: parseNullableNumber(data.nextCloseTime, "data.nextCloseTime")
  };

  if (data.offhours !== undefined) {
    if (!isObject(data.offhours) || typeof data.offhours.openState !== "boolean") {
      throw new ClientError("shape", "Binance RWA market status offhours is invalid.");
    }
    parsed.offhours = {
      openState: data.offhours.openState,
      nextOpenTime: parseNullableNumber(data.offhours.nextOpenTime, "data.offhours.nextOpenTime"),
      nextCloseTime: parseNullableNumber(data.offhours.nextCloseTime, "data.offhours.nextCloseTime")
    };
  }

  return parsed;
}

export function parseAssetMarketStatus(record: SourceRecord<unknown>): RwaAssetMarketStatus {
  const body = record.response.body;
  assertBusinessSuccess(body, "Binance RWA asset market status");
  if (!isObject(body.data)) {
    throw new ClientError("shape", "Binance RWA asset market status data is not an object.");
  }
  const data = body.data;
  const chainId = requiredString(data.chainId, "data.chainId");
  const contractAddress = parseAddress(data.contractAddress, "data.contractAddress");
  const openState = data.openState;
  if (openState !== null && typeof openState !== "boolean") {
    throw new ClientError("shape", "Binance RWA asset market status openState is invalid.");
  }
  return {
    chainId,
    contractAddress,
    openState,
    marketStatus: parseMarketStatusName(data.marketStatus, "data.marketStatus"),
    reasonCode: parseNullableString(data.reasonCode, "data.reasonCode"),
    reasonMsg: parseNullableString(data.reasonMsg, "data.reasonMsg"),
    nextOpenTime: parseNullableNumber(data.nextOpenTime, "data.nextOpenTime"),
    nextCloseTime: parseNullableNumber(data.nextCloseTime, "data.nextCloseTime")
  } satisfies RwaAssetMarketStatus;
}

export async function fetchBstockList(): Promise<SourceRecord<unknown>> {
  return fetchRwaList(3);
}

export async function fetchRwaList(type: RwaListType): Promise<SourceRecord<unknown>> {
  return requestJson<unknown>(`${BINANCE_RWA_LIST_URL}?type=${type}`);
}

export async function fetchMarketStatus(): Promise<SourceRecord<unknown>> {
  return requestJson<unknown>(BINANCE_RWA_MARKET_STATUS_URL, {
    headers: { "accept-encoding": "identity", "user-agent": "binance-web3/1.1 (Skill)" }
  });
}

export async function fetchAssetMarketStatus(
  chainId: string,
  contractAddress: string
): Promise<SourceRecord<unknown>> {
  if (!/^\d+$/.test(chainId))
    throw new ClientError("shape", "RWA chain id must be numeric.", { chainId });
  const address = parseAddress(contractAddress, "contractAddress");
  const query = new URLSearchParams({ chainId, contractAddress: address });
  return requestJson<unknown>(`${BINANCE_RWA_ASSET_STATUS_URL}?${query.toString()}`);
}
