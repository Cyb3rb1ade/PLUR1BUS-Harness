// The Memory step: use class, embedding model and reranker. What the engine runs comes from `model.memory.status` each time the
// step shows (answers.memoryModels); the page writes the picks into engine.embedding and engine.reranker (model.ts changesFor).
// A store that already holds data keeps its embedding model, so only the reranker can change then. Licence choices load when
// Memory is entered; the authenticated selection still belongs to the wizard page.
import { h } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import { sessionState } from "../../session.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { PageLoading } from "../../components/page-state.ts";
import { Notice } from "../common/states.ts";
import { getApi, useLoad } from "../common/load.ts";
import { DEFAULT_EMBEDDING, DEFAULT_RERANK, activeChoice, choiceById, choicesOf, lockedNcEmbedding, type MemoryModels, type ModelChoice, type ModelKind } from "./licences.ts";
import { USE_CLASSES, chosen, type Answers, type UseClass } from "./model.ts";
import type { StepProps } from "./steps.ts";
import "../../styles/setup.css";
const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : formatDateTime(d); };

function NcDialog({ model, who, at, onConfirm, onClose }: { model: ModelChoice; who: string; at: string; onConfirm: () => void; onClose: () => void }): View {
  return h(ConfirmDialog, { title: t("setup.nc.title"), confirmLabel: t("setup.nc.confirm"), onClose, onConfirm: async () => { onConfirm(); return { ok: true as const }; } },
    h("p", {}, t("setup.nc.intro", { name: model.name })),
    h("dl", { class: "facts" },
      h("div", {}, h("dt", {}, t("setup.nc.who")), h("dd", {}, who)),
      h("div", {}, h("dt", {}, t("setup.nc.when")), h("dd", {}, when(at))),
      h("div", {}, h("dt", {}, t("setup.nc.licence")), h("dd", {}, model.licence)),
      h("div", {}, h("dt", {}, t("setup.nc.model")), h("dd", {}, h("code", {}, model.model))),
      h("div", {}, h("dt", {}, t("setup.nc.revision")), h("dd", {}, model.revision))),
    h("p", { class: "field-hint" }, t("setup.nc.note")));
}

/** The model the engine runs when it is none of the offered ones (a cloud model, another width): kept unless another is picked. */
function CurrentOption({ kind, m, checked, onPick }: { kind: ModelKind; m: MemoryModels; checked: boolean; onPick: () => void }): View {
  const id = `setup-${kind}-current`;
  const model = kind === "embedding" ? `${m.embedding.model} · ${m.embedding.dimensions}` : m.reranker.model ?? m.reranker.provider;
  const provider = kind === "embedding" ? m.embedding.provider : m.reranker.provider;
  return h("div", { class: "setup-opt" },
    h("input", { id, type: "radio", name: `setup-${kind}`, checked, onChange: onPick }),
    h("label", { for: id }, t("setup.memory.current", { model, provider })));
}

