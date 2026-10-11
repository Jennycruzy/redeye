#!/usr/bin/env node
// Redeye from the command line, for people and for AI agents using the Redeye skill.
// Node 18+ only, no packages. Locking signs with the Binance Agentic Wallet CLI (baw).
//
//   redeye.mjs price NVDA [TSLA ...]     close, 24/7 price and token price, with ages
//   redeye.mjs window NVDA               the window a plan locked now would cover
//   redeye.mjs check '<plan json>'       the plan read back in one sentence; nothing saved
//   redeye.mjs lock '<plan json>' --yes  sign in your Agentic Wallet, lock in your name
//   redeye.mjs plan <id|#n>              one plan: status, result and chain links
//   redeye.mjs record                    every plan, newest first
//   redeye.mjs buy price NVDA --yes      buy the full 24/7 price over x402, paid from your
//                                        Agentic Wallet and settled by Binance B402
//
// Every command prints one JSON object. Set REDEYE_API to use another agent.

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const API = (process.env.REDEYE_API ?? "https://api.theredeyed-agent.site").replace(/\/$/, "");
const SITE = (process.env.REDEYE_SITE ?? "https://theredeyed-agent.site").replace(/\/$/, "");

// Must match SIGNED_PLAN_DOMAIN and SIGNED_PLAN_TYPES in Redeye's core package.
const DOMAIN = {
  name: "Redeye",
  version: "1",
  chainId: 56,
  verifyingContract: "0xC7B860d561f2208c725ac9a873bf4eA5205e9057"
};
const TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" }
  ],
  Plan: [
    { name: "promise", type: "string" },
    { name: "owner", type: "address" },
    { name: "ticker", type: "string" },
    { name: "planHash", type: "bytes32" },
    { name: "windowClose", type: "uint64" },
    { name: "issuedAt", type: "uint64" }
  ]
};

