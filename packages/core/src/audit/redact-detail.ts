// An audit event's `detail` is written to audit.log and to the hash chain. It goes through the same D111 redactor as the
// diagnostic logs (`logs/redact.ts`, data in `packages/log-schema/schema/redaction.json`), so a secret-keyed value or a credential
// shape inside it never reaches disk. Producers still must not put secrets there; this is the net underneath them.
import { createRedactor } from "../logs/redact.ts";

const redactor = createRedactor();

/**
 * The redacted copy of `detail`, as it will be serialised. The value is normalised through JSON first, so what is redacted is what
 * would be written (a `toJSON` result, a Date as its ISO string; an `undefined` member is gone either way). Throws, like the
 * serialisation itself, for a value JSON cannot hold (a cycle, a BigInt): the callers treat an event that cannot be written as not recorded.
 */
export function redactAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return redactor.value(JSON.parse(JSON.stringify(detail)) as Record<string, unknown>);
}
