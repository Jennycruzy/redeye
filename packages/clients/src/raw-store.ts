import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SourceRecord } from "@redeye/shared";

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export async function storeRawRecord<T>(
  rootDir: string,
  source: string,
  record: SourceRecord<T>
): Promise<string> {
  const date = record.fetchedAt.slice(0, 10);
  const directory = resolve(rootDir, "raw", safePart(source), date);
  await mkdir(directory, { recursive: true });
  const filename = `${safePart(record.fetchedAt)}.json`;
  const path = join(directory, filename);
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  return relative(resolve(rootDir), path);
}
