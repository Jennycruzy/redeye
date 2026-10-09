import { randomUUID } from "node:crypto";
import {
  checkQuote,
  createStandingRun,
  createWindowRecord,
  decide,
  expandStandingPlan,
  hashCanonical,
  hashDecision,
  hashPlan,
  hashVerdict,
  nextWindow,
  planLockDeadlineMs,
  signedPlanMessage,
  SIGNED_PLAN_DOMAIN,
  SIGNED_PLAN_MAX_AGE_S,
  SIGNED_PLAN_TYPES,
  PLAN_PERMISSION_TYPES,
  planPermissionDomain,
  serializePlanPermission,
  type PlanPermission,
  type SerializedPlanPermission,
  validatePlan,
  verifyReceipt,
  type Decision,
  type DecisionInput,
  type EventContext,
  type EventRecord,
  type PlanContext,
  type NormalizedQuote,
  type PlanKind,
  type QuoteCheckResult,
  type ReceiptBundle,
  type ReceiptReconciliation,
  type ReceiptVerdict,
  type RefusalCode,
  type StandingPlanRun,
  type WalletContext
} from "@redeye/core";
import Decimal from "decimal.js";
import type { OrderResult, QuoteRequest } from "./agentic-wallet.js";
import {
  getAddress,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex
} from "viem";
import { recoverAuthorizationAddress } from "viem/experimental";
import type { JobBook, JobKind, JobState } from "./job-chain.js";
import type { ChainWrite, Outcome, PlanChain } from "./plan-chain.js";
import type { PriceSnapshotOk } from "./price-service.js";

const WINDOW_PLAN_KINDS: readonly PlanKind[] = ["guard", "buy_dip", "sell_rise", "hold"];
const EVALUATION_LOG_INTERVAL_MS = 5 * 60 * 1000;
const ORDER_LOOKUP_GIVE_UP_MS = 10 * 60 * 1000;
/** After this long without an official open, the result is published without it. */
const OPEN_PRICE_WAIT_MS = 24 * 60 * 60 * 1000;

/** Refusals caused by a limit the user wrote into the plan count as a kept promise. */
const PLAN_LIMIT_CODES: ReadonlySet<RefusalCode> = new Set([
  "CONDITION_NOT_MET",
  "PRICE_OFF_REAL",
  "POOL_TOO_THIN",
  "IMPACT_TOO_HIGH"
]);
/** Refusals that may clear on the next check, so they never end a plan during the window. */
const TRANSIENT_CODES: ReadonlySet<RefusalCode> = new Set(["REAL_PRICE_UNAVAILABLE"]);

export interface PlanPreview {
  valid: boolean;
  issues: Array<{ field: string; message: string }>;
  promise?: string;
  planHash?: Hex;
  runId?: string;
  runHash?: Hex;
  /** Fields the owner will sign for the PlanAccount door (amounts are raw units). */
  permission?: SerializedPlanPermission & { template: Address };
  window?: { kind: string; closeTs: number; openTs: number; lockBy: number };
}

export class PlanError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export type PlanStatus = "draft" | "locked" | "decided" | "done" | "cancelled";

export interface StoredDecision {
  at: number;
  input: DecisionInput;
  decision: Decision;
  decisionHash: Hex;
  chain: ChainWrite | null;
}

/** Places a plan's trade. The Binance Agentic Wallet implements it. */
export interface Trader {
  address(): Promise<Address>;
  context(requiredQuotaUsd: string, requiredUntilMs: number): Promise<WalletContext>;
  quote(request: QuoteRequest): Promise<NormalizedQuote>;
  swap(quote: NormalizedQuote, slippagePct: string): Promise<OrderResult>;
  waitForOrder(orderId: string): Promise<OrderResult>;
  findOrder(quote: NormalizedQuote, sinceMs: number, replyId?: string): Promise<OrderResult | null>;
}

/**
 * The non-custodial PlanAccount door. It shares quote/order lookup semantics with
 * Agentic Wallet, but the final swap is relayed through the owner's account and
 * requires the permission captured at lock time.
 */
export interface PermissionTrader {
  address(): Promise<Address>;
  context(
    requiredQuotaUsd: string,
    requiredUntilMs: number,
    account?: Address
  ): Promise<WalletContext>;
  quote(request: QuoteRequest): Promise<NormalizedQuote>;
  swap(
    quote: NormalizedQuote,
    slippagePct: string,
    permission: StoredPermission
  ): Promise<OrderResult>;
  waitForOrder(orderId: string): Promise<OrderResult>;
  findOrder(quote: NormalizedQuote, sinceMs: number, replyId?: string): Promise<OrderResult | null>;
  /** Returns null for an EOA/EIP-7702 account, or ERC-1271 validity for a deployed account. */
  verifyPermission?(
    owner: Address,
    permission: PlanPermission,
    signature: Hex
  ): Promise<boolean | null>;
  /** Installs the EIP-7702 delegation if needed; returns its transaction when sent. */
  ensureAccount(owner: Address, permission: StoredPermission): Promise<Hex | null>;
}

export interface StoredAuthorization {
  contractAddress: Address;
  chainId: number;
  nonce: number;
  yParity: number;
  r: Hex;
  s: Hex;
}

export interface StoredPermission {
  owner: Address;
  permission: SerializedPlanPermission;
  signature: Hex;
  authorization?: StoredAuthorization;
  delegationTx?: Hex;
  /** Unsigned per-copy context needed by a standing permission at execution. */
  planHash?: Hex;
  eventKey?: Hex;
}

/** The plan's ERC-8183 job. Each step is saved before the next, so a retry never opens a second job. */
export type JobSlot = "job" | "teamJob";

export interface StoredJob {
  kind: JobKind;
  /** Saved as soon as the create transaction is sent. */
  createTx: Hex;
  jobId: number | null;
  state: JobState | "creating";
  fundTxs: Hex[];
  /** keccak256 of the delivery manifest written by submit. */
  deliverable?: Hex;
  manifest?: JobManifest;
  deliverChain?: ChainWrite;
  settleChain?: ChainWrite;
  /** Team jobs only: the buyer's approval or rejection, and the check behind it. */
  reviewChain?: ChainWrite;
  reviewReason?:
    "RECEIPT_VERIFIED" | "RECEIPT_MISSING" | "RECEIPT_INVALID" | "DELIVERABLE_MISMATCH";
  lastError?: { at: string; message: string };
}

export interface JobManifest {
  v: 1;
  planId: number;
  receipt: string;
  verdictHash: Hex;
}

export interface StoredTrade {
  wallet: Address;
  quote: NormalizedQuote;
  check: QuoteCheckResult;
  /** Saved before the swap is sent, so a restart can find the order. */
  submittedAt: number;
  order: OrderResult | null;
  /** Whole tokens (sell: USDT, buy: stock token) that reached the wallet, read from chain. */
  received: string | null;
  fillChain: ChainWrite | null;
}

export interface StoredPlan {
  v: 1;
  id: string;
  status: PlanStatus;
  createdAt: string;
  input: Record<string, unknown>;
  /** Set when the owner signed the plan in their own wallet and the agent locked it for them. */
  signedBy?: { owner: Address; signature: Hex; issuedAt: number };
  /** The bounded PlanAccount permission and optional EIP-7702 delegation signature. */
  signedPermission?: StoredPermission;
  plan?: PlanContext;
  event?: EventRecord;
  planHash?: Hex;
  owner?: Address;
  planId?: number;
  freeze?: ChainWrite;
  lastEvaluation?: { at: number; action: Decision["action"]; refusal: string | null };
  decision?: StoredDecision;
  trade?: StoredTrade;
  verdict?: ReceiptVerdict & { verdictHash: Hex };
  reconciliation?: ReceiptReconciliation;
  verdictChain?: ChainWrite | null;
  /** Official ERC-8183 job. Absent when no job buyer is configured; the plan then locks with job id 0. */
  job?: StoredJob;
  /** Team job approved by our own buyer wallet, for the first few plans only. */
  teamJob?: StoredJob;
  lastError?: { at: string; message: string };
}

export interface PlanRecordItem {
  id: string;
  /** Null for a standing-plan night that was never locked (LOCK_MISSED). */
  planId: number | null;
  owner: Address;
  status: PlanStatus | "missed";
  standingRunId: string | null;
  ticker: string;
  kind: PlanKind;
  promise: string;
  window: EventRecord["kind"];
  /** Block time of the lock transaction, in milliseconds. */
  lockedAt: number | null;
  closeTs: number;
  openTs: number;
  freezeTx: Hex | null;
  outcome: Outcome | null;
  reason: string | null;
  openPrice: string | null;
  verdictTx: Hex | null;
  /** ERC-8183 job for this plan, null when it has none. */
  jobId: number | null;
  jobState: JobState | "creating" | null;
  /** Team job approved by our own wallet, null when the plan has none. */
  teamJobId: number | null;
  teamJobState: JobState | "creating" | null;
  /** The plan's own numbers (trigger, share of holding, limits), for drawing it. */
  params: PlanContext["params"];
  heldShares: string;
  /** The execution door used by the plan, or signed for a promise-only lock. */
  door: "agentic_wallet" | "plan_account" | "signed" | null;
  /** The decision written on chain once the trigger was hit or the window ended. */
  decisionTx: Hex | null;
  decidedAt: number | null;
  action: string | null;
  /** The swap's transaction once the order finished. */
  fillTx: Hex | null;
}

/** The plan in one plain sentence, as shown in the public record. */
export function describePlan(plan: PlanContext): string {
  const shares = `${plan.heldShares} ${plan.ticker} ${Number(plan.heldShares) === 1 ? "share" : "shares"}`;
  const { params } = plan;
  if (plan.kind === "guard") {
    return `If the 24/7 price falls ${params.triggerDropPct}% below the close, sell ${params.sellPct}% of ${shares}.`;
  }
  if (plan.kind === "buy_dip") {
    return `If the 24/7 price falls ${params.triggerDropPct}% below the close, buy up to $${params.maxUsd} of ${plan.ticker}.`;
  }
  if (plan.kind === "sell_rise") {
    return `If the 24/7 price rises ${params.triggerRisePct}% above the close, sell ${params.sellPct}% of ${shares}.`;
  }
  return `Hold ${shares} through the window and report the result at the open.`;
}

