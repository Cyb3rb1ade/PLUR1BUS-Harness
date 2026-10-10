import { element } from "./dom.ts";

export function wordmark(goHome: () => void): { node: HTMLButtonElement; set: (text: string, spoken: string, morph: boolean, subtitle?: string) => void } {
  const node = element("button", "wordmark");
  node.type = "button";
  node.addEventListener("click", goHome);
  let timer: number | undefined;
  let frame: number | undefined;
  function render(text: string, subtitle: string | undefined, collapsed: boolean) {
    node.replaceChildren();
    node.dataset.length = text.length > 12 ? "long" : text.length > 9 ? "medium" : "short";
    const letters = element("span", "wordmark-letters");
    const pivots = [...text].flatMap((letter, index) => letter === "1" ? [index] : []);
    const pivot = pivots.sort((a, b) => Math.abs(a - (text.length - 1) / 2) - Math.abs(b - (text.length - 1) / 2))[0];
    for (const [index, letter] of [...text].entries()) {
      letters.append(element("span", index === pivot ? "wordmark-one" : `wordmark-letter${collapsed ? " is-collapsed" : ""}`, letter));
    }
    node.append(letters);
    if (subtitle) node.append(element("span", "wordmark-subtitle", subtitle));
  }
  let previous: {text:string;spoken:string;subtitle:string|undefined}|undefined;
  return { node, set(text, spoken, morph, subtitle) {
    if(!morph && previous?.text===text && previous.spoken===spoken && previous.subtitle===subtitle)return;
    previous={text,spoken,subtitle};
    if (timer !== undefined) window.clearTimeout(timer);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    node.setAttribute("aria-label", spoken);
    node.title = spoken;
    if (!morph || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      render(text, subtitle, false); return;
    }
    node.querySelectorAll(".wordmark-letter").forEach(letter => letter.classList.add("is-collapsed"));
    node.querySelector(".wordmark-subtitle")?.remove();
    timer = window.setTimeout(() => {
      render(text, subtitle, true);
      frame = window.requestAnimationFrame(() => node.querySelectorAll(".wordmark-letter").forEach(letter => letter.classList.remove("is-collapsed")));
    }, 190);
  } };
}
