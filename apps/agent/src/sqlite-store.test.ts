import { describe, expect, it } from "vitest";
import { SqliteAgentStore } from "./sqlite-store.js";

class FakeDatabase {
  private readonly rows = new Map<string, { payload: string; createdAt: string }>();

  exec(sql: string): void {
    void sql;
  }

  prepare(sql: string) {
    return {
      get: (...parameters: unknown[]) => {
        if (!sql.includes("WHERE kind = ? AND document_key = ?")) return undefined;
        const row = this.rows.get(`${parameters[0]}:${parameters[1]}`);
        return row === undefined ? undefined : { payload: row.payload };
      },
      all: (...parameters: unknown[]) => {
        const kind = String(parameters[0]);
        return [...this.rows.entries()]
          .filter(([key]) => key.startsWith(`${kind}:`))
          .sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt))
          .map(([, row]) => ({ payload: row.payload }));
      },
      run: (...parameters: unknown[]) => {
        const key = `${parameters[0]}:${parameters[1]}`;
        this.rows.set(key, { payload: String(parameters[2]), createdAt: String(parameters[3]) });
      }
    };
  }

  close(): void {}
}

describe("SQLite agent store boundary", () => {
  it("returns explicit empty states and persists drafts and replays", async () => {
    const store = new SqliteAgentStore(new FakeDatabase());
    expect(await store.health()).toMatchObject({
      state: "degraded",
      code: "HEALTH_SNAPSHOT_MISSING"
    });
    expect(await store.calendar(21)).toMatchObject({ state: "empty", items: [] });
    expect(await store.wallet()).toMatchObject({ state: "disconnected", connected: false });

    const draft = (await store.planDraft({ ticker: "NVDA", kind: "hold" })) as {
      id: string;
      status: string;
    };
    expect(draft.status).toBe("draft");
    expect(await store.planGet(draft.id)).toMatchObject({ id: draft.id, status: "draft" });

    const replay = (await store.replay({ event: "NVDA-2026-08-26" })) as {
      runId: string;
      state: string;
    };
    expect(replay.state).toBe("REPLAY");
    expect(await store.run(replay.runId)).toMatchObject({ runId: replay.runId, state: "REPLAY" });
    expect(await store.runEvents(replay.runId)).toMatchObject({ state: "ok", runId: replay.runId });
  });

  it("fails writes that would imply an unconfigured live wallet or PlanBook", async () => {
    const store = new SqliteAgentStore(new FakeDatabase());
    await expectStoreFailure(() => store.authSignin({}), "WALLET_AUTH_NOT_CONFIGURED");
    await expectStoreFailure(
      () => store.planAction("1", { action: "freeze" }),
      "PLANBOOK_NOT_CONFIGURED"
    );
  });

  it("persists source-backed price and health snapshots", async () => {
    const store = new SqliteAgentStore(new FakeDatabase());
    await store.recordPriceSnapshot({
      v: 1,
      state: "ok",
      ticker: "NVDA",
      at: "2026-10-06T02:00:00.000Z"
    });
    await expect(store.prices(["NVDA"])).resolves.toMatchObject({
      state: "ok",
      tickers: ["NVDA"],
      items: [{ ticker: "NVDA" }]
    });

    await store.recordHealthSnapshot({ v: 1, state: "ok", passes: 1 });
    await expect(store.health()).resolves.toMatchObject({ v: 1, state: "ok", passes: 1 });
  });
});

async function expectStoreFailure(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
    throw new Error("operation unexpectedly succeeded");
  } catch (error) {
    expect(error).toMatchObject({ code, status: 503 });
  }
}
