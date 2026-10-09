/** Formatting shared by every screen: money, percentages, ages, New York and local times. */

const NY = "America/New_York";

export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function usd(value: string | number | null | undefined, digits = 2): string {
  const n = num(value);
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function plain(value: string | number | null | undefined, digits = 2): string {
  const n = num(value);
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

/** Signed percentage change from `base` to `value`, e.g. "+0.27%". */
export function changePct(value: number | null, base: number | null): number | null {
  if (value === null || base === null || base === 0) return null;
  return ((value - base) / base) * 100;
}

export function pct(value: number | null, digits = 2, signed = true): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const text = Math.abs(value).toFixed(digits);
  if (!signed) return `${text}%`;
  if (Number(text) === 0) return `0.${"0".repeat(digits)}%`;
  return `${value > 0 ? "+" : "−"}${text}%`;
}

export function shortHash(hash: string | null | undefined, keep = 6): string {
  if (!hash) return "—";
  return `${hash.slice(0, keep + 2)}…${hash.slice(-4)}`;
}

/** "14s", "3 min", "2 h 5 min", "3 days". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  return `${Math.floor(hours / 24)} days`;
}

export function ago(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return "—";
  const at = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  return `${duration(now - at)} ago`;
}

function parts(atMs: number, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { ...options, ...(timeZone ? { timeZone } : {}) }).format(
    new Date(atMs)
  );
}

/** "16:00" in New York. */
export function nyClock(atMs: number, seconds = false): string {
  return parts(
    atMs,
    {
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      hourCycle: "h23"
    },
    NY
  );
}

/** "Thu 8 Oct, 16:00 New York". */
export function nyStamp(atMs: number): string {
  const day = parts(atMs, { weekday: "short", day: "numeric", month: "short" }, NY);
  return `${day}, ${nyClock(atMs)} New York`;
}

/** "Thu 8 Oct, 21:00" in the reader's own time zone. */
export function localStamp(atMs: number): string {
  return parts(atMs, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
}

export function utcStamp(atMs: number): string {
  return `${new Date(atMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function windowName(kind: string): string {
  if (kind === "weekend") return "Weekend";
  if (kind === "holiday") return "Holiday";
  return "Overnight";
}

export function kindName(kind: string): string {
  switch (kind) {
    case "guard":
      return "Guard";
    case "buy_dip":
      return "Buy the dip";
    case "sell_rise":
      return "Sell the rise";
    case "hold":
      return "Hold";
    default:
      return kind;
  }
}

export const BSCSCAN = "https://bscscan.com";
export const txUrl = (hash: string) => `${BSCSCAN}/tx/${hash}`;
export const addressUrl = (address: string) => `${BSCSCAN}/address/${address}`;

/** A refusal or reason code in plain words. */
export function reasonWords(code: string | null | undefined): string {
  switch (code) {
    case "CONDITION_NOT_MET":
      return "The price never reached the trigger, so nothing was done.";
    case "EXECUTION_DISABLED":
      return "The trigger was hit, but trading was switched off for this plan.";
    case "ORDER_FAILED":
      return "The wallet's order failed, so no trade happened.";
    case "LOCK_MISSED":
      return "This night's copy was not locked before the close.";
    case "REAL_PRICE_UNAVAILABLE":
      return "The 24/7 price was missing or stale, so the agent refused to act.";
    case "SESSION_EXPIRING":
      return "The wallet session would end before the open.";
    case "QUOTA_LOW":
      return "The wallet's daily limit had too little room left.";
    default:
      return code ? code.replace(/_/g, " ").toLowerCase() : "";
  }
}
