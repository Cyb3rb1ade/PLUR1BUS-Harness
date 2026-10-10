// Per-agent override of the real-time voice profile (Agents > agent detail). The same fields as the global form. The server answers
// `voice.realtime.profile.get {agentId}` with the profile that applies to the agent, so a field that equals the global value is shown as
// inherited and one that differs as overridden. The contract has no "remove override" call: Reset writes the global values for the agent.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Card } from "../../components/card.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { getApi } from "../../api/shared.ts";
import "../../styles/voice.css";
import { FailureState, Notice } from "../common/states.ts";
import { useLoad } from "../common/load.ts";
import { voiceFailure } from "./language.ts";
import { RealtimeForm, loadRealtime, validDraft, type RealtimeData } from "./realtime.ts";
import { draftOf, overriddenFields, sameDraft, setParams, type Draft } from "./model.ts";
import type { VoiceFeatureEffective, VoiceFeatureName } from "../../api/voice.types.ts";
import { VOICE_FEATURES } from "../../api/voice.types.ts";

type Pair = { base: RealtimeData; agent: RealtimeData };

export function VoiceOverride({ agentId, canManage }: { agentId: string; canManage: boolean }): View {
  const { state, reload } = useLoad(async (signal): Promise<Pair> => {
    const base = await loadRealtime(signal);
    const agent = await loadRealtime(signal, agentId);
    return { base, agent };
  }, [agentId]);
  const frame = (body: View): View => h(Card, { title: t("voice.agent.title"), level: 3 }, body);
  if (state.status === "loading") return frame(h(PageLoading, { label: t("state.loading") }));
  if (state.status === "fail") return frame(h(FailureState, { failure: voiceFailure(state.failure), unavailable: t("voice.unavailable.title"), onRetry: reload }));
  return h(OverrideLoaded, { key: agentId, agentId, canManage, pair: state.data });
}

function OverrideLoaded({ agentId, canManage, pair }: { agentId: string; canManage: boolean; pair: Pair }): View {
  const [agent, setAgent] = useState(pair.agent);
  const [draft, setDraft] = useState<Draft>(() => draftOf(pair.agent.profile));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const base = draftOf(pair.base.profile);
  const overridden = overriddenFields(draft, base);
  const effective: Partial<Record<VoiceFeatureName, VoiceFeatureEffective>> = {};
  for (const f of VOICE_FEATURES) { const e = agent.profile.features[f]?.effective; if (e) effective[f] = e; }

  const write = async (d: Draft, done: string): Promise<void> => {
    if (!validDraft(d)) { setMsg({ tone: "err", text: t("voice.rt.invalid") }); return; }
    setBusy(true); setMsg(null);
    try {
      const next = await getApi().rpc("voice.realtime.profile.set", setParams(d, agentId));
      setAgent({ profile: next, metrics: agent.metrics }); setDraft(draftOf(next)); setMsg({ tone: "ok", text: done });
    } catch { setMsg({ tone: "err", text: t("voice.rt.saveFailed") }); }
    setBusy(false);
  };

  return h(Card, { title: t("voice.agent.title"), level: 3 },
    h("p", { class: "reading" }, t("voice.agent.lead")),
    h(RealtimeForm, { idp: "voice-ag", draft, onChange: (d) => { setDraft(d); setMsg(null); }, canEdit: canManage, effective, metrics: agent.metrics, overridden }),
    h("div", { class: "setup-nav" },
      h("button", { type: "button", class: "btn btn-primary", id: "voice-ag-save", disabled: !canManage || busy || sameDraft(draft, draftOf(agent.profile)), onClick: () => { void write(draft, t("voice.rt.saved")); } }, t("voice.rt.save")),
      h("button", { type: "button", class: "btn", id: "voice-ag-reset", disabled: !canManage || busy || (overridden.size === 0 && sameDraft(draft, draftOf(agent.profile))), onClick: () => { void write(base, t("voice.agent.resetDone")); } }, t("voice.agent.reset"))),
    msg ? h("p", { role: msg.tone === "err" ? "alert" : "status", class: msg.tone === "err" ? "form-error" : "field-hint" }, msg.text) : null,
    !canManage ? h(Notice, {}, t("voice.readonly")) : null);
}
