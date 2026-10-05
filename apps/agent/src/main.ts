import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSqliteAgentStore } from "./sqlite-store.js";
import { startAgentServer } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

const databasePath = process.env.REDEYE_DB_PATH ?? ".redeye/redeye.sqlite";
const port = Number(process.env.AGENT_PORT ?? "8787");
const ownerToken = required("OWNER_API_TOKEN");
const siteOrigin = required("WEB_ORIGIN");
mkdirSync(dirname(databasePath), { recursive: true });
const store = await createSqliteAgentStore(databasePath);
const server = startAgentServer(store, { ownerToken, siteOrigin }, port);

const shutdown = (): void => {
  server.close(() => store.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(JSON.stringify({ status: "listening", port, databasePath }));
