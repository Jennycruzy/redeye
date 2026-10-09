// In-memory stand-in for node:sqlite, which Vitest cannot load.
export class FakeDatabase {
  private readonly rows = new Map<string, { payload: string; createdAt: string }>();

  exec(sql: string): void {
    void sql;
  }

  prepare(sql: string) {
    return {
      get: (...parameters: unknown[]) => {
        if (sql.includes("SELECT COUNT(*) AS count FROM documents")) {
          const kind = String(parameters[0]);
          const prefix = String(parameters[1]).replace("%", "");
          const count = [...this.rows.keys()].filter(
            (key) => key.startsWith(`${kind}:`) && key.slice(kind.length + 1).startsWith(prefix)
          ).length;
          return { count };
        }
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
        if (sql.includes("DELETE FROM documents")) {
          this.rows.delete(`${parameters[0]}:${parameters[1]}`);
          return;
        }
        const key = `${parameters[0]}:${parameters[1]}`;
        this.rows.set(key, { payload: String(parameters[2]), createdAt: String(parameters[3]) });
      }
    };
  }

  close(): void {}
}
