export type Locale = "en" | "de";

/** User-visible bot strings. Fixed text only: never built from daemon or sender input. */
const TABLE = {
  en: {
    help: "/link <code> - link this Signal account to your identity\n/help - show this help",
    linkOk: "Pairing claimed. Confirm this link in My identities.",
    linkFail: "Pairing failed. Request a new code in My identities.",
    viewOnce: "View-once messages are not supported by this bot. Please send a normal message.",
    recorded: "Recorded.",
    refused: "This approval code is not valid for you or has expired.",
    promptHint: (token: string) => `Reply "${token} <number>" with the number of your choice (for example "${token} 1").`,
    mediaRefused: "This attachment could not be accepted (size or type).",
  },
  de: {
    help: "/link <code> - dieses Signal-Konto mit deiner Identität verknüpfen\n/help - diese Hilfe anzeigen",
    linkOk: "Kopplung angenommen. Bestätige die Verknüpfung unter Meine Identitäten.",
    linkFail: "Kopplung fehlgeschlagen. Fordere einen neuen Code unter Meine Identitäten an.",
    viewOnce: "Einmal-Ansichten werden von diesem Bot nicht unterstützt. Bitte sende eine normale Nachricht.",
    recorded: "Gespeichert.",
    refused: "Dieser Freigabe-Code ist für dich nicht gültig oder abgelaufen.",
    promptHint: (token: string) => `Antworte mit "${token} <Nummer>" und der Nummer deiner Wahl (z. B. "${token} 1").`,
    mediaRefused: "Dieser Anhang konnte nicht angenommen werden (Größe oder Typ).",
  },
} as const;

export function messages(locale: Locale) {
  return TABLE[locale];
}
