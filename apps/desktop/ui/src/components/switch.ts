import { element } from "./dom.ts";

export function switchControl(label: string, checked: boolean, onToggle: (checked: boolean) => void): HTMLButtonElement {
  const node = element("button", "switch-control");
  node.type = "button";
  node.setAttribute("role", "switch");
  node.setAttribute("aria-label", label);
  node.setAttribute("aria-checked", String(checked));
  node.append(element("span", "switch-thumb"));
  node.addEventListener("click", () => onToggle(node.getAttribute("aria-checked") !== "true"));
  return node;
}
