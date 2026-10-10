export type Locale = "en" | "de";
export interface Messages {
  pairOk(pairingId: string): string;
  pairFail: string;
  statusOnline: string;
  statusDegraded: string;
  notHere: string;
  buttonInvalid: string;
  buttonForbidden: string;
  decided: (label: string) => string;
  failed: string;
  cmdLink: string;
  cmdLinkCode: string;
  cmdStatus: string;
}
export const MESSAGES: Record<Locale, Messages> = {
  en: {
    pairOk: (pairingId) => `Pairing claimed. Pairing ID: ${pairingId}. Confirm this link in My identities. Run: plur1bus identity approve ${pairingId}`,
    pairFail: "Pairing failed. Request a new code in My identities.",
    statusOnline: "Online: gateway connected.",
    statusDegraded: "Degraded: the gateway connection is being re-established.",
    notHere: "This is not available here.",
    buttonInvalid: "This button is expired or invalid. Please request a new one.",
    buttonForbidden: "You are not allowed to use this button.",
    decided: (label) => `Decision recorded: ${label}`,
    failed: "Something went wrong. Please try again.",
    cmdLink: "Link your Discord identity (direct message only)",
    cmdLinkCode: "The pairing code from My identities",
    cmdStatus: "Show the bot status",
  },
  de: {
    pairOk: (pairingId) => `Kopplung angenommen. ID: ${pairingId}. Bestätige diese Verknüpfung unter Meine Identitäten. Freigabe: plur1bus identity approve ${pairingId}`,
    pairFail: "Kopplung fehlgeschlagen. Fordere unter Meine Identitäten einen neuen Code an.",
    statusOnline: "Online: Gateway verbunden.",
    statusDegraded: "Eingeschränkt: Die Gateway-Verbindung wird neu aufgebaut.",
    notHere: "Das ist hier nicht verfügbar.",
    buttonInvalid: "Diese Schaltfläche ist abgelaufen oder ungültig. Bitte fordere eine neue an.",
    buttonForbidden: "Du darfst diese Schaltfläche nicht verwenden.",
    decided: (label) => `Entscheidung erfasst: ${label}`,
    failed: "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    cmdLink: "Discord-Identität verknüpfen (nur per Direktnachricht)",
    cmdLinkCode: "Der Kopplungscode aus Meine Identitäten",
    cmdStatus: "Bot-Status anzeigen",
  },
};
