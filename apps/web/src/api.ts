export interface ApiError {
  error?: { code?: string; reason?: string };
}

export interface AgentClient {
  health(): Promise<unknown>;
  study(): Promise<unknown>;
  prices(): Promise<unknown>;
  record(): Promise<unknown>;
  feed(): Promise<unknown>;
  calendar(): Promise<unknown>;
}

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_AGENT_URL ?? "";
  return `${base.replace(/\/$/, "")}${path}`;
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(apiUrl(path), { headers: { accept: "application/json" } });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`The agent returned a non-JSON response for ${path}.`);
  }
  if (!response.ok) {
    const error = body as ApiError;
    throw new Error(
      error.error?.reason ?? `The agent returned HTTP ${response.status} for ${path}.`
    );
  }
  return body;
}

export const agentClient: AgentClient = {
  health: () => get("/health"),
  study: () => get("/study"),
  prices: () => get("/prices"),
  record: () => get("/record"),
  feed: () => get("/feed"),
  calendar: () => get("/calendar?days=21")
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asItems(value: unknown): Array<Record<string, unknown>> {
  if (!isObject(value) || !Array.isArray(value.items)) return [];
  return value.items.filter(isObject);
}

export function displayValue(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "Unavailable";
}

export function displayTime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "Unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return `${date.toLocaleString()} (${date.toISOString()})`;
}
