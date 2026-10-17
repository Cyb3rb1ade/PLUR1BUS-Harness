// Licence choices load when Memory is entered; the authenticated selection still belongs to the wizard page.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import { sessionState } from "../../session.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { DEFAULT_EMBEDDING, choiceById, choicesOf, type ModelChoice, type ModelKind } from "./licences.ts";
import { USE_CLASSES, type Answers, type UseClass } from "./model.ts";
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

