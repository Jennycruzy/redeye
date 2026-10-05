import { keccak256, toBytes } from "viem";

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON cannot contain a non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => {
        const item = object[key];
        if (item === undefined)
          throw new Error(`Canonical JSON cannot contain undefined at ${key}.`);
        return `${JSON.stringify(key)}:${canonical(item)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return canonical(value);
}

export function hashCanonical(value: unknown): `0x${string}` {
  return keccak256(toBytes(canonicalJson(value)));
}
