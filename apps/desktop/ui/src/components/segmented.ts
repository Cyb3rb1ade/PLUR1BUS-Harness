import { element, append } from "./dom.ts";

export function segmented<T extends string>(legend: string, options: readonly { value: T; label: string }[], selected: T, onChoose: (value: T) => void): HTMLFieldSetElement {
  const field = element("fieldset", "segmented-field");
  const title = element("legend", "sr-only", legend);
  const track = element("div", "segmented");
  for (const option of options) {
    const choice = element("button", "segment", option.label);
    choice.type = "button";
    choice.setAttribute("aria-pressed", String(option.value === selected));
    choice.addEventListener("click", () => onChoose(option.value));
    track.append(choice);
  }
  append(field, title, track);
  return field;
}
