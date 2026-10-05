export interface AgentStore {
  health(): Promise<unknown>;
  calendar(days: number): Promise<unknown>;
  feed(since: string | null): Promise<unknown>;
  token(ticker: string): Promise<unknown>;
  history(ticker: string): Promise<unknown>;
  record(): Promise<unknown>;
  wallet(): Promise<unknown>;
  planGet(id: string): Promise<unknown>;
  run(runId: string): Promise<unknown>;
  runEvents(runId: string): Promise<unknown>;
  receipt(runId: string): Promise<unknown>;
  replay(body: unknown): Promise<unknown>;
  authSignin(body: unknown): Promise<unknown>;
  authVerify(qrCodeId: string): Promise<unknown>;
  planDraft(body: unknown): Promise<unknown>;
  planAction(id: string, body: unknown): Promise<unknown>;
}

export interface AgentApiConfig {
  ownerToken: string;
  siteOrigin: string;
}

export interface AgentRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Headers;
  body?: unknown;
}

export interface AgentResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
