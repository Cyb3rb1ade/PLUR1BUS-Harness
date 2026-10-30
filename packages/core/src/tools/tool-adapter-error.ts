/** Composition adapters preserve typed tool failures for the dispatcher without changing their diagnostic error text. */

/** Wrap a typed tool result; its detail is validated before use at the N1 model boundary. */
export class ToolAdapterError extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, detail: unknown) {
    super(code);
    this.name = "ToolAdapterError";
    this.code = code;
    this.detail = detail;
  }
}
