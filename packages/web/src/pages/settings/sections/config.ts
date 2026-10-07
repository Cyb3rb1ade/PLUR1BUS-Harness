// Placeholder, replaced by the config section implementation.
import { h } from "preact";
import type { View } from "../../../view.ts";
import type { SectionProps } from "../page.ts";

export function ConfigSection({ section }: SectionProps): View {
  return h("section", { "data-section": section.id });
}
