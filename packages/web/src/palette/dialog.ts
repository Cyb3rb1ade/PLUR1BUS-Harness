// The command palette (⌘K / Ctrl+K, "/" and the sidebar search pill): a modal dialog with a combobox over pages, actions, agents,
// sessions and settings, filtered by the signed-in role. Pages, actions and settings come from a local index; agents and sessions
// from a bounded, abortable client fan-out over existing list RPCs (debounced, one generation per keystroke, capped per group, 1.5 s
// total; a failing source drops only its group, silently). ARIA: combobox (input) + listbox of options in groups,
// aria-activedescendant for the active option, a polite, rate-limited live region for the count. Matching text is rendered as
// <mark> text nodes, never as HTML. Memories are not searched (no list RPC yet).
import { h, Fragment } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { View } from "../view.ts";
import { icon } from "../icons.ts";
import { lang, t } from "../i18n.ts";
import { navigate } from "../router.ts";
import { currentRole } from "../pages/common/load.ts";
import { loadSettingValues } from "./config-values.ts";
import { FANOUT, runFanout } from "./fanout.ts";
import { agentsSource, sessionsSource, type AgentRow, type SessionRow } from "./fanout-sources.ts";
import { agentEntries, buildIndex, logSearchEntries, sessionEntries } from "./index-build.ts";
import { highlight, search, type Entry, type Hit } from "./match.ts";
import { closePalette } from "./state.ts";
import "../styles/palette.css";

const MAX_SETTINGS = 40;
/** The count is announced when the list has been quiet for this long, not on every keystroke or arriving group. */
const ANNOUNCE_MS = 500;
type Remote = { agent?: Entry[]; session?: Entry[] };
type GroupKey = "palette.group.nav" | "palette.group.actions" | "palette.group.logs" | "palette.group.agents" | "palette.group.sessions" | "palette.group.settings";

function Marked({ text, query }: { text: string; query: string }): View {
  return h(Fragment, {}, highlight(text, query).map((s, i) => (s.hit ? h("mark", { key: i }, s.text) : s.text)));
}

function Row({ hit, query, id, active, onPick, onHover }: { hit: Hit; query: string; id: string; active: boolean; onPick: () => void; onHover: () => void }): View {
  const e: Entry = hit.entry;
  const second = e.group === "setting" || e.group === "agent" ? e.key : e.group === "action" ? undefined : e.meta;
  return h("div", { id, role: "option", class: "palette-opt", "aria-selected": active, "data-group": e.group, onClick: onPick, onMouseMove: onHover },
    h("span", { class: "palette-label" }, h(Marked, { text: e.label, query })),
    second ? h("span", { class: e.group === "setting" || e.group === "agent" ? "palette-sub mono" : "palette-sub" }, e.group === "setting" || e.group === "agent" ? h(Marked, { text: second, query }) : second) : null,
    e.value !== undefined ? h("span", { class: "palette-sub palette-val" }, "= ", h(Marked, { text: e.value, query })) : null,
    e.help ? h("span", { class: "palette-help" }, h(Marked, { text: e.help, query })) : null);
}