export type StandingStatus = "active" | "stopped" | "ended";

/** One night of a standing run: either locked as its own plan, or missed. */
export interface StandingNight {
  sequence: number;
  status: "locked" | "missed";
  planStoreId: string | null;
  closeTs: number;
}

export interface StoredStanding {
  v: 1;
  id: string;
  status: StandingStatus;
  createdAt: string;
  owner: Address;
  run: StandingPlanRun;
  runHash: Hex;
  /** One owner-signed permission reused once per frozen window when this is a wallet run. */
  signedPermission?: StoredPermission;
  /** Keyed by the night's event key. */
  nights: Record<string, StandingNight>;
  lastError?: { at: string; message: string };
}

export interface PlanStore {
  getStanding(id: string): Promise<StoredStanding | null>;
  saveStanding(standing: StoredStanding): Promise<void>;
  listStanding(): Promise<StoredStanding[]>;
  getPlan(id: string): Promise<StoredPlan | null>;
  savePlan(plan: StoredPlan): Promise<void>;
  listPlans(): Promise<StoredPlan[]>;
  saveRunEvent(runId: string, step: string, payload: Record<string, unknown>): Promise<void>;
  saveReceipt(runId: string, receipt: ReceiptBundle): Promise<void>;
  /** The published receipt; throws when there is none. */
  receipt(runId: string): Promise<unknown>;
  saveRecordItem(item: PlanRecordItem): Promise<void>;
}

export interface ListedToken {
  address: string;
  multiplier: string;
  multiplierAgreement: boolean;
}

export interface OfficialOpen {
  value: string;
  source: string;
  sourceRecordPath: string;
}

export interface PlanServiceOptions {
  store: PlanStore;
  /** Null when no PlanBook or agent key is configured; locking is then refused. */
  chain: PlanChain | null;
  latestPrice(ticker: string): Promise<PriceSnapshotOk | null>;
  listedToken(ticker: string): Promise<ListedToken | null>;
  officialOpen(ticker: string, nyDate: string): Promise<OfficialOpen | null>;
  /** Reconciles every Agentic Wallet transfer against all fills in a window. */
  reconcileWindow?(plans: StoredPlan[], event: EventRecord): Promise<ReceiptReconciliation>;
  /** Null until a wallet is connected; plans that may trade are then refused. */
  trader?: Trader | null;
  /** The user's own wallet/account path; null until a relayer is configured. */
  permissionTrader?: PermissionTrader | null;
  /** Immutable PlanAccount template and approved swap router used by permissions. */
  planAccount?: { template: Address; router: Address; maxPriceDeviationBps?: bigint };
  /** Null or absent when no job buyer is configured; plans then lock without a job. */
  jobs?: JobBook | null;
  /** How many plans in total get a team job as well; 0 or absent turns team jobs off. */
  teamJobLimit?: number;
  /** How many wallet-signed plans the agent locks (and pays gas for) per 24 hours. */
  signedDailyCap?: number;
  now?: () => number;
  newId?: () => string;
  /** Where a new or changed error is written; defaults to one JSON line on stderr. */
  log?: (line: Record<string, unknown>) => void;
}

function nyDate(atMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(atMs));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlanError(400, "PLAN_INVALID", `${field} is required.`);
  }
  return value.trim();
}

function eventContext(event: EventRecord): EventContext {
  if (event.lockTs === null || event.openTs === null) {
    throw new Error("A window event needs lock and open times.");
  }
  return {
    ticker: event.ticker,
    kind: event.kind,
    lockTs: event.lockTs,
    openTs: event.openTs,
    releaseTs: null,
    consensus: null
  };
}

function paramsFrom(input: Record<string, unknown>): PlanContext["params"] {
  return typeof input.params === "object" && input.params !== null && !Array.isArray(input.params)
    ? (input.params as PlanContext["params"])
    : ({} as PlanContext["params"]);
}

function invalid(issues: Array<{ field: string; message: string }>): PlanError {
  return new PlanError(
    400,
    "PLAN_INVALID",
    issues.map((issue) => `${issue.field} ${issue.message}`).join(" ")
  );
}

function ageSeconds(fetchedAt: string, atMs: number): number {
  return Math.max(0, Math.floor((atMs - Date.parse(fetchedAt)) / 1000));
}

const USDT_ADDRESS: Address = "0x55d398326f99059fF775485246999027B3197955";

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanError(400, "PERMISSION_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function hex32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new PlanError(400, "PERMISSION_INVALID", `${field} must be a 32-byte hex value.`);
  }
  return value as Hex;
}

function addressField(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new PlanError(400, "PERMISSION_INVALID", `${field} must be an address.`);
  }
  return getAddress(value);
}

function uintField(value: unknown, field: string): bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new PlanError(400, "PERMISSION_INVALID", `${field} must be an integer.`);
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new PlanError(400, "PERMISSION_INVALID", `${field} must be a non-negative integer.`);
  }
}

function permissionFromBody(value: unknown): PlanPermission {
  const body = jsonObject(value, "permission");
  return {
    planHash: hex32(body.planHash, "permission.planHash"),
    standingRunHash: hex32(body.standingRunHash ?? ZERO_HASH, "permission.standingRunHash"),
    agent: addressField(body.agent, "permission.agent"),
    tokenIn: addressField(body.tokenIn, "permission.tokenIn"),
    tokenOut: addressField(body.tokenOut, "permission.tokenOut"),
    maxAmount: uintField(body.maxAmount, "permission.maxAmount"),
    router: addressField(body.router, "permission.router"),
    notBefore: uintField(body.notBefore, "permission.notBefore"),
    notAfter: uintField(body.notAfter, "permission.notAfter"),
    maxPriceDeviationBps: uintField(body.maxPriceDeviationBps, "permission.maxPriceDeviationBps")
  };
}

function permissionsEqual(actual: PlanPermission, expected: PlanPermission): boolean {
  const a = serializePlanPermission(actual);
  const e = serializePlanPermission(expected);
  return (
    a.planHash.toLowerCase() === e.planHash.toLowerCase() &&
    a.standingRunHash.toLowerCase() === e.standingRunHash.toLowerCase() &&
    a.agent.toLowerCase() === e.agent.toLowerCase() &&
    a.tokenIn.toLowerCase() === e.tokenIn.toLowerCase() &&
    a.tokenOut.toLowerCase() === e.tokenOut.toLowerCase() &&
    a.maxAmount === e.maxAmount &&
    a.router.toLowerCase() === e.router.toLowerCase() &&
    a.notBefore === e.notBefore &&
    a.notAfter === e.notAfter &&
    a.maxPriceDeviationBps === e.maxPriceDeviationBps
  );
}

function authorizationFromBody(value: unknown): StoredAuthorization | undefined {
  if (value === undefined || value === null) return undefined;
  const body = jsonObject(value, "authorization");
  const yParity = uintField(body.yParity, "authorization.yParity");
  if (yParity > 1n) {
    throw new PlanError(400, "PERMISSION_INVALID", "authorization.yParity must be 0 or 1.");
  }
  const chainId = uintField(body.chainId, "authorization.chainId");
  const nonce = uintField(body.nonce, "authorization.nonce");
  if (chainId > 4_294_967_295n || nonce > 4_294_967_295n) {
    throw new PlanError(
      400,
      "PERMISSION_INVALID",
      "authorization chainId and nonce are too large."
    );
  }
  return {
    contractAddress: addressField(
      body.contractAddress ?? body.address,
      "authorization.contractAddress"
    ),
    chainId: Number(chainId),
    nonce: Number(nonce),
    yParity: Number(yParity),
    r: hex32(body.r, "authorization.r"),
    s: hex32(body.s, "authorization.s")
  };
}

/** USD per real share actually achieved, from the amounts that moved on chain. */
function actionPricePerShare(trade: StoredTrade): string {
  const { quote } = trade;
  const received = new Decimal(trade.received ?? "0");
  const sent = new Decimal(quote.inputAmount);
  const [usd, tokens] = quote.side === "sell" ? [received, sent] : [sent, received];
  if (tokens.lte(0)) return "0";
  return usd.div(tokens.mul(quote.multiplier)).toSignificantDigits(12).toString();
}

/** Seconds after the dispute window before settling, so the policy surely sees it as passed. */
const JOB_SETTLE_DELAY_S = 120;
/** Extra days after the dispute window before the buyer could take the budget back. */
const JOB_SETTLE_MARGIN_S = 3 * 24 * 60 * 60;

function jobDescription(stored: StoredPlan, context: EventContext, kind: JobKind): string {
  return JSON.stringify({
    task: `Redeye plan: ${describePlan(stored.plan!)}`,
    review:
      kind === "official"
        ? "BNB Chain optimistic policy after its dispute window"
        : "team job: approved by Redeye's own buyer wallet only if the receipt verifies",
    planHash: stored.planHash,
    ticker: context.ticker,
    window: context.kind,
    closeTs: Math.floor(context.lockTs / 1000),
    openTs: Math.floor(context.openTs / 1000),
    deliverable: "keccak256 of the canonical manifest {v, planId, receipt, verdictHash}"
  });
}

/**
 * The window a plan locked now belongs to. Until a close, that is the night after it; once
 * the close has passed, the night after the next close. Inside the last minutes before a
 * close it stays tonight, so a late lock is refused rather than moved to another night.
 */
export function lockableWindow(atMs: number): ReturnType<typeof nextWindow> {
  const window = nextWindow(atMs);
  return atMs >= window.closeTs ? nextWindow(window.openTs) : window;
}

function withoutJobError(job: StoredJob): StoredJob {
  const { lastError, ...rest } = job;
  void lastError;
  return rest;
}

function withoutError(stored: StoredPlan): StoredPlan {
  const { lastError, ...rest } = stored;
  void lastError;
  return rest;
}

function isTerminal(decision: Decision): boolean {
  if (decision.action === "buy" || decision.action === "sell") return true;
  return decision.refusal !== null && !TRANSIENT_CODES.has(decision.refusal.code as RefusalCode);
}

