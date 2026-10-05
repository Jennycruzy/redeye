import { describe, expect, it } from "vitest";
import {
  createEventRecord,
  createWindowRecord,
  earliestPublicSourceMs,
  freezeIsBeforeLock,
  freezeIsBeforeRelease
} from "./events.js";

const sources = [
  {
    name: "edgar",
    form: "8-K",
    seenAt: "2026-08-26T20:21:19.000Z",
    fetchedAt: "2026-08-26T20:21:20.000Z",
    recordPath: "raw/sec/2026-08-26/submissions.json"
  },
  {
    name: "issuer",
    seenAt: "2026-08-26T20:20:00.000Z",
    fetchedAt: "2026-08-26T20:20:01.000Z",
    recordPath: "raw/issuer/2026-08-26/release.json"
  }
];

describe("source-backed events", () => {
  it("uses the earliest observed source as release time", () => {
    const event = createEventRecord({
      ticker: "NVDA",
      kind: "earnings",
      issuerCik: "0001045810",
      expectedDate: "2026-08-26",
      sources,
      consensus: { eps: "1.01", basis: "adjusted diluted USD per share", noOfEsts: 12 }
    });

    expect(event.releaseTs).toBe(Date.parse("2026-08-26T20:20:00.000Z"));
    expect(event.sources).toHaveLength(2);
    expect(event.eventKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps the feed empty rather than inventing a release time", () => {
    expect(earliestPublicSourceMs([])).toBeNull();
    const event = createEventRecord({
      ticker: "TSM",
      kind: "scheduled_report",
      issuerCik: "0001046179",
      expectedDate: "2026-10-09",
      sources: [],
      consensus: null
    });
    expect(event.releaseTs).toBeNull();
    expect(() => freezeIsBeforeRelease(1_000, event)).toThrow("release time was observed");
  });

  it("checks the block timestamp against the earliest public source", () => {
    const event = createEventRecord({
      ticker: "NVDA",
      kind: "earnings",
      issuerCik: "0001045810",
      expectedDate: "2026-08-26",
      sources,
      consensus: null
    });
    expect(freezeIsBeforeRelease(Date.parse("2026-08-26T20:19:59.000Z"), event)).toBe(true);
    expect(freezeIsBeforeRelease(Date.parse("2026-08-26T20:20:00.000Z"), event)).toBe(false);
  });

  it("creates off-hours windows without an issuer or a release source", () => {
    const closeTs = Date.parse("2026-10-09T20:00:00.000Z");
    const openTs = Date.parse("2026-10-12T13:30:00.000Z");
    const event = createWindowRecord("weekend", "NVDA", closeTs, openTs);

    expect(event.issuerCik).toBeNull();
    expect(event.releaseTs).toBeNull();
    expect(event.lockTs).toBe(closeTs);
    expect(event.openTs).toBe(openTs);
    expect(event.eventKey).toBeDefined();
    expect(freezeIsBeforeLock(closeTs - 1, event)).toBe(true);
    expect(freezeIsBeforeLock(closeTs, event)).toBe(false);
  });
});
