import { element } from "./dom.ts";

export function button(label: string, onClick: () => void, variant: "primary" | "secondary" | "quiet" = "secondary"): HTMLButtonElement {
  const node = element("button", `button button-${variant}`, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
