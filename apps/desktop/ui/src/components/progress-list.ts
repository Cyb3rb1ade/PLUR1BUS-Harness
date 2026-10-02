import { element, append } from "./dom.ts";

export function progressList(title: string, rows: readonly { label: string; state: "waiting" | "done" }[]): HTMLElement {
  const section = element("section", "progress-card");
  const heading = element("h2", "card-title", title);
  const list = element("ol", "progress-list");
  list.setAttribute("aria-live", "polite");
  for (const row of rows) {
    const item = element("li", `progress-item progress-${row.state}`);
    append(item, element("span", "progress-dot"), element("span", undefined, row.label));
    list.append(item);
  }
  append(section, heading, list);
  return section;
}
