import type { Address, Hex } from "viem";

/**
 * EIP-712 domain used by PlanAccount. The verifying contract is the wallet
 * address when the account is installed through EIP-7702, and the deployed
 * PlanAccount address for a standalone/passkey account.
 */
export const PLAN_ACCOUNT_DOMAIN = {
  name: "Redeye PlanAccount",
  version: "1",
  chainId: 56
} as const;

/** Keep this in lockstep with PlanAccount.sol's PERMISSION_TYPEHASH. */
export const PLAN_PERMISSION_TYPES = {
  PlanPermission: [
    { name: "planHash", type: "bytes32" },
    { name: "standingRunHash", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "router", type: "address" },
    { name: "notBefore", type: "uint64" },
    { name: "notAfter", type: "uint64" },
    { name: "maxPriceDeviationBps", type: "uint256" }
  ]
} as const;

export interface PlanPermission {
  planHash: Hex;
  /** Zero for a one-window permission; set for a standing run. */
  standingRunHash: Hex;
  agent: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** Raw token units, not real shares or USD display units. */
  maxAmount: bigint;
  router: Address;
  notBefore: bigint;
  notAfter: bigint;
  maxPriceDeviationBps: bigint;
}

/** JSON-safe form used by the HTTP boundary and SQLite store. */
export interface SerializedPlanPermission {
  planHash: Hex;
  standingRunHash: Hex;
  agent: Address;
  tokenIn: Address;
  tokenOut: Address;
  maxAmount: string;
  router: Address;
  notBefore: string;
  notAfter: string;
  maxPriceDeviationBps: string;
}

export function serializePlanPermission(permission: PlanPermission): SerializedPlanPermission {
  return {
    planHash: permission.planHash,
    standingRunHash: permission.standingRunHash,
    agent: permission.agent,
    tokenIn: permission.tokenIn,
    tokenOut: permission.tokenOut,
    maxAmount: permission.maxAmount.toString(),
    router: permission.router,
    notBefore: permission.notBefore.toString(),
    notAfter: permission.notAfter.toString(),
    maxPriceDeviationBps: permission.maxPriceDeviationBps.toString()
  };
}

export function deserializePlanPermission(value: SerializedPlanPermission): PlanPermission {
  return {
    planHash: value.planHash,
    standingRunHash: value.standingRunHash,
    agent: value.agent,
    tokenIn: value.tokenIn,
    tokenOut: value.tokenOut,
    maxAmount: BigInt(value.maxAmount),
    router: value.router,
    notBefore: BigInt(value.notBefore),
    notAfter: BigInt(value.notAfter),
    maxPriceDeviationBps: BigInt(value.maxPriceDeviationBps)
  };
}

export function planPermissionDomain(verifyingContract: Address) {
  return { ...PLAN_ACCOUNT_DOMAIN, verifyingContract } as const;
}

/** The object shape expected by viem signTypedData. JSON-RPC callers should
 * stringify the bigint fields at their transport boundary. */
export function planPermissionTypedData(verifyingContract: Address, permission: PlanPermission) {
  return {
    domain: planPermissionDomain(verifyingContract),
    types: PLAN_PERMISSION_TYPES,
    primaryType: "PlanPermission" as const,
    message: permission
  } as const;
}
