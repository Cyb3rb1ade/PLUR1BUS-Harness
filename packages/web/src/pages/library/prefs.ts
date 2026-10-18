import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { Field } from "../common/field.ts";
import { currentRole, getApi } from "../common/load.ts";
import { loadDefaults, saveDefault } from "./defaults.ts";
import { FailureNote } from "./failure.ts";
import { adaptersFor, classifyFailure, generateKinds, parseAdapters, type Adapter, type Kind, type MediaFailure } from "./media-model.ts";
import "../../styles/library-media.css";

type Prefs = { global: boolean; agents: Record<string, boolean> };

/** Small section of the Library: the default adapter per kind (kept in this browser) and the global metadata switch
 *  (media.preferences.get|set). Settings pages are not touched. */
export function Preferences(): View {
  const [adapters, setAdapters] = useState<Adapter[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [defaults, setDefaults] = useState(loadDefaults);
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  const [saved, setSaved] = useState(false);
  const canWrite = ["owner", "admin"].includes(currentRole() ?? "owner");

  useEffect(() => {
    const ctl = new AbortController();
    const o = { write: false, signal: ctl.signal };
    getApi().rpc("media.adapters.list", {}, o).then((r) => { if (!ctl.signal.aborted) setAdapters(parseAdapters(r)); }, (e: unknown) => {
      if (!ctl.signal.aborted && (e as { kind?: string }).kind !== "aborted") { setAdapters([]); setFailure(classifyFailure(e)); }
    });
    getApi().rpc("media.preferences.get", {}, o).then((r) => {
      const v = r as Partial<Prefs>;
      if (!ctl.signal.aborted) setPrefs({ global: v.global === true, agents: v.agents ?? {} });
    }, (e: unknown) => {
      if (!ctl.signal.aborted && (e as { kind?: string }).kind !== "aborted") setFailure(classifyFailure(e));
    });
    return () => { ctl.abort(); };
  }, []);

  const toggle = async (value: boolean): Promise<void> => {
    setFailure(null); setSaved(false);
    try {
      const r = (await getApi().rpc("media.preferences.set", { embedMetadata: value }, { write: true })) as Partial<Prefs>;
      setPrefs({ global: r.global === true, agents: r.agents ?? {} });
      setSaved(true);
    } catch (e) {
      setFailure(classifyFailure(e));
    }
  };

  const kinds: Kind[] = adapters ? generateKinds(adapters) : [];
  return h("details", { class: "libmedia-prefs" },
    h("summary", {}, t("libmedia.prefs.title")),
    h("div", { class: "libmedia-prefs-body" },
      h("p", { class: "field-hint" }, t("libmedia.prefs.lead")),
      adapters === null && failure === null ? h(PageLoading, { label: t("state.loading") }) : null,
      kinds.map((kind) => h(Field, { key: kind, id: `lm-def-${kind}`, label: t("libmedia.prefs.adapter", { kind: t(`libmedia.kind.${kind}`) }), hint: t("libmedia.prefs.browserOnly") },
        h("select", {
          id: `lm-def-${kind}`, value: defaults[kind] ?? "",
          onChange: (e: Event) => { const v = (e.currentTarget as HTMLSelectElement).value; saveDefault(kind, v); setDefaults(loadDefaults()); setSaved(true); },
        },
        h("option", { value: "" }, t("libmedia.prefs.none")),
        adaptersFor(adapters ?? [], kind).map((a) => h("option", { key: a.id, value: a.id }, a.model ? `${a.id} · ${a.model}` : a.id))))),
      prefs
        ? h("div", { class: "field libmedia-check" },
            h("label", {}, h("input", { id: "lm-embed", type: "checkbox", checked: prefs.global, disabled: !canWrite, "aria-describedby": "lm-embed-hint",
              onChange: (e: Event) => { void toggle((e.currentTarget as HTMLInputElement).checked); } }), " ", t("libmedia.prefs.embed")),
            h("p", { class: "field-hint", id: "lm-embed-hint" }, canWrite ? t("libmedia.prefs.embedHint") : t("libmedia.prefs.readOnly")))
        : null,
      failure ? h(FailureNote, { failure }) : null,
      saved ? h("p", { class: "field-hint", role: "status" }, t("libmedia.prefs.saved")) : null));
}
