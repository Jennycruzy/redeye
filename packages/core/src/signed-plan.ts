/**
 * A plan signed by its owner's wallet. The owner signs this EIP-712 message in their own
 * wallet, which shows the promise word for word; the agent checks the signature, then locks
 * the plan in PlanBook under the owner's address and pays the gas. Signing moves no funds.
 */

export const SIGNED_PLAN_DOMAIN = {
  name: "Redeye",
  version: "1",
  chainId: 56,
  verifyingContract: "0xC7B860d561f2208c725ac9a873bf4eA5205e9057"
} as const;

export const SIGNED_PLAN_TYPES = {
  Plan: [
    { name: "promise", type: "string" },
    { name: "owner", type: "address" },
    { name: "ticker", type: "string" },
    { name: "planHash", type: "bytes32" },
    { name: "windowClose", type: "uint64" },
    { name: "issuedAt", type: "uint64" }
  ]
} as const;

export interface SignedPlanMessage {
  promise: string;
  owner: `0x${string}`;
  ticker: string;
  planHash: `0x${string}`;
  /** Seconds: the US close that starts the window this plan is for. */
  windowClose: bigint;
  /** Seconds: when the owner signed; the agent accepts it for a short time only. */
  issuedAt: bigint;
}

/** How long a signature stays usable after it was made. */
export const SIGNED_PLAN_MAX_AGE_S = 10 * 60;

export function signedPlanMessage(fields: {
  promise: string;
  owner: `0x${string}`;
  ticker: string;
  planHash: `0x${string}`;
  windowCloseMs: number;
  issuedAtS: number;
}): SignedPlanMessage {
  return {
    promise: fields.promise,
    owner: fields.owner,
    ticker: fields.ticker,
    planHash: fields.planHash,
    windowClose: BigInt(Math.floor(fields.windowCloseMs / 1000)),
    issuedAt: BigInt(fields.issuedAtS)
  };
}
