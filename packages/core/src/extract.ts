import type { ExtractedReport } from "./types.js";

export interface ExtractedCandidate {
  actualEps: string;
  basis: string;
  verbatim: string;
}

function requiredText(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty.`);
  return value;
}

export function verifyExtractedReport(
  candidate: ExtractedCandidate,
  filingText: string
): ExtractedReport {
  requiredText(filingText, "filingText");
  requiredText(candidate.actualEps, "actualEps");
  requiredText(candidate.basis, "basis");
  requiredText(candidate.verbatim, "verbatim");
  if (!filingText.includes(candidate.verbatim)) {
    return { ...candidate, verified: false };
  }
  if (!candidate.verbatim.includes(candidate.actualEps)) {
    return { ...candidate, verified: false };
  }
  return { ...candidate, verified: true };
}
