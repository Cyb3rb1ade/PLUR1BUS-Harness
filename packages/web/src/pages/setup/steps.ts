// Bodies of the seven wizard steps. They only show and edit the answers; the page owns validation, saving and navigation.
import { getApi } from "../../api/shared.ts";
import { h, type ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t, type Key } from "../../i18n.ts";
import { Notice } from "../common/states.ts";
import { Field, bad } from "../common/field.ts";
import { useLoad } from "../common/load.ts";
import { DecisionHintIfMissing } from "../common/decision-hint.ts";
import { type Answers, type Errors } from "./model.ts";

export type StepProps = { a: Answers; set: (p: Partial<Answers>) => void; errors: Errors; busy: boolean };
const errText = (e: string | undefined, map: Record<string, Key>): string | undefined => (e && map[e] ? t(map[e]) : undefined);


export function PersonaStep({ a, set, errors }: StepProps): View {
  const idErr = errText(errors.agentId, { required: "setup.persona.err.idRequired", format: "setup.persona.err.idFormat" });
  const nameErr = errText(errors.displayName, { required: "setup.persona.err.nameRequired", tooLong: "setup.persona.err.nameLong" });
  return h("div", {},
    h("p", { class: "reading" }, t("setup.persona.lead")),
    h(Field, { id: "setup-agent-id", label: t("setup.persona.id"), hint: t("setup.persona.idHint"), error: idErr },
      h("input", { id: "setup-agent-id", type: "text", autocomplete: "off", spellcheck: false, value: a.agentId, ...bad(idErr, "setup-agent-id"), onInput: (e: Event) => { set({ agentId: (e.target as HTMLInputElement).value.trim() }); } })),
    h(Field, { id: "setup-display-name", label: t("setup.persona.name"), error: nameErr },
      h("input", { id: "setup-display-name", type: "text", autocomplete: "off", value: a.displayName, ...bad(nameErr, "setup-display-name"), onInput: (e: Event) => { set({ displayName: (e.target as HTMLInputElement).value }); } })),
    h(Notice, {}, t("setup.persona.unavailable")));
}

type Entry = { provider: string; id: string; name: string };
function chatModels(raw: unknown): Entry[] {
  const list = (raw as { models?: unknown } | null)?.models;
  const out: Entry[] = [];
  for (const m of Array.isArray(list) ? list : []) {
    const o = (m ?? {}) as Record<string, unknown>;
    if (typeof o.provider !== "string" || typeof o.id !== "string") continue;
    if (o.status === "unavailable" || (typeof o.kind === "string" && o.kind !== "chat" && o.kind !== "unknown")) continue;
    out.push({ provider: o.provider, id: o.id, name: typeof o.displayName === "string" && o.displayName ? o.displayName : o.id });
  }
  return out;
}

export function ModelStep({ a, set, errors }: StepProps): View {
  const { state, reload } = useLoad(async (signal) => chatModels(await getApi().rpc("models.list", undefined, { write: false, signal })), []);
  const error = errors.chatModel ? t("setup.model.err.required") : undefined;
  let body: View;
  if (state.status === "loading") body = h(PageLoading, { label: t("setup.model.loading") });
  else if (state.status === "fail") {
    body = h("div", {}, state.failure.kind === "unavailable" ? h(Notice, {}, t("setup.err.unavailable")) : h("p", { class: "form-error", role: "alert" }, t("setup.model.loadFailed")),
      state.failure.kind === "error" ? h("button", { type: "button", class: "btn", onClick: reload }, t("setup.model.retry")) : null);
  } else if (state.data.length === 0) body = h(Notice, {}, t("setup.model.none"));
  else {
    const groups = new Map<string, Entry[]>();
    for (const m of state.data) { const g = groups.get(m.provider); if (g) g.push(m); else groups.set(m.provider, [m]); }
    body = h(Field, { id: "setup-model", label: t("setup.model.label"), error },
      h("select", { id: "setup-model", value: a.chatModel, ...bad(error, "setup-model"), onChange: (e: Event) => { set({ chatModel: (e.target as HTMLSelectElement).value }); } },
        h("option", { value: "" }, t("setup.model.choose")),
        [...groups].map(([p, list]) => h("optgroup", { key: p, label: p }, list.map((m) => h("option", { key: m.id, value: `${m.provider}/${m.id}` }, m.name))))));
  }
  // The wizard asks for the chat model only; say what stays limited until a decision model is set (nothing when it already is).
  return h("div", {}, h("p", { class: "reading" }, t("setup.model.lead")), body, h(DecisionHintIfMissing, { where: "wizard" }), h(Notice, {}, t("setup.model.noLogin")));
}

