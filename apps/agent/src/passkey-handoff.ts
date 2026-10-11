import { createHash, randomBytes } from "node:crypto";
import type { TelegramIdentity } from "./telegram.js";

// Telegram's in-app browser on Android cannot always show a passkey prompt. The bot verifies the
// person inside Telegram, then hands them to the phone's own browser with a short-lived link.
// The link carries a random token; only its hash is stored, it expires, and it is spent once the
// account is created or money is moved, so a copied link cannot be reused.

export class PasskeyHandoffError extends Error {
  readonly status = 401;
  readonly code = "PASSKEY_HANDOFF_INVALID";

  constructor(reason: string) {
    super(reason);
    this.name = "PasskeyHandoffError";
  }
}

export interface HandoffRecord {
  userId: string;
  issuedAt: number;
  expiresAt: number;
  spentAt: number | null;
}

/** Where handoff records live; reads and writes are synchronous so checks cannot interleave. */
export interface HandoffBook {
  get(key: string): HandoffRecord | null;
  put(key: string, record: HandoffRecord): void;
}

export interface PasskeyHandoff {
  /** Issues a link token for a Telegram user whose initData was just verified. */
  issue(identity: TelegramIdentity): { handoff: string; expiresAt: number };
  /** The Telegram user behind a live, unspent token. */
  identity(handoff: string): TelegramIdentity;
  /** Spends the token after the account was created or money moved. */
  spend(handoff: string): void;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function keyOf(handoff: string): string {
  return createHash("sha256").update(handoff).digest("hex");
}

export function createPasskeyHandoff(
  book: HandoffBook,
  options: { ttlMs?: number; now?: () => number; random?: () => Buffer } = {}
): PasskeyHandoff {
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => randomBytes(32));

  function live(handoff: string): { key: string; record: HandoffRecord } {
    if (!TOKEN.test(handoff)) throw new PasskeyHandoffError("This sign-in link is not valid.");
    const key = keyOf(handoff);
    const record = book.get(key);
    if (record === null) throw new PasskeyHandoffError("This sign-in link is not valid.");
    if (record.spentAt !== null)
      throw new PasskeyHandoffError(
        "This sign-in link was already used. Open Redeye from Telegram again."
      );
    if (now() > record.expiresAt)
      throw new PasskeyHandoffError(
        "This sign-in link has expired. Open Redeye from Telegram again."
      );
    return { key, record };
  }

  return {
    issue(identity) {
      const handoff = random().toString("base64url");
      const issuedAt = now();
      const expiresAt = issuedAt + ttlMs;
      book.put(keyOf(handoff), { userId: identity.userId, issuedAt, expiresAt, spentAt: null });
      return { handoff, expiresAt };
    },
    identity(handoff) {
      const { record } = live(handoff);
      return { userId: record.userId, authDate: Math.floor(record.issuedAt / 1000), queryId: null };
    },
    spend(handoff) {
      const { key, record } = live(handoff);
      book.put(key, { ...record, spentAt: now() });
    }
  };
}
