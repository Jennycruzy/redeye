export type ClientErrorKind = "transport" | "http" | "shape";

export class ClientError extends Error {
  readonly kind: ClientErrorKind;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    kind: ClientErrorKind,
    message: string,
    context: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "ClientError";
    this.kind = kind;
    this.context = context;
  }
}
