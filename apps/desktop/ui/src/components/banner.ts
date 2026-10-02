import { element } from "./dom.ts";

export function banner(message: string, kind: "info" | "error" = "info"): HTMLElement {
  const node = element("div", `banner banner-${kind}`, message);
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  return node;
}
