import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Role, type AgentCard, type Message, type Part } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import express from "express";
import type { McpSources } from "./mcp.js";

/** The A2A door reads the same sources as the MCP tools; every skill is read-only. */
export type A2aSources = McpSources;

export const A2A_PATH = "/a2a";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

const PLAN_KINDS = ["guard", "buy_dip", "sell_rise", "hold"];
const TICKER = /^[A-Za-z][A-Za-z0-9.-]{0,14}$/;

const SKILLS = [
  {
    id: "price",
    name: "24/7 price",
    description:
      "Latest checked prices for a tokenized US stock on BNB Chain: the last official close, the 24/7 price, the token price, the gaps between them, their ages and sources.",
    examples: ["price NVDA", '{"skill":"price","ticker":"NVDA"}']
  },
  {
    id: "windows",
    name: "Off-hours windows",
    description:
      "Off-hours windows (overnight, weekend, holiday) for a stock, each with its close time and the next official open.",
    examples: ["windows NVDA", '{"skill":"windows","ticker":"TSLA"}']
  },
  {
    id: "record",
    name: "Public record",
    description:
      "Every plan Redeye has locked: the promise, when it was locked before the close, its result at the open, and the chain transactions.",
    examples: ["record", '{"skill":"record"}']
  },
  {
    id: "run",
    name: "One plan",
    description:
      "One plan by id with its receipt when finished. The receipt can be checked by anyone with `npm run verify`.",
    examples: ["run 16f68a13-3232-4405-8a83-4da3ee007e38", '{"skill":"run","id":"<plan id>"}']
  },
  {
    id: "plan_check",
    name: "Check a plan",
    description:
      "Checks an off-hours plan against the next window it could lock for and returns the promise it would make, its fingerprint and the lock deadline. Nothing is saved or locked. Send the plan as a data part.",
    examples: [
      '{"skill":"plan_check","plan":{"ticker":"NVDA","kind":"guard","heldShares":"0.5","params":{"triggerDropPct":"3","sellPct":"50","maxPriceImpactPct":"1","minPoolDepthUsd":"100000","maxGapToRealPricePct":"1"}}}'
    ]
  }
] as const;

type SkillId = (typeof SKILLS)[number]["id"];

/** What a caller asked for, read from a data part or from a short text command. */
export type A2aAsk =
  | { skill: "price" | "windows"; ticker: string }
  | { skill: "record" }
  | { skill: "run"; id: string }
  | { skill: "plan_check"; plan: Record<string, unknown> };

export class AskError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tickerFrom(value: unknown): string {
  if (typeof value !== "string" || !TICKER.test(value)) {
    throw new AskError("A ticker such as NVDA is needed.");
  }
  return value.toUpperCase();
}

function askFromObject(value: Record<string, unknown>): A2aAsk {
  const skill = value.skill;
  if (skill === "price" || skill === "windows") {
    return { skill, ticker: tickerFrom(value.ticker) };
  }
  if (skill === "record") return { skill };
  if (skill === "run") {
    if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64) {
      throw new AskError("A plan id is needed.");
    }
    return { skill, id: value.id };
  }
  if (skill === "plan_check") {
    const plan = value.plan;
    if (!isRecord(plan)) throw new AskError("plan_check needs the plan as an object.");
    if (typeof plan.kind !== "string" || !PLAN_KINDS.includes(plan.kind)) {
      throw new AskError(`plan.kind must be one of: ${PLAN_KINDS.join(", ")}.`);
    }
    return { skill, plan: { ...plan, ticker: tickerFrom(plan.ticker) } };
  }
  throw new AskError(`Unknown skill. Redeye offers: ${SKILLS.map((s) => s.id).join(", ")}.`);
}

function askFromText(text: string): A2aAsk {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new AskError("The text looks like JSON but does not parse.");
    }
    if (!isRecord(parsed)) throw new AskError("Send one JSON object.");
    return askFromObject(parsed);
  }
  const [word = "", argument] = trimmed.split(/\s+/);
  const skill = word.toLowerCase();
  if (skill === "price" || skill === "windows") return askFromObject({ skill, ticker: argument });
  if (skill === "record") return { skill };
  if (skill === "run") return askFromObject({ skill, id: argument });
  throw new AskError(
    `Ask for one of: ${SKILLS.map((s) => s.examples[0]).join(" · ")}. A plan check goes as a data part.`
  );
}

