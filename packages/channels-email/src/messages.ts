export type Locale = "en" | "de";
export interface Messages {
  linkOk: string;
  linkFail: string;
  approvalRefused: string;
  approvalSubject: string;
  approvalHowTo: (token: string, choices: readonly { n: number; id: string; label: string }[], expiresInMin: number) => string;
  truncated: string;
  rateLimited: string;
}
const en: Messages = {
  linkOk: "Pairing claimed. Confirm this link in My identities.",
  linkFail: "Pairing failed. Request a new code in My identities.",
  approvalRefused: "This approval code is invalid, expired, already used or not for you. Nothing was approved.",
  approvalSubject: "Approval needed",
  approvalHowTo: (token, choices, min) =>
    `To answer, reply to this email with one line:\n${choices.map((c) => `  ${token} ${c.n}   = ${c.label}`).join("\n")}\nThe code works once and expires in about ${min} minutes.`,
  truncated: "[message truncated]",
  rateLimited: "email reply rate limit reached",
};
const de: Messages = {
  linkOk: "Verknüpfung angefordert. Bitte unter „Meine Identitäten“ bestätigen.",
  linkFail: "Verknüpfung fehlgeschlagen. Bitte unter „Meine Identitäten“ einen neuen Code anfordern.",
  approvalRefused: "Dieser Freigabecode ist ungültig, abgelaufen, schon benutzt oder nicht für Sie. Es wurde nichts freigegeben.",
  approvalSubject: "Freigabe erforderlich",
  approvalHowTo: (token, choices, min) =>
    `Zum Antworten schreiben Sie eine Zeile als Antwort auf diese E-Mail:\n${choices.map((c) => `  ${token} ${c.n}   = ${c.label}`).join("\n")}\nDer Code gilt einmal und läuft in etwa ${min} Minuten ab.`,
  truncated: "[Nachricht gekürzt]",
  rateLimited: "E-Mail-Antwortlimit erreicht",
};
export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, de };