export function MemoryStep({ a, set, errors }: StepProps): View {
  const [ask, setAsk] = useState<{ model: ModelChoice; at: string } | null>(null);
  const { state, reload } = useLoad((signal) => getApi().rpc("model.memory.status", {}, { write: false, signal }) as Promise<MemoryModels>, []);
  // A failed load forgets an earlier answer: without the engine's answer the step writes no model. Taken over before the step is
  // painted, so Next never sees the models on screen without the engine's answer in the wizard state.
  useLayoutEffect(() => { if (state.status !== "loading") set({ memoryModels: state.status === "ok" ? state.data : undefined }); }, [state]);
  const s = sessionState.value;
  const who = s.status === "authenticated" ? s.user.id : "";
  const isOwner = s.status === "authenticated" && s.user.role === "owner";
  const commercial = a.useClass === "commercial";
  // Drawn from the loaded answer itself, so the first draw after loading already shows what the page will write.
  const m = state.status === "ok" ? state.data : undefined;
  const av: Answers = { ...a, memoryModels: m };
  const locked = (kind: ModelKind): boolean => kind === "embedding" && m?.embeddingSwitch === "migration-required";
  // A non-commercial embedding the store is bound to keeps its licence: commercial use waits until the store is moved.
  const ncLocked = lockedNcEmbedding(m);
  const useError = errors.useClass === "ncLocked" && ncLocked && commercial ? t("setup.memory.err.ncLocked", { model: ncLocked.model }) : undefined;
  const pick = (kind: ModelKind, id: string): Partial<Answers> => (kind === "embedding" ? { embedding: id } : { rerank: id });

  const group = (kind: ModelKind, mm: MemoryModels): View => {
    const selected = chosen(kind, av), active = activeChoice(kind, mm);
    const lockedHint = locked(kind) ? `setup-${kind}-locked` : undefined;
    return h("fieldset", { class: "setup-opts", ...(lockedHint ? { "aria-describedby": lockedHint } : {}) },
      h("legend", {}, t(kind === "embedding" ? "setup.memory.embedding" : "setup.memory.rerank")),
      active === "" ? h(CurrentOption, { kind, m: mm, checked: selected === "", onPick: () => { set(pick(kind, "")); } }) : null,
      choicesOf(kind).map((c) => {
        const id = `setup-${kind}-${c.id}`;
        const lockedOut = locked(kind) && c.id !== active;
        const blocked = lockedOut || (c.nc && (commercial || !isOwner));
        const hint = c.nc && !lockedOut ? (commercial ? t("setup.memory.ncBlocked") : !isOwner ? t("setup.memory.ncOwner") : a.nc && selected === c.id ? t("setup.memory.confirmed", { who: a.nc.who, when: when(a.nc.at) }) : "") : "";
        return h("div", { key: c.id, class: "setup-opt" },
          h("input", {
            id, type: "radio", name: `setup-${kind}`, checked: selected === c.id, disabled: blocked, ...(hint ? { "aria-describedby": `${id}-d` } : {}),
            // A non-commercial model is selected only by the confirmation dialog: the click itself is cancelled.
            onClick: (e: Event) => { if (c.nc && selected !== c.id) { e.preventDefault(); setAsk({ model: c, at: new Date().toISOString() }); } },
            onChange: () => { if (!c.nc) set(pick(kind, c.id)); },
          }),
          h("label", { for: id }, `${c.name} · ${c.licence}`, c.nc ? h("span", { class: "badge", "data-tone": "warn" }, t("setup.memory.nc")) : null),
          hint ? h("p", { class: "field-hint", id: `${id}-d` }, hint) : null);
      }),
      lockedHint ? h("p", { class: "field-hint", id: lockedHint }, t("setup.memory.locked", { model: mm.embedding.model })) : null);
  };

  const setUse = (u: UseClass): void => {
    const nc = (kind: ModelKind): boolean => choiceById(chosen(kind, av))?.nc === true;
    // Commercial use never keeps a non-commercial model: back to the permissive defaults, acceptance forgotten.
    set(u === "commercial" ? { useClass: u, nc: null, ...(nc("embedding") && !locked("embedding") ? { embedding: DEFAULT_EMBEDDING } : {}), ...(nc("rerank") ? { rerank: DEFAULT_RERANK } : {}) } : { useClass: u });
  };

  let models: View;
  if (state.status === "loading") models = h(PageLoading, { label: t("setup.memory.loading") });
  else if (!m) models = h("div", {}, h(Notice, {}, t("setup.memory.loadFailed")), h("button", { type: "button", class: "btn", onClick: reload }, t("setup.model.retry")));
  else models = h("div", {}, group("embedding", m), h("p", { class: "field-hint" }, t("setup.memory.embeddingNote")), group("rerank", m));

  return h("div", {},
    h("p", { class: "reading" }, t("setup.memory.lead")),
    h("fieldset", { class: "setup-opts", ...(useError ? { "aria-describedby": "setup-use-error" } : {}) },
      h("legend", {}, t("setup.memory.useClass")),
      USE_CLASSES.map((u) => {
        const id = `setup-use-${u}`;
        const lockHint = u === "commercial" && ncLocked ? t("setup.memory.commercialLocked", { model: ncLocked.model }) : undefined;
        return h("div", { key: u, class: "setup-opt" },
          h("input", { id, type: "radio", name: "setup-use", checked: a.useClass === u, disabled: lockHint !== undefined, ...(lockHint ? { "aria-describedby": `${id}-d` } : useError ? { "aria-invalid": "true" } : {}), onChange: () => { setUse(u); } }),
          h("label", { for: id }, t(`setup.memory.use.${u}` as Key)),
          lockHint ? h("p", { class: "field-hint", id: `${id}-d` }, lockHint) : null);
      }),
      useError ? h("p", { class: "form-error", id: "setup-use-error", role: "alert" }, useError) : null),
    models,
    ask ? h(NcDialog, {
      model: ask.model, who, at: ask.at, onClose: () => { setAsk(null); },
      onConfirm: () => { set({ ...pick(ask.model.kind, ask.model.id), nc: { at: ask.at, who } }); },
    }) : null);
}
