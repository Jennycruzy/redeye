import { useEffect, useMemo, useState } from "react";
import { Problem, Skeleton, TxLink } from "../components/bits";
import { NightStrip } from "../components/NightStrip";
import { stockName } from "../components/PriceBoard";
import { agent, type PlanPreview, type PriceItem } from "../lib/api";
import {
  changePct,
  duration,
  localStamp,
  nyClock,
  nyStamp,
  num,
  pct,
  usd,
  windowName
} from "../lib/format";
import { useAgent, useNow } from "../lib/hooks";
import { Link, useLocation } from "../lib/router";
import {
  connect,
  discoverWallets,
  signDelegation,
  signPlan,
  signPlanPermission,
  type WalletChoice
} from "../lib/wallet";
import { lastFinishedClose, replayResult } from "../lib/replay";

type Kind = "guard" | "buy_dip" | "sell_rise" | "hold";

const KINDS: Array<{ id: Kind; name: string; line: string; icon: string }> = [
  { id: "guard", name: "Guard", line: "Sell part of it if it falls", icon: "M4 6l8 8 8-8" },
  {
    id: "buy_dip",
    name: "Buy the dip",
    line: "Buy some if it falls",
    icon: "M12 4v14M6 12l6 6 6-6"
  },
  {
    id: "sell_rise",
    name: "Sell the rise",
    line: "Sell part of it if it rises",
    icon: "M12 20V6M6 12l6-6 6 6"
  },
  { id: "hold", name: "Hold", line: "No trades, just a promise kept in public", icon: "M5 12h14" }
];

const DEFAULTS: Record<Kind, { trigger: number; share: number; usd: number }> = {
  guard: { trigger: 5, share: 50, usd: 25 },
  buy_dip: { trigger: 3, share: 50, usd: 25 },
  sell_rise: { trigger: 4, share: 25, usd: 25 },
  hold: { trigger: 3, share: 50, usd: 25 }
};