export class Refused extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function api(path, init) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {})
      }
    });
  } catch (error) {
    throw new Refused("AGENT_UNREACHABLE", `Redeye did not answer at ${API}: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Refused(
      body?.error?.code ?? `HTTP_${response.status}`,
      body?.error?.reason ?? `HTTP ${response.status}`
    );
  }
  return body;
}

function baw(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "baw",
      ["--json", ...args],
      { timeout: 60_000, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => {
        let body;
        try {
          body = JSON.parse(stdout);
        } catch {
          const missing = error?.code === "ENOENT";
          reject(
            new Refused(
              missing ? "BAW_MISSING" : "BAW_FAILED",
              missing
                ? "The Binance Agentic Wallet CLI (baw) is not installed: npm i -g @binance/agentic-wallet"
                : (stderr || error?.message || stdout).trim()
            )
          );
          return;
        }
        if (body.success !== true) {
          const code = body.error?.code;
          // Message signing needs Developer mode, which only the owner can switch on in the app.
          if (code === 351801) {
            reject(
              new Refused(
                "DEVELOPER_MODE_OFF",
                "Signing needs Developer mode. In the Binance App, open Agentic Wallet settings and turn on Developer mode, then run this again."
              )
            );
          } else
            reject(
              new Refused(
                "BAW_REFUSED",
                body.error?.message ?? body.message ?? JSON.stringify(body).slice(0, 400)
              )
            );
        } else resolve(body.data);
      }
    );
  });
}

export function parsePlan(text) {
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Refused(
      "PLAN_INVALID",
      'The plan must be JSON, for example \'{"ticker":"NVDA","kind":"hold","heldShares":"2"}\'.'
    );
  }
  if (typeof plan !== "object" || plan === null || Array.isArray(plan))
    throw new Refused("PLAN_INVALID", "The plan must be a JSON object.");
  // Safe limits unless the plan sets its own (same defaults as the site).
  plan.params = {
    maxPriceImpactPct: "1",
    minPoolDepthUsd: "100000",
    maxGapToRealPricePct: "1",
    ...(plan.params ?? {})
  };
  if (typeof plan.ticker === "string") plan.ticker = plan.ticker.toUpperCase();
  return plan;
}

const ago = (ms) => {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

async function price(tickers) {
  if (tickers.length === 0)
    throw new Refused("TICKER_REQUIRED", "Name at least one ticker, for example NVDA.");
  const data = await api(`/prices?tickers=${tickers.map((t) => t.toUpperCase()).join(",")}`);
  return {
    items: data.items.map((item) =>
      item.state !== "ok"
        ? {
            ticker: item.ticker,
            state: item.state,
            reason: item.reason ?? "a source did not answer"
          }
        : {
            ticker: item.ticker,
            close: { usd: item.close.value, date: item.close.date },
            price247: {
              usd: item.real.value,
              ageSeconds: item.real.ageSeconds,
              source: item.real.source
            },
            tokenPerShare: { usd: item.token.value, ageSeconds: item.token.ageSeconds },
            sinceClosePct: (
              ((Number(item.real.value) - Number(item.close.value)) / Number(item.close.value)) *
              100
            ).toFixed(2),
            tokenVs247Pct: Number(item.gaps.tokenToRealPct).toFixed(2)
          }
    )
  };
}

async function check(plan) {
  const preview = await api("/preview", { method: "POST", body: JSON.stringify(plan) });
  const now = Date.now();
  return {
    valid: preview.valid,
    promise: preview.promise,
    issues: preview.issues,
    planHash: preview.planHash,
    window: {
      kind: preview.window.kind,
      closesAt: new Date(preview.window.closeTs).toISOString(),
      opensAt: new Date(preview.window.openTs).toISOString(),
      lockBy: new Date(preview.window.lockBy).toISOString(),
      timeLeftToLock: preview.window.lockBy > now ? ago(preview.window.lockBy - now) : "passed"
    }
  };
}

async function walletAddress() {
  const data = await baw(["wallet", "address"]);
  const row = (data.addresses ?? []).find((a) => String(a.binanceChainId) === "56");
  if (!row)
    throw new Refused(
      "NO_BSC_ADDRESS",
      "The Agentic Wallet has no BNB Smart Chain address. Sign in with: baw auth signin"
    );
  return row.address;
}

/** baw returns r||s and a recovery byte; Redeye takes the usual 65-byte r||s||v. */
export function joinSignature(signature, v) {
  const hex = signature.replace(/^0x/, "");
  if (hex.length === 130) return `0x${hex}`;
  if (hex.length !== 128)
    throw new Refused("SIGNATURE_SHAPE", `Unexpected signature length ${hex.length}.`);
  return `0x${hex}${v.toString(16).padStart(2, "0")}`;
}

async function waitForSignature(orderId) {
  for (let i = 0; i < 60; i += 1) {
    const result = await baw(["sign-message", "result", "--order-id", orderId]);
    if (result.status === "COMPLETED") return result;
    if (result.status === "REJECTED" || result.status === "EXPIRED") {
      throw new Refused(
        "SIGN_DECLINED",
        `The signature was ${result.status.toLowerCase()} in the Binance App.`
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Refused("SIGN_TIMEOUT", "No confirmation in the Binance App within five minutes.");
}

async function lock(plan, confirmed) {
  if (plan.door)
    throw new Refused(
      "PLAN_INVALID",
      'A plan signed in your wallet is a promise only; remove "door".'
    );
  const checked = await check(plan);
  if (!checked.valid)
    throw new Refused("PLAN_INVALID", "The plan does not pass its checks.", {
      issues: checked.issues
    });
  if (!confirmed) {
    return {
      state: "needs_confirmation",
      promise: checked.promise,
      window: checked.window,
      next: "Read the promise to the user word for word. Only if they say yes, run the same command with --yes."
    };
  }
  const owner = await walletAddress();
  const issuedAt = Math.floor(Date.now() / 1000);
  const preview = await api("/preview", { method: "POST", body: JSON.stringify(plan) });
  const typed = {
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Plan",
    message: {
      promise: preview.promise,
      owner,
      ticker: plan.ticker,
      planHash: preview.planHash,
      windowClose: String(Math.floor(preview.window.closeTs / 1000)),
      issuedAt: String(issuedAt)
    }
  };
  const request = JSON.stringify({
    method: "eth_signTypedData_v4",
    params: [owner, JSON.stringify(typed)]
  });
  const previewed = await baw([
    "sign-message",
    "preview",
    "--binanceChainId",
    "56",
    "--signType",
    "EIP712",
    "--message",
    request
  ]);
  let signed = await baw(["sign-message", "execute", "--requestId", previewed.requestId]);
  if (signed.status === "PENDING_CONFIRMATION") signed = await waitForSignature(signed.orderId);
  if (signed.status !== "COMPLETED" || !signed.signature) {
    throw new Refused("SIGN_FAILED", `The wallet did not sign (status ${signed.status}).`);
  }
  const recovery = parseInt(signed.signatureRecovery ?? "0", 16);
  // Try the recovery byte as given (27/28), then the other form; Redeye checks and rejects a mismatch.
  const attempts = [
    ...new Set([27 + (recovery % 2), recovery >= 27 ? recovery : 27 + (1 - (recovery % 2))])
  ];
  let lastError;
  for (const v of attempts) {
    try {
      const locked = await api("/signed-plans", {
        method: "POST",
        body: JSON.stringify({
          plan,
          owner,
          issuedAt,
          signature: joinSignature(signed.signature, v)
        })
      });
      return {
        state: "locked",
        planId: locked.planId,
        promise: preview.promise,
        owner,
        lockTx: locked.freeze.txHash,
        lockTxUrl: `https://bscscan.com/tx/${locked.freeze.txHash}`,
        follow: `${SITE}/runs/${locked.id}`,
        gradedAt: new Date(preview.window.openTs).toISOString()
      };
    } catch (error) {
      lastError = error;
      if (error.code !== "SIGNATURE_MISMATCH") throw error;
    }
  }
  throw lastError;
}

