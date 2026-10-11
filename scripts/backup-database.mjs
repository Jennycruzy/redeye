import { chmod, mkdir, readdir, stat, statfs, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import "./load-env.mjs";

const source = resolve(process.env.REDEYE_DB_PATH ?? ".redeye/redeye.sqlite");
const backupRoot = resolve(process.env.REDEYE_BACKUP_ROOT ?? "../redeye-data/backups");
const keepDays = Number(process.env.REDEYE_BACKUP_KEEP_DAYS ?? "14");
if (!Number.isInteger(keepDays) || keepDays < 1)
  throw new Error("Backup retention must be positive.");

await stat(source);
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await chmod(backupRoot, 0o700);
const stamp = new Date().toISOString().replaceAll(":", "_").replaceAll(".", "_");
const target = resolve(backupRoot, `redeye-${stamp}.sqlite`);
const escaped = target.replaceAll("'", "''");
const database = new DatabaseSync(source);
try {
  const check = database.prepare("PRAGMA quick_check").get();
  if (check?.quick_check !== "ok") throw new Error("SQLite quick_check failed.");
  database.exec(`VACUUM INTO '${escaped}'`);
} finally {
  database.close();
}
await chmod(target, 0o600);

const cutoff = Date.now() - keepDays * 86_400_000;
for (const name of await readdir(backupRoot)) {
  if (!/^redeye-.*\.sqlite$/.test(name)) continue;
  const path = resolve(backupRoot, name);
  if (dirname(path) !== backupRoot) continue;
  if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
}
const filesystem = await statfs(backupRoot);
const usedPct = Number(
  ((1 - Number(filesystem.bavail) / Number(filesystem.blocks)) * 100).toFixed(1)
);
console.log(
  JSON.stringify({
    state: usedPct >= 85 ? "backed_up_disk_warning" : "backed_up",
    target,
    keepDays,
    diskUsedPct: usedPct
  })
);
