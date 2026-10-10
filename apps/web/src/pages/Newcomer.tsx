import { useEffect, useState } from "react";
import { TxLink } from "../components/bits";
import { agent, type PasskeyAccountResult, type PasskeyStatus } from "../lib/api";
import { useAgent } from "../lib/hooks";
import {
  loadPasskeyAccount,
  registerPasskey,
  savePasskeyAccount,
  signPasskeyWithdraw,
  telegramInitData,
  type PasskeyRegistrationMode,
  type RegisteredPasskey,
  type StoredPasskeyAccount
} from "../lib/passkey";
import { formatUnits, isAddress, parseUnits, type Address } from "viem";

const USDT = "0x55d398326f99059fF775485246999027B3197955";

type MoveState =
  | { step: "idle" }
  | { step: "busy"; label: string }
  | { step: "sent"; txHash: string }
  | { step: "error"; message: string };

/** Moves money out of a passkey account: the phone signs, Redeye relays and pays the fee. */
function MoveMoneyOut({ account }: { account: StoredPasskeyAccount }) {
  const binance = useAgent(() => agent.binance(), []);
  const tokens = [
    { label: "USDT", address: USDT },
    ...(binance.status === "ready"
      ? binance.value.bstocks.items
          .filter((t) => t.ticker && t.tokenAddress)
          .map((t) => ({ label: `${t.ticker} stock token`, address: t.tokenAddress! }))
      : [])
  ];
  const [token, setToken] = useState(USDT);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [state, setState] = useState<MoveState>({ step: "idle" });
  const label = tokens.find((t) => t.address === token)?.label ?? "token";

  useEffect(() => {
    let live = true;
    setBalance(null);
    import("../lib/withdraw")
      .then(({ readTokenBalance }) => readTokenBalance(token as Address, account.account))
      .then((value) => live && setBalance(value))
      .catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [token, account.account]);

  let raw: bigint | null = null;
  try {
    raw = amount.trim() === "" ? null : parseUnits(amount.trim(), 18);
  } catch {
    raw = null;
  }
  const ready =
    raw !== null && raw > 0n && isAddress(to.trim()) && (balance === null || raw <= balance);

  const send = async () => {
    const initData = telegramInitData();
    if (initData === null || raw === null) return;
    try {
      setState({ step: "busy", label: "Reading your account on BNB Chain…" });
      const { readWithdrawNonce } = await import("../lib/withdraw");
      const nonce = await readWithdrawNonce(account.account);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
      const request = {
        token: token as Address,
        to: to.trim() as Address,
        amount: raw,
        nonce,
        deadline
      };
      setState({ step: "busy", label: "Approve with your fingerprint, face or screen lock…" });
      const signature = await signPasskeyWithdraw(account, request);
      setState({ step: "busy", label: "Sending it on BNB Chain…" });
      const result = await agent.passkeyWithdraw({
        telegramInitData: initData,
        account: account.account,
        token,
        to: request.to,
        amount: raw.toString(),
        deadline: Number(deadline),
        signature
      });
      setState({ step: "sent", txHash: result.txHash });
    } catch (error) {
      setState({
        step: "error",
        message: error instanceof Error ? error.message : "Nothing was sent."
      });
    }
  };

  return (
    <section className="section--tight">
      <h2 className="h2">Move money out</h2>
      <p className="muted">
        Your money stays yours. Send it to any address on BNB Chain: your phone approves it and
        Redeye pays the fee.
      </p>
      {state.step === "sent" ? (
        <div className="locked" role="status">
          <p className="locked__title">Sent.</p>
          <TxLink hash={state.txHash}>transfer transaction</TxLink>
        </div>
      ) : (
        <div className="withdraw">
          <label className="field">
            <span>What to send</span>
            <select value={token} onChange={(e) => setToken(e.target.value)}>
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>
              Amount
              {balance !== null && ` · you have ${formatUnits(balance, 18)}`}
            </span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>To address</span>
            <input
              value={to}
              placeholder="0x…"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {ready && (
            <p className="fine">
              Your phone will ask you to approve sending {amount.trim()} {label} to{" "}
              {to.trim().slice(0, 6)}…{to.trim().slice(-4)}. Only this transfer, once, within 15
              minutes.
            </p>
          )}
          <button
            className="button button--primary"
            type="button"
            disabled={!ready || state.step === "busy" || telegramInitData() === null}
            onClick={() => void send()}
          >
            {state.step === "busy" ? state.label : "Approve and send"}
          </button>
          {state.step === "error" && <p className="problem">{state.message}</p>}
        </div>
      )}
    </section>
  );
}

type State =
  | { step: "idle" }
  | { step: "busy" }
  | { step: "ready"; passkey: RegisteredPasskey; account: PasskeyAccountResult }
  | { step: "error"; message: string };

export default function Newcomer() {
  const status = useAgent<PasskeyStatus>(() => agent.passkey(), [], 60_000);
  const [state, setState] = useState<State>({ step: "idle" });
  const [saved, setSaved] = useState<StoredPasskeyAccount | null>(() => loadPasskeyAccount());
  const insideTelegram = telegramInitData() !== null;
  const create = async (mode: PasskeyRegistrationMode) => {
    if (status.status !== "ready" || !status.value.available) return;
    setState({ step: "busy" });
    try {
      const passkey = await registerPasskey(status.value.rpId, mode);
      const initData = telegramInitData();
      if (initData === null) throw new Error("Open Redeye from Telegram to finish onboarding.");
      const request = { ...passkey, telegramInitData: initData };
      await agent.passkeyPreview(request);
      const account = await agent.passkeyCreate(request);
      savePasskeyAccount({
        ...passkey,
        account: account.account as `0x${string}`,
        owner: account.owner as `0x${string}`,
        rpId: status.value.rpId
      });
      setState({ step: "ready", passkey, account });
      setSaved(loadPasskeyAccount());
    } catch (error) {
      setState({
        step: "error",
        message: error instanceof Error ? error.message : "Passkey creation failed."
      });
    }
  };
  return (
    <main className="wrap section">
      <p className="eyebrow">New to crypto</p>
      <h1 className="display">Your device is the key. There is no seed phrase.</h1>
      <p className="lede">
        Redeye makes you an account on BNB Chain that only your phone can approve, with Face ID,
        fingerprint or screen lock. Redeye pays the fee to create it.
      </p>
      {!insideTelegram && (
        <p className="problem">
          Open this page from the Redeye Telegram bot, so the account is linked to you safely.
        </p>
      )}
      {status.status === "error" && (
        <p className="problem">Accounts can't be created right now. Please try again later.</p>
      )}
      {status.status === "ready" && !status.value.available && (
        <p className="problem">
          Accounts can't be created right now. Nothing was set up on your phone.
        </p>
      )}
      {state.step === "ready" ? (
        <div className="locked" role="status">
          <p className="locked__title">Your account is ready.</p>
          <p>
            It is linked to your Telegram and approved by this phone. Your account address is{" "}
            <code>{state.account.account}</code>.
          </p>
          {state.account.txHash && (
            <TxLink hash={state.account.txHash}>creation transaction</TxLink>
          )}
        </div>
      ) : (
        <div className="walletlist">
          <button
            className="button button--primary"
            type="button"
            disabled={
              !insideTelegram ||
              status.status !== "ready" ||
              !status.value.available ||
              state.step === "busy"
            }
            onClick={() => void create("device")}
          >
            {state.step === "busy" ? "Opening passkey prompt…" : "Use this phone or tablet"}
          </button>
          <button
            className="button button--ghost"
            type="button"
            disabled={
              !insideTelegram ||
              status.status !== "ready" ||
              !status.value.available ||
              state.step === "busy"
            }
            onClick={() => void create("flexible")}
          >
            Use another device or security key
          </button>
        </div>
      )}
      {state.step === "error" && <p className="problem">{state.message}</p>}
      {saved && <MoveMoneyOut account={saved} />}
    </main>
  );
}
