/** Bilingual ACP presentation; protocol ids and Core error codes remain language-independent. */
export type AcpLanguage = "en" | "de";

const EN = {
  chatName: "Chat", chatDescription: "Use the agent's conversational tool profile",
  codingName: "Coding", codingDescription: "Use the coding profile in the granted worktree",
  profileChanged: "Harness: switching modes changes the tool offer; " +
    "expect one prompt-cache miss on the next model request.\n",
  approvalRefused: "Harness: the editor's permission choice was refused by the core.\n",
  allowOnce: "Allow once", allowTask: "Allow for this task, until it ends",
  allowSession: "Allow for this session, until it ends", always: "Always", deny: "Deny",
  risk: "Risk", agentReason: "Agent reason (unverified)", patchPreview: "Agent patch preview (unverified)",
  patch: "Unified text patch", toolResult: "Tool result", unknownContents: "complete before/after contents unavailable",
  truncated: "truncated", sizeLimit: "size limit", toolFailed: "tool failed", noPatch: "no unified patch supplied",
  displayClipped: "[display clipped at 32 KiB]",
  failures: {
    "root-not-granted": "This folder is not granted. Approve it from an interactive local plur1bus code session first.",
    "coding-unavailable": "This Core does not provide the ACP coding profile. Update the Core first.",
    "unknown-session": "This ACP connection does not own that session.",
    "delivery-unavailable": "This Core does not provide steering or queued delivery.",
    "mode-unavailable": "This Core does not provide ACP session modes.",
    "session-limit": "This ACP connection has reached its session limit.",
  },
};
type AcpText = { [Key in keyof typeof EN]: Key extends "failures" ?
  Record<keyof typeof EN.failures, string> : string };

const DE: AcpText = {
  chatName: "Chat", chatDescription: "Das Gesprächsprofil des Agenten verwenden",
  codingName: "Programmieren", codingDescription: "Das Coding-Profil im freigegebenen Worktree verwenden",
  profileChanged: "Harness: Der Moduswechsel ändert das Werkzeugangebot; " +
    "beim nächsten Modellaufruf ist ein Prompt-Cache-Miss zu erwarten.\n",
  approvalRefused: "Harness: Der Core hat die Freigabeauswahl aus dem Editor abgelehnt.\n",
  allowOnce: "Einmal erlauben", allowTask: "Für diese Aufgabe erlauben, bis sie endet",
  allowSession: "Für diese Sitzung erlauben, bis sie endet", always: "Immer", deny: "Ablehnen",
  risk: "Risiko", agentReason: "Begründung des Agenten (ungeprüft)",
  patchPreview: "Patch-Vorschau des Agenten (ungeprüft)",
  patch: "Unified-Text-Patch", toolResult: "Werkzeugergebnis",
  unknownContents: "vollständiger Vorher-/Nachher-Inhalt nicht verfügbar",
  truncated: "gekürzt", sizeLimit: "Größengrenze", toolFailed: "Werkzeug fehlgeschlagen",
  noPatch: "kein Unified-Patch geliefert", displayClipped: "[Anzeige bei 32 KiB gekürzt]",
  failures: {
    "root-not-granted": "Dieser Ordner ist nicht freigegeben. " +
      "Zuerst in einer interaktiven lokalen Sitzung mit plur1bus code freigeben.",
    "coding-unavailable": "Dieser Core bietet das ACP-Coding-Profil nicht an. Zuerst den Core aktualisieren.",
    "unknown-session": "Diese ACP-Verbindung besitzt diese Sitzung nicht.",
    "delivery-unavailable": "Dieser Core bietet Steering und Folge-Warteschlange nicht an.",
    "mode-unavailable": "Dieser Core bietet keine ACP-Sitzungsmodi an.",
    "session-limit": "Diese ACP-Verbindung hat ihre Sitzungsgrenze erreicht.",
  },
};

/** Match the native CLI's existing locale precedence; no new configuration or environment key. */
export function acpLanguage(env: Readonly<Record<string, string | undefined>> = process.env): AcpLanguage {
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find(value => value !== undefined && value !== "");
  return locale?.startsWith("de") ? "de" : "en";
}

/** Fixed strings only; untrusted provider text is never substituted into these notices. */
export function acpText(language: AcpLanguage = "en"): AcpText {
  return language === "de" ? DE : EN;
}
