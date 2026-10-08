// Bodies of the seven wizard steps. They only show and edit the answers; the page owns validation, saving and navigation.
import { getApi } from "../../api/shared.ts";
import { h, type ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { PageLoading } from "../../components/page-state.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import { sessionState, signIn } from "../../session.ts";
import { Notice } from "../common/states.ts";
import { Field, bad } from "../common/field.ts";
import { useLoad } from "../common/load.ts";
import { DEFAULT_EMBEDDING, choiceById, choicesOf, type ModelChoice, type ModelKind } from "./licences.ts";
import { USE_CLASSES, type Answers, type Errors, type UseClass } from "./model.ts";

export type StepProps = { a: Answers; set: (p: Partial<Answers>) => void; errors: Errors; busy: boolean };
const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : formatDateTime(d); };
const errText = (e: string | undefined, map: Record<string, Key>): string | undefined => (e && map[e] ? t(map[e]) : undefined);

export function AccountStep({ errors }: StepProps): View {
  const s = sessionState.value;
  const [token, setToken] = useState("");
  const [failed, setFailed] = useState(false);
  if (s.status === "authenticated") {
    return h("div", {}, h("p", { role: "status" }, t("setup.account.signedIn", { user: s.user.id, role: s.user.role })), h("p", { class: "field-hint" }, t("setup.account.hint")));
  }
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const r = await signIn(token.trim());
    setToken(""); // the token lives in this field only until it has been sent
    setFailed(!r.ok);
  };
  const error = failed ? t("setup.account.failed") : errors.account ? t("setup.account.needSignIn") : undefined;
  return h("form", { noValidate: true, onSubmit: (e: Event) => { void submit(e); } },
    h(Field, { id: "setup-token", label: t("setup.account.token"), hint: t("setup.account.hint"), error },
      h("input", { id: "setup-token", type: "password", autocomplete: "off", spellcheck: false, value: token, ...bad(error, "setup-token"), onInput: (e: Event) => { setToken((e.target as HTMLInputElement).value); } })),
    h("button", { type: "submit", class: "btn" }, t("setup.account.signIn")));
}

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
  return h("div", {}, h("p", { class: "reading" }, t("setup.model.lead")), body, h(Notice, {}, t("setup.model.noLogin")));
}

export function UnavailableStep({ title, body, children }: { title: string; body: string; children?: ComponentChildren }): View {
  return h("div", {}, h("h3", { class: "card-title" }, title), h(Notice, {}, body), children ?? null);
}

function NcDialog({ model, who, at, onConfirm, onClose }: { model: ModelChoice; who: string; at: string; onConfirm: () => void; onClose: () => void }): View {
  return h(ConfirmDialog, { title: t("setup.nc.title"), confirmLabel: t("setup.nc.confirm"), onClose, onConfirm: async () => { onConfirm(); return { ok: true as const }; } },
    h("p", {}, t("setup.nc.intro", { name: model.name })),
    h("dl", { class: "facts" },
      h("div", {}, h("dt", {}, t("setup.nc.who")), h("dd", {}, who)),
      h("div", {}, h("dt", {}, t("setup.nc.when")), h("dd", {}, when(at))),
      h("div", {}, h("dt", {}, t("setup.nc.licence")), h("dd", {}, model.licence)),
      h("div", {}, h("dt", {}, t("setup.nc.model")), h("dd", {}, h("code", {}, model.hf))),
      h("div", {}, h("dt", {}, t("setup.nc.revision")), h("dd", {}, model.revision ?? t("setup.nc.noRevision")))),
    h("p", { class: "field-hint" }, t("setup.nc.note")));
}

export function MemoryStep({ a, set }: StepProps): View {
  const [ask, setAsk] = useState<{ model: ModelChoice; at: string } | null>(null);
  const s = sessionState.value;
  const who = s.status === "authenticated" ? s.user.id : "";
  const isOwner = s.status === "authenticated" && s.user.role === "owner";
  const commercial = a.useClass === "commercial";
  const pick = (kind: ModelKind, id: string): Partial<Answers> => (kind === "embedding" ? { embedding: id } : { rerank: id });

  const group = (kind: ModelKind): View => {
    const selected = kind === "embedding" ? a.embedding : a.rerank;
    return h("fieldset", { class: "setup-opts" },
      h("legend", {}, t(kind === "embedding" ? "setup.memory.embedding" : "setup.memory.rerank")),
      choicesOf(kind).map((c) => {
        const id = `setup-${kind}-${c.id}`;
        const blocked = c.nc && (commercial || !isOwner);
        const hint = c.nc ? (commercial ? t("setup.memory.ncBlocked") : !isOwner ? t("setup.memory.ncOwner") : a.nc && selected === c.id ? t("setup.memory.confirmed", { who: a.nc.who, when: when(a.nc.at) }) : "") : "";
        return h("div", { key: c.id, class: "setup-opt" },
          h("input", {
            id, type: "radio", name: `setup-${kind}`, checked: selected === c.id, disabled: blocked, ...(hint ? { "aria-describedby": `${id}-d` } : {}),
            // A non-commercial model is selected only by the confirmation dialog: the click itself is cancelled.
            onClick: (e: Event) => { if (c.nc && selected !== c.id) { e.preventDefault(); setAsk({ model: c, at: new Date().toISOString() }); } },
            onChange: () => { if (!c.nc) set(pick(kind, c.id)); },
          }),
          h("label", { for: id }, `${c.name} · ${c.licence}`, c.nc ? h("span", { class: "badge", "data-tone": "warn" }, t("setup.memory.nc")) : null),
          hint ? h("p", { class: "field-hint", id: `${id}-d` }, hint) : null);
      }));
  };

  const setUse = (u: UseClass): void => {
    const nc = (id: string): boolean => choiceById(id)?.nc === true;
    // Commercial use never keeps a non-commercial model: back to the permissive defaults, acceptance forgotten.
    set(u === "commercial" ? { useClass: u, nc: null, ...(nc(a.embedding) ? { embedding: DEFAULT_EMBEDDING } : {}), ...(nc(a.rerank) ? { rerank: "bge-m3" } : {}) } : { useClass: u });
  };

  return h("div", {},
    h("p", { class: "reading" }, t("setup.memory.lead")),
    h("fieldset", { class: "setup-opts" },
      h("legend", {}, t("setup.memory.useClass")),
      USE_CLASSES.map((u) => h("div", { key: u, class: "setup-opt" },
        h("input", { id: `setup-use-${u}`, type: "radio", name: "setup-use", checked: a.useClass === u, onChange: () => { setUse(u); } }),
        h("label", { for: `setup-use-${u}` }, t(`setup.memory.use.${u}` as Key))))),
    group("embedding"),
    h("p", { class: "field-hint" }, t("setup.memory.embeddingNote")),
    group("rerank"),
    ask ? h(NcDialog, {
      model: ask.model, who, at: ask.at, onClose: () => { setAsk(null); },
      onConfirm: () => { set({ ...pick(ask.model.kind, ask.model.id), nc: { at: ask.at, who } }); },
    }) : null);
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
