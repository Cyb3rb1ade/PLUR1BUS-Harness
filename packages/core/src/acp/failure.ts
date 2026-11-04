/** Fixed ACP-facing failures. Provider/Core error prose never crosses this boundary or enters diagnostics. */
import { acpText } from "./text.ts";
export type AcpFailureReason = keyof ReturnType<typeof acpText>["failures"];

/** A known refusal with a static explanation, never an arbitrary downstream error message. */
export class AcpFailure extends Error {
  readonly reason: AcpFailureReason;

  constructor(reason: AcpFailureReason) {
    super(acpText().failures[reason]);
    this.name = "AcpFailure";
    this.reason = reason;
  }
}
