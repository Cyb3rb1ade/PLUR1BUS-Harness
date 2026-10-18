// Unsaved edits of the Settings page. A section with a draft reports it here; the router's dirty guard then asks before anything leaves
// the section (sidebar, palette, links, the browser's back button, an edited address) and the browser asks before the tab is closed or reloaded.
import { path, registerDirtyGuard } from "../../router.ts";
import { t } from "../../i18n.ts";

let off: (() => void) | null = null;

/** Where `to` (a route as `navigate` takes it, query included) lands, without the query. */
const target = (to: string): string => to.split("?")[0]!;

/** Reports whether the open section holds edits that are not saved. */
export function setUnsaved(on: boolean): void {
  if (on === (off !== null)) return;
  if (on) {
    // Same route with another query (`?focus=`) keeps the section mounted, so the draft survives: no question. An empty target is the tab closing.
    off = registerDirtyGuard((to) => to === "" || target(to) !== path.value, () => t("settings.unsaved.confirm"));
  } else {
    off?.();
    off = null;
  }
}