// Tokens Redeye's paid routes ask for, so the cost reads in whole units.
const PAY_TOKENS = {
  "0xce24439f2d9c6a2289f741120fe202248b666666": { symbol: "U", decimals: 18 }
};

function units(raw, decimals) {
  const text = BigInt(raw)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals);
  const fraction = text.slice(text.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function decodeHeader(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

/** What a 402 asks for, in words a person can confirm. */
export function describeChallenge(header) {
  const required = decodeHeader(header);
  const offer = required.accepts?.[0];
  if (!offer) throw new Refused("NOT_FOR_SALE", "The agent's 402 offers no way to pay.");
  const token = PAY_TOKENS[String(offer.asset).toLowerCase()];
  return {
    resource: required.resource?.url ?? null,
    cost: token
      ? `${units(offer.amount, token.decimals)} ${token.symbol}`
      : `${offer.amount} raw units of ${offer.asset}`,
    network: offer.network,
    payTo: offer.payTo,
    settledBy: offer.extra?.signerAddress ?? null
  };
}

async function buy(kind, ticker, confirmed) {
  if (kind !== "price" && kind !== "window")
    throw new Refused("USAGE", "Buy price or window, for example: buy price NVDA --yes");
  if (!ticker) throw new Refused("TICKER_REQUIRED", "Name a ticker, for example NVDA.");
  const path = `/x402/${kind}/${ticker.toUpperCase()}`;
  const ask = (headers = {}) =>
    fetch(`${API}${path}`, { headers: { accept: "application/json", ...headers } }).catch(
      (error) => {
        throw new Refused("AGENT_UNREACHABLE", `Redeye did not answer at ${API}: ${error.message}`);
      }
    );
  const first = await ask();
  const header = first.headers.get("payment-required");
  if (first.status !== 402 || !header) {
    const body = await first.json().catch(() => null);
    throw new Refused(
      body?.error?.code ?? `HTTP_${first.status}`,
      body?.error?.reason ?? `Expected 402 Payment Required, got HTTP ${first.status}.`
    );
  }
  const offer = describeChallenge(header);
  if (!confirmed) {
    return {
      state: "needs_confirmation",
      ...offer,
      next: "Tell the user the cost. Only if they say yes, run the same command with --yes."
    };
  }
  const preview = await baw(["x402-payment", "preview", "--paymentRequirements", header]);
  const options = preview.options ?? [];
  const index = options.findIndex((option) => option.status === "READY_TO_SIGN");
  if (index < 0)
    throw new Refused("CANNOT_PAY", "The Agentic Wallet cannot pay this (not enough balance?).", {
      options
    });
  const signed = await baw([
    "x402-payment",
    "sign",
    "--paymentId",
    String(preview.paymentId),
    "--selectedIndex",
    String(options[index].index ?? index)
  ]);
  const paid = await ask({
    [signed.paymentHeaderName ?? "PAYMENT-SIGNATURE"]: signed.paymentHeaderValue
  });
  const body = await paid.json().catch(() => null);
  const receipt = paid.headers.get("payment-response");
  const settlement = receipt ? decodeHeader(receipt) : null;
  if (paid.status !== 200) {
    throw new Refused(
      body?.error?.code ?? `HTTP_${paid.status}`,
      body?.error?.reason ?? settlement?.errorReason ?? `The paid request got HTTP ${paid.status}.`,
      { settlement }
    );
  }
  return {
    state: "bought",
    ...offer,
    payer: settlement?.payer ?? null,
    tx: settlement?.transaction ?? null,
    txUrl: settlement?.transaction ? `https://bscscan.com/tx/${settlement.transaction}` : null,
    data: body
  };
}

async function planInfo(ref) {
  const record = await api("/record");
  const id = String(ref ?? "").replace(/^#/, "");
  const item = record.items.find((i) => i.id === id || String(i.planId) === id);
  if (!item) throw new Refused("PLAN_NOT_FOUND", `No plan ${ref} in the record.`);
  return summarize(item);
}

function summarize(item) {
  const link = (hash) => (hash ? `https://bscscan.com/tx/${hash}` : null);
  return {
    planId: item.planId,
    promise: item.promise,
    status: item.status,
    outcome: item.outcome,
    reason: item.reason,
    window: item.window,
    closesAt: new Date(item.closeTs).toISOString(),
    opensAt: new Date(item.openTs).toISOString(),
    openPrice: item.openPrice,
    owner: item.owner,
    door: item.door ?? null,
    lock: link(item.freezeTx),
    decision: link(item.decisionTx),
    trade: link(item.fillTx),
    result: link(item.verdictTx),
    page: `${SITE}/runs/${item.id}`
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = rest.filter((a) => !a.startsWith("--"));
  switch (command) {
    case "price":
      return price(args);
    case "window":
      return check({
        ticker: (args[0] ?? "NVDA").toUpperCase(),
        kind: "hold",
        heldShares: "1",
        params: {}
      }).then((c) => ({ ticker: (args[0] ?? "NVDA").toUpperCase(), window: c.window }));
    case "check":
      return check(parsePlan(args[0] ?? ""));
    case "lock":
      return lock(parsePlan(args[0] ?? ""), rest.includes("--yes"));
    case "plan":
      return planInfo(args[0]);
    case "buy":
      return buy(args[0], args[1], rest.includes("--yes"));
    case "record": {
      const record = await api("/record");
      return {
        totals: {
          kept: record.kept,
          refused: record.refused,
          broken: record.broken,
          running: record.open,
          missed: record.missed
        },
        items: [...record.items].sort((a, b) => b.closeTs - a.closeTs).map(summarize)
      };
    }
    default:
      throw new Refused(
        "USAGE",
        "Commands: price, window, check, lock, plan, record, buy. See the header of this file."
      );
  }
}

// Runs as a command; importing the file (as the tests do) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (value) => out({ ok: true, ...value }),
    (error) => {
      out({
        ok: false,
        code: error.code ?? "FAILED",
        reason: error.message,
        ...(error.extra ?? {})
      });
      process.exitCode = 1;
    }
  );
}
