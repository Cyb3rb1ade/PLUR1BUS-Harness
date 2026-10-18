// Chat head: model and reasoning of this chat, two native selects (keyboard and screen reader for free). Only configured
// profiles are offered; locked ones ("Nur lokal", gone from the catalog) stay visible, disabled, with the reason. The
// reasoning select offers only the levels the model supports; a stored level the model lacks is shown with the level it
// becomes, never silently replaced. A change applies from the next reply and leaves a quiet note in the transcript.
import { h } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { isApiError } from "../../api/index.ts";
import { t, type Key } from "../../i18n.ts";
import type { View } from "../../view.ts";
import { getChatApi } from "./api.ts";
import { REASONING_LEVELS, activeProfile, effectiveLevel, loadChatModel, setChatModel, type ChatModelOption, type ChatModelSet, type ChatModelState, type ReasoningChoice } from "./model-switch.ts";

const levelText = (c: ReasoningChoice): string => t(`chat.reasoning.${c}` as Key);
const fmt = (n: number, digits = 0): string => n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });

function optionLabel(o: ChatModelOption): string {
  if (o.disabledReason === "local-only") return t("chat.model.lockedLocalOnly", { name: o.displayName });
  if (o.disabledReason === "unavailable") return t("chat.model.lockedUnavailable", { name: o.displayName });
  return o.local ? t("chat.model.local", { name: o.displayName }) : o.displayName;
}

function reasoningLabel(o: ChatModelOption | undefined, level: ReasoningChoice): string {
  const tokens = level === "default" ? undefined : o?.reasoning.budgetTokens?.[level];
  return tokens !== undefined && level !== "off" ? t("chat.reasoning.tokens", { level: levelText(level), tokens: fmt(tokens) }) : levelText(level);
}

/** What the hint line says about the current state (before or after a change). */
function hintFor(o: ChatModelOption | undefined, choice: ReasoningChoice): string {
  if (!o) return "";
  if (o.reasoning.kind === "none") return o.reasoning.note === "reasoning-unknown" ? t("chat.model.unknownLevels", { model: o.displayName }) : t("chat.model.noControl", { model: o.displayName });
  const effective = effectiveLevel(choice, o.reasoning.levels);
  return effective !== choice ? t("chat.model.adjusted", { model: o.displayName, choice: levelText(choice), effective: levelText(effective) }) : "";
}

function costText(o: ChatModelOption | undefined, r: ChatModelSet): string {
  if (r.costHint !== "reasoning-cost-higher") return "";
  const parts = [t("chat.model.costHigher")];
  const price = o?.outputUsdPerMTok;
  if (price !== undefined) {
    parts.push(t("chat.model.costPrice", { price: fmt(price, 2) }));
    const tokens = r.effectiveReasoning === "default" ? undefined : o?.reasoning.budgetTokens?.[r.effectiveReasoning];
    if (tokens !== undefined) parts.push(t("chat.model.costBudget", { cost: fmt((tokens * price) / 1_000_000, 2) }));
  } else parts.push(t("chat.model.costUnknown"));
  return parts.join(" ");
}

