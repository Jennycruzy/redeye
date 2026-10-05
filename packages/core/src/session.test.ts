import { describe, expect, it } from "vitest";
import { nextWindow, nyseSessionAt } from "./session.js";

function utc(value: string): number {
  return Date.parse(`${value}Z`);
}

describe("NYSE session clock", () => {
  it("handles regular, pre-market, post-market and overnight periods", () => {
    expect(nyseSessionAt(utc("2026-10-05T13:00:00")).period).toBe("premarket");
    expect(nyseSessionAt(utc("2026-10-05T14:00:00")).period).toBe("regular");
    expect(nyseSessionAt(utc("2026-10-05T21:00:00")).period).toBe("postmarket");
    expect(nyseSessionAt(utc("2026-10-06T01:00:00")).period).toBe("overnight");
  });

  it("recognizes the observed Independence Day holiday", () => {
    const session = nyseSessionAt(utc("2026-07-03T14:00:00"));
    expect(session.period).toBe("closed");
    expect(session.holiday).toBe("Independence Day");
    expect(new Date(session.nextRegularOpenMs).toISOString()).toBe("2026-07-06T13:30:00.000Z");
  });

  it("recognizes the Thanksgiving early close", () => {
    const session = nyseSessionAt(utc("2026-11-27T18:30:00"));
    expect(session.period).toBe("postmarket");
    expect(session.earlyClose).toBe(true);
    expect(new Date(session.regularCloseMs).toISOString()).toBe("2026-11-27T18:00:00.000Z");
  });

  it("tracks daylight-saving time around the November transition", () => {
    const before = nyseSessionAt(utc("2026-10-30T13:30:00"));
    const after = nyseSessionAt(utc("2026-11-02T14:30:00"));
    expect(before.period).toBe("regular");
    expect(after.period).toBe("regular");
    expect(new Date(before.regularOpenMs).toISOString()).toBe("2026-10-30T13:30:00.000Z");
    expect(new Date(after.regularOpenMs).toISOString()).toBe("2026-11-02T14:30:00.000Z");
  });

  it("builds a weeknight window from the close to the next open", () => {
    const window = nextWindow(utc("2026-10-05T15:00:00"));
    expect(window.kind).toBe("overnight");
    expect(new Date(window.closeTs).toISOString()).toBe("2026-10-05T20:00:00.000Z");
    expect(new Date(window.openTs).toISOString()).toBe("2026-10-06T13:30:00.000Z");
  });

  it("builds a Friday-to-Monday weekend window", () => {
    const window = nextWindow(utc("2026-10-09T15:00:00"));
    expect(window.kind).toBe("weekend");
    expect(new Date(window.closeTs).toISOString()).toBe("2026-10-09T20:00:00.000Z");
    expect(new Date(window.openTs).toISOString()).toBe("2026-10-12T13:30:00.000Z");
  });

  it("marks a long weekend with a market holiday as a holiday window", () => {
    const window = nextWindow(utc("2026-09-04T15:00:00"));
    expect(window.kind).toBe("holiday");
    expect(new Date(window.closeTs).toISOString()).toBe("2026-09-04T20:00:00.000Z");
    expect(new Date(window.openTs).toISOString()).toBe("2026-09-08T13:30:00.000Z");
  });

  it("uses the early close and crosses the daylight-saving weekend", () => {
    const early = nextWindow(utc("2026-11-27T16:00:00"));
    expect(early.kind).toBe("weekend");
    expect(new Date(early.closeTs).toISOString()).toBe("2026-11-27T18:00:00.000Z");

    const dst = nextWindow(utc("2026-10-30T15:00:00"));
    expect(new Date(dst.closeTs).toISOString()).toBe("2026-10-30T20:00:00.000Z");
    expect(new Date(dst.openTs).toISOString()).toBe("2026-11-02T14:30:00.000Z");
  });
});
