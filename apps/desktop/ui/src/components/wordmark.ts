import { element } from "./dom.ts";

export function wordmark(goHome: () => void): { node: HTMLButtonElement; set: (text: string, spoken: string, morph: boolean) => void } {
  const node = element("button", "wordmark");
  node.type = "button";
  node.addEventListener("click", goHome);
  let timer: number | undefined;
  function render(text: string, spoken: string) {
    node.replaceChildren();
    node.dataset.length = text.length > 12 ? "long" : text.length > 9 ? "medium" : "short";
    node.setAttribute("aria-label", spoken);
    node.title = spoken;
    for (const letter of text) node.append(element("span", letter === "1" ? "wordmark-one" : "", letter));
  }
  return { node, set(text, spoken, morph) {
    if (timer !== undefined) window.clearTimeout(timer);
    if (!morph || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.classList.remove("wordmark-collapsed"); render(text, spoken); return;
    }
    node.classList.add("wordmark-collapsed");
    timer = window.setTimeout(() => { render(text, spoken); node.classList.remove("wordmark-collapsed"); }, 190);
  } };
}
