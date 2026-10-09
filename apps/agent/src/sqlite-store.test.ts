import { describe, expect, it } from "vitest";
import { FakeDatabase } from "./fake-database.js";
import { SqliteAgentStore } from "./sqlite-store.js";

describe("SQLite agent store boundary", () => {
  it("returns explicit empty states and persists drafts and replays", async () => {
    const store = new SqliteAgentStore(new FakeDatabase(), "/path/that/does/not/exist");
    expect(await store.health()).toMatchObject({
      state: "degraded",
      code: "HEALTH_SNAPSHOT_MISSING"
    });
    expect(await store.calendar(21)).toMatchObject({ state: "empty", items: [] });
    expect(await store.study()).toMatchObject({ state: "empty" });
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

  it("persists scheduled windows in the calendar and ticker view", async () => {
    const store = new SqliteAgentStore(new FakeDatabase());
    await store.recordWindow({
      v: 1,
      ticker: "NVDA",
      eventKey: "0xwindow",
      kind: "overnight",
      lockTs: 1,
      openTs: 2
    });
    await expect(store.calendar(21)).resolves.toMatchObject({
      state: "ok",
      items: [{ ticker: "NVDA", kind: "overnight" }]
    });
    await expect(store.windows("NVDA")).resolves.toMatchObject({
      state: "ok",
      ticker: "NVDA",
      items: [{ eventKey: "0xwindow" }]
    });
  });

  it("keeps sponsored passkey claims durable and bounded per UTC day", () => {
    const store = new SqliteAgentStore(new FakeDatabase());
    expect(store.claimPasskeySponsor("42", "2026-10-09", "0xaccount-a", 2)).toBe(true);
    expect(store.claimPasskeySponsor("42", "2026-10-09", "0xaccount-b", 2)).toBe(false);
    expect(store.claimPasskeySponsor("43", "2026-10-09", "0xaccount-c", 2)).toBe(true);
    expect(store.claimPasskeySponsor("44", "2026-10-09", "0xaccount-d", 2)).toBe(false);
    store.releasePasskeySponsor("42", "2026-10-09", "0xaccount-a");
    expect(store.claimPasskeySponsor("44", "2026-10-09", "0xaccount-d", 2)).toBe(true);
    expect(store.claimPasskeySponsor("42", "2026-10-10", "0xaccount-a", 2)).toBe(true);
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
