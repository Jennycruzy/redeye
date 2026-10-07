// In-memory stand-in for node:sqlite, which Vitest cannot load.
export class FakeDatabase {
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
