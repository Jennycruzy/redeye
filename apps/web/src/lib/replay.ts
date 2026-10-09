import { nextWindow } from "@redeye/core";
import type { NightTrace } from "./api";

export type ReplayKind = "guard" | "buy_dip" | "sell_rise";

const SEVEN_HOURS_MS = 7 * 3600e3;

/** The close of the last window that has fully finished, so a replay never shows half a night. */
export function lastFinishedClose(now: number): number {
  const upcoming = nextWindow(now);
  const running =
    upcoming.closeTs <= now ? upcoming : nextWindow(upcoming.closeTs - SEVEN_HOURS_MS);
  return running.openTs <= now
    ? running.closeTs
    : nextWindow(running.closeTs - SEVEN_HOURS_MS).closeTs;
}

/** When, in a recorded night, the 24/7 price first crossed a plan's trigger, and how close it came. */
export function replayResult(trace: NightTrace, kind: ReplayKind, triggerPct: number) {
  const close = trace.close ? Number(trace.close.value) : null;
  if (close === null || trace.points.length === 0) return null;
  const falling = kind !== "sell_rise";
  const level = falling ? close * (1 - triggerPct / 100) : close * (1 + triggerPct / 100);
  const hit = trace.points.find(([, p]) => (falling ? Number(p) <= level : Number(p) >= level));
  const extreme = trace.points.reduce(
    (best, [, p]) => (falling ? Math.min(best, Number(p)) : Math.max(best, Number(p))),
    falling ? Infinity : -Infinity
  );
  return { close, level, hit: hit ? { at: hit[0], price: Number(hit[1]) } : null, extreme };
}
