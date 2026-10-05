import { describe, expect, it } from "vitest";
import { nyseSessionAt } from "./session.js";

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
});
