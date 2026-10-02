import { element, append } from "./dom.ts";
import { button } from "./button.ts";

export function openDialog(title: string, body: string, closeLabel: string, confirmLabel: string): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = element("dialog", "app-dialog");
  const heading = element("h2", undefined, title);
  heading.id = "dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const copy = element("p", undefined, body);
  const footer = element("div", "dialog-footer");
  const cancel = button(closeLabel, () => dialog.close(), "secondary");
  const confirm = button(confirmLabel, () => dialog.close(), "primary");
  const affirmativeFirst = document.documentElement.dataset.platform === "win" || document.documentElement.dataset.platform === "kde";
  append(footer, ...(affirmativeFirst ? [confirm, cancel] : [cancel, confirm]));
  append(dialog, heading, copy, footer);
  document.body.append(dialog);
  dialog.addEventListener("close", () => { dialog.remove(); opener?.focus(); }, { once: true });
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const first = affirmativeFirst ? confirm : cancel;
    const last = affirmativeFirst ? cancel : confirm;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.showModal();
  (affirmativeFirst ? confirm : cancel).focus();
}
