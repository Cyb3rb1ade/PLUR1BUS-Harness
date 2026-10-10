// Settings > Voice: language and profile with download, real-time mode, feature switches with their measured cost. Lazy chunk with its own CSS and catalogue.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { Card } from "../../../components/card.ts";
import { t } from "../../../i18n.ts";
import "../../../styles/voice.css";
import { currentRole, roleIn } from "../../common/load.ts";
import { LanguagePanel } from "../../voice/language.ts";
import { RealtimePanel } from "../../voice/realtime.ts";
import type { SectionProps } from "../page.ts";

export function VoiceSection({ section }: SectionProps): View {
  const canEdit = roleIn(currentRole(), ["owner", "admin"]);
  return h("section", { "data-section": section.id, "aria-labelledby": "voice-h", class: "voice" },
    h("h2", { id: "voice-h" }, t("voice.title")),
    h(Card, { title: t("voice.lang.title"), level: 3 }, h(LanguagePanel, { canEdit, mode: "settings" })),
    h(RealtimePanel, { canEdit }));
}
