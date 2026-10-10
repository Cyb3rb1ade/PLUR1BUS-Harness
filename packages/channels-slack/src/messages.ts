import { escapeSlackText } from "./mrkdwn.ts";

export type Locale = "en" | "de";

/** User-visible bot strings. Dynamic parts are escaped by the caller-facing helpers below. */
export interface Messages {
  pairingOk(pairingId: string): string;
  pairingFail: string;
  pairingDmOnly: string;
  usage(withPairing: boolean): string;
  status: string;
  received: string;
  approvalExpired: string;
  approvalForbidden: string;
  approvalDecided(label: string, userId: string): string;
  buttonReceived: string;
}

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    pairingOk: (pairingId) => `Pairing claimed. Pairing ID: ${escapeSlackText(pairingId)}. Confirm this link in My identities. Run: plur1bus identity approve ${escapeSlackText(pairingId)}`,
    pairingFail: "Pairing failed. Request a new code in My identities.",
    pairingDmOnly: "Please use this command in a direct message with me.",
    usage: (p) => (p ? "Usage: /plur1bus status | /plur1bus link CODE" : "Usage: /plur1bus status"),
    status: "plur1bus is connected.",
    received: "Received.",
    approvalExpired: "This button is expired or was already used. Please request a new one.",
    approvalForbidden: "You are not allowed to decide this request.",
    approvalDecided: (label, user) => `*Decision:* ${escapeSlackText(label)} (<@${user}>)`,
    buttonReceived: "_Received._",
  },
  de: {
    pairingOk: (pairingId) => `Kopplung angenommen. ID: ${escapeSlackText(pairingId)}. Bestätige diese Verknüpfung unter „Meine Identitäten“. Freigabe: plur1bus identity approve ${escapeSlackText(pairingId)}`,
    pairingFail: "Kopplung fehlgeschlagen. Fordere unter „Meine Identitäten“ einen neuen Code an.",
    pairingDmOnly: "Bitte verwende diesen Befehl in einer Direktnachricht an mich.",
    usage: (p) => (p ? "Verwendung: /plur1bus status | /plur1bus link CODE" : "Verwendung: /plur1bus status"),
    status: "plur1bus ist verbunden.",
    received: "Empfangen.",
    approvalExpired: "Diese Schaltfläche ist abgelaufen oder wurde schon verwendet. Bitte fordere eine neue an.",
    approvalForbidden: "Du darfst diese Anfrage nicht entscheiden.",
    approvalDecided: (label, user) => `*Entscheidung:* ${escapeSlackText(label)} (<@${user}>)`,
    buttonReceived: "_Empfangen._",
  },
};
