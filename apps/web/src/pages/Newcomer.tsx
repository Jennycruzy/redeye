import { useState } from "react";
import { agent, type PasskeyAccountResult, type PasskeyStatus } from "../lib/api";
import { useAgent } from "../lib/hooks";
import {
  registerPasskey,
  savePasskeyAccount,
  telegramInitData,
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
  const create = async () => {
    if (status.status !== "ready" || !status.value.available) return;
    setState({ step: "busy" });
    try {
      const passkey = await registerPasskey(status.value.rpId);
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
      <h1 className="display">Your face is the key. There is no seed phrase.</h1>
      <p className="lede">
        Redeye creates a dedicated PlanAccount on BNB Chain. Face ID or your device passkey signs
        bounded plans; Redeye sponsors the account-creation fee.
      </p>
      {!insideTelegram && (
        <p className="problem">
          Open this page from the Redeye Telegram bot to bind the account safely.
        </p>
      )}
      {status.status === "error" && <p className="problem">The account service is unavailable.</p>}
      {status.status === "ready" && !status.value.available && (
        <p className="problem">
          Passkey account deployment is not configured yet. No credential was created.
        </p>
      )}
      {state.step === "ready" ? (
        <div className="locked" role="status">
          <p className="locked__title">Passkey created on this device.</p>
          <p>
            Credential {state.passkey.credentialId.slice(0, 10)}… is bound to Telegram. Your
            PlanAccount is {state.account.state === "existing" ? "already live" : "now live"} at{" "}
            <code>{state.account.account}</code>.
          </p>
          {state.account.txHash && <p>Deployment: {state.account.txHash}</p>}
        </div>
      ) : (
        <button
          className="button button--primary"
          type="button"
          disabled={
            !insideTelegram ||
            status.status !== "ready" ||
            !status.value.available ||
            state.step === "busy"
          }
          onClick={() => void create()}
        >
          {state.step === "busy" ? "Creating passkey…" : "Create with Face ID"}
        </button>
      )}
      {state.step === "error" && <p className="problem">{state.message}</p>}
    </main>
  );
}
