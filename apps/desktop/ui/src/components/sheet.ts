import { element, append, restoreFocus } from "./dom.ts";
import { button } from "./button.ts";

export function openSheet(title: string, body: Node, closeLabel: string, onClose?: () => void, side: "right" | "left" = "right"): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const shell = document.querySelector<HTMLElement>(".shell-mount");
  const scrim = element("div", side === "left" ? "sheet-scrim sidebar-overlay" : "sheet-scrim");
  const sheet = element("aside", `sheet sheet-${side}`);
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const heading = element("h2", undefined, title);
  heading.id = `sheet-title-${crypto.randomUUID()}`;
  sheet.setAttribute("aria-labelledby", heading.id);
  const close = button(closeLabel, dismiss, "quiet");
  close.classList.add("sheet-close");
  append(sheet, close, heading, body);
  append(scrim, sheet);
  document.body.append(scrim);
  if (shell) shell.inert = true;
  close.focus();
  function dismiss() {
    scrim.remove();
    if (shell) shell.inert = false;
    document.removeEventListener("keydown", keydown);
    queueMicrotask(() => { restoreFocus(opener); onClose?.(); });
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    if (event.key === "Tab") {
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>("button, a, input, select")).filter(n => n.getBoundingClientRect().width > 0);
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
    }
  }
  document.addEventListener("keydown", keydown);
  scrim.addEventListener("click", event => { if (event.target === scrim) dismiss(); });
}
