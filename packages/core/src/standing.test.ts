import { describe, expect, it } from "vitest";
import {
  createStandingRun,
  expandStandingPlan,
  lockStandingCopy,
  stopStandingRun
} from "./standing.js";
import type { PlanContext } from "./types.js";

function utc(value: string): number {
  return Date.parse(`${value}Z`);
}

const template: PlanContext = {
  kind: "hold",
  ticker: "NVDA",
  wrapper: "bStock",
  tokenAddress: "0x0000000000000000000000000000000000000001",
  heldShares: "1",
  params: {
    maxPriceImpactPct: "1",
    minPoolDepthUsd: "50000"
  }
};

describe("standing off-hours plans", () => {
  it("expands three windows with one event and plan copy per close", () => {
    const run = createStandingRun({
      runId: "standing-1",
      template,
      startAtMs: utc("2026-10-05T15:00:00"),
      untilTs: utc("2026-10-08T00:00:00")
    });
    const copies = expandStandingPlan(run);

    expect(copies).toHaveLength(3);
    expect(copies.map((copy) => copy.event.kind)).toEqual(["overnight", "overnight", "overnight"]);
    expect(copies.map((copy) => copy.event.expectedDate)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07"
    ]);
    expect(copies[0]?.plan.standingRunId).toBe("standing-1");
    expect(new Date(copies[0]?.lockByMs ?? 0).toISOString()).toBe("2026-10-05T19:50:00.000Z");
    expect(copies[0]?.event.eventKey).not.toBe(copies[1]?.event.eventKey);
  });

  it("includes a holiday window and stops before future copies after cancellation", () => {
    const run = createStandingRun({
      runId: "standing-2",
      template,
      startAtMs: utc("2026-09-04T15:00:00"),
      untilTs: utc("2026-09-10T00:00:00")
    });
    const stopped = stopStandingRun(run, utc("2026-09-04T20:00:00"));
    const copies = expandStandingPlan(stopped);

    expect(copies).toHaveLength(1);
    expect(copies[0]?.event.kind).toBe("holiday");
    expect(copies[0]?.event.expectedDate).toBe("2026-09-04");
  });

  it("publishes a missed copy and reserves limits one window at a time", () => {
    const run = createStandingRun({
      runId: "standing-3",
      template,
      startAtMs: utc("2026-10-05T15:00:00"),
      untilTs: utc("2026-10-07T00:00:00")
    });
    const [first, second] = expandStandingPlan(run);
    if (first === undefined || second === undefined)
      throw new Error("standing fixtures are incomplete");

    const locked = lockStandingCopy(first, first.lockByMs, {
      remainingUsd: "25",
      requiredUsd: "25"
    });
    expect(locked.status).toBe("locked");
    expect(locked.remainingUsd).toBe("0");

    const lowQuota = lockStandingCopy(second, second.lockByMs, {
      remainingUsd: "0",
      requiredUsd: "25"
    });
    expect(lowQuota.refusal?.code).toBe("QUOTA_LOW");

    const missed = lockStandingCopy(first, first.lockByMs + 1);
    expect(missed.refusal?.code).toBe("LOCK_MISSED");
    expect(missed.refusal?.sentence).toBe(
      "This window's copy wasn't locked before the close, so it didn't run."
    );
  });

  it("rejects a standing run longer than thirty days", () => {
    expect(() =>
      createStandingRun({
        runId: "standing-long",
        template,
        startAtMs: utc("2026-10-05T15:00:00"),
        untilTs: utc("2026-11-05T15:00:01")
      })
    ).toThrow("at most 30 days");
  });
});