const STEPS = [
  "Pick a stock",
  "Say what should happen",
  "Choose how it trades",
  "Lock it before the close"
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function Rail({
  step,
  setStep,
  done
}: {
  step: number;
  setStep: (n: number) => void;
  done: boolean[];
}) {
  return (
    <ol className="rail" aria-label="Steps">
      {STEPS.map((label, index) => (
        <li key={label}>
          <button
            type="button"
            className={`rail__step${index === step ? " rail__step--on" : ""}${done[index] ? " rail__step--done" : ""}`}
            onClick={() => setStep(index)}
            aria-current={index === step ? "step" : undefined}
          >
            <span className="rail__n">{done[index] && index !== step ? "✓" : index + 1}</span>
            <span>{label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function StockPicker({
  items,
  ticker,
  choose
}: {
  items: PriceItem[];
  ticker: string;
  choose: (t: string) => void;
}) {
  const ok = items.filter((i) => i.state === "ok");
  return (
    <div className="picker" role="radiogroup" aria-label="Stock">
      {ok.map((item) => {
        const close = num(item.close?.value);
        const real = num(item.real?.value);
        const move = changePct(real, close);
        const on = item.ticker === ticker;
        return (
          <button
            key={item.ticker}
            type="button"
            role="radio"
            aria-checked={on}
            className={`pick${on ? " pick--on" : ""}`}
            onClick={() => choose(item.ticker)}
          >
            <span className="ticker">{item.ticker}</span>
            <span className="pick__name">{stockName(item.ticker)}</span>
            <span className="pick__price">{usd(real)}</span>
            <span className={`pick__move ${move !== null && move < 0 ? "move--down" : "move--up"}`}>
              {pct(move)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  hint
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  hint?: string | undefined;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="slider">
      <span className="slider__top">
        <span>{label}</span>
        <output className="slider__value">{unit === "$" ? `$${value}` : `${value}${unit}`}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--fill" as string]: `${fill}%` }}
      />
      {hint && <span className="slider__hint">{hint}</span>}
    </label>
  );
}

const DOORS = [
  {
    id: "signed",
    name: "Sign it with your wallet",
    state: "Live",
    body: "Your wallet signs one bounded PlanAccount permission and, where needed, an EIP-7702 delegation. The agent can make only this plan's swap; your funds stay in your wallet and the chain rejects anything else."
  },
  {
    id: "agentic",
    name: "Binance Agentic Wallet",
    state: "Live",
    body: "Trades stay inside the daily limit you set in the Binance app. Redeye reads your limits and session, quotes every trade, and refuses anything outside the plan. Plans #2 and #3 trade through this door this weekend."
  },
  {
    id: "wallet",
    name: "Trade from your own wallet",
    state: "Built",
    body: "Your wallet signs one bounded permission for one plan or standing run. PlanAccount on BNB Chain lets the agent make only the approved swap and refuses anything else."
  },
  {
    id: "newcomer",
    name: "New to crypto",
    state: "In progress",
    body: "Start in Telegram, make an account protected by Face ID, no seed phrase and no gas to buy. Redeye pays the network fee."
  }
];

export default function Start() {
  const { query } = useLocation();
  const now = useNow(1000);
  const prices = useAgent(() => agent.prices(), [], 30_000);
  const [step, setStep] = useState(0);
  const [ticker, setTicker] = useState((query.get("ticker") ?? "NVDA").toUpperCase());
  const [kind, setKind] = useState<Kind>("guard");
  const [trigger, setTrigger] = useState(DEFAULTS.guard.trigger);
  const [share, setShare] = useState(DEFAULTS.guard.share);
  const [amount, setAmount] = useState(DEFAULTS.guard.usd);
  const [held, setHeld] = useState("1");
  const [door, setDoor] = useState("signed");
  const [standing, setStanding] = useState(false);
  const [days, setDays] = useState(5);
  const [standingRunId] = useState(
    () => globalThis.crypto?.randomUUID?.() ?? `standing-${Math.random().toString(36).slice(2)}`
  );

  const chooseKind = (next: Kind) => {
    setKind(next);
    setTrigger(DEFAULTS[next].trigger);
    setShare(DEFAULTS[next].share);
    setAmount(DEFAULTS[next].usd);
  };

  const plan = useMemo(() => {
    const params: Record<string, string> = {
      maxPriceImpactPct: "1",
      minPoolDepthUsd: "100000",
      maxGapToRealPricePct: "1"
    };
    if (kind === "guard" || kind === "buy_dip") params.triggerDropPct = String(trigger);
    if (kind === "sell_rise") params.triggerRisePct = String(trigger);
    if (kind === "guard" || kind === "sell_rise") params.sellPct = String(share);
    if (kind === "buy_dip") params.maxUsd = String(amount);
    return { ticker, kind, heldShares: kind === "buy_dip" ? "0" : held || "0", params };
  }, [ticker, kind, trigger, share, amount, held]);
  // The door is part of the canonical plan hash. Preview the exact input that
  // the signed lock will submit, otherwise the permission's planHash would be
  // for a door-less draft and PlanBook would correctly reject the mismatch.
  const previewPlan = useMemo(
    () =>
      door === "signed" && (kind !== "hold" || standing)
        ? {
            ...plan,
            ...(standing ? { days, runId: standingRunId } : {}),
            door: "plan_account",
            auditNoDataAccepted: true
          }
        : door === "agentic"
          ? {
              ...plan,
              ...(standing ? { days, runId: standingRunId } : {}),
              door: "agentic_wallet",
              auditNoDataAccepted: true
            }
          : { ...plan, ...(standing ? { days, runId: standingRunId } : {}) },
    [days, door, plan, standing, standingRunId]
  );
  const debounced = useDebounced(previewPlan, 250);

  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    (standing ? agent.previewStanding(debounced) : agent.preview(debounced))
      .then((value) => active && (setPreview(value), setPreviewError(null)))
      .catch(
        (error: unknown) =>
          active && setPreviewError(error instanceof Error ? error.message : "The check failed.")
      );
    return () => {
      active = false;
    };
  }, [debounced, standing]);

  const replayClose = useMemo(() => lastFinishedClose(now), [Math.floor(now / 600_000)]);
  const replay = useAgent(() => agent.night(ticker, replayClose), [ticker, replayClose]);
  const result =
    replay.status === "ready" && kind !== "hold"
      ? replayResult(replay.value, kind as "guard" | "buy_dip" | "sell_rise", trigger)
      : null;

  const item =
    prices.status === "ready" ? prices.value.items.find((i) => i.ticker === ticker) : undefined;
  const lockBy = preview?.window.lockBy ?? null;
  const [reached, setReached] = useState(0);
  useEffect(() => setReached((r) => Math.max(r, step)), [step]);
  const done = STEPS.map((_, index) => index < reached);
  const when =
    preview?.window.kind === "weekend"
      ? "this weekend"
      : preview?.window.kind === "holiday"
        ? "over the holiday"
        : "tonight";

  return (
    <div className="start">
      <div className="wrap start__grid">
        <aside className="start__aside">
          <p className="eyebrow">Your first plan · about two minutes</p>
          <h1 className="title">
            Decide <em>now</em> what happens {when}.
          </h1>
          <Rail step={step} setStep={setStep} done={done} />
          {lockBy !== null && (
            <div className="deadline">
              <p className="label">Lock deadline</p>
              <p className="deadline__count">{lockBy > now ? duration(lockBy - now) : "passed"}</p>
              <p className="fine">
                {nyStamp(lockBy)} · {localStamp(lockBy)} your time
              </p>
            </div>
          )}
        </aside>

        <div className="start__main">
          {step === 0 && (
            <section className="panel" aria-labelledby="s1">
              <h2 id="s1" className="panel__title">
                Pick a stock
              </h2>
              <p className="panel__lede">
                A stock token is a token on BNB Chain that follows one real US share. When Wall
                Street closes, the token keeps trading, and so does the same stock on a 24/7 futures
                market. Prices can fall as well as rise.
              </p>
              {prices.status === "loading" && <Skeleton height={300} />}
              {prices.status === "error" && (
                <Problem message={prices.message} retry={prices.retry} />
              )}
              {prices.status === "ready" && (
                <StockPicker items={prices.value.items} ticker={ticker} choose={setTicker} />
              )}
              <div className="panel__next">
                <button className="button button--primary" type="button" onClick={() => setStep(1)}>
                  Continue with {stockName(ticker)}
                </button>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="panel" aria-labelledby="s2">
              <h2 id="s2" className="panel__title">
                What should happen to your {stockName(ticker)} {when}?
              </h2>
              <div className="kinds" role="radiogroup" aria-label="Plan">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.id}
                    className={`kindcard${kind === k.id ? " kindcard--on" : ""}`}
                    onClick={() => chooseKind(k.id)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d={k.icon}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <strong>{k.name}</strong>
                    <span>{k.line}</span>
                  </button>
                ))}
              </div>

              <div className="controls">
                {kind !== "hold" && (
                  <Slider
                    label={
                      kind === "sell_rise"
                        ? "If the 24/7 price rises above the close by"
                        : "If the 24/7 price falls below the close by"
                    }
                    value={trigger}
                    min={1}
                    max={20}
                    step={0.5}
                    unit="%"
                    onChange={setTrigger}
                    hint={
                      item?.close
                        ? `That is ${usd(Number(item.close.value) * (kind === "sell_rise" ? 1 + trigger / 100 : 1 - trigger / 100))} against the last ${usd(item.close.value)} close.`
                        : undefined
                    }
                  />
                )}
                {(kind === "guard" || kind === "sell_rise") && (
                  <Slider
                    label="Sell this share of your holding"
                    value={share}
                    min={10}
                    max={100}
                    step={5}
                    unit="%"
                    onChange={setShare}
                  />
                )}
                {kind === "buy_dip" && (
                  <Slider
                    label="Spend up to"
                    value={amount}
                    min={5}
                    max={200}
                    step={5}
                    unit="$"
                    onChange={setAmount}
                  />
                )}
                {kind !== "buy_dip" && (
                  <label className="field">
                    <span>Shares you hold</span>
                    <input
                      inputMode="decimal"
                      value={held}
                      onChange={(e) => setHeld(e.target.value.replace(/[^\d.]/g, ""))}
                    />
                  </label>
                )}
                <fieldset className="toggle">
                  <legend className="sr-only">How often</legend>
                  <button
                    type="button"
                    className={`toggle__opt${!standing ? " toggle__opt--on" : ""}`}
                    onClick={() => setStanding(false)}
                    aria-pressed={!standing}
                  >
                    This window only
                  </button>
                  <button
                    type="button"
                    className={`toggle__opt${standing ? " toggle__opt--on" : ""}`}
                    onClick={() => setStanding(true)}
                    aria-pressed={standing}
                  >
                    Every close for
                  </button>
                  {standing && (
                    <select
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value))}
                      aria-label="Days"
                    >
                      {[3, 5, 7, 14, 30].map((d) => (
                        <option key={d} value={d}>
                          {d} days
                        </option>
                      ))}
                    </select>
                  )}
                </fieldset>
              </div>

              <div className="readback" aria-live="polite">
                <p className="label">Your promise, word for word</p>
                <p className="readback__text">{preview ? `“${preview.promise}”` : "…"}</p>
                {standing && (
                  <p className="fine">
                    A fresh copy is locked before every close for {days} days. Each night gets its
                    own fingerprint and its own result.
                  </p>
                )}
                {preview && preview.issues.length > 0 && (
                  <ul className="issues">
                    {preview.issues.map((i) => (
                      <li key={i.field + i.message}>
                        {i.field.replace("params.", "")} {i.message}
                      </li>
                    ))}
                  </ul>
                )}
                {previewError && <p className="problem">{previewError}</p>}
              </div>

              {kind !== "hold" && (
                <div className="replay">
                  <div className="replay__head">
                    <p className="label">Your rule against the last finished night</p>
                    {result && (
                      <p className="replay__verdict">
                        {result.hit ? (
                          <>
                            It would have <strong>{kind === "buy_dip" ? "bought" : "sold"}</strong>{" "}
                            at {nyClock(result.hit.at)} New York, with the 24/7 price at{" "}
                            {usd(result.hit.price)}.
                          </>
                        ) : (
                          <>
                            It would <strong>not</strong> have acted. The closest the 24/7 price
                            came was {usd(result.extreme)} (
                            {pct(changePct(result.extreme, result.close))}).
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  {replay.status === "loading" && <Skeleton height={200} />}
                  {replay.status === "error" && (
                    <Problem message={replay.message} retry={replay.retry} />
                  )}
                  {replay.status === "ready" && result && (
                    <NightStrip
                      trace={replay.value}
                      now={now}
                      height={200}
                      replay
                      lines={[
                        {
                          value: result.level,
                          label: `Your trigger ${usd(result.level)}`,
                          tone: "trigger"
                        }
                      ]}
                      marks={
                        result.hit
                          ? [
                              {
                                at: result.hit.at,
                                label: kind === "buy_dip" ? "would buy" : "would sell",
                                tone: "trade"
                              }
                            ]
                          : []
                      }
                      title={`${stockName(ticker)}, ${windowName(replay.value.window.kind).toLowerCase()} from ${nyStamp(replay.value.window.closeTs)}`}
                    />
                  )}
                </div>
              )}

              <div className="panel__next">
                <button className="button button--ghost" type="button" onClick={() => setStep(0)}>
                  Back
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setStep(2)}
                  disabled={!preview?.valid}
                >
                  {preview?.valid ? "This is my plan" : "Fix the plan to continue"}
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="panel" aria-labelledby="s3">
              <h2 id="s3" className="panel__title">
                Choose how it trades
              </h2>
              <p className="panel__lede">
                Redeye never holds your money. It acts through a door you open, and only inside the
                plan you locked.
              </p>
              <div className="doors" role="radiogroup" aria-label="Door">
                {DOORS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={door === d.id}
                    className={`door${door === d.id ? " door--on" : ""}`}
                    onClick={() => setDoor(d.id)}
                  >
                    <span className="door__top">
                      <strong>{d.name}</strong>
                      <span
                        className={`door__state door__state--${d.state === "Live" ? "live" : "soon"}`}
                      >
                        {d.state}
                      </span>
                    </span>
                    <span className="door__body">{d.body}</span>
                  </button>
                ))}
              </div>
              <div className="panel__next">
                <button className="button button--ghost" type="button" onClick={() => setStep(1)}>
                  Back
                </button>
                <button className="button button--primary" type="button" onClick={() => setStep(3)}>
                  Continue
                </button>
              </div>
            </section>
          )}

          {step === 3 && preview && (
            <section className="panel" aria-labelledby="s4">
              <h2 id="s4" className="panel__title">
                What happens when you lock it
              </h2>
              <p className="readback__text readback__text--sm">“{preview.promise}”</p>
              <ol className="tline">
                <li>
                  <span className="tline__when">Now</span>
                  <strong>The plan's fingerprint goes on chain</strong>
                  <span>
                    PlanBook on BNB Chain stores <code>{preview.planHash.slice(0, 18)}…</code>.
                    Anyone can recompute it from the sentence above. After this it cannot be
                    changed.
                  </span>
                </li>
                <li>
                  <span className="tline__when">{nyStamp(preview.window.closeTs)}</span>
                  <strong>The {windowName(preview.window.kind).toLowerCase()} window starts</strong>
                  <span>
                    The agent checks the 24/7 price every minute against your trigger and logs each
                    check.
                  </span>
                </li>
                <li>
                  <span className="tline__when">If the trigger is hit</span>
                  <strong>The decision goes on chain first, then the trade</strong>
                  <span>
                    The quote is checked against the 24/7 price and your limits. Anything outside
                    the plan is refused with a reason.
                  </span>
                </li>
                <li>
                  <span className="tline__when">{nyStamp(preview.window.openTs)}</span>
                  <strong>Graded at the open</strong>
                  <span>
                    Kept, refused or broken, with the official opening price, published whatever
                    happens.
                  </span>
                </li>
              </ol>
              <div className="lockbox">
                <div>
                  <p className="label">Lock it before</p>
                  <p className="lockbox__time">{nyStamp(preview.window.lockBy)}</p>
                  <p className="fine">
                    {localStamp(preview.window.lockBy)} your time · five minutes before the close
                  </p>
                </div>
                <div className="lockbox__how">
                  {door === "signed" ? (
                    <SignAndLock
                      plan={plan}
                      preview={preview}
                      standing={standing}
                      days={days}
                      runId={standingRunId}
                    />
                  ) : door === "agentic" ? (
                    <>
                      <p>
                        With a Binance Agentic Wallet paired to a Redeye agent, this is exactly the
                        plan it locks. Copy it and send it to the agent before the deadline.
                      </p>
                      <CopyPlan plan={previewPlan} />
                    </>
                  ) : (
                    <>
                      <p>
                        This door is not open yet. Your plan is ready: copy it, and watch plans #2
                        and #3 run through the Agentic Wallet this weekend in the meantime.
                      </p>
                      <CopyPlan plan={previewPlan} />
                    </>
                  )}
                  <Link to="/record" className="arrowlink">
                    See the plans that are running now
                  </Link>
                </div>
              </div>
              <div className="panel__next">
                <button className="button button--ghost" type="button" onClick={() => setStep(2)}>
                  Back
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

type SignState =
  | { step: "idle" }
  | { step: "choosing"; wallets: WalletChoice[] }
  | { step: "busy"; label: string }
  | { step: "done"; id: string; planId: number; tx: string; owner: string }
  | { step: "standing-done"; id: string; owner: string }
  | { step: "error"; message: string };

/** Connect, sign the bounded permission, and have the agent lock it under the signer's address. */
function SignAndLock({
  plan,
  preview,
  standing,
  days,
  runId
}: {
  plan: Record<string, unknown>;
  preview: PlanPreview;
  standing: boolean;
  days: number;
  runId: string;
}) {
  const [state, setState] = useState<SignState>({ step: "idle" });

  const lockWith = async (wallet: WalletChoice) => {
    try {
      setState({ step: "busy", label: `Connecting ${wallet.name}…` });
      const owner = await connect(wallet);
      if (!standing && String(plan.kind) === "hold") {
        setState({ step: "busy", label: "Check the promise in your wallet and sign it…" });
        const { signature, issuedAt } = await signPlan(wallet, {
          promise: preview.promise,
          owner,
          ticker: String(plan.ticker),
          planHash: preview.planHash,
          windowCloseMs: preview.window.closeTs
        });
        setState({ step: "busy", label: "Locking it on BNB Chain…" });
        const locked = await agent.lockSigned({ plan, owner, issuedAt, signature });
        setState({
          step: "done",
          id: locked.id,
          planId: locked.planId,
          tx: locked.freeze.txHash,
          owner
        });
        return;
      }
      if (preview.permission === undefined) {
        throw new Error(
          "The agent has not configured a PlanAccount template and approved router yet."
        );
      }
      setState({ step: "busy", label: "Check the bounded trade permission in your wallet…" });
      const { signature, issuedAt } = await signPlanPermission(wallet, owner, preview.permission);
      setState({ step: "busy", label: "Authorize the PlanAccount delegation…" });
      const authorization = await signDelegation(wallet, owner, preview.permission.template);
      if (standing) {
        setState({ step: "busy", label: "Starting the standing run on BNB Chain…" });
        const started = await agent.startStanding({
          ...plan,
          days,
          runId,
          door: "plan_account",
          auditNoDataAccepted: true,
          owner,
          issuedAt,
          permission: preview.permission,
          permissionSignature: signature,
          authorization
        });
        setState({ step: "standing-done", id: String(started.id), owner });
      } else {
        setState({ step: "busy", label: "Locking it on BNB Chain…" });
        const locked = await agent.lockSigned({
          plan: { ...plan, door: "plan_account", auditNoDataAccepted: true },
          owner,
          issuedAt,
          permission: preview.permission,
          permissionSignature: signature,
          authorization
        });
        setState({
          step: "done",
          id: locked.id,
          planId: locked.planId,
          tx: locked.freeze.txHash,
          owner
        });
      }
    } catch (error) {
      setState({
        step: "error",
        message: error instanceof Error ? error.message : "Locking failed."
      });
    }
  };

  const start = async () => {
    setState({ step: "busy", label: "Looking for a wallet in this browser…" });
    const wallets = await discoverWallets();
    if (wallets.length === 0) {
      setState({
        step: "error",
        message:
          "No wallet found in this browser. Install MetaMask or Rabby, or open this page in the browser inside Trust Wallet or Binance Web3 Wallet."
      });
      return;
    }
    if (wallets.length === 1) void lockWith(wallets[0]!);
    else setState({ step: "choosing", wallets });
  };

  if (state.step === "done") {
    return (
      <div className="locked" role="status">
        <p className="locked__title">Locked as plan #{state.planId}, in your name.</p>
        <p>
          PlanBook now holds it under {state.owner.slice(0, 6)}…{state.owner.slice(-4)}. The bounded
          permission is recorded with it; the agent cannot use it for another plan.
        </p>
        <TxLink hash={state.tx}>lock transaction</TxLink>
        <Link to={`/runs/${state.id}`} className="arrowlink">
          Follow your plan through the night
        </Link>
      </div>
    );
  }
  if (state.step === "standing-done") {
    return (
      <div className="locked" role="status">
        <p className="locked__title">Standing run started in your name.</p>
        <p>
          PlanBook will receive one frozen copy before each close for {days} days. The same bounded
          permission can be used once per window and expires with this run.
        </p>
        <Link to="/record" className="arrowlink">
          Follow it in the public record
        </Link>
      </div>
    );
  }
  return (
    <>
      <p>
        Your wallet will show the exact token, amount, router and time bounds. Signing authorizes
        one bounded swap; it moves no funds and Redeye pays the network fee to lock it.
      </p>
      {state.step === "choosing" ? (
        <div className="walletlist">
          {state.wallets.map((w) => (
            <button
              key={w.id}
              type="button"
              className="button button--ghost"
              onClick={() => void lockWith(w)}
            >
              {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
              {w.name}
            </button>
          ))}
        </div>
      ) : (
        <button
          className="button button--primary"
          type="button"
          onClick={() => void start()}
          disabled={state.step === "busy" || !preview.valid}
        >
          {state.step === "busy" ? state.label : "Sign and lock it"}
        </button>
      )}
      {state.step === "error" && <p className="problem">{state.message}</p>}
    </>
  );
}

function CopyPlan({ plan }: { plan: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ ...plan, door: "agentic_wallet", auditNoDataAccepted: true }, null, 2)
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button className="button button--ghost" type="button" onClick={copy}>
      {copied ? "Copied" : "Copy the plan"}
    </button>
  );
}
