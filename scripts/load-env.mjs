import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export function loadRepositoryEnv(repoRoot) {
  const envPath = resolve(repoRoot, ".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
}
