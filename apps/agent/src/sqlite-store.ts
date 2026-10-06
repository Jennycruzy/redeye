import { randomUUID } from "node:crypto";
import type { AgentStore } from "./types.js";

interface SqliteStatement {
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  run(...parameters: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export class StoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.status = status;
    this.code = code;
  }
}

function objectBody(body: unknown, field: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new StoreError(400, "INVALID_BODY", `${field} must be a JSON object.`);
  }
  return body as Record<string, unknown>;
}

function jsonPayload(row: Record<string, unknown> | undefined): unknown | null {
  if (row === undefined) return null;
  if (typeof row.payload !== "string")
    throw new StoreError(500, "STORE_CORRUPT", "Stored payload is not text.");
  try {
    return JSON.parse(row.payload);
  } catch {
    throw new StoreError(500, "STORE_CORRUPT", "Stored payload is not valid JSON.");
  }
}

function sourceRows(rows: Array<Record<string, unknown>>): unknown[] {
  return rows.map((row) => jsonPayload(row)).filter((value): value is unknown => value !== null);
}

export class SqliteAgentStore implements AgentStore {
  constructor(private readonly database: SqliteDatabase) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        kind TEXT NOT NULL,
        document_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, document_key)
      );
      CREATE INDEX IF NOT EXISTS documents_kind_created_idx
        ON documents (kind, created_at);
    `);
  }

  close(): void {
    this.database.close();
  }

  private put(kind: string, key: string, payload: unknown): void {
    this.database
      .prepare(
        `INSERT INTO documents(kind, document_key, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, document_key) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at`
      )
      .run(kind, key, JSON.stringify(payload), new Date().toISOString());
  }

  private one(kind: string, key: string): unknown | null {
    return jsonPayload(
      this.database
        .prepare("SELECT payload FROM documents WHERE kind = ? AND document_key = ?")
        .get(kind, key)
    );
  }

  private many(kind: string): unknown[] {
    return sourceRows(
      this.database
        .prepare("SELECT payload FROM documents WHERE kind = ? ORDER BY created_at ASC")
        .all(kind)
    );
  }

  async health(): Promise<unknown> {
    return (
      this.one("health", "current") ?? {
        state: "degraded",
        code: "HEALTH_SNAPSHOT_MISSING",
        reason: "No source-backed health snapshot has been recorded yet."
      }
    );
  }

  async calendar(days: number): Promise<unknown> {
    const items = [...this.many("event"), ...this.many("window")];
    return items.length === 0
      ? {
          state: "empty",
          days,
          items: [],
          reason: "No source-backed calendar events have been recorded yet."
        }
      : { state: "ok", days, items };
  }

  async prices(tickers: string[]): Promise<unknown> {
    const requested = new Set(tickers.map((ticker) => ticker.toUpperCase()));
    const items = this.many("price").filter((value) => {
      if (requested.size === 0) return true;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const ticker = (value as Record<string, unknown>).ticker;
      return typeof ticker === "string" && requested.has(ticker.toUpperCase());
    });
    return items.length === 0
      ? {
          state: "empty",
          tickers,
          items: [],
          reason: "No source-backed price snapshots have been recorded yet."
        }
      : { state: "ok", tickers, items };
  }

  async windows(ticker: string): Promise<unknown> {
    const normalized = ticker.toUpperCase();
    const items = this.many("window").filter((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      return (value as Record<string, unknown>).ticker === normalized;
    });
    return items.length === 0
      ? {
          state: "empty",
          ticker: normalized,
          items: [],
          reason: "No source-backed off-hours windows have been recorded yet."
        }
      : { state: "ok", ticker: normalized, items };
  }

  async recordPriceSnapshot(snapshot: unknown): Promise<void> {
    const input = objectBody(snapshot, "price snapshot");
    if (typeof input.ticker !== "string" || input.ticker.trim().length === 0) {
      throw new StoreError(400, "TICKER_REQUIRED", "A price snapshot requires a ticker.");
    }
    this.put("price", input.ticker.toUpperCase(), input);
  }

  async recordHealthSnapshot(snapshot: unknown): Promise<void> {
    this.put("health", "current", snapshot);
  }

  async recordWindow(window: unknown): Promise<void> {
    const input = objectBody(window, "window");
    if (typeof input.ticker !== "string" || input.ticker.trim().length === 0) {
      throw new StoreError(400, "TICKER_REQUIRED", "A window requires a ticker.");
    }
    if (typeof input.eventKey !== "string" || input.eventKey.trim().length === 0) {
      throw new StoreError(400, "EVENT_KEY_REQUIRED", "A window requires an event key.");
    }
    this.put("window", `${input.ticker.toUpperCase()}:${input.eventKey}`, input);
  }

  async feed(since: string | null): Promise<unknown> {
    if (since !== null && !Number.isFinite(Date.parse(since))) {
      throw new StoreError(400, "INVALID_SINCE", "since must be an ISO timestamp.");
    }
    const items = this.many("filing");
    return items.length === 0
      ? {
          state: "empty",
          since,
          items: [],
          reason: "No source-backed filings have been recorded yet."
        }
      : { state: "ok", since, items };
  }

  async token(ticker: string): Promise<unknown> {
    const key = ticker.toUpperCase();
    return (
      this.one("token", key) ?? {
        state: "empty",
        ticker: key,
        items: [],
        reason: "No source-backed token snapshot exists for this ticker."
      }
    );
  }

  async history(ticker: string): Promise<unknown> {
    const items = this.many("history").filter((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      return (value as Record<string, unknown>).ticker === ticker.toUpperCase();
    });
    return items.length === 0
      ? {
          state: "empty",
          ticker: ticker.toUpperCase(),
          items: [],
          reason: "No recorded release-night history exists for this ticker."
        }
      : { state: "ok", ticker: ticker.toUpperCase(), items };
  }

  async record(): Promise<unknown> {
    const items = this.many("record");
    return { state: items.length === 0 ? "empty" : "ok", items };
  }

  async wallet(): Promise<unknown> {
    return (
      this.one("wallet", "current") ?? {
        state: "disconnected",
        connected: false,
        reason: "No Agentic Wallet session is connected to this agent."
      }
    );
  }

  async planGet(id: string): Promise<unknown> {
    const plan = this.one("plan", id);
    if (plan === null)
      throw new StoreError(404, "PLAN_NOT_FOUND", "The requested plan does not exist.");
    return plan;
  }

  async run(runId: string): Promise<unknown> {
    const run = this.one("run", runId);
    if (run === null)
      throw new StoreError(404, "RUN_NOT_FOUND", "The requested run does not exist.");
    return run;
  }

  async runEvents(runId: string): Promise<unknown> {
    const items = this.many("run-event").filter((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      return (value as Record<string, unknown>).runId === runId;
    });
    return { state: items.length === 0 ? "empty" : "ok", runId, items };
  }

  async receipt(runId: string): Promise<unknown> {
    const receipt = this.one("receipt", runId);
    if (receipt === null)
      throw new StoreError(404, "RECEIPT_NOT_FOUND", "The requested receipt does not exist.");
    return receipt;
  }

  async replay(body: unknown): Promise<unknown> {
    const input = objectBody(body, "replay body");
    const runId = randomUUID();
    const run = {
      v: 1,
      runId,
      state: "REPLAY",
      createdAt: new Date().toISOString(),
      input
    };
    this.put("run", runId, run);
    this.put("run-event", `${runId}:created`, {
      runId,
      state: "REPLAY",
      step: "created",
      at: run.createdAt
    });
    return run;
  }

  async authSignin(body: unknown): Promise<unknown> {
    void body;
    throw new StoreError(
      503,
      "WALLET_AUTH_NOT_CONFIGURED",
      "Agentic Wallet sign-in is not configured on this agent."
    );
  }

  async authVerify(qrCodeId: string): Promise<unknown> {
    void qrCodeId;
    throw new StoreError(
      503,
      "WALLET_AUTH_NOT_CONFIGURED",
      "Agentic Wallet sign-in is not configured on this agent."
    );
  }

  async planDraft(body: unknown): Promise<unknown> {
    const input = objectBody(body, "plan body");
    if (typeof input.ticker !== "string" || input.ticker.trim().length === 0) {
      throw new StoreError(400, "TICKER_REQUIRED", "A plan draft requires a ticker.");
    }
    const id = randomUUID();
    const draft = {
      v: 1,
      id,
      status: "draft",
      createdAt: new Date().toISOString(),
      input
    };
    this.put("plan", id, draft);
    return draft;
  }

  async planAction(id: string, body: unknown): Promise<unknown> {
    void id;
    void body;
    throw new StoreError(
      503,
      "PLANBOOK_NOT_CONFIGURED",
      "PlanBook and the execution service are not configured on this agent."
    );
  }
}

export async function createSqliteAgentStore(path: string): Promise<SqliteAgentStore> {
  const sqlite = await import("node:sqlite");
  const database = new sqlite.DatabaseSync(path);
  return new SqliteAgentStore(database);
}
