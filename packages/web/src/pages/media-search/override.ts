// Per-agent media index override, shown in the agent's detail (Agents page). Same fields as the global settings; every field is
// either "inherits" (the global value, shown) or set for this agent. Saves only the changed fields as
// `agents.<id>.memory.mediaEmbedding.<field>` with ifRevision. Clearing a field writes null (see the note in docs/web-ui.md).
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t, type Key } from "../../i18n.ts";
import { FailureState, Notice } from "../common/states.ts";
import { getApi, useLoad } from "../common/load.ts";
import type { MediaModality } from "./contract.ts";
import { ALL_MODALITIES, CAPTION_SOURCES, CLOUD_CAPTION_PROVIDER, MEDIA_PROVIDERS, draftOf, mediaErrorOf, overrideKey, problemText, type MediaDraft } from "./model.ts";
import "./rpc-types.ts";

export type OverrideFields = { provider: string | null; modalities: MediaModality[] | null; captionProvider: string | null; captionSource: string | null };
type Change = { key: string; value: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The override as saved for the agent (null = inherits). */
export function overrideOf(config: unknown, agentId: string): OverrideFields {
  const m = (isObj(config) && isObj(config.agents) && isObj(config.agents[agentId]) && isObj((config.agents[agentId] as Record<string, unknown>).memory)
    ? (((config.agents[agentId] as Record<string, unknown>).memory as Record<string, unknown>).mediaEmbedding) : undefined) as Record<string, unknown> | undefined;
  const caption = isObj(m?.caption) ? (m?.caption as Record<string, unknown>) : {};
  return {
    provider: typeof m?.provider === "string" ? m.provider : null,
    modalities: Array.isArray(m?.modalities) ? (m.modalities as MediaModality[]) : null,
    captionProvider: typeof caption.provider === "string" ? caption.provider : null,
    captionSource: typeof caption.source === "string" ? caption.source : null,
  };
}

/** Changed fields only. A field that inherits now but was set before writes null (clears the override). */
export function overrideChanges(agentId: string, before: OverrideFields, after: OverrideFields): Change[] {
  const out: Change[] = [];
  const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(before.provider, after.provider)) out.push({ key: overrideKey(agentId, "provider"), value: after.provider });
  if (!eq(before.modalities, after.modalities)) out.push({ key: overrideKey(agentId, "modalities"), value: after.modalities });
  if (!eq(before.captionProvider, after.captionProvider)) out.push({ key: overrideKey(agentId, "caption.provider"), value: after.captionProvider });
  if (!eq(before.captionSource, after.captionSource)) out.push({ key: overrideKey(agentId, "caption.source"), value: after.captionSource });
  return out;
}

export function MediaOverride({ agentId, canManage }: { agentId: string; canManage: boolean }): View {
  const { state, reload } = useLoad(async (signal) => {
    const cfg = (await getApi().rpc("config.get", undefined, { write: false, signal })) as unknown;
    const o = isObj(cfg) ? cfg : {};
    return { revision: typeof o.revision === "string" ? o.revision : "", inherited: draftOf(o.value), own: overrideOf(o.value, agentId) };
  }, [agentId]);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("mediasearch.override.unavailable"), onRetry: reload });
  return h(Form, { key: `${agentId}:${state.data.revision}`, agentId, canManage, data: state.data, reload });
}

function Form({ agentId, canManage, data, reload }: { agentId: string; canManage: boolean; data: { revision: string; inherited: MediaDraft; own: OverrideFields }; reload: () => void }): View {
  const [draft, setDraft] = useState<OverrideFields>(data.own);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inh = data.inherited;
  const changes = overrideChanges(agentId, data.own, draft);
  const set = (p: Partial<OverrideFields>): void => { setDraft((d) => ({ ...d, ...p })); setMsg(null); };
  const save = async (): Promise<void> => {
    if (busy || changes.length === 0) return;
    setBusy(true); setMsg(null);
    try {
      await getApi().rpc("config.set", { changes, ifRevision: data.revision } as never, { write: true });
      setMsg({ tone: "ok", text: t("mediasearch.override.saved") });
      reload();
    } catch (e) {
      const code = mediaErrorOf(e);
      setMsg({ tone: "err", text: code ? problemText(code) : t("mediasearch.override.failed") });
    } finally { setBusy(false); }
  };
  const select = (id: string, label: Key, value: string | null, options: [string, string][], inherit: string, onChange: (v: string | null) => void): View =>
    h("label", { class: "field", for: id },
      h("span", { class: "field-label" }, t(label)),
      h("select", { id, value: value ?? "", disabled: !canManage, onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; onChange(v === "" ? null : v); } },
        h("option", { value: "" }, `${t("mediasearch.override.inherit")} (${inherit})`),
        options.map(([v, l]) => h("option", { key: v, value: v }, l))));
  return h("section", { class: "card media-override", "aria-labelledby": "media-override-title", "data-section": "media-override" },
    h("h2", { id: "media-override-title" }, t("mediasearch.override.title")),
    h("p", { class: "field-hint" }, t("mediasearch.override.lead")),
    !canManage ? h(Notice, {}, t("mediasearch.settings.readOnly")) : null,
    select("override-media-provider", "mediasearch.override.provider", draft.provider, MEDIA_PROVIDERS.map((p) => [p.id, p.name] as [string, string]), inh.provider, (v) => set({ provider: v })),
    h("fieldset", { class: "setup-opts" }, h("legend", {}, t("mediasearch.override.modalities")),
      ALL_MODALITIES.map((m) => {
        const current = draft.modalities ?? inh.modalities;
        const id = `override-modality-${m}`;
        return h("div", { key: m, class: "setup-opt" },
          h("input", { id, type: "checkbox", checked: current.includes(m), disabled: !canManage, onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; set({ modalities: ALL_MODALITIES.filter((x) => (x === m ? on : current.includes(x))) }); } }),
          h("label", { for: id }, t(`mediasearch.setup.modality.${m}` as Key)));
      })),
    select("override-caption-provider", "mediasearch.override.caption", draft.captionProvider, [["local", t("mediasearch.setup.caption.local")], [CLOUD_CAPTION_PROVIDER, t("mediasearch.setup.caption.cloud")], ["off", t("mediasearch.setup.caption.off")]], inh.caption.provider, (v) => set({ captionProvider: v })),
    select("override-caption-source", "mediasearch.override.captionSource", draft.captionSource, CAPTION_SOURCES.map((s) => [s, s] as [string, string]), inh.caption.source, (v) => set({ captionSource: v })),
    h("div", { class: "setup-nav" }, h("button", { type: "button", class: "btn btn-primary", disabled: !canManage || busy || changes.length === 0, onClick: () => { void save(); } }, t("mediasearch.override.save"))),
    msg ? h("p", { role: msg.tone === "err" ? "alert" : "status", class: msg.tone === "err" ? "form-error" : "field-hint" }, msg.text) : null,
  );
}
