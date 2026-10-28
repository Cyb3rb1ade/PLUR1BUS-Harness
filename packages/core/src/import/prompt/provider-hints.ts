/** General copy-paste guidance only; no provider-specific memory access or menu paths have been verified. */

/** Source labels used by the prompt import tile when M supplies the UI. */
export type PromptProvider = "chatgpt" | "claude" | "gemini" | "grok" | "copilot" | "le-chat" | "other";

/** Short guidance for the eventual de/en interface; availability depends on the person's account and assistant. */
export const PROVIDER_HINTS: Readonly<Record<PromptProvider, Readonly<{ en: string; de: string }>>> = {
  chatgpt: {
    en: "Paste the prompt into a new ChatGPT chat with memory enabled, if available. Copy its reply here.",
    de: "Füge den Prompt in einen neuen ChatGPT-Chat mit eingeschaltetem Gedächtnis ein, falls verfügbar."
      + " Kopiere die Antwort hierher.",
  },
  claude: {
    en: "Paste the prompt into a new Claude chat with memory enabled, if available. Copy its reply here.",
    de: "Füge den Prompt in einen neuen Claude-Chat mit eingeschaltetem Gedächtnis ein, falls verfügbar."
      + " Kopiere die Antwort hierher.",
  },
  gemini: {
    en: "Paste the prompt into a new Gemini chat with memory enabled, if available. Copy its reply here.",
    de: "Füge den Prompt in einen neuen Gemini-Chat mit eingeschaltetem Gedächtnis ein, falls verfügbar."
      + " Kopiere die Antwort hierher.",
  },
  grok: {
    en: "Paste the prompt into a new Grok chat with memory enabled, if available. Copy its reply here.",
    de: "Füge den Prompt in einen neuen Grok-Chat mit eingeschaltetem Gedächtnis ein, falls verfügbar."
      + " Kopiere die Antwort hierher.",
  },
  copilot: {
    en: "Paste the prompt into a new Copilot chat with memory enabled, if available. Copy its reply here.",
    de: "Füge den Prompt in einen neuen Copilot-Chat mit eingeschaltetem Gedächtnis ein, falls verfügbar."
      + " Kopiere die Antwort hierher.",
  },
  "le-chat": {
    en: "Paste the prompt into a new Le Chat conversation with memory enabled, if available. Copy its reply here.",
    de: "Füge den Prompt in einen neuen Le-Chat-Chat mit eingeschaltetem Gedächtnis ein, falls verfügbar."
      + " Kopiere die Antwort hierher.",
  },
  other: {
    en: "Paste the prompt into a new chat with your assistant and enable memory, if available. Copy its reply here.",
    de: "Füge den Prompt in einen neuen Chat mit deinem Assistenten ein und schalte sein Gedächtnis ein,"
      + " falls verfügbar. Kopiere die Antwort hierher.",
  },
};
