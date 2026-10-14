// Unsaved edits of the Settings page. A section with a draft reports it here; the page's own navigation asks before it drops the
// draft, and the browser asks before the tab is closed or reloaded. The router is not touched: other pages' links do not ask.
import { t } from "../../i18n.ts";

let dirty = false;
const warn = (e: Event): void => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ""; };

/** Reports whether the open section holds edits that are not saved. */
export function setUnsaved(on: boolean): void {
  if (on === dirty) return;
  dirty = on;
  if (on) globalThis.addEventListener?.("beforeunload", warn); else globalThis.removeEventListener?.("beforeunload", warn);
}

/** True when leaving is fine: nothing unsaved, or the person agreed to lose it. */
export function leaveAllowed(): boolean {
  if (!dirty) return true;
  const ok = typeof globalThis.confirm === "function" ? globalThis.confirm(t("settings.unsaved.confirm")) : true;
  if (ok) setUnsaved(false);
  return ok;
}
