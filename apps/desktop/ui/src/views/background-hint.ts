import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import { translate } from "../i18n.ts";
let shown = false;
/** Separate from the shell render root; repeated probes and rerenders cannot duplicate it. */
export function showBackgroundHint(): void {
  if (shown) return;
  shown = true;
  const locale = document.documentElement.lang.startsWith("de") ? "de" : "en";
  const panel = element("aside", "banner toast");
  panel.dataset.backgroundHint = "true";
  panel.setAttribute("role", "status");
  const dismiss = button(translate(locale, "background.dismiss"), () => panel.remove(), "quiet");
  append(panel, element("p", undefined, translate(locale, "background.hint")), dismiss);
  document.body.append(panel);
}
