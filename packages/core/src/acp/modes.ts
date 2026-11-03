/** ACP v1 modes select tool admission; neither a mode nor its client label grants filesystem authority. */
import { acpText, type AcpLanguage } from "./text.ts";
export type AcpMode = "chat" | "coding";
/** Validate the closed mode ids without interpreting arbitrary editor text. */
export const isAcpMode = (value: unknown): value is AcpMode => value === "chat" || value === "coding";
/** ACP v1 mode metadata with stable ids and localized presentation. */
export function modeState(currentModeId: AcpMode, language: AcpLanguage = "en") {
  const text = acpText(language);
  return { currentModeId, availableModes: [
    { id: "chat", name: text.chatName, description: text.chatDescription },
    { id: "coding", name: text.codingName, description: text.codingDescription },
  ] };
}
