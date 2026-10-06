import { element, append, restoreFocus } from "../components/dom.ts";
import { button } from "../components/button.ts";
import { translate } from "../i18n.ts";

export type QuitChoice = "keep-running" | "stop-bundled";
export type QuitOffer = {choice: QuitChoice; canStopHarness: boolean};
export type QuitActions = {confirm(choice: QuitChoice): Promise<void>; cancel(): Promise<void>};

export function openQuitDialog(offer: QuitOffer, actions: QuitActions): void {
  if (document.querySelector("dialog[data-quit]")) return;
  const locale = document.documentElement.lang.startsWith("de") ? "de" : "en";
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = element("dialog", "app-dialog");
  dialog.dataset.quit = "true";
  const heading = element("h2", undefined, t("quit.title"));
  heading.id = `quit-title-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  let choice: QuitChoice = "keep-running";
  const choices = element("div");
  for (const [value, key] of [["keep-running", "quit.keep"], ...(offer.canStopHarness ? [["stop-bundled", "quit.stop"]] : [])] as Array<[QuitChoice, Parameters<typeof translate>[1]]>) {
    const label = element("label", "quit-choice");
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "quit-choice"; radio.value = value; radio.checked = value === choice;
    radio.addEventListener("change", () => { if (radio.checked) choice = value; });
    append(label, radio, document.createTextNode(t(key))); choices.append(label);
  }
  const error = element("p", undefined, ""); error.setAttribute("role", "alert");
  let settled = false;
  const cancel = button(t("quit.cancel"), () => dialog.close(), "secondary");
  const confirm = button(t("quit.confirm"), async () => {
    confirm.disabled = true; cancel.disabled = true;
    try { await actions.confirm(choice); settled = true; dialog.close(); }
    catch { error.textContent = t("quit.failed"); confirm.disabled = false; cancel.disabled = false; }
  }, "primary");
  const footer = element("div", "dialog-footer");
  append(footer, cancel, confirm); append(dialog, heading, choices, error, footer);
  dialog.addEventListener("cancel", event => { if (confirm.disabled) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (!settled) void actions.cancel().catch(() => {});
    dialog.remove(); restoreFocus(opener);
  }, {once:true});
  document.body.append(dialog); dialog.showModal(); cancel.focus();
}
