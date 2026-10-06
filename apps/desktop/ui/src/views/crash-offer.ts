import {element, append, restoreFocus} from "../components/dom.ts";
import {button} from "../components/button.ts";
export type CrashOffer = {id:string; details:string};
export async function showCrashOffers(offers:CrashOffer[], handled:(id:string)=>Promise<void>, copy:(text:string)=>Promise<void> = text => navigator.clipboard.writeText(text)):Promise<void> {
  const de = document.documentElement.lang.startsWith("de");
  for (const offer of offers) {
    await new Promise<void>(resolve => {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const dialog = element("dialog", "app-dialog"); dialog.dataset.crashOffer = "true";
      const title = element("h2", undefined, de ? "Vorheriger App-Absturz" : "Previous app crash");
      title.id = `crash-${crypto.randomUUID()}`; dialog.setAttribute("aria-labelledby", title.id);
      const details = element("pre", "crash-details", offer.details);
      const error = element("p"); error.setAttribute("role", "alert");
      const copyButton = button(de ? "Details kopieren" : "Copy details", async () => {
        try { await copy(offer.details); error.textContent = de ? "Details kopiert." : "Details copied."; }
        catch { error.textContent = de ? "Kopieren fehlgeschlagen." : "Copy failed."; }
      }, "secondary");
      const dismiss = button(de ? "Schließen" : "Dismiss", async () => {
        dismiss.disabled = true;
        try { await handled(offer.id); dialog.close(); }
        catch { error.textContent = de ? "Bestätigung fehlgeschlagen." : "Acknowledgment failed."; dismiss.disabled = false; }
      }, "primary");
      dialog.addEventListener("cancel", event => event.preventDefault());
      dialog.addEventListener("close", () => {dialog.remove(); restoreFocus(opener); resolve();}, {once:true});
      const footer = element("div", "dialog-footer"); append(footer, copyButton, dismiss);
      append(dialog, title, element("p", undefined, de ? "Diese Details bleiben lokal. Es wird nichts hochgeladen." : "These details stay local. Nothing is uploaded."), details, error, footer);
      document.body.append(dialog); dialog.showModal(); dismiss.focus();
    });
  }
}
