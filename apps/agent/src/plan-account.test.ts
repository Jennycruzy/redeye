import { describe, expect, it } from "vitest";
import { boundedMinimumOutput } from "./plan-account.js";

describe("PlanAccount adapter", () => {
  it("rounds the output band up like the contract after the real-router fork failure", () => {
    const quoted = 18_788_440_599_603_057n;
    expect(boundedMinimumOutput(quoted, 100)).toBe(18_600_556_193_607_027n);
    expect(boundedMinimumOutput(10_000n, 100)).toBe(9_900n);
  });

  it("rejects an invalid slippage band", () => {
    expect(() => boundedMinimumOutput(1n, -1)).toThrow("slippage bps");
    expect(() => boundedMinimumOutput(1n, 10_001)).toThrow("slippage bps");
  });
});
