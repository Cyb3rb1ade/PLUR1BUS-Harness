// Setup step "Language for voice features": the same language panel as Settings > Voice, with the system language preselected.
// Lazy chunk with its own CSS and catalogue (the panel registers the voice area). Skippable; leaving it without a download counts as skipped.
import { h } from "preact";
import type { View } from "../../view.ts";
import "../../styles/voice.css";
import { currentRole, roleIn } from "../common/load.ts";
import { LanguagePanel } from "../voice/language.ts";
import type { StepProps } from "./steps.ts";

export function VoiceStep({ a, set }: StepProps): View {
  return h("div", { class: "voice-step" },
    h(LanguagePanel, { canEdit: roleIn(currentRole(), ["owner", "admin"]), mode: "setup", initial: a.voice, onApplied: (v) => { set({ voice: v }); } }));
}
