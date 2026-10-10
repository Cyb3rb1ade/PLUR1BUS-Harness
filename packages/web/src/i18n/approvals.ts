// Approvals: the texts of the OS confirmation (issue #192) that lifts one approval of a plain local connection to T2.
export const en = {
  "approvals.attest.required": "Confirmation by {method} is needed. It covers this approval only.",
  "approvals.attest.method.touchId": "Touch ID",
  "approvals.attest.method.macosPassword": "your Mac password",
  "approvals.attest.method.windowsHello": "Windows Hello",
  "approvals.attest.method.uac": "the Windows consent prompt",
  "approvals.attest.method.polkit": "your system password",
  "approvals.attest.method.system": "the operating system",
  "approvals.attest.cancelled": "The confirmation was cancelled. Nothing was approved.",
  "approvals.attest.timeout": "The confirmation timed out after 60 seconds. Nothing was approved.",
  "approvals.attest.failed": "The confirmation did not succeed. Nothing was approved.",
  "approvals.attest.unavailable": "A confirmation by the operating system is not available here. This connection can approve low-risk requests only.",
  "approvals.attest.inProgress": "Another decision for this request is waiting for its confirmation dialog.",
} as const;

export const de: Record<keyof typeof en, string> = {
  "approvals.attest.required": "Bestätigung durch {method} nötig. Sie gilt nur für diese Freigabe.",
  "approvals.attest.method.touchId": "Touch ID",
  "approvals.attest.method.macosPassword": "Ihr Mac-Passwort",
  "approvals.attest.method.windowsHello": "Windows Hello",
  "approvals.attest.method.uac": "die Windows-Zustimmungsabfrage",
  "approvals.attest.method.polkit": "Ihr Systempasswort",
  "approvals.attest.method.system": "das Betriebssystem",
  "approvals.attest.cancelled": "Die Bestätigung wurde abgebrochen. Nichts wurde freigegeben.",
  "approvals.attest.timeout": "Die Bestätigung ist nach 60 Sekunden abgelaufen. Nichts wurde freigegeben.",
  "approvals.attest.failed": "Die Bestätigung ist nicht gelungen. Nichts wurde freigegeben.",
  "approvals.attest.unavailable": "Eine Bestätigung durch das Betriebssystem ist hier nicht verfügbar. Diese Verbindung kann nur risikoarme Anfragen freigeben.",
  "approvals.attest.inProgress": "Eine andere Entscheidung für diese Anfrage wartet auf ihren Bestätigungsdialog.",
};