/** Reads the request from the message: a data part wins over text. */
export function askFromMessage(message: Message): A2aAsk {
  for (const part of message.parts) {
    if (part.content?.$case === "data" && isRecord(part.content.value)) {
      return askFromObject(part.content.value);
    }
  }
  const text = message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join(" ")
    .trim();
  if (text.length === 0) throw new AskError("The message has no text or data part.");
  return askFromText(text);
}

async function answer(sources: A2aSources, ask: A2aAsk): Promise<{ text: string; data: unknown }> {
  switch (ask.skill) {
    case "price":
      return {
        text: `Latest checked prices for ${ask.ticker}.`,
        data: await sources.prices([ask.ticker])
      };
    case "windows":
      return {
        text: `Off-hours windows for ${ask.ticker}.`,
        data: await sources.windows(ask.ticker)
      };
    case "record":
      return {
        text: "Every plan Redeye has locked, with its result.",
        data: await sources.record()
      };
    case "run": {
      const plan = await sources.planGet(ask.id);
      const receipt = await sources.receipt(ask.id).catch(() => null);
      return {
        text:
          receipt === null
            ? `Plan ${ask.id}; it has no receipt yet.`
            : `Plan ${ask.id} with its receipt.`,
        data: { plan, receipt }
      };
    }
    case "plan_check":
      return {
        text: "The plan as checked against the next window it could lock for. Nothing was saved or locked.",
        data: await sources.preview(ask.plan)
      };
  }
}

function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain"
  };
}

function dataPart(value: unknown): Part {
  return {
    content: { $case: "data", value },
    metadata: undefined,
    filename: "",
    mediaType: "application/json"
  };
}

/**
 * Answers each message at once with one reply message: a short sentence plus the result
 * as data. Nothing runs long, so no task is kept; a bad request gets a plain explanation.
 */
export class RedeyeExecutor implements AgentExecutor {
  constructor(private readonly sources: A2aSources) {}

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    let parts: Part[];
    let metadata: Record<string, unknown>;
    try {
      const ask = askFromMessage(context.userMessage);
      const result = await answer(this.sources, ask);
      parts = [textPart(result.text), dataPart(result.data)];
      metadata = { skill: ask.skill satisfies SkillId, ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      parts = [textPart(reason)];
      metadata = { ok: false, reason: error instanceof AskError ? "BAD_REQUEST" : "SOURCE_FAILED" };
    }
    const reply: Message = {
      messageId: randomUUID(),
      contextId: context.contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts,
      metadata,
      extensions: [],
      referenceTaskIds: []
    };
    bus.publish(AgentEvent.message(reply));
    bus.finished();
  }

  async cancelTask(): Promise<void> {
    // Every answer is sent at once, so there is never a running task to cancel.
  }
}

export function redeyeAgentCard(baseUrl: string, version: string): AgentCard {
  const url = `${baseUrl.replace(/\/$/, "")}${A2A_PATH}`;
  return {
    name: "Redeye",
    description:
      "Redeye watches tokenized US stocks on BNB Chain while Wall Street is closed. Each plan is locked on chain before the close, checked every minute against the 24/7 price, and graded against the official open. These skills read its prices, windows and public record, and check a plan without locking it.",
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
      { url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "0.3" }
    ],
    provider: undefined,
    version,
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: SKILLS.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: ["tokenized-stocks", "bnb-chain", "off-hours"],
      examples: [...skill.examples],
      inputModes: ["text/plain", "application/json"],
      outputModes: ["text/plain", "application/json"],
      securityRequirements: []
    })),
    signatures: []
  };
}

/**
 * The A2A door: the agent card at /.well-known/agent-card.json and JSON-RPC at /a2a, through
 * the official SDK's own handlers. v0.3 callers (and callers that send no A2A-Version) are
 * answered through the SDK's compatibility layer.
 */
export function createA2aHandler(
  sources: A2aSources,
  baseUrl: string,
  version: string
): (request: IncomingMessage, response: ServerResponse) => void {
  const card = redeyeAgentCard(baseUrl, version);
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new RedeyeExecutor(sources)
  );
  const app = express();
  app.disable("x-powered-by");
  app.use(
    AGENT_CARD_PATH,
    agentCardHandler({
      agentCardProvider: requestHandler,
      legacyCompat: { enabled: true }
    })
  );
  app.use(
    A2A_PATH,
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true }
    })
  );
  return (request, response) => app(request, response);
}

export function isA2aPath(pathname: string): boolean {
  return pathname === AGENT_CARD_PATH || pathname === A2A_PATH || pathname === `${A2A_PATH}/`;
}
