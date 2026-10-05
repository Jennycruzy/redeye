import { describe, expect, it } from "vitest";
import { asItems, displayTime, displayValue } from "./api";

describe("web evidence formatting", () => {
  it("does not turn missing values into demo numbers", () => {
    expect(displayValue(undefined)).toBe("Unavailable");
    expect(displayValue(null)).toBe("Unavailable");
    expect(displayValue("$12.30")).toBe("$12.30");
  });

  it("only renders object records from an API items array", () => {
    expect(asItems({ items: [{ ticker: "NVDA" }, 4, null, "sample"] })).toEqual([
      { ticker: "NVDA" }
    ]);
    expect(asItems({ state: "empty" })).toEqual([]);
  });

  it("shows both local and UTC context for valid timestamps", () => {
    expect(displayTime("2026-08-26T20:21:19.000Z")).toContain("2026-08-26T20:21:19.000Z");
    expect(displayTime("not-a-time")).toBe("Unavailable");
  });
});
