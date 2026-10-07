// The command palette (⌘K / Ctrl+K, "/" and the sidebar search pill): a modal dialog with a combobox over pages and settings.
// ARIA: combobox (input) + listbox of options in two groups, aria-activedescendant for the active option, a polite live region for
// the count. Matching text is rendered as <mark> text nodes, never as HTML. Scope: navigation and settings only; searching agents,
// memories and sessions needs a search endpoint or client fan-out and is an owner decision (docs/milestones.md M3).
import { h, Fragment } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { View } from "../view.ts";
import { icon } from "../icons.ts";
import { lang, t } from "../i18n.ts";
import { navigate } from "../router.ts";
import { loadSettingValues } from "./config-values.ts";
import { buildIndex } from "./index-build.ts";
import { highlight, search, type Entry, type Hit } from "./match.ts";
import { closePalette, paletteOpen } from "./state.ts";

const MAX_SETTINGS = 40;

function Marked({ text, query }: { text: string; query: string }): View {
  return h(Fragment, {}, highlight(text, query).map((s, i) => (s.hit ? h("mark", { key: i }, s.text) : s.text)));
}

function Row({ hit, query, id, active, onPick, onHover }: { hit: Hit; query: string; id: string; active: boolean; onPick: () => void; onHover: () => void }): View {
  const e: Entry = hit.entry;
  const second = e.group === "nav" ? e.meta : e.key;
  return h("div", { id, role: "option", class: "palette-opt", "aria-selected": active, "data-group": e.group, onClick: onPick, onMouseMove: onHover },
    h("span", { class: "palette-label" }, h(Marked, { text: e.label, query })),
    second ? h("span", { class: e.group === "setting" ? "palette-sub mono" : "palette-sub" }, e.group === "setting" ? h(Marked, { text: second, query }) : second) : null,
    e.value !== undefined ? h("span", { class: "palette-sub palette-val" }, "= ", h(Marked, { text: e.value, query })) : null,
    e.help ? h("span", { class: "palette-help" }, h(Marked, { text: e.help, query })) : null);
}

function PaletteDialog(): View {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(true);
  const uid = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [values, setValues] = useState<Record<string, string> | null>(null);

  // Like Dialog: modal, focus into the field, focus back to the opener on unmount (unless a choice moved focus to the new page).
  useLayoutEffect(() => {
    const el = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && !el.open) el.showModal();
    input.current?.focus();
    return () => {
      if (el?.open) el.close();
      if (restoreFocus.current && opener?.isConnected) opener.focus();
    };
  }, []);

  // Current values: best effort, once per opening.
  useEffect(() => {
    const ctl = new AbortController();
    void loadSettingValues(undefined, ctl.signal).then((v) => { if (!ctl.signal.aborted) setValues(v); });
    return () => ctl.abort();
  }, []);

  const language = lang.value;
  const index = useMemo(() => buildIndex({ lang: language, values }), [language, values]);
  const hits = useMemo(() => {
    const all = search(index, query);
    let settings = 0;
    return all.filter((x) => x.entry.group === "nav" || ++settings <= MAX_SETTINGS);
  }, [index, query]);
  const nav = hits.filter((x) => x.entry.group === "nav");
  const settings = hits.filter((x) => x.entry.group === "setting");
  const flat = [...nav, ...settings];
  const at = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optId = (i: number): string => `${uid}-opt-${i}`;

  useLayoutEffect(() => {
    if (at >= 0) document.getElementById(optId(at))?.scrollIntoView({ block: "nearest" });
  }, [at, flat.length]);

  const pick = (hit: Hit | undefined): void => {
    if (!hit) return;
    restoreFocus.current = false; // the new page's heading takes focus (Shell), not the opener
    closePalette();
    navigate(hit.entry.to);
    // Same page, only the query changed: the shell does not move focus, so make sure it does not fall to <body>.
    setTimeout(() => {
      const main = document.querySelector("main");
      if (main && !main.contains(document.activeElement)) main.querySelector<HTMLElement>("h1")?.focus();
    }, 60);
  };

  const onInputKey = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    const n = flat.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n > 0) setActive((at + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(flat[at]);
    }
  };

  const onDialogKey = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? []);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || cur === dialog.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
  };

  const group = (key: "palette.group.nav" | "palette.group.settings", list: Hit[], offset: number): View | null => {
    if (list.length === 0) return null;
    const gid = `${uid}-${key}`;
    return h("div", { role: "group", "aria-labelledby": gid, class: "palette-group", key },
      h("div", { id: gid, class: "palette-group-label" }, t(key)),
      list.map((hit, i) => h(Row, { key: hit.entry.id, hit, query, id: optId(offset + i), active: offset + i === at, onPick: () => { pick(hit); }, onHover: () => { setActive(offset + i); } })));
  };

  const count = flat.length === 0 ? t("palette.none") : flat.length === 1 ? t("palette.count.one") : t("palette.count.other", { n: flat.length });
  const expanded = flat.length > 0;
  const titleId = `${uid}-title`;

  return h("dialog", {
    ref: dialog, class: "dialog palette", "aria-labelledby": titleId,
    onKeyDown: onDialogKey,
    onCancel: (e: Event) => { e.preventDefault(); closePalette(); },
    onClick: (e: MouseEvent) => { if (e.target === dialog.current) closePalette(); },
  },
    h("div", { class: "dialog-body palette-body" },
      h("h2", { id: titleId, class: "sr-only" }, t("palette.title")),
      h("div", { class: "palette-head" },
        h("span", { class: "palette-icon", "aria-hidden": "true" }, icon("search")),
        h("input", {
          ref: input, type: "text", role: "combobox", class: "palette-input", value: query, autocomplete: "off", spellcheck: false, autocapitalize: "off",
          "aria-label": t("palette.label"), "aria-autocomplete": "list", "aria-expanded": expanded, "aria-describedby": `${uid}-scope`,
          ...(expanded ? { "aria-controls": `${uid}-list`, "aria-activedescendant": optId(at) } : {}),
          placeholder: t("palette.placeholder"), enterKeyHint: "go",
          onInput: (e: Event) => { setQuery((e.currentTarget as HTMLInputElement).value); setActive(0); }, onKeyDown: onInputKey,
        }),
        h("button", { type: "button", class: "icon-btn", onClick: closePalette }, icon("close"), h("span", { class: "sr-only" }, t("dialog.close")))),
      expanded
        ? h("div", { id: `${uid}-list`, role: "listbox", "aria-label": t("palette.title"), class: "palette-list" }, group("palette.group.nav", nav, 0), group("palette.group.settings", settings, nav.length))
        : h("p", { class: "palette-none" }, t("palette.none")),
      h("div", { role: "status", "aria-live": "polite", class: "sr-only" }, count),
      h("p", { id: `${uid}-scope`, class: "palette-foot" }, t("palette.scope")),
      h("p", { class: "palette-foot palette-keys", "aria-hidden": "true" }, t("palette.hint"))));
}

/** Mounted once by the shell; renders the dialog only while open. */
export function Palette(): View | null {
  return paletteOpen.value ? h(PaletteDialog, {}) : null;
}
