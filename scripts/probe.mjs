import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepositoryEnv } from "./load-env.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
loadRepositoryEnv(repoRoot);
const rawRoot = join(repoRoot, "data", "raw", "probes");
const reportPath = join(rawRoot, "latest-report.json");

const timeoutMs = 15_000;
const date = process.env.PROBE_DATE || new Date().toISOString().slice(0, 10);
const rpcUrl = process.env.BSC_RPC_URL_LIVE || "https://bsc-dataseed.bnbchain.org";
const secUserAgent = process.env.SEC_USER_AGENT?.trim() || null;

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
    "user-agent": "Redeye/0.1",
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

const rwaBase =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa";
const auditUrl = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit";
const skillHeaders = { "accept-encoding": "identity", "user-agent": "binance-web3/1.1 (Skill)" };

function listRows(body) {
  const data = body?.data;
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.list) ? data.list : [];
}

// String compare after trimming zeros; Number() would round 18-digit multipliers.
function normalizeMultiplier(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [integer, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${integer.replace(/^0+(?=\d)/, "")}${trimmed ? `.${trimmed}` : ""}`;
}

function sameMultiplier(a, b) {
  const left = normalizeMultiplier(a);
  return left !== null && left === normalizeMultiplier(b);
}

/**
 * A22: does the Token Security Audit have data for the bStocks we trade (F26)?
 * A23: do the share counts agree across sources (F27)? bStock contracts expose no
 * multiplier and the per-asset endpoints carry none, so the sources are the bStock
 * list, the unfiltered RWA list (matched by address) and the per-token meta record.
 */
async function probeTradedTokens(bstockBody) {
  const poolMapPath = resolve(
    repoRoot,
    process.env.REDEYE_POOL_MAP_PATH || "data/raw/offhours/pools.json"
  );
  const tickers = Object.keys(JSON.parse(await readFile(poolMapPath, "utf8")));
  const bstocks = listRows(bstockBody).filter(
    (row) => row.chainId === "56" && tickers.includes(row.ticker)
  );
  const allList = await requestJson("binance-rwa-list-all", `${rwaBase}/stock/detail/list/ai`, {
    headers: skillHeaders
  });
  const allRows = listRows(allList.body);

  const rows = [];
  for (const token of bstocks) {
    const address = token.contractAddress.toLowerCase();
    const audit = await requestJson(`binance-token-audit-${token.symbol}`, auditUrl, {
      method: "POST",
      headers: { ...skillHeaders, "content-type": "application/json", source: "agent" },
      body: JSON.stringify({
        binanceChainId: "56",
        contractAddress: token.contractAddress,
        requestId: crypto.randomUUID()
      })
    });
    const meta = await requestJson(
      `binance-rwa-meta-${token.symbol}`,
      `${rwaBase}/meta/ai?chainId=56&contractAddress=${token.contractAddress}`,
      { headers: skillHeaders }
    );
    const listed = allRows.filter(
      (row) => row.chainId === "56" && row.contractAddress?.toLowerCase() === address
    );
    const auditData = audit.body?.data;
    const metaData = meta.body?.data;
    rows.push({
      ticker: token.ticker,
      symbol: token.symbol,
      contractAddress: token.contractAddress,
      audit: !audit.ok
        ? "unavailable"
        : auditData?.hasResult === true
          ? auditData.riskLevel > 1
            ? "flagged"
            : "clear"
          : "no_data",
      auditRiskLevel: auditData?.riskLevel ?? null,
      multiplier: {
        bstockList: token.multiplier ?? null,
        allList: listed.map((row) => row.multiplier ?? null),
        contract: null
      },
      multiplierAgreement:
        listed.length > 0 &&
        listed.every((row) => sameMultiplier(row.multiplier, token.multiplier)),
      metaMatches:
        metaData?.symbol === token.symbol && metaData?.type === 3 && metaData?.decimals === 18
    });
  }

  const noData = rows.filter((row) => row.audit === "no_data").map((row) => row.symbol);
  const unavailable = rows.filter((row) => row.audit === "unavailable").map((row) => row.symbol);
  const disagree = rows.filter((row) => !row.multiplierAgreement || !row.metaMatches);
  return {
    rows,
    A22: {
      status: rows.length === 0 || unavailable.length > 0 ? "failed" : "partial",
      evidence:
        `Audit answered for ${rows.length - unavailable.length} of ${rows.length} traded bStocks; ` +
        `no data for ${noData.length} (${noData.join(", ") || "none"}). ` +
        "Whether the Agentic Wallet refuses a swap without audit data needs a paired wallet."
    },
    A23: {
      status: rows.length > 0 && disagree.length === 0 ? "confirmed" : "failed",
      evidence:
        disagree.length === 0
          ? `Share counts agree for all ${rows.length} traded bStocks across the bStock list and the full RWA list; meta symbol, type and decimals match. The token contracts expose no multiplier.`
          : `Disagreement for ${disagree.map((row) => row.symbol).join(", ")}.`
    }
  };
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
    kind: "probe_report",
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
    warnings: [],
    assumptionChecks: {
      A12: {
        status: "pending",
        evidence: "Requires a funded Agentic Wallet and $2 swaps during a night and a weekend."
      },
      A18: {
        status: "pending",
        evidence: "Requires a real phone test of Face ID from Telegram."
      },
      A20: {
        status: "pending",
        evidence: "Requires 60-second refresh and weekend-gap observation over the covered stocks."
      },
      A21: {
        status: "pending",
        evidence: "Requires a simulated and executed swap from the user's smart account."
      }
    }
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
        headers: { "user-agent": "Mozilla/5.0 Redeye/0.1" }
      }),
      secUserAgent
        ? requestJson("sec-company-tickers", secTickerUrl, {
            headers: { "user-agent": secUserAgent }
          })
        : Promise.resolve(null),
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
      summarize(gecko),
      summarize(hyperliquid, {
        xyzAssetCount: Array.isArray(hyperliquid.body?.[0]?.universe)
          ? hyperliquid.body[0].universe.length
          : null
      })
    );
    if (secTicker) {
      report.probes.push(summarize(secTicker));
    } else {
      report.skipped.push({
        name: "sec-company-tickers",
        reason: "SEC_USER_AGENT is not set to a real contact address"
      });
    }
    const xyzShapeObserved =
      hyperliquid.ok &&
      Array.isArray(hyperliquid.body?.[0]?.universe) &&
      Array.isArray(hyperliquid.body?.[1]) &&
      hyperliquid.body[0].universe.length === hyperliquid.body[1].length;
    report.assumptionChecks.A20 = {
      status: xyzShapeObserved ? "partial" : "failed",
      evidence: xyzShapeObserved
        ? `The public response contains ${hyperliquid.body[0].universe.length} matched xyz markets; refresh limits and weekend continuity remain unmeasured.`
        : "The public xyz response did not contain matched market and context arrays."
    };
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

    if (process.env.PROBE_POOL_ADDRESS) {
      const poolUrl = `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${encodeURIComponent(process.env.PROBE_POOL_ADDRESS)}`;
      report.probes.push(summarize(await requestJson("geckoterminal-configured-pool", poolUrl)));
    } else {
      report.skipped.push({
        name: "geckoterminal-configured-pool",
        reason: "PROBE_POOL_ADDRESS is not set"
      });
    }

    const tokenChecks = await probeTradedTokens(rwaList.body);
    report.tokenChecks = tokenChecks.rows;
    report.assumptionChecks.A22 = tokenChecks.A22;
    report.assumptionChecks.A23 = tokenChecks.A23;
  }

  if (!report.prerequisites.nodeRequirementSatisfied) {
    report.warnings.push("Node 22 or newer is required before automated checks and package work.");
  }
  if (!secUserAgent) {
    report.warnings.push(
      "SEC_USER_AGENT is required before any SEC request; no SEC request was made."
    );
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
    kind: "probe_failure",
    failedAt: now(),
    error: { name: error?.name || "Error", message: error?.message || String(error) }
  };
  await mkdir(rawRoot, { recursive: true });
  await writeFile(reportPath, JSON.stringify(failure, null, 2) + "\n", "utf8");
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
