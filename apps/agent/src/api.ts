import type { AgentApiConfig, AgentRequest, AgentResponse, AgentStore } from "./types.js";
import { StoreError } from "./sqlite-store.js";
import { verifyTelegramInitData } from "./telegram.js";

function json(status: number, body: unknown, config: AgentApiConfig): AgentResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": config.siteOrigin,
      "access-control-allow-headers":
        "content-type, authorization, x-owner-token, payment-signature",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    },
    body
  };
}

function error(
  status: number,
  code: string,
  reason: string,
  config: AgentApiConfig
): AgentResponse {
  return json(status, { error: { code, reason } }, config);
}

function pathParts(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
}

function telegramIdentity(initData: string, config: AgentApiConfig) {
  return verifyTelegramInitData(
    initData,
    config.telegramBotToken ?? "",
    config.telegramInitDataMaxAgeSeconds === undefined
      ? {}
      : { maxAgeSeconds: config.telegramInitDataMaxAgeSeconds }
  );
}

function ownerAuthorized(request: AgentRequest, config: AgentApiConfig): boolean {
  const bearer = request.headers.get("authorization");
  const token = request.headers.get("x-owner-token");
  return token === config.ownerToken || bearer === `Bearer ${config.ownerToken}`;
}

function writeRoute(request: AgentRequest): boolean {
  return request.method === "POST";
}