export function ModelSwitch({ sessionId, optionsVersion = 0, running, onChanged }: { sessionId: string; optionsVersion?:number; running: boolean; onChanged?: (note: string) => void }): View | null {
  const modelId = useId(), reasoningId = useId(), hintId = useId();
  const [state, setState] = useState<ChatModelState | null>(null);
  const [failed, setFailed] = useState<"hidden" | "error" | false>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [status, setStatus] = useState("");

  const reloadGeneration = useRef(0);
  const reload = async (signal?: AbortSignal): Promise<void> => {
    const generation=++reloadGeneration.current;
    try { const s = await loadChatModel(getChatApi(), sessionId, signal); if (!signal?.aborted && generation===reloadGeneration.current) { setState(s); setFailed(false); } }
    // A backend without the route (older API) shows no picker at all; any other failure says so.
    catch (e) { if (!signal?.aborted && generation===reloadGeneration.current) setFailed(isApiError(e) && e.kind === "unavailable" ? "hidden" : "error"); }
  };
  useEffect(() => {const ctl=new AbortController();void reload(ctl.signal);return ()=>{ctl.abort();};},[sessionId,optionsVersion]);

  if (failed === "hidden") return null;
  if (failed) return h("p", { class: "chat-note chat-model-note" }, t("chat.model.loadError"));
  if (!state) return null;
  if (state.profiles.length === 0) return h("p", { class: "chat-note chat-model-note" }, t("chat.model.none"));

  const current = activeProfile(state);
  const option = state.profiles.find((p) => p.name === current);
  const levels = option?.reasoning.levels ?? [];
  const choices: ReasoningChoice[] = ["default", ...REASONING_LEVELS.filter((l) => levels.includes(l))];
  // A stored level the model does not offer stays visible, showing what it becomes.
  const strayChoice = state.reasoning !== "default" && !choices.includes(state.reasoning);
  const disabled = busy || running;

  const apply = async (profile: string, reasoning: ReasoningChoice): Promise<void> => {
    if (disabled) return;
    setBusy(true); setError(null); setStatus("");
    try {
      const r = await setChatModel(getChatApi(), state, profile, reasoning);
      const next = state.profiles.find((p) => p.name === r.profile);
      setState({ ...state, profile: r.profile, reasoning: r.reasoning, revision: r.revision });
      const effective = r.effectiveReasoning === "default" ? levelText("default") : levelText(r.effectiveReasoning);
      onChanged?.(t("chat.model.changed", { model: next?.displayName ?? r.profile, reasoning: effective }));
      setStatus([t("chat.model.applies"), r.adjusted && next ? hintFor(next, r.reasoning) : "", costText(next, r), r.warning ? t("chat.model.cache") : ""].filter(Boolean).join(" "));
    } catch (e) {
      const code = isApiError(e) && "errorCode" in e ? e.errorCode : undefined, reason = isApiError(e) && "reason" in e ? e.reason : undefined;
      setError(code === "E_CONFLICT" && reason === "stale-model-preview" ? "chat.model.stale" : code === "E_CONFLICT" ? "chat.model.busy" : code === "E_DENIED" ? "chat.model.denied" : "chat.model.error");
      await reload();
    } finally { setBusy(false); }
  };

  const hint = running ? t("chat.model.busy") : status || hintFor(option, state.reasoning);
  return h("div", { class: "chat-model", role: "group", "aria-label": t("chat.model.label") },
    h("div", { class: "chat-model-field" },
      h("label", { for: modelId }, t("chat.model.model")),
      h("select", { id: modelId, value: current ?? "", disabled, "aria-describedby": hintId,
        onChange: (e: Event) => { void apply((e.target as HTMLSelectElement).value, state.reasoning); } },
        current === null ? h("option", { value: "", disabled: true }, t("chat.model.pick")) : null,
        state.profiles.map((p) => h("option", { key: p.name, value: p.name, disabled: !p.selectable }, optionLabel(p))))),
    h("div", { class: "chat-model-field" },
      h("label", { for: reasoningId }, t("chat.model.reasoning")),
      h("select", { id: reasoningId, value: state.reasoning, disabled: disabled || current === null || (levels.length === 0 && state.reasoning === "default"), "aria-describedby": hintId,
        onChange: (e: Event) => { if (current !== null) void apply(current, (e.target as HTMLSelectElement).value as ReasoningChoice); } },
        choices.map((c) => h("option", { key: c, value: c }, reasoningLabel(option, c))),
        strayChoice ? h("option", { value: state.reasoning, disabled: true }, t("chat.reasoning.adjustedOption", { choice: levelText(state.reasoning), effective: levelText(effectiveLevel(state.reasoning, levels)) })) : null)),
    h("p", { id: hintId, class: "chat-model-hint", role: "status" }, hint),
    error ? h("p", { class: "chat-model-error", role: "alert" }, t(error)) : null);
}
