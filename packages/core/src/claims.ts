export type ClaimWord = "executed" | "autonomous" | "live" | "agentStudio" | "x402" | "bounded";

export interface ClaimEvidence {
  terminalOrderStatus?: "FINISHED" | "FAILED";
  chainConfirmed?: boolean;
  userSignInNeededAtAction?: boolean;
  fetchedAtMs?: number;
  nowMs?: number;
  freshnessMs?: number;
  identityTx?: `0x${string}`;
  completedJobTx?: `0x${string}`;
  settledPaymentTx?: `0x${string}`;
  evidenceUrl?: string;
}

export function canPublishClaim(claim: ClaimWord, evidence: ClaimEvidence): boolean {
  switch (claim) {
    case "executed":
      return evidence.terminalOrderStatus === "FINISHED" && evidence.chainConfirmed === true;
    case "autonomous":
      return evidence.userSignInNeededAtAction === false;
    case "live":
      return (
        evidence.fetchedAtMs !== undefined &&
        evidence.nowMs !== undefined &&
        evidence.freshnessMs !== undefined &&
        evidence.freshnessMs >= 0 &&
        evidence.nowMs >= evidence.fetchedAtMs &&
        evidence.nowMs - evidence.fetchedAtMs <= evidence.freshnessMs
      );
    case "agentStudio":
      return evidence.identityTx !== undefined && evidence.completedJobTx !== undefined;
    case "x402":
      return evidence.settledPaymentTx !== undefined;
    case "bounded":
      return evidence.evidenceUrl !== undefined && evidence.evidenceUrl.trim().length > 0;
  }
}

export function assertClaimAllowed(claim: ClaimWord, evidence: ClaimEvidence): void {
  if (!canPublishClaim(claim, evidence)) {
    throw new Error(`Claim '${claim}' lacks the required evidence.`);
  }
}