export function createAgentApi(store: AgentStore, config: AgentApiConfig) {
  if (config.ownerToken.trim().length === 0)
    throw new Error("Agent API ownerToken must not be empty.");
  if (config.siteOrigin.trim().length === 0)
    throw new Error("Agent API siteOrigin must not be empty.");

  return async function handle(request: AgentRequest): Promise<AgentResponse> {
    if (request.method === "OPTIONS") return json(204, null, config);
    const parts = pathParts(request.pathname);
    const [root, id, tail] = parts;
    try {
      if (request.method === "GET" && root === "health" && parts.length === 1)
        return json(200, await store.health(), config);
      if (request.method === "GET" && root === "passkey" && parts.length === 1)
        return json(
          200,
          config.passkeyStatus?.() ?? {
            available: false,
            rpId: "",
            factory: null,
            reason: "Passkey account deployment is not configured."
          },
          config
        );
      if (
        request.method === "POST" &&
        root === "passkey" &&
        (id === "preview" || id === "create" || id === "withdraw") &&
        parts.length === 2
      ) {
        const callback =
          id === "preview"
            ? config.passkeyPreview
            : id === "create"
              ? config.passkeyCreate
              : config.passkeyWithdraw;
        if (callback === undefined)
          return error(
            404,
            "PASSKEY_NOT_AVAILABLE",
            id === "preview"
              ? "Passkey account preview is not configured on this agent."
              : id === "create"
                ? "Passkey account creation is not configured on this agent."
                : "Passkey withdrawals are not configured on this agent.",
            config
          );
        if (config.telegramBotToken === undefined || config.telegramBotToken.trim().length === 0)
          return error(
            503,
            "PASSKEY_NOT_CONFIGURED",
            "Telegram verification is not configured on this agent.",
            config
          );
        if (
          typeof request.body !== "object" ||
          request.body === null ||
          Array.isArray(request.body)
        )
          return error(
            400,
            "PASSKEY_INVALID",
            "Send the passkey request as a JSON object.",
            config
          );
        const body = request.body as Record<string, unknown>;
        // In the phone's own browser, a handoff link from Telegram stands in for initData.
        const handoff =
          typeof body.handoff === "string" && config.passkeyHandoff !== undefined
            ? body.handoff
            : null;
        if (
          handoff === null &&
          (typeof body.telegramInitData !== "string" || body.telegramInitData.length === 0)
        )
          return error(
            400,
            "TELEGRAM_INIT_DATA_REQUIRED",
            "Telegram initData is required.",
            config
          );
        const identity =
          handoff !== null
            ? config.passkeyHandoff!.identity(handoff)
            : telegramIdentity(body.telegramInitData as string, config);
        const input = { ...body };
        delete input.telegramInitData;
        delete input.handoff;
        const result = await callback(input, identity);
        // Spent only once the account exists or money moved, so a failed try can be retried.
        if (handoff !== null && id !== "preview") config.passkeyHandoff!.spend(handoff);
        return json(200, result, config);
      }
      if (
        request.method === "POST" &&
        root === "passkey" &&
        id === "handoff" &&
        parts.length === 2
      ) {
        if (
          config.passkeyHandoff === undefined ||
          config.telegramBotToken === undefined ||
          config.telegramBotToken.trim().length === 0
        )
          return error(
            404,
            "PASSKEY_NOT_AVAILABLE",
            "Passkey handoff is not configured on this agent.",
            config
          );
        const body = request.body as Record<string, unknown> | null;
        if (typeof body?.telegramInitData !== "string" || body.telegramInitData.length === 0)
          return error(
            400,
            "TELEGRAM_INIT_DATA_REQUIRED",
            "Telegram initData is required.",
            config
          );
        const issued = config.passkeyHandoff.issue(telegramIdentity(body.telegramInitData, config));
        return json(
          200,
          {
            ...issued,
            // Keep the bearer token in the fragment so browsers never send it to web-server logs.
            url: `${config.siteOrigin}/new#handoff=${encodeURIComponent(issued.handoff)}`
          },
          config
        );
      }
      if (
        request.method === "GET" &&
        ((root === ".well-known" && id === "agent-registration.json" && parts.length === 2) ||
          (root === "identity" && parts.length === 1))
      )
        return config.identity === undefined
          ? error(404, "IDENTITY_NOT_PUBLISHED", "This agent has no public identity yet.", config)
          : json(200, config.identity, config);
      if (root === "x402" && config.x402 !== undefined) {
        const sale = await config.x402.handle(request);
        return {
          ...sale,
          headers: {
            ...sale.headers,
            "access-control-allow-origin": config.siteOrigin,
            "access-control-allow-headers":
              "content-type, authorization, x-owner-token, payment-signature",
            "access-control-allow-methods": "GET, POST, OPTIONS"
          }
        };
      }
      if (request.method === "GET" && root === "night" && id !== undefined && parts.length === 2) {
        if (!config.night)
          return error(404, "NOT_FOUND", "Night traces are not served here.", config);
        const close = request.query.get("close");
        const closeTs = close === null ? undefined : Number(close);
        if (closeTs !== undefined && !Number.isInteger(closeTs))
          return error(400, "CLOSE_INVALID", "close must be a time in milliseconds.", config);
        return json(200, await config.night(id, closeTs), config);
      }
      if (request.method === "POST" && root === "signed-plans" && parts.length === 1) {
        if (!config.lockSigned)
          return error(404, "NOT_FOUND", "Signed plans are not accepted here.", config);
        if (
          typeof request.body !== "object" ||
          request.body === null ||
          Array.isArray(request.body)
        )
          return error(400, "PLAN_INVALID", "Send the signed plan as a JSON object.", config);
        return json(201, await config.lockSigned(request.body as Record<string, unknown>), config);
      }
      if (request.method === "POST" && root === "preview" && parts.length === 1) {
        if (!config.preview)
          return error(404, "NOT_FOUND", "Plan checks are not served here.", config);
        if (
          typeof request.body !== "object" ||
          request.body === null ||
          Array.isArray(request.body)
        )
          return error(400, "PLAN_INVALID", "Send the plan as a JSON object.", config);
        return json(200, await config.preview(request.body as Record<string, unknown>), config);
      }
      if (request.method === "POST" && root === "preview-standing" && parts.length === 1) {
        if (!config.previewStanding)
          return error(404, "NOT_FOUND", "Standing plan checks are not served here.", config);
        if (
          typeof request.body !== "object" ||
          request.body === null ||
          Array.isArray(request.body)
        )
          return error(400, "PLAN_INVALID", "Send the standing plan as a JSON object.", config);
        return json(
          200,
          await config.previewStanding(request.body as Record<string, unknown>),
          config
        );
      }
      if (request.method === "GET" && root === "study" && parts.length === 1)
        return json(200, await store.study(), config);
      if (request.method === "GET" && root === "calendar" && parts.length === 1) {
        const rawDays = request.query.get("days") ?? "21";
        const days = Number(rawDays);
        if (!Number.isInteger(days) || days < 1 || days > 31)
          return error(400, "INVALID_DAYS", "days must be an integer from 1 to 31.", config);
        return json(200, await store.calendar(days), config);
      }
      if (request.method === "GET" && root === "prices" && parts.length === 1) {
        const rawTickers = request.query.get("tickers");
        const tickers = rawTickers
          ? rawTickers
              .split(",")
              .map((ticker) => ticker.trim().toUpperCase())
              .filter((ticker) => ticker.length > 0)
          : [];
        if (tickers.some((ticker) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)))
          return error(
            400,
            "INVALID_TICKER",
            "tickers must contain uppercase stock symbols.",
            config
          );
        return json(200, await store.prices(tickers), config);
      }
      if (request.method === "GET" && root === "windows" && id !== undefined && parts.length === 2)
        return json(200, await store.windows(id), config);
      if (request.method === "GET" && root === "feed" && parts.length === 1)
        return json(200, await store.feed(request.query.get("since")), config);
      if (request.method === "GET" && root === "tokens" && id !== undefined && parts.length === 2)
        return json(200, await store.token(id), config);
      if (request.method === "GET" && root === "history" && id !== undefined && parts.length === 2)
        return json(200, await store.history(id), config);
      if (request.method === "GET" && root === "record" && parts.length === 1)
        return json(200, await store.record(), config);
      if (request.method === "GET" && root === "binance" && parts.length === 1)
        return json(
          200,
          config.binanceStatus?.() ?? { state: "not_configured", modules: {} },
          config
        );
      if (request.method === "GET" && root === "wallet" && parts.length === 1)
        return json(200, await store.wallet(), config);
      if (request.method === "GET" && root === "plans" && id !== undefined && parts.length === 2)
        return json(200, await store.planGet(id), config);
      if (
        request.method === "GET" &&
        root === "runs" &&
        id !== undefined &&
        tail === undefined &&
        parts.length === 2
      )
        return json(200, await store.run(id), config);
      if (
        request.method === "GET" &&
        root === "runs" &&
        id !== undefined &&
        tail === "events" &&
        parts.length === 3
      )
        return json(200, await store.runEvents(id), config);
      if (
        request.method === "GET" &&
        root === "runs" &&
        id !== undefined &&
        tail === "receipt" &&
        parts.length === 3
      )
        return json(200, await store.receipt(id), config);
      if (request.method === "POST" && root === "replay" && parts.length === 1) {
        if (!ownerAuthorized(request, config))
          return error(
            401,
            "OWNER_AUTH_REQUIRED",
            "This action needs the agent owner token.",
            config
          );
        return json(201, await store.replay(request.body), config);
      }
      if (request.method === "POST" && root === "auth" && id === "signin" && parts.length === 2) {
        if (!ownerAuthorized(request, config))
          return error(
            401,
            "OWNER_AUTH_REQUIRED",
            "This action needs the agent owner token.",
            config
          );
        return json(200, await store.authSignin(request.body), config);
      }
      if (
        request.method === "GET" &&
        root === "auth" &&
        id === "verify" &&
        tail !== undefined &&
        parts.length === 3
      ) {
        if (!ownerAuthorized(request, config))
          return error(
            401,
            "OWNER_AUTH_REQUIRED",
            "This action needs the agent owner token.",
            config
          );
        return json(200, await store.authVerify(tail), config);
      }
      if (request.method === "GET" && root === "standing" && id !== undefined && parts.length === 2)
        return json(200, await store.standingGet(id), config);
      if (request.method === "POST" && root === "standing" && parts.length === 1) {
        const body = request.body;
        const signedWalletStanding =
          typeof body === "object" &&
          body !== null &&
          !Array.isArray(body) &&
          (body as Record<string, unknown>).door === "plan_account";
        if (!ownerAuthorized(request, config) && !signedWalletStanding)
          return error(
            401,
            "OWNER_AUTH_REQUIRED",
            "This action needs the agent owner token.",
            config
          );
        return json(201, await store.standingCreate(request.body), config);
      }
      if (
        request.method === "POST" &&
        root === "standing" &&
        id !== undefined &&
        tail === "stop" &&
        parts.length === 3
      ) {
        if (!ownerAuthorized(request, config))
          return error(
            401,
            "OWNER_AUTH_REQUIRED",
            "This action needs the agent owner token.",
            config
          );
        return json(200, await store.standingStop(id), config);
      }
      if (request.method === "POST" && root === "plans" && parts.length === 1) {
        if (!ownerAuthorized(request, config))
          return error(
            401,
            "OWNER_AUTH_REQUIRED",
            "This action needs the agent owner token.",
            config
          );
        return json(201, await store.planDraft(request.body), config);
      }
      if (
        request.method === "POST" &&
        root === "plans" &&
        id !== undefined &&
        tail !== undefined &&
        parts.length === 3
      ) {
        if (!ownerAuthorized(request, config))
          return error(
            401,
            "OWNER_AUTH_REQUIRED",
            "This action needs the agent owner token.",
            config
          );
        if (tail !== "lock" && tail !== "freeze" && tail !== "cancel")
          return error(
            404,
            "PLAN_ACTION_NOT_FOUND",
            "The requested plan action does not exist.",
            config
          );
        return json(200, await store.planAction(id, { action: tail, body: request.body }), config);
      }
      if (writeRoute(request))
        return error(
          404,
          "WRITE_ROUTE_NOT_FOUND",
          "The requested write route does not exist.",
          config
        );
      return error(404, "NOT_FOUND", "The requested Redeye resource does not exist.", config);
    } catch (caught) {
      if (caught instanceof StoreError)
        return error(caught.status, caught.code, caught.message, config);
      // Plan and night errors carry their own status and code.
      if (
        caught instanceof Error &&
        typeof (caught as { status?: unknown }).status === "number" &&
        typeof (caught as { code?: unknown }).code === "string"
      ) {
        const { status, code } = caught as Error & { status: number; code: string };
        return error(status, code, caught.message, config);
      }
      const reason =
        caught instanceof Error ? caught.message : "The agent store failed without a reason.";
      return error(500, "STORE_ERROR", reason, config);
    }
  };
}
