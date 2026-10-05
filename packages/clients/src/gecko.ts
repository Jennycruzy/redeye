import type { GeckoPoolSnapshot, SourceRecord } from "@redeye/shared";
import { ClientError } from "./errors.js";
import { requestJson } from "./http.js";

export const GECKOTERMINAL_BSC_POOLS_URL =
  "https://api.geckoterminal.com/api/v2/networks/bsc/pools";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientError("shape", `GeckoTerminal field ${field} is missing or invalid.`, {
      field,
      value
    });
  }
  return value;
}

export function parseGeckoPool(record: SourceRecord<unknown>): GeckoPoolSnapshot {
  const body = record.response.body;
  if (!isObject(body) || !isObject(body.data)) {
    throw new ClientError("shape", "GeckoTerminal pool response is missing data.attributes.");
  }
  const data = body.data;
  if (!isObject(data.attributes)) {
    throw new ClientError("shape", "GeckoTerminal pool response is missing data.attributes.");
  }
  const attributes = data.attributes;
  if (data.type !== "pool") {
    throw new ClientError("shape", "GeckoTerminal response is not a pool.", { type: data.type });
  }
  if (!isObject(attributes.volume_usd)) {
    throw new ClientError("shape", "GeckoTerminal pool response is missing volume_usd.");
  }

  const address = stringField(attributes.address, "data.attributes.address");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new ClientError("shape", "GeckoTerminal pool address is not an EVM address.", {
      address
    });
  }
  return {
    network: "bsc",
    address,
    name: stringField(attributes.name, "data.attributes.name"),
    poolCreatedAt: stringField(attributes.pool_created_at, "data.attributes.pool_created_at"),
    baseTokenPriceUsd: stringField(
      attributes.base_token_price_usd,
      "data.attributes.base_token_price_usd"
    ),
    quoteTokenPriceUsd: stringField(
      attributes.quote_token_price_usd,
      "data.attributes.quote_token_price_usd"
    ),
    reserveUsd: stringField(attributes.reserve_in_usd, "data.attributes.reserve_in_usd"),
    volume24hUsd: stringField(attributes.volume_usd.h24, "data.attributes.volume_usd.h24")
  } satisfies GeckoPoolSnapshot;
}

export async function fetchGeckoPool(address: string): Promise<SourceRecord<unknown>> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new ClientError("shape", "GeckoTerminal pool address is not an EVM address.", {
      address
    });
  }
  return requestJson<unknown>(`${GECKOTERMINAL_BSC_POOLS_URL}/${address}`);
}
