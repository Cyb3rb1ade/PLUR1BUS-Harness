export type Locale = "en" | "de";
export type MessageKey = "encryptedRoom" | "linkFailed" | "approvalHint" | "approvalGone";

const TABLE: Record<Locale, Record<MessageKey, string>> = {
  en: {
    encryptedRoom: "This room is end-to-end encrypted; this bot cannot read it yet. Please use an unencrypted room.",
    linkFailed: "Pairing failed. Request a new code in My identities.",
    approvalHint: "React to this message with the matching emoji to answer.",
    approvalGone: "This confirmation is no longer valid.",
  },
  de: {
    encryptedRoom:
      "Dieser Raum ist Ende-zu-Ende-verschlüsselt; dieser Bot kann ihn noch nicht lesen. Bitte einen unverschlüsselten Raum verwenden.",
    linkFailed: "Kopplung fehlgeschlagen. Bitte unter Meine Identitäten einen neuen Code anfordern.",
    approvalHint: "Zum Antworten mit dem passenden Emoji auf diese Nachricht reagieren.",
    approvalGone: "Diese Bestätigung ist nicht mehr gültig.",
  },
};

export function message(locale: Locale, key: MessageKey): string {
  return TABLE[locale][key];
}

export function pairingClaimed(locale: Locale, pairingId: string): string {
  return locale === "de"
    ? `Kopplung angefordert. ID: ${pairingId}. Bitte die Verknüpfung unter Meine Identitäten bestätigen. Freigabe: plur1bus identity approve ${pairingId}`
    : `Pairing claimed. Pairing ID: ${pairingId}. Confirm this link in My identities. Run: plur1bus identity approve ${pairingId}`;
}
