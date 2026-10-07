// Agent detail (`/agents/<id>`): facts, skills and the lifecycle actions. The harness has no RPC for pause, archive, export or
// delete (F39): the buttons are aria-disabled with a visible reason. The delete flow itself is built (archive-first, export
// offer, typed name) and ends in the "unavailable" result without sending anything.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import type { Agent } from "./model.ts";

export const whenText = (iso: string | null): string => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? formatDateTime(d) : t("agents.field.unknown");
};

/** A button that does nothing and says why. aria-disabled keeps it focusable; the reason is its description. */
function Blocked({ id, label, reason }: { id: string; label: string; reason: string }): View {
  return h("li", { class: "a-action" },
    h("button", { type: "button", class: "btn", "aria-disabled": "true", "aria-describedby": id, onClick: (e: Event) => { e.preventDefault(); } }, label),
    h("p", { class: "field-hint", id }, reason));
}

export function AgentDetail({ agent, canManage }: { agent: Agent; canManage: boolean }): View {
  const [deleting, setDeleting] = useState(false);
  const role = t("agents.reason.role");
  const canDelete = canManage && agent.state === "archived";
  const stateTone = agent.state === "active" ? "ok" : agent.state === "paused" ? "warn" : "neutral";
  return h("div", { class: "a-detail" },
    h(Card, { title: agent.name, aside: h(Badge, { tone: stateTone }, t(`agents.state.${agent.state}` as Key)) },
      h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, t("agents.field.name")), h("dd", {}, agent.name)),
        h("div", {}, h("dt", {}, t("agents.field.id")), h("dd", { class: "a-mono" }, agent.id)),
        h("div", {}, h("dt", {}, t("agents.field.created")), h("dd", {}, whenText(agent.createdAt))),
        h("div", {}, h("dt", {}, t("agents.field.state")), h("dd", {}, t(`agents.state.${agent.state}` as Key))),
        h("div", {}, h("dt", {}, t("agents.field.skills")), h("dd", {}, agent.skills.length === 0 ? t("agents.skills.none") : h("ul", { class: "plain-list" }, agent.skills.map((s) => h("li", { key: s }, s))))))),
    h(Card, { title: t("agents.actions") },
      h("ul", { class: "plain-list a-actions" },
        h(Blocked, { id: "ag-r-pause", label: t("agents.action.pause"), reason: canManage ? t("agents.reason.pause") : role }),
        h(Blocked, { id: "ag-r-archive", label: t("agents.action.archive"), reason: canManage ? t("agents.reason.archive") : role }),
        h(Blocked, { id: "ag-r-export", label: t("agents.action.export"), reason: canManage ? t("agents.reason.export") : role }),
        canDelete
          ? h("li", { class: "a-action" }, h("button", { type: "button", class: "btn btn-danger", onClick: () => { setDeleting(true); } }, t("agents.action.delete")))
          : h(Blocked, { id: "ag-r-delete", label: t("agents.action.delete"), reason: canManage ? t("agents.reason.archiveFirst") : role }))),
    deleting
      ? h(ConfirmDialog, {
        title: t("agents.delete.title", { name: agent.name }), confirmLabel: t("agents.delete.confirm"), danger: true, expected: agent.name,
        onConfirm: () => Promise.resolve({ ok: false as const, message: t("agents.delete.unavailable") }),
        onClose: () => { setDeleting(false); },
      },
        h("p", {}, t("agents.delete.body")),
        h("div", { class: "a-action" },
          h("p", {}, t("agents.delete.exportFirst")),
          h("button", { type: "button", class: "btn", "aria-disabled": "true", "aria-describedby": "ag-r-dexport", onClick: (e: Event) => { e.preventDefault(); } }, t("agents.action.export")),
          h("p", { class: "field-hint", id: "ag-r-dexport" }, t("agents.reason.export"))))
      : null);
}
