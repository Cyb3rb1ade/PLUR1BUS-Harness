import { translate, type MessageKey, type Locale } from "../i18n.ts";
const messages = new Set<MessageKey>([
  "runtime.not-found", "runtime.too-old", "runtime.no-access", "runtime.wrong-mode",
  "runtime.stopped", "runtime.object-missing", "runtime.conflict", "runtime.timeout",
  "runtime.failed", "runtime.remote-endpoint-ignored",
]);
/** Native errors supply a closed code; arbitrary engine output never becomes UI text. */
export function runtimeMessage(locale: Locale, code: unknown): string {
  const key = typeof code === "string" && messages.has(code as MessageKey) ? code as MessageKey : "runtime.failed";
  return translate(locale, key);
}
