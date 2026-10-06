import { h } from "preact";
import type { View } from "../view.ts";
import { useEffect, useRef, useState } from "preact/hooks";
import { langPref, setLangPref, t, type LangPref } from "../i18n.ts";
import { icon } from "../icons.ts";
import { compact } from "../layout.ts";
import { sessionState, signOut } from "../session.ts";
import { setThemePref, themePref, type ThemePref } from "../theme.ts";

function select<V extends string>(id: string, label: string, value: V, options: readonly [V, string][], onChange: (v: V) => void): View {
  return h("div", { class: "inline-field" },
    h("label", { for: id }, label),
    h("select", { id, value, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value as V) },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text))));
}

/** Theme and language pickers (system / light / dark; system / English / Deutsch). */
export function PreferenceControls({ idPrefix }: { idPrefix: string }): View {
  return h("div", { class: "prefs" },
    select<ThemePref>(`${idPrefix}-theme`, t("theme.label"), themePref.value,
      [["system", t("theme.system")], ["light", t("theme.light")], ["dark", t("theme.dark")]], setThemePref),
    select<LangPref>(`${idPrefix}-lang`, t("lang.label"), langPref.value,
      [["system", t("lang.system")], ["en", t("lang.en")], ["de", t("lang.de")]], setLangPref));
}

function UserBlock(): View | null {
  const s = sessionState.value;
  if (s.status !== "authenticated") return null;
  return h("div", { class: "user" },
    h("span", { class: "user-name" }, t("user.signedInAs", { name: s.user.displayName })),
    h("button", { type: "button", class: "btn btn-quiet", onClick: () => { void signOut(); } }, t("user.signOut")));
}

/** Header actions. Compact: everything except the page itself moves into a "More" disclosure (rule 5, step 6). */
export function HeaderActions(): View {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const isCompact = compact.value;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => { if (!isCompact) setOpen(false); }, [isCompact]);

  if (!isCompact) return h("div", { class: "header-actions" }, h(PreferenceControls, { idPrefix: "hdr" }), h(UserBlock, {}));
  return h("div", { class: "header-actions more" },
    h("button", { type: "button", ref: button, class: "icon-btn", "aria-expanded": open, "aria-controls": "more-panel", onClick: () => setOpen(!open) },
      icon("menu"), h("span", { class: "sr-only" }, t("app.more"))),
    open ? h("div", { id: "more-panel", class: "more-panel" }, h(PreferenceControls, { idPrefix: "more" }), h(UserBlock, {})) : null);
}
