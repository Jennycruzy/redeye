// Read-only check of Binance B402 through the signed Web3 API gateway.
// Usage: node scripts/b402-probe.mjs   (reads BINANCE_WEB3_API_KEY / _SECRET from .env)
// Calls only POST /build/api/v2/b402/supported: it settles nothing, sends no transaction and
// changes no plan or setting. Prints status, business code, latency and the payment kinds;
// never prints credentials. Needs a build of packages/clients (pnpm packages:build), or
// REDEYE_CLIENTS_DIST pointing at one.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dist = process.env.REDEYE_CLIENTS_DIST
  ? pathToFileURL(`${process.env.REDEYE_CLIENTS_DIST.replace(/\/$/, "")}/index.js`).href
  : new URL("../packages/clients/dist/index.js", import.meta.url).href;
const { BinanceWeb3Client } = await import(dist);

function env(name) {
  if (process.env[name]) return process.env[name];
  const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line
    ? line
        .slice(name.length + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
    : "";
}

const calls = [];
const client = new BinanceWeb3Client({
  apiKey: env("BINANCE_WEB3_API_KEY"),
  secret: env("BINANCE_WEB3_API_SECRET"),
  // One try: a probe should report what Binance said, not retry until it changes.
  maxAttempts: 1,
  onCall: (c) => calls.push(c)
});

let kinds = null;
let signers = null;
let failure = null;
try {
  const { data } = await client.b402Supported();
  kinds = data.kinds.map((k) => ({
    x402Version: k.x402Version,
    network: k.network,
    scheme: k.scheme,
    tokenName: k.extra.name ?? null,
    tokenVersion: k.extra.version ?? null,
    assetTransferMethod: k.extra.assetTransferMethod ?? null,
    signerAddress: k.extra.signerAddress ?? null,
    spenderAddress: k.extra.spenderAddress ?? null
  }));
  signers = data.signers;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

const call = calls[calls.length - 1] ?? null;
console.log(
  JSON.stringify(
    {
      at: call?.at ?? new Date().toISOString(),
      path: "POST /build/api/v2/b402/supported",
      httpStatus: call?.httpStatus ?? null,
      businessCode: call?.businessCode ?? null,
      message: call?.message ?? null,
      latencyMs: call?.latencyMs ?? null,
      ok: call?.ok ?? false,
      kindCount: kinds?.length ?? null,
      bscKinds: kinds?.filter((k) => k.network === "eip155:56") ?? null,
      kinds,
      signers,
      failure
    },
    null,
    2
  )
);
process.exitCode = call?.ok ? 0 : 1;