function outcomeFor(decision: Decision): Outcome {
  if (decision.refusal === null) return "kept";
  return PLAN_LIMIT_CODES.has(decision.refusal.code as RefusalCode) ? "kept" : "refused";
}

/**
 * Locks off-hours plans in PlanBook, checks each one every minute between the US
 * close and the next open, and publishes reconciled results at the open.
 */
export class PlanService {
  private readonly now: () => number;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly newId: () => string;

  constructor(private readonly options: PlanServiceOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  /** Builds the exact bounded permission the wallet signs for this frozen plan. */
  private async permissionForPlan(
    plan: PlanContext,
    event: EventRecord,
    planHash: Hex,
    standingRunHash = ZERO_HASH
  ): Promise<PlanPermission> {
    const account = this.options.planAccount;
    if (!account) {
      throw new PlanError(
        503,
        "PLAN_ACCOUNT_NOT_CONFIGURED",
        "The PlanAccount template and approved swap router are not configured."
      );
    }
    if (event.lockTs === null || event.openTs === null) {
      throw new PlanError(400, "PERMISSION_INVALID", "The plan window has no lock or open time.");
    }
    const listed = await this.options.listedToken(plan.ticker);
    if (listed === null) {
      throw new PlanError(400, "TOKEN_NOT_LISTED", `${plan.ticker} has no listed token.`);
    }
    const multiplier = new Decimal(listed.multiplier);
    const rawScale = new Decimal(10).pow(18);
    // The permission amount is expressed in raw token units. Buy plans spend
    // USDT (18 decimals); sells convert real shares back through the listed
    // token multiplier before applying the same scale.
    let maxAmount = new Decimal(0);
    if (plan.kind === "buy_dip") {
      maxAmount = new Decimal(plan.params.maxUsd ?? "0").mul(rawScale);
    } else if (plan.kind === "guard" || plan.kind === "sell_rise") {
      maxAmount = new Decimal(plan.heldShares)
        .mul(plan.params.sellPct ?? "0")
        .div(100)
        .div(multiplier)
        .mul(rawScale);
    }
    const impact = new Decimal(plan.params.maxPriceImpactPct ?? "1");
    const bps = account.maxPriceDeviationBps ?? BigInt(impact.mul(100).ceil().toFixed(0));
    return {
      planHash,
      standingRunHash,
      agent: this.requireConfiguredChain().agentAddress,
      tokenIn: (plan.kind === "buy_dip" ? USDT_ADDRESS : plan.tokenAddress) as Address,
      tokenOut: (plan.kind === "buy_dip" ? plan.tokenAddress : USDT_ADDRESS) as Address,
      maxAmount: BigInt(maxAmount.floor().toFixed(0)),
      router: account.router,
      notBefore: BigInt(Math.floor(event.lockTs / 1000)),
      notAfter: BigInt(Math.floor(event.openTs / 1000)),
      maxPriceDeviationBps: bps
    };
  }

  /** Checks a standalone ERC-1271 PlanAccount before falling back to EIP-712 EOA recovery. */
  private async permissionSigner(
    owner: Address,
    permission: PlanPermission,
    signature: Hex,
    mismatchMessage: string
  ): Promise<Address> {
    const verifyContract = this.options.permissionTrader?.verifyPermission;
    if (verifyContract !== undefined) {
      const contractResult = await verifyContract(owner, permission, signature);
      if (contractResult !== null) {
        if (!contractResult) {
          throw new PlanError(
            400,
            "SIGNATURE_INVALID",
            "The passkey assertion did not authorize this permission."
          );
        }
        return owner;
      }
    }
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        domain: planPermissionDomain(owner),
        types: PLAN_PERMISSION_TYPES,
        primaryType: "PlanPermission",
        message: permission,
        signature
      });
    } catch {
      throw new PlanError(400, "SIGNATURE_INVALID", "The permission signature could not be read.");
    }
    if (signer.toLowerCase() !== owner.toLowerCase()) {
      throw new PlanError(403, "SIGNATURE_MISMATCH", mismatchMessage);
    }
    return signer;
  }

  /**
   * Checks a plan against tonight's window without saving or locking anything, and says
   * what it would promise. Used by the MCP draft tool.
   */
  async preview(input: Record<string, unknown>): Promise<PlanPreview> {
    const atMs = this.now();
    let plan: PlanContext;
    try {
      if (input.door === "plan_account" && !this.options.permissionTrader) {
        return {
          valid: false,
          issues: [
            {
              field: "PLAN_ACCOUNT_NOT_CONFIGURED",
              message: "The PlanAccount relayer is not enabled on this agent."
            }
          ]
        };
      }
      // A browser asks for the signed-door preview before it has connected the
      // owner's wallet. Do not read the relayer's balance as a proxy for the
      // owner; the lock endpoint repeats the holdings check after the address
      // and signature arrive.
      const accountPreview =
        input.door === "plan_account" &&
        (typeof input.owner !== "string" || !isAddress(input.owner));
      if (accountPreview) {
        const draft = { ...input };
        delete draft.door;
        delete draft.auditNoDataAccepted;
        const base = await this.planFromInput(draft, null);
        plan = {
          ...base,
          door: "plan_account",
          auditNoDataAccepted: input.auditNoDataAccepted === true
        };
      } else {
        plan = await this.planFromInput(
          input,
          null,
          typeof input.owner === "string" && isAddress(input.owner)
            ? getAddress(input.owner)
            : undefined
        );
      }
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
      return { valid: false, issues: [{ field: error.code, message: error.message }] };
    }
    const window = lockableWindow(atMs);
    const event = createWindowRecord(window.kind, plan.ticker, window.closeTs, window.openTs);
    const context = eventContext(event);
    const lockBy = planLockDeadlineMs(context);
    const issues = validatePlan(plan, context).issues;
    if (atMs >= lockBy) {
      issues.push({ field: "lockTs", message: "Tonight's lock time has passed." });
    }
    const planHash = hashPlan(plan);
    const permission =
      this.options.planAccount === undefined || plan.kind === "hold"
        ? undefined
        : serializePlanPermission(await this.permissionForPlan(plan, event, planHash));
    return {
      valid: issues.length === 0,
      issues,
      promise: describePlan(plan),
      planHash,
      ...(permission === undefined
        ? {}
        : { permission: { ...permission, template: this.options.planAccount!.template } }),
      window: { kind: window.kind, closeTs: window.closeTs, openTs: window.openTs, lockBy }
    };
  }

  /**
   * Previews a standing run, including the single permission that covers every
   * future copy. The returned runId is supplied back to startStanding so the
   * owner signs the same standingRunHash that PlanBook will publish.
   */
  async previewStanding(input: Record<string, unknown>): Promise<PlanPreview> {
    const atMs = this.now();
    try {
      const days = Number(input.days);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        return {
          valid: false,
          issues: [{ field: "days", message: "must be a whole number from 1 to 30." }]
        };
      }
      if (input.door === "plan_account" && !this.options.permissionTrader) {
        return {
          valid: false,
          issues: [
            {
              field: "PLAN_ACCOUNT_NOT_CONFIGURED",
              message: "The PlanAccount relayer is not enabled on this agent."
            }
          ]
        };
      }
      const runId =
        typeof input.runId === "string" && input.runId.trim().length > 0
          ? input.runId.trim()
          : this.newId();
      const accountPreview =
        input.door === "plan_account" &&
        (typeof input.owner !== "string" || !isAddress(input.owner));
      const draft = accountPreview ? { ...input } : input;
      if (accountPreview) {
        delete draft.door;
        delete draft.auditNoDataAccepted;
      }
      let plan = await this.planFromInput(
        draft,
        runId,
        accountPreview
          ? undefined
          : typeof input.owner === "string" && isAddress(input.owner)
            ? getAddress(input.owner)
            : undefined
      );
      if (accountPreview) {
        plan = {
          ...plan,
          door: "plan_account",
          auditNoDataAccepted: input.auditNoDataAccepted === true
        };
      }
      const run = createStandingRun({
        runId,
        template: plan,
        startAtMs: atMs,
        untilTs: atMs + days * 86_400_000
      });
      const copies = expandStandingPlan(run).filter((copy) => copy.lockByMs > atMs);
      const [first] = copies;
      if (first === undefined) {
        return {
          valid: false,
          issues: [{ field: "days", message: "the run covers no market close." }]
        };
      }
      const issues = validatePlan(plan, eventContext(first.event)).issues;
      if (atMs >= planLockDeadlineMs(eventContext(first.event))) {
        issues.push({ field: "lockTs", message: "Tonight's lock time has passed." });
      }
      const runHash = hashCanonical({
        runId: run.runId,
        template: run.template,
        startAtMs: run.startAtMs,
        untilTs: run.untilTs
      });
      const planHash = hashPlan(plan);
      const last = copies[copies.length - 1]!;
      const permission =
        this.options.planAccount === undefined ||
        (plan.kind === "hold" && plan.door !== "plan_account")
          ? undefined
          : serializePlanPermission(
              await this.permissionForPlan(
                plan,
                { ...first.event, openTs: last.event.openTs },
                ZERO_HASH,
                runHash
              )
            );
      return {
        valid: issues.length === 0,
        issues,
        promise: describePlan(plan),
        planHash,
        runId,
        runHash,
        ...(permission === undefined
          ? {}
          : { permission: { ...permission, template: this.options.planAccount!.template } }),
        window: {
          kind: first.window.kind,
          closeTs: first.window.closeTs,
          openTs: first.window.openTs,
          lockBy: planLockDeadlineMs(eventContext(first.event))
        }
      };
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
      return { valid: false, issues: [{ field: error.code, message: error.message }] };
    }
  }

  async lock(id: string): Promise<StoredPlan> {
    const chain = this.requireConfiguredChain();
    const stored = await this.requirePlan(id);
    if (stored.status !== "draft") {
      throw new PlanError(409, "PLAN_NOT_DRAFT", `Plan ${id} is already ${stored.status}.`);
    }
    const atMs = this.now();
    const plan = await this.planFromInput(stored.input, null);
    const window = lockableWindow(atMs);
    const event = createWindowRecord(window.kind, plan.ticker, window.closeTs, window.openTs);
    const context = eventContext(event);
    if (atMs >= planLockDeadlineMs(context)) {
      throw new PlanError(
        409,
        "LOCK_MISSED",
        "Plans must be locked at least 5 minutes before the US close."
      );
    }
    const validation = validatePlan(plan, context);
    if (!validation.valid) throw invalid(validation.issues);
    if (plan.door === "plan_account") {
      throw new PlanError(
        400,
        "PERMISSION_REQUIRED",
        "A PlanAccount plan must include the owner's signed permission; use the wallet lock flow."
      );
    }
    return this.freeze(chain, stored, plan, event);
  }

  /**
   * Locks a plan signed by an external wallet. The legacy no-door form remains a
   * public promise; `door: plan_account` carries the bounded PlanPermission that
   * authorizes one later trade through the owner's account.
   */
  async lockSigned(body: Record<string, unknown>): Promise<StoredPlan> {
    const chain = this.requireConfiguredChain();
    const input = body.plan;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new PlanError(400, "PLAN_INVALID", "Send the plan as an object.");
    }
    const planInput = { ...(input as Record<string, unknown>) };
    const accountDoor = planInput.door === "plan_account";
    if (planInput.door !== undefined && planInput.door !== null && !accountDoor) {
      throw new PlanError(400, "PLAN_INVALID", "The wallet lock door must be plan_account.");
    }
    if (!accountDoor) {
      delete planInput.door;
      delete planInput.auditNoDataAccepted;
    }
    if (typeof body.owner !== "string" || !isAddress(body.owner)) {
      throw new PlanError(400, "OWNER_INVALID", "owner must be a wallet address.");
    }
    const owner = getAddress(body.owner);
    const issuedAt = Number(body.issuedAt);
    const signature = accountDoor ? (body.permissionSignature ?? body.signature) : body.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new PlanError(400, "SIGNATURE_INVALID", "signature must be a hex string.");
    }

    const atMs = this.now();
    const age = Math.floor(atMs / 1000) - issuedAt;
    if (!Number.isInteger(issuedAt) || age < -60 || age > SIGNED_PLAN_MAX_AGE_S) {
      throw new PlanError(
        400,
        "SIGNATURE_EXPIRED",
        "The signature is too old; sign the plan again."
      );
    }

    const plan = await this.planFromInput(planInput, null, owner);
    const window = lockableWindow(atMs);
    const event = createWindowRecord(window.kind, plan.ticker, window.closeTs, window.openTs);
    const context = eventContext(event);
    if (atMs >= planLockDeadlineMs(context)) {
      throw new PlanError(
        409,
        "LOCK_MISSED",
        "Plans must be locked at least 5 minutes before the US close."
      );
    }
    const validation = validatePlan(plan, context);
    if (!validation.valid) throw invalid(validation.issues);

    const planHash = hashPlan(plan);
    let signedPermission: StoredPermission | undefined;
    let signer: Address;
    if (accountDoor) {
      if (!this.options.permissionTrader || !this.options.planAccount) {
        throw new PlanError(
          503,
          "PLAN_ACCOUNT_NOT_CONFIGURED",
          "The PlanAccount relayer is not configured on this agent."
        );
      }
      const permission = permissionFromBody(body.permission);
      const expected = await this.permissionForPlan(plan, event, planHash);
      const actual = serializePlanPermission(permission);
      if (!permissionsEqual(permission, expected)) {
        throw new PlanError(
          400,
          "PERMISSION_MISMATCH",
          "The signed permission does not match this frozen plan's token, amount, router or window."
        );
      }
      signer = await this.permissionSigner(
        owner,
        permission,
        signature as Hex,
        "The permission signature does not match this wallet."
      );
      const authorization = authorizationFromBody(body.authorization);
      if (authorization !== undefined) {
        if (
          authorization.contractAddress.toLowerCase() !==
            this.options.planAccount.template.toLowerCase() ||
          authorization.chainId !== 56
        ) {
          throw new PlanError(
            400,
            "AUTHORIZATION_MISMATCH",
            "The delegation must target Redeye's PlanAccount template on BNB Smart Chain."
          );
        }
        try {
          const recoverSignedAuthorization = recoverAuthorizationAddress as unknown as (input: {
            authorization: {
              address: Address;
              chainId: number;
              nonce: number;
              yParity: number;
              r: Hex;
              s: Hex;
            };
          }) => Promise<Address>;
          const recovered = await recoverSignedAuthorization({
            authorization: {
              address: authorization.contractAddress,
              chainId: authorization.chainId,
              nonce: authorization.nonce,
              yParity: authorization.yParity,
              r: authorization.r,
              s: authorization.s
            }
          });
          if (recovered.toLowerCase() !== owner.toLowerCase()) {
            throw new Error("wrong owner");
          }
        } catch {
          throw new PlanError(
            403,
            "AUTHORIZATION_MISMATCH",
            "The EIP-7702 delegation signature does not match this wallet."
          );
        }
      }
      signedPermission = {
        owner,
        permission: actual,
        signature: signature as Hex,
        ...(authorization === undefined ? {} : { authorization })
      };
    } else {
      const message = signedPlanMessage({
        promise: describePlan(plan),
        owner,
        ticker: plan.ticker,
        planHash,
        windowCloseMs: window.closeTs,
        issuedAtS: issuedAt
      });
      try {
        signer = await recoverTypedDataAddress({
          domain: SIGNED_PLAN_DOMAIN,
          types: SIGNED_PLAN_TYPES,
          primaryType: "Plan",
          message,
          signature: signature as Hex
        });
      } catch {
        throw new PlanError(400, "SIGNATURE_INVALID", "The signature could not be read.");
      }
    }
    if (!accountDoor && signer.toLowerCase() !== owner.toLowerCase()) {
      throw new PlanError(
        403,
        "SIGNATURE_MISMATCH",
        "The signature does not match this plan and address. Sign the plan shown, from this wallet."
      );
    }

    const cap = this.options.signedDailyCap ?? 20;
    const recent = (await this.options.store.listPlans()).filter(
      (p) =>
        (p.signedBy !== undefined || p.signedPermission !== undefined) &&
        p.freeze !== undefined &&
        atMs - p.freeze.blockTs * 1000 < 86_400_000
    ).length;
    if (recent >= cap) {
      throw new PlanError(
        429,
        "SIGNED_LIMIT",
        `The agent locks ${cap} signed plans a day; try again tomorrow.`
      );
    }

    if (accountDoor) {
      const delegationTx = await this.options.permissionTrader!.ensureAccount(
        owner,
        signedPermission!
      );
      if (delegationTx !== null) {
        signedPermission = { ...signedPermission!, delegationTx };
      }
    }

    const signed: StoredPlan = {
      v: 1,
      id: this.newId(),
      status: "draft",
      createdAt: new Date(atMs).toISOString(),
      input: planInput,
      signedBy: { owner, signature: signature as Hex, issuedAt },
      ...(signedPermission === undefined ? {} : { signedPermission })
    };
    await this.options.store.savePlan(signed);
    return this.freeze(
      chain,
      signed,
      plan,
      event,
      undefined,
      // Promise-only locks do not open a paid job; executable permissions do.
      { owner, jobs: accountDoor }
    );
  }

  /**
   * Starts a standing plan: the same plan, locked again before every close until it
   * ends or is stopped. Each night becomes its own plan in PlanBook, linked to the run.
   */
  async startStanding(input: Record<string, unknown>): Promise<StoredStanding> {
    const chain = this.requireConfiguredChain();
    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      throw new PlanError(400, "PLAN_INVALID", "days must be a whole number from 1 to 30.");
    }
    const atMs = this.now();
    const id =
      typeof input.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : this.newId();
    const accountDoor = input.door === "plan_account";
    let owner = chain.agentAddress;
    if (accountDoor) {
      if (!this.options.permissionTrader || !this.options.planAccount) {
        throw new PlanError(
          503,
          "PLAN_ACCOUNT_NOT_CONFIGURED",
          "The PlanAccount relayer is not configured on this agent."
        );
      }
      if (typeof input.owner !== "string" || !isAddress(input.owner)) {
        throw new PlanError(400, "OWNER_INVALID", "owner must be a wallet address.");
      }
      owner = getAddress(input.owner);
    }
    const template = await this.planFromInput(input, id, accountDoor ? owner : undefined);
    let run: StandingPlanRun;
    try {
      run = createStandingRun({
        runId: id,
        template,
        startAtMs: atMs,
        untilTs: atMs + days * 86_400_000
      });
    } catch (error) {
      throw new PlanError(
        400,
        "PLAN_INVALID",
        error instanceof Error ? error.message : String(error)
      );
    }
    const copies = expandStandingPlan(run).filter((copy) => copy.lockByMs > atMs);
    const [first] = copies;
    if (first === undefined) {
      throw new PlanError(400, "PLAN_INVALID", "The run covers no market close.");
    }
    const validation = validatePlan(template, eventContext(first.event));
    if (!validation.valid) throw invalid(validation.issues);
    const runHash = hashCanonical({
      runId: run.runId,
      template: run.template,
      startAtMs: run.startAtMs,
      untilTs: run.untilTs
    });
    let signedPermission: StoredPermission | undefined;
    if (accountDoor) {
      const issuedAt = Number(input.issuedAt);
      const age = Math.floor(atMs / 1000) - issuedAt;
      if (!Number.isInteger(issuedAt) || age < -60 || age > SIGNED_PLAN_MAX_AGE_S) {
        throw new PlanError(
          400,
          "SIGNATURE_EXPIRED",
          "The standing permission is too old; sign the run again."
        );
      }
      const signature = input.permissionSignature ?? input.signature;
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        throw new PlanError(400, "SIGNATURE_INVALID", "permissionSignature must be a hex string.");
      }
      const permission = permissionFromBody(input.permission);
      const last = copies[copies.length - 1]!;
      const permissionWindow = { ...first.event, openTs: last.event.openTs };
      const expected = await this.permissionForPlan(template, permissionWindow, ZERO_HASH, runHash);
      if (!permissionsEqual(permission, expected)) {
        throw new PlanError(
          400,
          "PERMISSION_MISMATCH",
          "The standing permission does not match this run's token, amount, router or bounds."
        );
      }
      await this.permissionSigner(
        owner,
        permission,
        signature as Hex,
        "The standing permission does not match this wallet."
      );
      const authorization = authorizationFromBody(input.authorization);
      if (authorization !== undefined) {
        if (
          authorization.contractAddress.toLowerCase() !==
            this.options.planAccount!.template.toLowerCase() ||
          authorization.chainId !== 56
        ) {
          throw new PlanError(
            400,
            "AUTHORIZATION_MISMATCH",
            "The delegation must target Redeye's PlanAccount template on BNB Smart Chain."
          );
        }
        try {
          const recoverSignedAuthorization = recoverAuthorizationAddress as unknown as (input: {
            authorization: {
              address: Address;
              chainId: number;
              nonce: number;
              yParity: number;
              r: Hex;
              s: Hex;
            };
          }) => Promise<Address>;
          const recovered = await recoverSignedAuthorization({
            authorization: {
              address: authorization.contractAddress,
              chainId: authorization.chainId,
              nonce: authorization.nonce,
              yParity: authorization.yParity,
              r: authorization.r,
              s: authorization.s
            }
          });
          if (recovered.toLowerCase() !== owner.toLowerCase()) throw new Error("wrong owner");
        } catch {
          throw new PlanError(
            403,
            "AUTHORIZATION_MISMATCH",
            "The EIP-7702 delegation signature does not match this wallet."
          );
        }
      }
      signedPermission = {
        owner,
        permission: serializePlanPermission(permission),
        signature: signature as Hex,
        ...(authorization === undefined ? {} : { authorization })
      };
      const delegationTx = await this.options.permissionTrader!.ensureAccount(
        owner,
        signedPermission
      );
      if (delegationTx !== null) signedPermission = { ...signedPermission, delegationTx };
    }
    const standing: StoredStanding = {
      v: 1,
      id,
      status: "active",
      createdAt: new Date(atMs).toISOString(),
      owner,
      run,
      runHash,
      ...(signedPermission === undefined ? {} : { signedPermission }),
      nights: {}
    };
    await this.options.store.saveStanding(standing);
    await this.advanceStanding(standing);
    return (await this.options.store.getStanding(id)) ?? standing;
  }

  /** Stops future nights. Nights already locked stay public promises. */
  async stopStanding(id: string): Promise<StoredStanding> {
    const standing = await this.options.store.getStanding(id);
    if (standing === null) {
      throw new PlanError(404, "STANDING_NOT_FOUND", "The requested standing plan does not exist.");
    }
    if (standing.status !== "active") {
      throw new PlanError(409, "STANDING_NOT_ACTIVE", `Standing plan ${id} is ${standing.status}.`);
    }
    const atMs = this.now();
    const stopped: StoredStanding = {
      ...standing,
      status: "stopped",
      run: { ...standing.run, stoppedAtMs: atMs }
    };
    await this.options.store.saveStanding(stopped);
    return stopped;
  }

  async cancel(id: string): Promise<StoredPlan> {
    const stored = await this.requirePlan(id);
    if (stored.status === "draft") {
      const cancelled: StoredPlan = { ...stored, status: "cancelled" };
      await this.options.store.savePlan(cancelled);
      return cancelled;
    }
    if (stored.status !== "locked" || stored.planId === undefined || stored.event === undefined) {
      throw new PlanError(409, "PLAN_NOT_CANCELLABLE", `Plan ${id} is ${stored.status}.`);
    }
    if (this.now() >= (stored.event.lockTs ?? 0)) {
      throw new PlanError(
        409,
        "PLAN_NOT_CANCELLABLE",
        "A plan cannot be cancelled after the close."
      );
    }
    if (this.options.chain === null) {
      throw new PlanError(503, "PLANBOOK_NOT_CONFIGURED", "PlanBook is not configured.");
    }
    const write = await this.options.chain.cancel(stored.planId);
    const cancelled: StoredPlan = { ...stored, status: "cancelled" };
    await this.options.store.savePlan(cancelled);
    await this.options.store.saveRunEvent(id, "cancelled", { txHash: write.txHash });
    await this.saveRecord(cancelled);
    return cancelled;
  }

  /** One pass over every active plan. Errors stay on the plan and are retried next pass. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const standing of await this.options.store.listStanding()) {
        if (standing.status !== "active") continue;
        try {
          await this.advanceStanding(standing);
        } catch (error) {
          const message = this.reportError("standing", standing.id, standing.lastError, error);
          await this.options.store.saveStanding({
            ...standing,
            lastError: { at: new Date(this.now()).toISOString(), message }
          });
        }
      }
      for (const stored of await this.options.store.listPlans()) {
        await this.advanceJobs(stored);
      }
      for (const stored of await this.options.store.listPlans()) {
        if (stored.status !== "locked" && stored.status !== "decided") continue;
        try {
          await this.advance(stored);
          // A pass that only waits saves nothing, so clear an error a past pass left behind.
          if (stored.lastError !== undefined) {
            const latest = await this.options.store.getPlan(stored.id);
            if (latest?.lastError !== undefined) {
              await this.options.store.savePlan(withoutError(latest));
            }
          }
        } catch (error) {
          // Re-read first: the failed step may have saved progress (such as a sent trade)
          // that must not be overwritten by the copy this pass started with.
          const latest = (await this.options.store.getPlan(stored.id)) ?? stored;
          const message = this.reportError("plan", stored.id, latest.lastError, error);
          await this.options.store.savePlan({
            ...latest,
            lastError: { at: new Date(this.now()).toISOString(), message }
          });
        }
      }
      await this.publishReadyWindows();
    } finally {
      this.running = false;
    }
  }

  /** Publishes a window only after its plan decisions and wallet orders have settled. */
  private async publishReadyWindows(): Promise<void> {
    const plans = await this.options.store.listPlans();
    const windows = new Map<string, StoredPlan[]>();
    for (const plan of plans) {
      const event = plan.event;
      if (!event || event.lockTs === null || event.openTs === null) continue;
      if (plan.status !== "locked" && plan.status !== "decided" && plan.status !== "done") continue;
      const key = `${event.kind}:${event.lockTs}:${event.openTs}`;
      const group = windows.get(key) ?? [];
      group.push(plan);
      windows.set(key, group);
    }

    for (const group of windows.values()) {
      const event = group[0]?.event;
      if (!event || event.openTs === null || this.now() < event.openTs) continue;
      if (group.some((plan) => plan.status === "locked" || this.tradePending(plan))) continue;
      if (!group.some((plan) => plan.status === "decided")) continue;

      try {
        const tradingPlans = group.filter(
          (plan) => plan.plan?.door === "agentic_wallet" || plan.plan?.door === "plan_account"
        );
        if (tradingPlans.length > 0 && !this.options.reconcileWindow) {
          throw new Error(
            "Transfer reconciliation is not configured; the trading result was not published."
          );
        }
        const reconciliation =
          tradingPlans.length > 0
            ? await this.options.reconcileWindow!(tradingPlans, event)
            : undefined;
        for (const plan of group) {
          if (plan.status !== "decided") continue;
          await this.publishResult(
            plan,
            this.now(),
            plan.plan?.door === "agentic_wallet" || plan.plan?.door === "plan_account"
              ? reconciliation
              : undefined
          );
        }
      } catch (error) {
        const first = group.find((plan) => plan.status === "decided");
        if (!first) continue;
        const message = this.reportError(
          "reconciliation",
          String(event.openTs),
          first.lastError,
          error
        );
        for (const plan of group) {
          if (plan.status !== "decided") continue;
          const latest = (await this.options.store.getPlan(plan.id)) ?? plan;
          await this.options.store.savePlan({
            ...latest,
            lastError: { at: new Date(this.now()).toISOString(), message }
          });
        }
      }
    }
  }

  /**
   * The error's message, written to the log when it is new or differs from the one already
   * stored, so a step that fails every minute is reported once rather than every pass.
   */
  private reportError(
    scope: string,
    id: string,
    previous: { message: string } | undefined,
    error: unknown
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    if (previous?.message !== message) {
      const log = this.options.log ?? ((line) => console.error(JSON.stringify(line)));
      log({ code: "PLAN_STEP_FAILED", scope, id, message });
    }
    return message;
  }

  /** Rewrites every public record row from the stored plans, so the record always matches them. */
  async refreshRecord(): Promise<void> {
    for (const stored of await this.options.store.listPlans()) await this.saveRecord(stored);
  }

  start(intervalMs = 60_000): () => void {
    if (this.timer !== null) throw new Error("The plan service is already running.");
    void this.refreshRecord().then(() => this.tick());
    this.timer = setInterval(() => void this.tick(), intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Locks each night of a standing run once the night before it has closed, and
   * publishes any night whose lock time passed without a lock as LOCK_MISSED.
   */
  private async advanceStanding(standing: StoredStanding): Promise<void> {
    const atMs = this.now();
    const nights = { ...standing.nights };
    let changed = false;
    // A night whose lock time had passed when the run started was never part of it.
    const copies = expandStandingPlan(standing.run).filter(
      (copy) => copy.lockByMs > standing.run.startAtMs
    );
    for (const copy of copies) {
      const key = copy.event.eventKey;
      if (nights[key] !== undefined) continue;
      if (atMs > copy.lockByMs) {
        nights[key] = {
          sequence: copy.sequence,
          status: "missed",
          planStoreId: null,
          closeTs: copy.window.closeTs
        };
        changed = true;
        await this.saveMissedNight(standing, copy.plan, copy.event);
        continue;
      }
      // One night is locked ahead at a time: each locks once the night before it has closed.
      const previous = copies[copies.indexOf(copy) - 1];
      if (previous !== undefined && atMs < previous.window.closeTs) break;
      const draft: StoredPlan = {
        v: 1,
        id: `${standing.id}-${copy.sequence}`,
        status: "draft",
        createdAt: new Date(atMs).toISOString(),
        input: { standingRunId: standing.id, sequence: copy.sequence },
        ...(standing.signedPermission === undefined
          ? {}
          : { signedPermission: standing.signedPermission })
      };
      const locked = await this.freeze(
        this.requireConfiguredChain(),
        draft,
        copy.plan,
        copy.event,
        standing.runHash,
        { owner: standing.owner, jobs: true }
      );
      nights[key] = {
        sequence: copy.sequence,
        status: "locked",
        planStoreId: locked.id,
        closeTs: copy.window.closeTs
      };
      changed = true;
      break;
    }
    const endTs = standing.run.stoppedAtMs ?? standing.run.untilTs;
    const finished =
      atMs > endTs && copies.every((copy) => nights[copy.event.eventKey] !== undefined);
    if (!changed && !finished) return;
    const next: StoredStanding = { ...standing, nights };
    delete next.lastError;
    if (finished) next.status = "ended";
    await this.options.store.saveStanding(next);
  }

  private async saveMissedNight(
    standing: StoredStanding,
    plan: PlanContext,
    event: EventRecord
  ): Promise<void> {
    await this.options.store.saveRecordItem({
      id: `${standing.id}:${event.eventKey}`,
      planId: null,
      owner: standing.owner,
      status: "missed",
      standingRunId: standing.id,
      ticker: plan.ticker,
      kind: plan.kind,
      promise: describePlan(plan),
      window: event.kind,
      lockedAt: null,
      closeTs: event.lockTs ?? 0,
      openTs: event.openTs ?? 0,
      freezeTx: null,
      outcome: null,
      reason: "LOCK_MISSED",
      openPrice: null,
      verdictTx: null,
      jobId: null,
      jobState: null,
      teamJobId: null,
      teamJobState: null,
      params: plan.params,
      heldShares: plan.heldShares,
      door: plan.door ?? null,
      decisionTx: null,
      decidedAt: null,
      action: null,
      fillTx: null
    });
  }

  private async planFromInput(
    input: Record<string, unknown>,
    standingRunId: string | null,
    walletOverride?: Address
  ): Promise<PlanContext> {
    const ticker = text(input.ticker, "ticker").toUpperCase();
    const kind = text(input.kind, "kind") as PlanKind;
    if (!WINDOW_PLAN_KINDS.includes(kind)) {
      throw new PlanError(
        400,
        "PLAN_INVALID",
        `Off-hours plans must be one of: ${WINDOW_PLAN_KINDS.join(", ")}.`
      );
    }
    const token = await this.options.listedToken(ticker);
    if (token === null) {
      throw new PlanError(400, "TOKEN_NOT_LISTED", `${ticker} has no bStock on the official list.`);
    }
    if (!token.multiplierAgreement) {
      throw new PlanError(409, "MULTIPLIER_MISMATCH", `${ticker} share counts disagree.`);
    }
    const plan: PlanContext = {
      kind,
      standingRunId,
      ticker,
      wrapper: "bStock",
      tokenAddress: token.address,
      heldShares: text(input.heldShares, "heldShares"),
      params: paramsFrom(input)
    };
    if (input.door === undefined || input.door === null) return plan;
    if (input.door !== "agentic_wallet" && input.door !== "plan_account") {
      throw new PlanError(
        400,
        "PLAN_INVALID",
        "door must be agentic_wallet or plan_account when set."
      );
    }
    const wallet =
      input.door === "agentic_wallet" ? this.options.trader : this.options.permissionTrader;
    if (!wallet) {
      throw new PlanError(
        503,
        input.door === "plan_account" ? "PLAN_ACCOUNT_NOT_CONFIGURED" : "WALLET_NOT_CONNECTED",
        input.door === "plan_account"
          ? "The PlanAccount relayer is not configured, so this plan could not trade."
          : "No Agentic Wallet is connected, so this plan could not trade."
      );
    }
    await this.requireHoldings(plan, token.multiplier, walletOverride ?? (await wallet.address()));
    return {
      ...plan,
      door: input.door,
      auditNoDataAccepted: input.auditNoDataAccepted === true
    };
  }

  /**
   * A plan that may trade must be backed by what the wallet holds now: the shares it
   * names, or for Buy the dip the USDT it would spend. Read from the chain, not the wallet.
   */
  private async requireHoldings(
    plan: PlanContext,
    multiplier: string,
    wallet: Address
  ): Promise<void> {
    const chain = this.requireConfiguredChain();
    if (plan.kind === "buy_dip") {
      const usdt = new Decimal(await chain.balance(USDT_ADDRESS, wallet));
      const needed = new Decimal(plan.params.maxUsd ?? "0");
      if (usdt.lt(needed)) {
        throw new PlanError(
          409,
          "HOLDINGS_SHORT",
          `The wallet holds ${usdt.toString()} USDT, less than the ${needed.toString()} USD this plan would spend.`
        );
      }
      return;
    }
    const tokens = new Decimal(await chain.balance(plan.tokenAddress as Address, wallet));
    const shares = tokens.mul(multiplier);
    if (shares.lt(plan.heldShares)) {
      throw new PlanError(
        409,
        "HOLDINGS_SHORT",
        `The wallet holds ${shares.toDecimalPlaces(6, Decimal.ROUND_DOWN).toString()} ${plan.ticker} shares, less than the ${plan.heldShares} this plan names.`
      );
    }
  }

  private async freeze(
    chain: PlanChain,
    stored: StoredPlan,
    plan: PlanContext,
    event: EventRecord,
    standingRunHash?: Hex,
    lockFor?: { owner: Address; jobs: boolean }
  ): Promise<StoredPlan> {
    const context = eventContext(event);
    const planHash = hashPlan(plan);
    const owner = lockFor?.owner ?? chain.agentAddress;
    // PlanBook keeps one plan per owner, stock and window. Checked before a job is opened,
    // so a refused lock never leaves a paid job behind.
    const existing = await chain.planIdFor(owner, event.eventKey as Hex);
    if (existing !== 0) {
      throw new PlanError(
        409,
        "DUPLICATE_PLAN",
        `Plan #${existing} is already locked for ${plan.ticker} in this window; PlanBook keeps one plan per stock and window.`
      );
    }
    const withJob =
      lockFor?.jobs === false
        ? { ...stored, plan, event, planHash }
        : await this.openJob({ ...stored, plan, event, planHash }, context);
    const freeze = await chain.freeze({
      owner,
      eventKey: event.eventKey,
      planHash,
      ticker: plan.ticker,
      lockTs: context.lockTs,
      ...(withJob.job?.jobId ? { jobId: withJob.job.jobId } : {}),
      ...(standingRunHash === undefined ? {} : { standingRunHash })
    });
    const locked: StoredPlan = {
      ...withJob,
      status: "locked",
      plan,
      event,
      planHash,
      owner,
      planId: freeze.planId,
      freeze,
      ...(withJob.signedPermission !== undefined &&
      withJob.signedPermission.permission.standingRunHash.toLowerCase() !== ZERO_HASH
        ? {
            signedPermission: {
              ...withJob.signedPermission,
              planHash,
              eventKey: event.eventKey as Hex
            }
          }
        : {})
    };
    await this.options.store.savePlan(locked);
    await this.options.store.saveRunEvent(stored.id, "locked", {
      planId: freeze.planId,
      txHash: freeze.txHash,
      lockTs: context.lockTs,
      openTs: context.openTs
    });
    await this.saveRecord(locked);
    return locked;
  }

  /**
   * Opens and pays for the plan's jobs before the lock, so PlanBook can link the official
   * one. A job failure never blocks the lock: the promise matters more than its jobs, and
   * every step is retried each pass.
   */
  private async openJob(stored: StoredPlan, context: EventContext): Promise<StoredPlan> {
    const jobs = this.options.jobs;
    if (!jobs) return stored;
    let current = await this.openJobOf(stored, context, "job");
    if (jobs.teamJobs && (await this.teamJobsLeft()) > 0) {
      current = await this.openJobOf(current, context, "teamJob");
    }
    return current;
  }

  private async teamJobsLeft(): Promise<number> {
    const limit = this.options.teamJobLimit ?? 0;
    const used = (await this.options.store.listPlans()).filter(
      (plan) => plan.teamJob !== undefined
    ).length;
    return limit - used;
  }

  private async openJobOf(
    stored: StoredPlan,
    context: EventContext,
    slot: JobSlot
  ): Promise<StoredPlan> {
    const jobs = this.options.jobs!;
    if (stored[slot] !== undefined) return stored;
    const kind: JobKind = slot === "job" ? "official" : "team";
    let current: StoredPlan = stored;
    try {
      // Official jobs need room for the dispute window; team jobs are reviewed at the open.
      const wait = kind === "official" ? await jobs.disputeWindow() : 0;
      const expiresAt = Math.floor(context.openTs / 1000) + wait + JOB_SETTLE_MARGIN_S;
      const jobId = await jobs.create(
        { description: jobDescription(stored, context, kind), expiresAt },
        kind,
        async (createTx) => {
          current = {
            ...current,
            [slot]: { kind, createTx, jobId: null, state: "creating", fundTxs: [] }
          };
          await this.saveWithRecord(current);
        }
      );
      current = { ...current, [slot]: { ...current[slot]!, jobId, state: "open" } };
      await this.saveWithRecord(current);
      return await this.fundJob(current, slot);
    } catch (error) {
      return this.jobFailed(current, slot, error);
    }
  }

  private async fundJob(stored: StoredPlan, slot: JobSlot): Promise<StoredPlan> {
    const job = stored[slot]!;
    const fundTxs = await this.options.jobs!.fund(job.jobId!);
    const view = await this.options.jobs!.get(job.jobId!);
    const next: StoredPlan = {
      ...stored,
      [slot]: withoutJobError({ ...job, state: view.state, fundTxs: [...job.fundTxs, ...fundTxs] })
    };
    await this.saveWithRecord(next);
    return next;
  }

  private async jobFailed(stored: StoredPlan, slot: JobSlot, error: unknown): Promise<StoredPlan> {
    const job = stored[slot];
    const message = this.reportError(slot, stored.id, job?.lastError, error);
    if (job === undefined) {
      // Nothing reached the chain; the plan simply has no job of this kind.
      await this.options.store.saveRunEvent(stored.id, "job_failed", { slot, message });
      return stored;
    }
    const next: StoredPlan = {
      ...stored,
      [slot]: { ...job, lastError: { at: new Date(this.now()).toISOString(), message } }
    };
    await this.saveWithRecord(next);
    return next;
  }

  private async advanceJobs(stored: StoredPlan): Promise<void> {
    if (!this.options.jobs || stored.status === "cancelled") return;
    for (const slot of ["job", "teamJob"] as const) {
      const latest = (await this.options.store.getPlan(stored.id)) ?? stored;
      if (latest[slot] !== undefined) await this.advanceJob(latest, slot);
    }
  }

  /**
   * Moves one job a step: finds a job whose create reply was lost, pays an open job,
   * delivers once the result is published, then settles an official job after the dispute
   * window or has the buyer review a team job against the receipt.
   */
  private async advanceJob(stored: StoredPlan, slot: JobSlot): Promise<void> {
    const jobs = this.options.jobs!;
    const job = stored[slot]!;
    try {
      if (job.jobId === null) {
        const jobId = await jobs.createdJobId(job.createTx);
        if (jobId === null) return;
        const found: StoredPlan = { ...stored, [slot]: { ...job, jobId, state: "open" } };
        await this.saveWithRecord(found);
        return await this.advanceJob(found, slot);
      }
      if (job.state === "open") {
        await this.fundJob(stored, slot);
        return;
      }
      if (job.state === "funded" && stored.status === "done" && stored.verdict) {
        const manifest = this.jobManifest(stored);
        const deliverable = hashCanonical(manifest);
        const deliverChain = await jobs.deliver(job.jobId, deliverable);
        await this.saveWithRecord({
          ...stored,
          [slot]: withoutJobError({
            ...job,
            state: "submitted",
            manifest,
            deliverable,
            deliverChain
          })
        });
        await this.options.store.saveRunEvent(stored.id, "job_delivered", {
          slot,
          jobId: job.jobId,
          txHash: deliverChain.txHash
        });
        return;
      }
      if (job.state !== "submitted" || !job.deliverChain) return;
      if (job.kind === "team") {
        await this.reviewTeamJob(stored, job);
        return;
      }
      const window = await jobs.disputeWindow();
      if (this.now() / 1000 < job.deliverChain.blockTs + window + JOB_SETTLE_DELAY_S) return;
      const settleChain = await jobs.settle(job.jobId);
      const view = await jobs.get(job.jobId);
      await this.saveWithRecord({
        ...stored,
        [slot]: withoutJobError({ ...job, state: view.state, settleChain })
      });
      await this.options.store.saveRunEvent(stored.id, "job_settled", {
        slot,
        jobId: job.jobId,
        state: view.state,
        txHash: settleChain.txHash
      });
    } catch (error) {
      await this.jobFailed(stored, slot, error);
    }
  }

  /**
   * The team buyer approves only when the published receipt verifies and the delivered
   * fingerprint matches it; otherwise it rejects, with the failed check as the reason.
   */
  private async reviewTeamJob(stored: StoredPlan, job: StoredJob): Promise<void> {
    const receipt = (await this.options.store
      .receipt(stored.id)
      .catch(() => null)) as ReceiptBundle | null;
    const verified = receipt === null ? null : verifyReceipt(receipt);
    const matches =
      receipt !== null &&
      job.deliverable === hashCanonical(this.jobManifest(stored)) &&
      receipt.verdictHash === stored.verdict?.verdictHash;
    const approve = verified?.valid === true && matches;
    const reasonCode = approve
      ? "RECEIPT_VERIFIED"
      : receipt === null
        ? "RECEIPT_MISSING"
        : verified?.valid
          ? "DELIVERABLE_MISMATCH"
          : "RECEIPT_INVALID";
    const reviewChain = await this.options.jobs!.review(
      job.jobId!,
      approve,
      keccak256(toBytes(reasonCode))
    );
    const view = await this.options.jobs!.get(job.jobId!);
    await this.saveWithRecord({
      ...stored,
      teamJob: withoutJobError({ ...job, state: view.state, reviewChain, reviewReason: reasonCode })
    });
    await this.options.store.saveRunEvent(stored.id, "job_reviewed", {
      jobId: job.jobId,
      approved: approve,
      reason: reasonCode,
      txHash: reviewChain.txHash
    });
  }

  private jobManifest(stored: StoredPlan): JobManifest {
    return {
      v: 1,
      planId: this.requirePlanId(stored),
      receipt: `/plans/${stored.id}/receipt`,
      verdictHash: stored.verdict!.verdictHash
    };
  }

  private async saveWithRecord(stored: StoredPlan): Promise<void> {
    await this.options.store.savePlan(stored);
    await this.saveRecord(stored);
  }

  private requireConfiguredChain(): PlanChain {
    if (this.options.chain === null) {
      throw new PlanError(
        503,
        "PLANBOOK_NOT_CONFIGURED",
        "PlanBook and the agent key are not configured on this agent."
      );
    }
    return this.options.chain;
  }

  private async advance(stored: StoredPlan): Promise<void> {
    const { plan, event } = stored;
    if (plan === undefined || event === undefined) throw new Error("Locked plan is incomplete.");
    const context = eventContext(event);
    const atMs = this.now();
    if (atMs < context.lockTs) return;

    if (stored.status === "locked") {
      let input = await this.decisionInput(plan, context, atMs);
      if (input === null) return;
      let decision = decide(input);
      const atOpen = atMs >= context.openTs;
      // EXECUTION_DISABLED means the trigger and price checks passed; a plan that may
      // trade is now checked again with a real quote and the wallet's limits.
      if (!atOpen && plan.door !== undefined && decision.refusal?.code === "EXECUTION_DISABLED") {
        const armed = await this.tradeInput(plan, input, stored);
        if (armed !== null) {
          input = armed;
          decision = decide(armed);
        }
      }
      await this.logEvaluation(stored, input, decision);
      if (!atOpen && !isTerminal(decision)) return;
      if (atOpen && decision.refusal?.code === "REAL_PRICE_UNAVAILABLE") return;
      stored = await this.recordDecision(stored, input, decision);
    }

    if (stored.status === "decided" && this.tradePending(stored)) {
      stored = await this.trade(stored);
      if (this.tradePending(stored)) return;
    }
  }

  /** The decision input with a checked quote and the wallet's state, or null without a wallet. */
  private async tradeInput(
    plan: PlanContext,
    input: DecisionInput,
    stored?: StoredPlan
  ): Promise<DecisionInput | null> {
    const trader =
      plan.door === "plan_account" ? this.options.permissionTrader : this.options.trader;
    if (!trader) return null;
    const token = await this.options.listedToken(plan.ticker);
    if (token === null) return null;
    const side = plan.kind === "buy_dip" ? "buy" : "sell";
    const real = new Decimal(input.prices.P ?? input.prices.T);
    let amount: string;
    let orderUsd: Decimal;
    if (side === "sell") {
      const shares = new Decimal(plan.heldShares).mul(plan.params.sellPct ?? "0").div(100);
      amount = shares.div(token.multiplier).toDecimalPlaces(18, Decimal.ROUND_DOWN).toString();
      orderUsd = shares.mul(real);
    } else {
      amount = new Decimal(plan.params.maxUsd ?? "0")
        .toDecimalPlaces(18, Decimal.ROUND_DOWN)
        .toString();
      orderUsd = new Decimal(amount);
    }
    const account =
      plan.door === "plan_account" ? stored?.signedPermission?.owner : await trader.address();
    const quote = await trader.quote({
      side,
      tokenAddress: plan.tokenAddress,
      multiplier: token.multiplier,
      amount,
      displayedPricePerShare: input.prices.T,
      ...(account === undefined ? {} : { account })
    });
    const checked = checkQuote({
      ticker: plan.ticker,
      quote,
      expectedTokenAddress: plan.tokenAddress,
      expectedWrapper: plan.wrapper,
      usReferencePricePerShare: input.prices.C,
      realPricePerShare: input.prices.P,
      realPriceAgeSeconds: input.prices.ages.P,
      marketOpen: false,
      maxPriceImpactPct: plan.params.maxPriceImpactPct,
      checkedAtMs: this.now(),
      displayedPricePerShare: input.prices.T
    });
    const wallet = await trader.context(
      orderUsd.toDecimalPlaces(2).toString(),
      this.now(),
      account
    );
    return {
      ...input,
      executionEnabled: true,
      wallet,
      quotes: [quote],
      // Only the overall result: an earlier stage can pass while a later one fails.
      quoteChecks: [checked.result]
    };
  }

  /** True while a decided trade still needs sending, confirming or recording on chain. */
  private tradePending(stored: StoredPlan): boolean {
    const action = stored.decision?.decision.action;
    if (action !== "buy" && action !== "sell") return false;
    const order = stored.trade?.order;
    if (order === undefined || order === null || order.status === "PENDING") return true;
    if (order.status === "FAILED" || order.txHash === null) return false;
    return stored.trade?.fillChain === null;
  }

  /**
   * Sends the decided trade, or follows up on one already sent. The decision is on
   * chain before this runs, so the promise always comes before the trade.
   */
  private async trade(stored: StoredPlan): Promise<StoredPlan> {
    const accountDoor = stored.plan?.door === "plan_account";
    const trader = accountDoor ? this.options.permissionTrader : this.options.trader;
    const decision = stored.decision;
    if (!trader || decision === undefined)
      throw new Error("No wallet is connected for this trade.");
    const quote = decision.input.quotes[0];
    const check = decision.input.quoteChecks[0];
    if (quote === undefined || check === undefined) throw new Error("The trade has no quote.");

    let trade = stored.trade;
    if (trade === undefined) {
      trade = {
        wallet: stored.signedPermission?.owner ?? (await trader.address()),
        quote,
        check,
        submittedAt: this.now(),
        order: null,
        received: null,
        fillChain: null
      };
      await this.options.store.savePlan({ ...stored, trade });
      const slippage = stored.plan?.params.maxPriceImpactPct ?? "1";
      const order = accountDoor
        ? await this.options.permissionTrader!.swap(quote, slippage, this.requirePermission(stored))
        : await this.options.trader!.swap(quote, slippage);
      trade = { ...trade, order };
    } else if (trade.order === null) {
      const found = await trader.findOrder(quote, trade.submittedAt);
      // Saved as sent, but the wallet has no such order: the swap never left the agent.
      const lost =
        found === null && this.now() - trade.submittedAt > ORDER_LOOKUP_GIVE_UP_MS
          ? { orderId: "not-found", status: "FAILED" as const, txHash: null }
          : null;
      trade = { ...trade, order: found ?? lost };
    } else if (trade.order.status === "PENDING") {
      // The swap reply's id may not be the listed one, so look the order up again.
      const found = await trader.findOrder(quote, trade.submittedAt, trade.order.orderId);
      trade = { ...trade, order: found ?? trade.order };
    }

    const order = trade.order;
    if (order?.status === "FINISHED" && order.txHash !== null && trade.fillChain === null) {
      const received = quote.side === "sell" ? USDT_ADDRESS : (quote.tokenAddress as Address);
      const chain = this.requireChain();
      trade = {
        ...trade,
        received: await chain.received(order.txHash, received, trade.wallet),
        fillChain: await chain.recordFill(this.requirePlanId(stored), order.txHash, 1)
      };
    }
    const next: StoredPlan = { ...withoutError(stored), trade };
    await this.options.store.savePlan(next);
    await this.options.store.saveRunEvent(stored.id, `trade:${order?.status ?? "LOOKUP"}`, {
      orderId: order?.orderId ?? null,
      status: order?.status ?? null,
      txHash: order?.txHash ?? null,
      received: trade.received
    });
    return next;
  }

  private requirePermission(stored: StoredPlan): StoredPermission {
    if (stored.signedPermission === undefined) {
      throw new Error(`Plan ${stored.id} has no signed PlanAccount permission.`);
    }
    return stored.signedPermission;
  }

  private async decisionInput(
    plan: PlanContext,
    event: EventContext,
    atMs: number
  ): Promise<DecisionInput | null> {
    const price = await this.options.latestPrice(plan.ticker);
    // The plan compares against tonight's official close; wait until it is published.
    if (price === null || price.close.date !== nyDate(event.lockTs)) return null;
    const realAge = ageSeconds(price.real.fetchedAt, atMs);
    return {
      plan,
      event,
      extracted: null,
      quotes: [],
      quoteChecks: [],
      status: { reasonCode: null, reasonMsg: null },
      audit: {
        status: "no_data",
        reason: null,
        officialListAddress: true,
        multiplierAgreement: true,
        walletRefused: false
      },
      wallet: {
        connected: false,
        tokenAllowed: true,
        quotaLeftUsd: "0",
        requiredQuotaUsd: "0",
        sessionExpiresAtMs: 0,
        requiredUntilMs: event.openTs
      },
      poolDepthUsd: price.pool.reserveUsd,
      atMs,
      executionEnabled: false,
      prices: {
        C: price.close.value,
        P: price.real.value,
        T: price.token.value,
        sources: { C: price.close.source, P: price.real.source, T: price.token.source },
        ages: {
          C: ageSeconds(price.close.fetchedAt, atMs),
          P: realAge,
          T: ageSeconds(price.token.fetchedAt, atMs)
        }
      }
    };
  }

  private async logEvaluation(
    stored: StoredPlan,
    input: DecisionInput,
    decision: Decision
  ): Promise<void> {
    const refusal = decision.refusal?.code ?? null;
    const previous = stored.lastEvaluation;
    const changed =
      previous === undefined || previous.action !== decision.action || previous.refusal !== refusal;
    if (!changed && input.atMs - previous.at < EVALUATION_LOG_INTERVAL_MS) return;
    stored.lastEvaluation = { at: input.atMs, action: decision.action, refusal };
    await this.options.store.savePlan(stored);
    await this.options.store.saveRunEvent(stored.id, `check:${input.atMs}`, {
      action: decision.action,
      refusal,
      reason: decision.reason,
      prices: input.prices
    });
  }

  private async recordDecision(
    stored: StoredPlan,
    input: DecisionInput,
    decision: Decision
  ): Promise<StoredPlan> {
    const decisionHash = hashDecision(input, decision);
    const chain = this.requireChain();
    const write = await chain.recordDecision(this.requirePlanId(stored), decisionHash);
    const decided: StoredPlan = {
      ...withoutError(stored),
      status: "decided",
      decision: { at: input.atMs, input, decision, decisionHash, chain: write }
    };
    await this.saveWithRecord(decided);
    await this.options.store.saveRunEvent(stored.id, "decided", {
      action: decision.action,
      refusal: decision.refusal?.code ?? null,
      reason: decision.reason,
      txHash: write.txHash
    });
    return decided;
  }

  private async publishResult(
    stored: StoredPlan,
    atMs: number,
    reconciliation?: ReceiptReconciliation
  ): Promise<void> {
    const { decision, event, plan } = stored;
    if (decision === undefined || event === undefined || plan === undefined) {
      throw new Error("Decided plan is incomplete.");
    }
    const openTs = event.openTs ?? atMs;
    const open = await this.options.officialOpen(plan.ticker, nyDate(openTs));
    if (open === null && atMs - openTs < OPEN_PRICE_WAIT_MS) return;

    const trade = stored.trade;
    const failedOrder = trade?.order?.status === "FAILED";
    const outcome =
      reconciliation?.result.valid === false
        ? "broken"
        : failedOrder
          ? "refused"
          : outcomeFor(decision.decision);
    const reconciliationHash = reconciliation ? hashCanonical(reconciliation) : undefined;
    const verdict: ReceiptVerdict = {
      outcome,
      reason:
        reconciliation?.result.valid === false
          ? "TRANSFER_RECONCILIATION_FAILED"
          : failedOrder
            ? "ORDER_FAILED"
            : (decision.decision.refusal?.code ?? decision.decision.reason),
      ...(reconciliationHash === undefined ? {} : { reconciliationHash }),
      ...(open === null ? {} : { openPrice: open.value }),
      ...(trade?.received ? { actionPrice: actionPricePerShare(trade) } : {})
    };
    const verdictHash = hashVerdict(verdict);
    const write = await this.requireChain().recordVerdict(
      this.requirePlanId(stored),
      outcome,
      verdictHash
    );
    const done: StoredPlan = {
      ...withoutError(stored),
      status: "done",
      verdict: { ...verdict, verdictHash },
      ...(reconciliation === undefined ? {} : { reconciliation }),
      verdictChain: write
    };
    await this.options.store.savePlan(done);
    await this.options.store.saveRunEvent(stored.id, "result", {
      outcome,
      openPrice: open?.value ?? null,
      openSource: open?.sourceRecordPath ?? null,
      txHash: write.txHash
    });
    await this.options.store.saveReceipt(stored.id, this.receipt(done, reconciliation));
    await this.saveRecord(done);
  }

  private receipt(stored: StoredPlan, reconciliation?: ReceiptReconciliation): ReceiptBundle {
    const { event, plan, planHash, freeze, decision, verdict } = stored;
    if (!event || !plan || !planHash || !freeze || !decision || !verdict) {
      throw new Error("Receipt needs a finished plan.");
    }
    const { verdictHash, ...verdictBody } = verdict;
    return {
      v: 1,
      event,
      plan: { ...plan, planId: stored.planId ?? null },
      planHash,
      freezeTx: freeze.txHash,
      freezeBlockTs: freeze.blockTs * 1000,
      ...(stored.signedPermission?.delegationTx === undefined
        ? {}
        : { permissionTx: stored.signedPermission.delegationTx }),
      decisions: [
        {
          at: decision.at,
          input: decision.input,
          decision: decision.decision,
          decisionHash: decision.decisionHash
        }
      ],
      fills:
        stored.trade?.order?.txHash && stored.trade.fillChain
          ? [
              {
                step: 1,
                txHash: stored.trade.order.txHash,
                confirmedAt: new Date(stored.trade.fillChain.blockTs * 1000).toISOString(),
                ...(reconciliation === undefined
                  ? {}
                  : {
                      transfers: reconciliation.expectedTransfers.filter(
                        (transfer) =>
                          transfer.txHash?.toLowerCase() ===
                          stored.trade!.order!.txHash!.toLowerCase()
                      )
                    })
              }
            ]
          : [],
      ...(reconciliation === undefined ? {} : { reconciliation }),
      verdict: verdictBody,
      verdictHash
    };
  }

  private async saveRecord(stored: StoredPlan): Promise<void> {
    const { plan, event, freeze, owner } = stored;
    if (!plan || !event || !freeze || !owner || stored.planId === undefined) return;
    await this.options.store.saveRecordItem({
      id: stored.id,
      planId: stored.planId,
      owner,
      status: stored.status,
      standingRunId: plan.standingRunId ?? null,
      ticker: plan.ticker,
      kind: plan.kind,
      promise: describePlan(plan),
      window: event.kind,
      lockedAt: freeze.blockTs * 1000,
      closeTs: event.lockTs ?? 0,
      openTs: event.openTs ?? 0,
      freezeTx: freeze.txHash,
      outcome: stored.verdict?.outcome ?? null,
      reason: stored.verdict?.reason ?? null,
      openPrice: stored.verdict?.openPrice ?? null,
      verdictTx: stored.verdictChain?.txHash ?? null,
      jobId: stored.job?.jobId ?? null,
      jobState: stored.job?.state ?? null,
      teamJobId: stored.teamJob?.jobId ?? null,
      teamJobState: stored.teamJob?.state ?? null,
      params: plan.params,
      heldShares: plan.heldShares,
      door: plan.door ?? (stored.signedBy ? "signed" : null),
      decisionTx: stored.decision?.chain?.txHash ?? null,
      decidedAt: stored.decision?.at ?? null,
      action: stored.decision?.decision.action ?? null,
      fillTx: stored.trade?.order?.status === "FINISHED" ? stored.trade.order.txHash : null
    });
  }

  private async requirePlan(id: string): Promise<StoredPlan> {
    const stored = await this.options.store.getPlan(id);
    if (stored === null)
      throw new PlanError(404, "PLAN_NOT_FOUND", "The requested plan does not exist.");
    return stored;
  }

  private requireChain(): PlanChain {
    if (this.options.chain === null) throw new Error("PlanBook is not configured.");
    return this.options.chain;
  }

  private requirePlanId(stored: StoredPlan): number {
    if (stored.planId === undefined) throw new Error(`Plan ${stored.id} has no PlanBook id.`);
    return stored.planId;
  }
}
