// Placeholder, replaced by the users section implementation.
import { h } from "preact";
import type { View } from "../../../view.ts";
import type { SectionProps } from "../page.ts";

export function UsersSection({ section }: SectionProps): View {
  return h("section", { "data-section": section.id });
}
