import { useState } from "react";
import { TxLink } from "../components/bits";
import { agent, type PasskeyAccountResult, type PasskeyStatus } from "../lib/api";
import { useAgent } from "../lib/hooks";
import {
  registerPasskey,
  savePasskeyAccount,
  telegramInitData,
  type PasskeyRegistrationMode,
  type RegisteredPasskey
} from "../lib/passkey";

type State =
  | { step: "idle" }
  | { step: "busy" }
  | { step: "ready"; passkey: RegisteredPasskey; account: PasskeyAccountResult }
  | { step: "error"; message: string };

export default function Newcomer() {
  const status = useAgent<PasskeyStatus>(() => agent.passkey(), [], 60_000);
  const [state, setState] = useState<State>({ step: "idle" });
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
    </main>
  );
}
