import type { EventKind } from "./types.js";
import { makeEventKey } from "./receipt.js";

export interface EventSourceObservation {
  name: string;
  form?: string;
  seenAt: string;
  fetchedAt: string;
  recordPath: string;
}

export interface EventConsensus {
  eps: string;
  basis: string;
  noOfEsts: number;
}

export interface EventRecord {
  v: 1;
  eventKey: `0x${string}`;
  ticker: string;
  kind: EventKind;
  issuerCik: string;
  expectedDate: string;
  sources: EventSourceObservation[];
  releaseTs: number | null;
  consensus: EventConsensus | null;
}

function isoMs(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO timestamp.`);
  return timestamp;
}

function validateDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD.`);
}

export function earliestPublicSourceMs(sources: readonly EventSourceObservation[]): number | null {
  if (sources.length === 0) return null;
  const timestamps = sources.map((source, index) =>
    isoMs(source.seenAt, `sources[${index}].seenAt`)
  );
  return Math.min(...timestamps);
}

export function createEventRecord(input: {
  ticker: string;
  kind: EventKind;
  issuerCik: string;
  expectedDate: string;
  sources: EventSourceObservation[];
  consensus: EventConsensus | null;
}): EventRecord {
  validateDate(input.expectedDate, "expectedDate");
  if (!/^\d{10}$/.test(input.issuerCik)) throw new Error("issuerCik must be a ten-digit CIK.");
  for (const [index, source] of input.sources.entries()) {
    if (source.name.trim().length === 0)
      throw new Error(`sources[${index}].name must not be empty.`);
    if (source.recordPath.trim().length === 0)
      throw new Error(`sources[${index}].recordPath must not be empty.`);
    isoMs(source.seenAt, `sources[${index}].seenAt`);
    isoMs(source.fetchedAt, `sources[${index}].fetchedAt`);
  }
  if (input.consensus !== null) {
    if (!Number.isInteger(input.consensus.noOfEsts) || input.consensus.noOfEsts < 0) {
      throw new Error("consensus.noOfEsts must be a non-negative integer.");
    }
    if (input.consensus.eps.trim().length === 0 || input.consensus.basis.trim().length === 0) {
      throw new Error("consensus EPS and basis must not be empty.");
    }
  }
  const releaseTs = earliestPublicSourceMs(input.sources);
  return {
    v: 1,
    eventKey: makeEventKey(input.ticker, input.kind, input.expectedDate),
    ticker: input.ticker,
    kind: input.kind,
    issuerCik: input.issuerCik,
    expectedDate: input.expectedDate,
    sources: input.sources,
    releaseTs,
    consensus: input.consensus
  };
}

export function freezeIsBeforeRelease(freezeBlockTs: number, event: EventRecord): boolean {
  if (!Number.isFinite(freezeBlockTs)) throw new Error("freezeBlockTs must be finite.");
  if (event.releaseTs === null)
    throw new Error("Cannot compare a freeze before a release time was observed.");
  return freezeBlockTs < event.releaseTs;
}
