import { describe, expect, it } from "vitest";
import { createStandingRun, type PlanContext } from "@redeye/core";
import { StandingService } from "./standing-service.js";

function utc(value: string): number {
  return Date.parse(`${value}Z`);
}

const template: PlanContext = {
  kind: "hold",
  ticker: "NVDA",
  wrapper: "bStock",
  tokenAddress: "0x0000000000000000000000000000000000000001",
  heldShares: "1",
  params: { maxPriceImpactPct: "1", minPoolDepthUsd: "50000" }
};

describe("standing plan scheduler", () => {
  it("keeps future copies scheduled and locks the copy at the ten-minute boundary", async () => {
    const run = createStandingRun({
      runId: "standing-service-1",
      template,
      startAtMs: utc("2026-10-05T15:00:00"),
      untilTs: utc("2026-10-07T00:00:00")
    });
    const saved: string[] = [];
    const service = new StandingService({
      run,
      now: () => utc("2026-10-05T19:50:00"),
      saveCopy: async (snapshot) => {
        saved.push(`${snapshot.sequence}:${snapshot.status}`);
      }
    });

    const snapshots = await service.refresh();
    expect(snapshots.map((snapshot) => snapshot.status)).toEqual(["locked", "scheduled"]);
    expect(saved).toEqual(["0:locked", "1:scheduled"]);
  });

  it("uses the per-window quota and publishes a missed lock", async () => {
    const run = createStandingRun({
      runId: "standing-service-2",
      template,
      startAtMs: utc("2026-10-05T15:00:00"),
      untilTs: utc("2026-10-07T00:00:00")
    });
    const saved: Array<{ sequence: number; status: string; code: string | null }> = [];
    const service = new StandingService({
      run,
      now: () => utc("2026-10-05T19:50:01"),
      quota: async () => ({ remainingUsd: "0", requiredUsd: "25" }),
      saveCopy: async (snapshot) => {
        saved.push({
          sequence: snapshot.sequence,
          status: snapshot.status,
          code: snapshot.refusal?.code ?? null
        });
      }
    });

    const snapshots = await service.refresh();
    expect(snapshots[0]?.status).toBe("refused");
    expect(snapshots[0]?.refusal?.code).toBe("LOCK_MISSED");
    expect(saved[0]).toEqual({ sequence: 0, status: "refused", code: "LOCK_MISSED" });
  });

  it("stops future copies while leaving already lockable windows in the run", async () => {
    const run = createStandingRun({
      runId: "standing-service-3",
      template,
      startAtMs: utc("2026-10-05T15:00:00"),
      untilTs: utc("2026-10-08T00:00:00")
    });
    const service = new StandingService({
      run,
      now: () => utc("2026-10-06T19:40:00"),
      saveCopy: async () => undefined
    });
    service.cancel(utc("2026-10-06T19:55:00"));
    const snapshots = await service.refresh();
    expect(snapshots).toHaveLength(2);
  });
});