export function PaletteDialog(): View {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(true);
  const uid = useId();
  const [query, setQuery] = useState("");
  // The active option is tracked by entry id, so a group arriving above it does not move the selection.
  const [activeId, setActiveId] = useState<string | null>(null);
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
  const role = currentRole();
  const index = useMemo(() => buildIndex({ lang: language, values, role }), [language, values, role]);

  // Entity groups: one fan-out generation per (debounced) query; the previous generation is aborted on every keystroke and its
  // answers are dropped. A group appears when its source answers and stays absent when the source fails.
  const [remote, setRemote] = useState<Remote>({});
  useEffect(() => {
    setRemote({});
    const q = query.trim();
    if (q === "") return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      runFanout(q, [agentsSource, sessionsSource], ctl.signal, (id, value) => {
        if (value === null) return;
        if (id === "agent") setRemote((r) => ({ ...r, agent: agentEntries(value as AgentRow[]) }));
        else setRemote((r) => ({ ...r, session: sessionEntries((value as SessionRow[]).slice(0, FANOUT.cap)) }));
      });
    }, FANOUT.debounceMs);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [query]);

  const { nav, actions, agents, sessions, settings, logs } = useMemo(() => {
    const local = search(index, query);
    const of = (g: Entry["group"]): Hit[] => local.filter((x) => x.entry.group === g);
    const ranked = (list: Entry[] | undefined): Hit[] => (list ? search(list, query).slice(0, FANOUT.cap) : []);
    return {
      nav: of("nav"), actions: of("action"),
      // Last: a query-built fallback ("Search logs for ..."), so Enter on the best match never lands on it.
      logs: logSearchEntries(query, language, role).map((entry, rank) => ({ entry, rank })), agents: ranked(remote.agent),
      // The server matched the sessions (titles and messages), so they keep its order instead of being re-filtered by title.
      sessions: (remote.session ?? []).slice(0, FANOUT.cap).map((entry, rank) => ({ entry, rank })),
      settings: of("setting").slice(0, MAX_SETTINGS),
    };
  }, [index, query, remote, language, role]);
  const flat = [...nav, ...actions, ...agents, ...sessions, ...settings, ...logs];
  const found = activeId === null ? -1 : flat.findIndex((x) => x.entry.id === activeId);
  const at = flat.length === 0 ? -1 : found >= 0 ? found : 0;
  const setActive = (i: number): void => { const x = flat[i]; if (x) setActiveId(x.entry.id); };
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
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n > 0) setActive((at + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if ((e.key === "Home" || e.key === "End") && n > 0 && !e.shiftKey && (e.ctrlKey || e.metaKey || (e.key === "Home" ? el.selectionStart === 0 && el.selectionEnd === 0 : el.selectionStart === el.value.length && el.selectionEnd === el.value.length))) {
      // Home/End jump within the list when the caret is already at that end of the text (or with Ctrl/Cmd); otherwise they move the caret.
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : n - 1);
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

  const group = (key: GroupKey, list: Hit[], offset: number): View | null => {
    if (list.length === 0) return null;
    const gid = `${uid}-${key}`;
    return h("div", { role: "group", "aria-labelledby": gid, class: "palette-group", key },
      h("div", { id: gid, class: "palette-group-label" }, t(key)),
      list.map((hit, i) => h(Row, { key: hit.entry.id, hit, query, id: optId(offset + i), active: offset + i === at, onPick: () => { pick(hit); }, onHover: () => { setActive(offset + i); } })));
  };

  const count = flat.length === 0 ? t("palette.none") : flat.length === 1 ? t("palette.count.one") : t("palette.count.other", { n: flat.length });
  // Polite and rate-limited: announced once the list has settled (async groups arrive after the keystroke).
  const [announced, setAnnounced] = useState(count);
  useEffect(() => {
    const id = setTimeout(() => { setAnnounced(count); }, ANNOUNCE_MS);
    return () => { clearTimeout(id); };
  }, [count]);
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
          onInput: (e: Event) => { setQuery((e.currentTarget as HTMLInputElement).value); setActiveId(null); }, onKeyDown: onInputKey,
        }),
        h("button", { type: "button", class: "icon-btn", onClick: closePalette }, icon("close"), h("span", { class: "sr-only" }, t("dialog.close")))),
      expanded
        ? h("div", { id: `${uid}-list`, role: "listbox", "aria-label": t("palette.title"), class: "palette-list" },
          group("palette.group.nav", nav, 0), group("palette.group.actions", actions, nav.length),
          group("palette.group.agents", agents, nav.length + actions.length), group("palette.group.sessions", sessions, nav.length + actions.length + agents.length),
          group("palette.group.settings", settings, nav.length + actions.length + agents.length + sessions.length),
          group("palette.group.logs", logs, nav.length + actions.length + agents.length + sessions.length + settings.length))
        : h("p", { class: "palette-none" }, t("palette.none")),
      h("div", { role: "status", "aria-live": "polite", class: "sr-only" }, announced),
      h("p", { id: `${uid}-scope`, class: "palette-foot" }, t("palette.scope")),
      h("p", { class: "palette-foot palette-keys", "aria-hidden": "true" }, t("palette.hint"))));
}