export function UnavailableStep({ title, body, children }: { title: string; body: string; children?: ComponentChildren }): View {
  return h("div", {}, h("h3", { class: "card-title" }, title), h(Notice, {}, body), children ?? null);
}


export function BackupStep({ a, set, errors, busy }: StepProps): View {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  const live = useRef(true);
  const run = async (): Promise<void> => {
    setState("working");
    try {
      const r = (await getApi().rpc("admin.backup.snapshot", { label: "setup" })) as { id?: unknown } | null;
      const id = typeof r?.id === "string" ? r.id : "";
      if (id === "") throw new Error("no id");
      set({ backupId: id }); setState("idle");
    } catch { if (live.current) setState("failed"); }
  };
  const error = errors.backup ? t("setup.backup.err.required") : undefined;
  return h("div", {},
    h("p", { class: "reading" }, t("setup.backup.lead")),
    h("button", { type: "button", class: "btn", disabled: busy || state === "working", ...(error ? { "aria-describedby": "setup-backup-create-err" } : {}), id: "setup-backup-create", onClick: () => { void run(); } }, state === "working" ? t("setup.backup.creating") : t("setup.backup.create")),
    a.backupId ? h("p", { role: "status" }, t("setup.backup.done", { id: a.backupId })) : null,
    state === "failed" ? h("p", { class: "form-error", role: "alert" }, t("setup.backup.failed")) : null,
    error ? h("p", { class: "form-error", id: "setup-backup-create-err" }, error) : null,
    h(Notice, {}, t("setup.backup.schedule")));
}

export const IMPORT_COMMAND = "plur1bus import <source-type> --detect";
export function ImportStep(): View {
  const [note, setNote] = useState("");
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(IMPORT_COMMAND); setNote(t("setup.import.copied")); } catch { setNote(t("setup.import.copyFailed")); }
  };
  return h(UnavailableStep, { title: t("setup.import.title"), body: t("setup.import.body") },
    h("div", {}, h("pre", { class: "setup-cmd", tabIndex: 0 }, h("code", {}, IMPORT_COMMAND)),
      h("button", { type: "button", class: "btn", onClick: () => { void copy(); } }, t("setup.import.copy")),
      h("p", { role: "status", class: "field-hint" }, note)));
}

/** Optional: an empty selection keeps rule triage and never overwrites an existing role. */
export function DecisionStep({ a, set, busy }: StepProps): View {
  const { state } = useLoad(async signal => chatModels(await getApi().rpc("models.list", undefined, { write: false, signal })), []);
  return h("div", {}, h(DecisionHintIfMissing, { where: "wizard" }),
    h("p", { class: "reading" }, t("setup.decision.lead")),
    h(Field, { id: "setup-decision", label: t("setup.decision.label") },
      h("select", { id: "setup-decision", value: a.decisionModel ?? "", disabled: busy || state.status !== "ok", onChange: (e: Event) => { set({ decisionModel: (e.target as HTMLSelectElement).value }); } },
        h("option", { value: "" }, t("setup.decision.skip")),
        state.status === "ok" ? state.data.map(m => h("option", { key: `${m.provider}/${m.id}`, value: `${m.provider}/${m.id}` }, `${m.name} (${m.provider})`)) : null)),
    state.status === "fail" ? h("p", { role: "alert" }, t("setup.model.loadFailed")) : null);
}
