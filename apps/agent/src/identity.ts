import { getAddress, isAddress } from "viem";

/** ERC-8004 registries on BNB Chain (chain 56), read on chain on 2026-10-07: AgentIdentity v2.0.0. */
export const BSC_CHAIN_ID = 56;
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export interface IdentityConfig {
  /** Public https address of this agent's API, without a trailing slash. */
  agentUrl: string;
  /** Public https address of the site, or null while it is not public. */
  siteUrl: string | null;
  /** Token id in the identity registry, or null before registration. */
  agentId: string | null;
  agentAddress: string;
  planBook: string;
  planAccount: string | null;
  /** Public source code, or null while the repository is private. */
  repoUrl: string | null;
}

export interface IdentityService {
  name: string;
  endpoint: string;
  version?: string;
}

export interface IdentityCard {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  services: IdentityService[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
  contracts: { name: string; chainId: number; address: string }[];
}

function publicUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a full URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${field} must use https.`);
  return url.toString().replace(/\/$/, "");
}

function checksum(value: string, field: string): string {
  if (!isAddress(value)) throw new Error(`${field} must be an address.`);
  return getAddress(value);
}

/** Registry id in the CAIP-10 form ERC-8004 uses: eip155:{chain}:{registry}. */
export function agentRegistry(): string {
  return `eip155:${BSC_CHAIN_ID}:${IDENTITY_REGISTRY}`;
}

/**
 * Builds the ERC-8004 registration file. It lists only services that exist today, so the
 * card never claims x402 sales or an MCP server before they are live.
 */
export function buildIdentityCard(config: IdentityConfig): IdentityCard {
  const agentUrl = publicUrl(config.agentUrl, "agentUrl");
  const services: IdentityService[] = [];
  if (config.siteUrl !== null) {
    services.push({ name: "web", endpoint: publicUrl(config.siteUrl, "siteUrl") });
  }
  services.push(
    { name: "record", endpoint: `${agentUrl}/record` },
    { name: "health", endpoint: `${agentUrl}/health` },
    { name: "MCP", endpoint: `${agentUrl}/mcp` }
  );
  if (config.repoUrl !== null) {
    services.push({ name: "source", endpoint: publicUrl(config.repoUrl, "repoUrl") });
  }
  const registrations: IdentityCard["registrations"] = [];
  if (config.agentId !== null) {
    if (!/^\d+$/.test(config.agentId)) throw new Error("agentId must be a whole number.");
    registrations.push({ agentId: Number(config.agentId), agentRegistry: agentRegistry() });
  }
  const contracts = [
    { name: "PlanBook", chainId: BSC_CHAIN_ID, address: checksum(config.planBook, "planBook") }
  ];
  if (config.planAccount !== null) {
    contracts.push({
      name: "PlanAccount",
      chainId: BSC_CHAIN_ID,
      address: checksum(config.planAccount, "planAccount")
    });
  }
  checksum(config.agentAddress, "agentAddress");
  return {
    type: REGISTRATION_TYPE,
    name: "Redeye",
    description:
      "Redeye watches tokenized US stocks on BNB Chain while Wall Street is closed. Each plan is locked on chain before the close, checked every minute against the 24/7 price, and graded against the official open.",
    services,
    x402Support: false,
    active: true,
    registrations,
    supportedTrust: ["reputation"],
    contracts
  };
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/** Reads the identity settings; returns null when the agent has no public address yet. */
export function identityConfigFromEnv(
  env: Record<string, string | undefined>,
  agentAddress: string | null
): IdentityConfig | null {
  const agentUrl = optional(env.PUBLIC_AGENT_URL);
  const planBook = optional(env.PLANBOOK_ADDRESS);
  if (agentUrl === null || planBook === null || agentAddress === null) return null;
  return {
    agentUrl,
    siteUrl: optional(env.PUBLIC_SITE_URL),
    agentId: optional(env.ERC8004_AGENT_ID),
    agentAddress,
    planBook,
    planAccount: optional(env.PLANACCOUNT_ADDRESS),
    repoUrl: optional(env.PUBLIC_REPO_URL)
  };
}
