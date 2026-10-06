import { describe, expect, it } from "vitest";
import { buildUpcomingWindows, WindowService } from "./window-service.js";

function utc(value: string): number {
  return Date.parse(`${value}Z`);
}

describe("source-backed window service", () => {
  it("builds the next shared weekend window with an explicit schedule source", () => {
    const windows = buildUpcomingWindows(["NVDA", "TSLA"], utc("2026-10-09T15:00:00"));
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      ticker: "NVDA",
      kind: "weekend",
      lockTs: utc("2026-10-09T20:00:00"),
      openTs: utc("2026-10-12T13:30:00"),
      scheduleSource: {
        name: "NYSE calendar in @redeye/core",
        recordPath: "code:@redeye/core/session"
      }
    });
    expect(windows[0]?.eventKey).not.toBe(windows[1]?.eventKey);
    expect(windows[0]?.generatedAt).toBe("2026-10-09T15:00:00.000Z");
  });

  it("refreshes and stops without leaving a timer behind", async () => {
    const saved: string[] = [];
    const service = new WindowService({
      tickers: ["NVDA"],
      now: () => utc("2026-10-05T15:00:00"),
      saveWindow: async (window) => {
        saved.push(window.eventKey);
      }
    });
    await service.start(1_000);
    service.stop();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toBeTypeOf("string");
  });
});
