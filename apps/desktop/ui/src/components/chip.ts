import { element } from "./dom.ts";

export function chip(label: string, kind: "neutral" | "ok" = "neutral"): HTMLElement {
  return element("span", `chip chip-${kind}`, label);
}
