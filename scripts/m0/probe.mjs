import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const rawRoot = join(repoRoot, "data", "raw", "m0");
const reportPath = join(rawRoot, "latest-report.json");

const timeoutMs = 15_000;
const date = process.env.M0_DATE || new Date().toISOString().slice(0, 10);
const rpcUrl = process.env.BSC_RPC_URL_LIVE || "https://bsc-dataseed.bnbchain.org";
const secUserAgent = process.env.SEC_USER_AGENT || "Redeye (contact@example.com)";

const requiredNodeMajor = 22;
const nodeMajor = Number(process.versions.node.split(".")[0]);
const statusOnly = process.argv.includes("--status-only");

function now() {
  return new Date().toISOString();
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function persistRaw(name, record) {
  await mkdir(rawRoot, { recursive: true });
  const path = join(rawRoot, `${safeName(name)}.json`);
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  return path;
}

async function requestJson(name, url, options = {}) {
  const startedAt = now();
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: "application/json",
    "user-agent": "Redeye-M0/0.1 (+https://example.invalid/redeye)",
    ...(options.headers || {})
  };

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });
    const bodyText = await response.text();
    let body = bodyText;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // Preserve non-JSON responses verbatim; a shape mismatch is evidence.
    }
    const record = {
      fetchedAt: startedAt,
      completedAt: now(),
      durationMs: Date.now() - startMs,
      request: { method: options.method || "GET", url },
      response: { status: response.status, ok: response.ok, body }
    };
    const rawPath = await persistRaw(name, record);
    return {
      name,
      ok: response.ok,
      status: response.status,
      durationMs: record.durationMs,
      rawPath: rawPath.slice(repoRoot.length + 1),
      body
    };
  } catch (error) {
    const record = {
      fetchedAt: startedAt,
      completedAt: now(),
      durationMs: Date.now() - startMs,
      request: { method: options.method || "GET", url },
      error: { name: error?.name || "Error", message: error?.message || String(error) }
    };
    const rawPath = await persistRaw(name, record);
    return {
      name,
      ok: false,
      status: null,
      durationMs: record.durationMs,
      rawPath: rawPath.slice(repoRoot.length + 1),
      error: record.error
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractTopLevelKeys(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const keys = Object.keys(body).sort();
  return keys.length > 40 ? [...keys.slice(0, 40), `...${keys.length - 40} more`] : keys;
}

function summarize(result, extra = {}) {
  const summary = {
    name: result.name,
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    rawPath: result.rawPath,
    ...extra
  };
  if (result.error) summary.error = result.error;
  if (result.body !== undefined) summary.topLevelKeys = extractTopLevelKeys(result.body);
  return summary;
}

async function run() {
  await mkdir(rawRoot, { recursive: true });

  const report = {
    v: 1,
    kind: "m0_probe_report",
    startedAt: now(),
    date,
    executionEnabled: process.env.EXECUTION_ENABLED || "unset",
    prerequisites: {
      node: process.version,
      nodeMajor,
      requiredNodeMajor,
      nodeRequirementSatisfied: nodeMajor >= requiredNodeMajor,
      authenticatedBinanceKeyPresent: Boolean(process.env.BINANCE_WEB3_API_KEY),
      authenticatedBinanceSecretPresent: Boolean(process.env.BINANCE_WEB3_API_SECRET),
      agentPrivateKeyPresent: Boolean(process.env.AGENT_PRIVATE_KEY),
      ownerTokenPresent: Boolean(process.env.OWNER_API_TOKEN)
    },
    probes: [],
    skipped: [],
    warnings: []
  };

  if (statusOnly) {
    report.skipped.push({ name: "network", reason: "status-only mode" });
  } else {
    const rwaListUrl =
      "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=3";
    const marketStatusUrl =
      "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai";
    const nasdaqUrl = `https://api.nasdaq.com/api/calendar/earnings?date=${encodeURIComponent(date)}`;
    const secTickerUrl = "https://www.sec.gov/files/company_tickers.json";
    const geckoUrl = "https://api.geckoterminal.com/api/v2/networks/bsc/pools";
    const b402Url = "https://web3.binance.com/build/api/v2/b402/supported";
    const hyperliquidUrl = process.env.HYPERLIQUID_INFO_URL || "https://api.hyperliquid.xyz/info";

    const [rwaList, marketStatus, nasdaq, secTicker, gecko, hyperliquid, b402] = await Promise.all([
      requestJson("binance-rwa-bstock-list", rwaListUrl),
      requestJson("binance-rwa-market-status", marketStatusUrl, {
        headers: { "accept-encoding": "identity", "user-agent": "binance-web3/1.1 (Skill)" }
      }),
      requestJson("nasdaq-earnings-calendar", nasdaqUrl, {
        headers: { "user-agent": "Mozilla/5.0 Redeye-M0/0.1" }
      }),
      requestJson("sec-company-tickers", secTickerUrl, {
        headers: { "user-agent": secUserAgent }
      }),
      requestJson("geckoterminal-bsc-pools", geckoUrl),
      requestJson("hyperliquid-xyz-markets", hyperliquidUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" })
      }),
      process.env.BINANCE_WEB3_API_KEY
        ? requestJson("binance-b402-supported", b402Url, {
            headers: { "X-OC-APIKEY": process.env.BINANCE_WEB3_API_KEY }
          })
        : Promise.resolve(null)
    ]);

    report.probes.push(
      summarize(rwaList),
      summarize(marketStatus),
      summarize(nasdaq),
      summarize(secTicker),
      summarize(gecko),
      summarize(hyperliquid, {
        xyzAssetCount: Array.isArray(hyperliquid.body?.[0]?.universe)
          ? hyperliquid.body[0].universe.length
          : null
      })
    );
    if (b402) report.probes.push(summarize(b402));
    else
      report.skipped.push({
        name: "binance-b402-supported",
        reason: "BINANCE_WEB3_API_KEY is not set"
      });

    const rpc = await requestJson("bsc-rpc-chain-id", rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
    });
    report.probes.push(summarize(rpc, { expectedChainId: "0x38" }));

    if (process.env.M0_POOL_ADDRESS) {
      const poolUrl = `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${encodeURIComponent(process.env.M0_POOL_ADDRESS)}`;
      report.probes.push(summarize(await requestJson("geckoterminal-configured-pool", poolUrl)));
    } else {
      report.skipped.push({
        name: "geckoterminal-configured-pool",
        reason: "M0_POOL_ADDRESS is not set"
      });
    }
  }

  if (!report.prerequisites.nodeRequirementSatisfied) {
    report.warnings.push("Node 22 or newer is required before M1 CI and package work.");
  }
  if (report.executionEnabled !== "false") {
    report.warnings.push(
      "EXECUTION_ENABLED is not exactly false; no authenticated or funded execution probe is permitted."
    );
  }
  report.completedAt = now();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(
    JSON.stringify(
      {
        report: reportPath.slice(repoRoot.length + 1),
        node: report.prerequisites.node,
        nodeRequirementSatisfied: report.prerequisites.nodeRequirementSatisfied,
        executionEnabled: report.executionEnabled,
        probeCount: report.probes.length,
        skippedCount: report.skipped.length,
        warningCount: report.warnings.length
      },
      null,
      2
    )
  );

  if (!report.prerequisites.nodeRequirementSatisfied) process.exitCode = 2;
}

run().catch(async (error) => {
  const failure = {
    v: 1,
    kind: "m0_probe_failure",
    failedAt: now(),
    error: { name: error?.name || "Error", message: error?.message || String(error) }
  };
  await mkdir(rawRoot, { recursive: true });
  await writeFile(reportPath, JSON.stringify(failure, null, 2) + "\n", "utf8");
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
