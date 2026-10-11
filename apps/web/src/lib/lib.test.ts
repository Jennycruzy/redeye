import { afterEach, describe, expect, it, vi } from "vitest";
import type { NightTrace } from "./api";
import { changePct, duration, pct, reasonWords, usd } from "./format";
import { triggerLabel, triggerPrice } from "./plans";
import { lastFinishedClose, replayResult } from "./replay";
import {
  hasPlanAccountDelegation,
  signDelegation,
  WalletUnsupported,
  type WalletChoice
} from "./wallet";
import { handoffToken, p256Coordinates, passkeyCreationOptions, withdrawDigest } from "./passkey";

afterEach(() => vi.unstubAllGlobals());

const THU_CLOSE = Date.parse("2026-10-08T20:00:00Z");
const FRI_OPEN = Date.parse("2026-10-09T13:30:00Z");

function trace(points: Array<[number, string]>): NightTrace {
  return {
    state: "ok",
    ticker: "NVDA",
    window: { kind: "overnight", closeTs: THU_CLOSE, openTs: FRI_OPEN },
    phase: "finished",
    close: { value: "200", date: "2026-10-08", source: "nasdaq" },
    points,
    interval: "5m",
    source: "hyperliquid:xyz:NVDA 5m candles",
    fetchedAt: "2026-10-09T14:00:00.000Z"
  };
}

describe("formatting", () => {
  it("writes money, signed changes and durations the way the site shows them", () => {
    expect(usd("230.48")).toBe("$230.48");
    expect(usd(null)).toBe("—");
    expect(pct(changePct(231, 230.48))).toBe("+0.23%");
    expect(pct(-1.12)).toBe("−1.12%");
    expect(pct(0.001)).toBe("0.00%");
    expect(duration(5 * 3600e3 + 27 * 60e3)).toBe("5 h 27 min");
    expect(duration(3 * 86_400e3)).toBe("3 days");
    expect(reasonWords("CONDITION_NOT_MET")).toBe(
      "The price never reached the trigger, so nothing was done."
    );
  });
});

describe("plan triggers", () => {
  it("puts the trigger line where the agent would act", () => {
    const guard = { kind: "guard", params: { triggerDropPct: "3", sellPct: "50" } };
    expect(triggerPrice(guard, 200)).toBeCloseTo(194);
    expect(triggerLabel(guard, 194)).toBe("Sell 50% at $194.00 or less (−3.00%)");
    const rise = { kind: "sell_rise", params: { triggerRisePct: "1", sellPct: "50" } };
    expect(triggerPrice(rise, 200)).toBeCloseTo(202);
    expect(triggerPrice({ kind: "hold", params: {} }, 200)).toBeNull();
  });
});

describe("replay against a recorded night", () => {
  it("finds the first minute a falling trigger was crossed", () => {
    const result = replayResult(
      trace([
        [THU_CLOSE + 3e5, "199"],
        [THU_CLOSE + 6e5, "193.5"],
        [THU_CLOSE + 9e5, "192"]
      ]),
      "guard",
      3
    );
    expect(result?.hit).toEqual({ at: THU_CLOSE + 6e5, price: 193.5 });
    expect(result?.extreme).toBe(192);
  });

  it("reports how close a rise came when it never triggered", () => {
    const result = replayResult(
      trace([
        [THU_CLOSE + 3e5, "201"],
        [THU_CLOSE + 6e5, "201.5"]
      ]),
      "sell_rise",
      1
    );
    expect(result?.hit).toBeNull();
    expect(result?.extreme).toBe(201.5);
  });

  it("replays only a window that has fully ended", () => {
    // During Thursday night the last finished window is Wednesday's.
    expect(lastFinishedClose(THU_CLOSE + 3600e3)).toBe(Date.parse("2026-10-07T20:00:00Z"));
    // After Friday's open, Thursday night is finished.
    expect(lastFinishedClose(FRI_OPEN + 3600e3)).toBe(THU_CLOSE);
  });
});

const OWNER = `0x${"11".repeat(20)}` as const;
const TEMPLATE = `0x${"22".repeat(20)}` as const;

function wallet(request: WalletChoice["provider"]["request"]): WalletChoice {
  return { id: "test", name: "Test wallet", icon: null, provider: { request } };
}

describe("PlanAccount wallet compatibility", () => {
  it("recognizes an existing delegation without asking for another authorization", async () => {
    const methods: string[] = [];
    const choice = wallet(async ({ method }) => {
      methods.push(method);
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getCode") return `0xef0100${TEMPLATE.slice(2)}`;
      throw new Error(`unexpected ${method}`);
    });

    await expect(hasPlanAccountDelegation(choice, OWNER, TEMPLATE)).resolves.toBe(true);
    expect(methods).toEqual(["eth_chainId", "eth_getCode"]);
  });

  it("turns two unsupported authorization methods into an actionable refusal", async () => {
    const choice = wallet(async ({ method }) => {
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getTransactionCount") return "0x1";
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    });

    await expect(signDelegation(choice, OWNER, TEMPLATE)).rejects.toBeInstanceOf(WalletUnsupported);
  });
});

describe("passkey registration", () => {
  it("moves a fragment handoff into tab storage and removes it from the address bar", () => {
    const stored = new Map<string, string>();
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://redeye.example/new#handoff=token-123" },
      history: { replaceState }
    });
    vi.stubGlobal("sessionStorage", {
      setItem: (key: string, value: string) => stored.set(key, value),
      getItem: (key: string) => stored.get(key) ?? null
    });

    expect(handoffToken()).toBe("token-123");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/new");
    expect([...stored.values()]).toEqual(["token-123"]);
  });

  it("offers a platform path and a flexible cross-device path", () => {
    const userId = new Uint8Array(32);
    const device = passkeyCreationOptions("theredeyed-agent.site", userId, "device");
    const flexible = passkeyCreationOptions("theredeyed-agent.site", userId, "flexible");
    expect(device.authenticatorSelection?.authenticatorAttachment).toBe("platform");
    expect(flexible.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
    expect(flexible.authenticatorSelection?.userVerification).toBe("required");
    expect(flexible.authenticatorSelection?.residentKey).toBe("required");
    expect(flexible.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
  });

  it("extracts both P-256 coordinates from a browser SPKI key", () => {
    const prefix = new Uint8Array(26);
    const point = new Uint8Array(65);
    point[0] = 4;
    point.fill(0x11, 1, 33);
    point.fill(0x22, 33);
    const spki = new Uint8Array([...prefix, ...point]);
    expect(p256Coordinates(spki.buffer)).toEqual({
      publicKeyX: `0x${"11".repeat(32)}`,
      publicKeyY: `0x${"22".repeat(32)}`
    });
  });

  it("refuses a non-P-256 point", () => {
    expect(() => p256Coordinates(new Uint8Array(40).buffer)).toThrow("P-256");
  });
});

describe("withdrawDigest", () => {
  it("matches PlanAccount.withdrawDigest for the same inputs (pinned in the Foundry test)", () => {
    expect(
      withdrawDigest("0x000000000000000000000000000000000000c0de", {
        token: "0x55d398326f99059ff775485246999027b3197955",
        to: "0x000000000000000000000000000000000000beef",
        amount: 5_000_000_000_000_000_000n,
        nonce: 3n,
        deadline: 1_791_700_000n
      })
    ).toBe("0x06b2e958af2aa6e074854443025cc6aa0be576b3c7c335ff933490b172f3ff64");
  });
});
