import {
  expandStandingPlan,
  lockStandingCopy,
  stopStandingRun,
  type Refusal,
  type StandingPlanRun,
  type StandingQuota,
  type StandingWindowCopy
} from "@redeye/core";

const DEFAULT_STANDING_INTERVAL_MS = 60_000;

export interface StandingCopySnapshot {
  v: 1;
  runId: string;
  sequence: number;
  status: "scheduled" | "locked" | "refused";
  event: StandingWindowCopy["event"];
  plan: StandingWindowCopy["plan"];
  lockByMs: number;
  observedAt: string;
  lockedAtMs: number | null;
  refusal: Refusal | null;
}

export interface StandingServiceOptions {
  run: StandingPlanRun;
  saveCopy: (snapshot: StandingCopySnapshot) => Promise<void>;
  now?: () => number;
  quota?: (copy: StandingWindowCopy) => Promise<StandingQuota | undefined>;
}

export class StandingService {
  private runState: StandingPlanRun;
  private readonly saveCopy: (snapshot: StandingCopySnapshot) => Promise<void>;
  private readonly now: () => number;
  private readonly quota:
    ((copy: StandingWindowCopy) => Promise<StandingQuota | undefined>) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StandingServiceOptions) {
    this.runState = options.run;
    this.saveCopy = options.saveCopy;
    this.now = options.now ?? Date.now;
    this.quota = options.quota;
  }

  get run(): StandingPlanRun {
    return this.runState;
  }

  async refresh(): Promise<StandingCopySnapshot[]> {
    const atMs = this.now();
    if (!Number.isFinite(atMs)) throw new Error("Standing service time must be finite.");
    const observedAt = new Date(atMs).toISOString();
    const snapshots: StandingCopySnapshot[] = [];
    for (const copy of expandStandingPlan(this.runState)) {
      if (atMs < copy.lockByMs) {
        const snapshot: StandingCopySnapshot = {
          v: 1,
          runId: copy.runId,
          sequence: copy.sequence,
          status: "scheduled",
          event: copy.event,
          plan: copy.plan,
          lockByMs: copy.lockByMs,
          observedAt,
          lockedAtMs: null,
          refusal: null
        };
        snapshots.push(snapshot);
        await this.saveCopy(snapshot);
        continue;
      }

      const quota = this.quota === undefined ? undefined : await this.quota(copy);
      const locked = lockStandingCopy(copy, atMs, quota);
      const snapshot: StandingCopySnapshot = {
        v: 1,
        runId: copy.runId,
        sequence: copy.sequence,
        status: locked.status,
        event: copy.event,
        plan: copy.plan,
        lockByMs: copy.lockByMs,
        observedAt,
        lockedAtMs: locked.lockedAtMs,
        refusal: locked.refusal
      };
      snapshots.push(snapshot);
      await this.saveCopy(snapshot);
    }
    return snapshots;
  }

  async start(intervalMs = DEFAULT_STANDING_INTERVAL_MS): Promise<() => void> {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
      throw new Error("Standing interval is too short.");
    }
    if (this.timer !== null) throw new Error("Standing service is already running.");
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            code: "STANDING_REFRESH_FAILED",
            reason: error instanceof Error ? error.message : String(error)
          })
        );
      });
    }, intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  cancel(atMs = this.now()): void {
    this.runState = stopStandingRun(this.runState, atMs);
  }
}
