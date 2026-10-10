// Agent detail (`/agents/<id>`): facts, skills and the lifecycle actions.
// Wired to agent.pause, agent.resume, agent.archive, agent.unarchive, agent.export and agent.delete (F39).
import { MediaOverride } from "../media-search/override.ts";
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { ConfirmDialog, type ConfirmResult } from "../../components/confirm-dialog.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import { lazySection } from "../common/lazy-section.ts";
import type { Agent, AgentState } from "./model.ts";
import { archiveAgent, deleteAgent, exportAgent, pauseAgent, resumeAgent, unarchiveAgent } from "./model.ts";

// Voice (real-time) override of this agent: its own lazy chunk with catalogue and CSS.
const VoiceOverride = lazySection<{ agentId: string; canManage: boolean }>(() => import("../voice/override.ts").then((m) => m.VoiceOverride));

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

function downloadBundle(agentId: string, bundle: unknown): void {
  try {
    const data = JSON.stringify(bundle, null, 2);
    if (typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${agentId}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch {
    // Ignore in environments without DOM/Blob support
  }
}

export function AgentDetail({ agent, canManage }: { agent: Agent; canManage: boolean }): View {
  const [state, setState] = useState<AgentState>(agent.state);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const roleReason = t("agents.reason.role");
  const canDelete = canManage && state === "archived";
  const stateTone = state === "active" ? "ok" : state === "paused" ? "warn" : "neutral";

  const handlePause = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      await pauseAgent(agent.id);
      setState("paused");
      setFlash(t("agents.flash.paused", { name: agent.name }));
    } catch (e: unknown) {
      const err = e as { message?: string };
      setFlash(err.message ?? t("agents.reason.pause"));
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      await resumeAgent(agent.id);
      setState("active");
      setFlash(t("agents.flash.resumed", { name: agent.name }));
    } catch (e: unknown) {
      const err = e as { message?: string };
      setFlash(err.message ?? t("agents.reason.pause"));
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      await archiveAgent(agent.id);
      setState("archived");
      setFlash(t("agents.flash.archived", { name: agent.name }));
    } catch (e: unknown) {
      const err = e as { message?: string };
      setFlash(err.message ?? t("agents.reason.archive"));
    } finally {
      setBusy(false);
    }
  };

  const handleUnarchive = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      await unarchiveAgent(agent.id);
      setState("active");
      setFlash(t("agents.flash.unarchived", { name: agent.name }));
    } catch (e: unknown) {
      const err = e as { message?: string };
      setFlash(err.message ?? t("agents.reason.archive"));
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      const res = await exportAgent(agent.id, false);
      downloadBundle(agent.id, res.bundle ?? res);
      setFlash(t("agents.flash.exported"));
    } catch (e: unknown) {
      const err = e as { message?: string };
      setFlash(err.message ?? t("agents.reason.export"));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteConfirm = async (): Promise<ConfirmResult> => {
    try {
      let offerId = "";
      try {
        const offer = await exportAgent(agent.id, true);
        offerId = offer.offerId;
      } catch {
        // Continue even if offer creation failed, delete will report appropriate error
      }
      const outcome = await deleteAgent(agent.id, agent.name, offerId);
      if (outcome.ok) {
        setFlash(t("agents.flash.deleted", { name: agent.name }));
        return { ok: true };
      }
      if (outcome.kind === "engine-erasure-unavailable") {
        return { ok: false, message: t("agents.delete.engineErasureUnavailable") };
      }
      if (outcome.kind === "unavailable") {
        return { ok: false, message: t("agents.delete.unavailable") };
      }
      return { ok: false, message: outcome.message ?? t("agents.delete.unavailable") };
    } catch (e: unknown) {
      const err = e as { message?: string };
      return { ok: false, message: err.message ?? t("agents.delete.unavailable") };
    }
  };

  return h("div", { class: "a-detail" },
    h(MediaOverride, { agentId: agent.id, canManage }),
    h(VoiceOverride, { agentId: agent.id, canManage }),
    h(Card, { title: agent.name, aside: h(Badge, { tone: stateTone }, t(`agents.state.${state}` as Key)) },
      h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, t("agents.field.name")), h("dd", {}, agent.name)),
        h("div", {}, h("dt", {}, t("agents.field.id")), h("dd", { class: "a-mono" }, agent.id)),
        h("div", {}, h("dt", {}, t("agents.field.created")), h("dd", {}, whenText(agent.createdAt))),
        h("div", {}, h("dt", {}, t("agents.field.state")), h("dd", {}, t(`agents.state.${state}` as Key))),
        h("div", {}, h("dt", {}, t("agents.field.skills")), h("dd", {}, agent.skills.length === 0 ? t("agents.skills.none") : h("ul", { class: "plain-list" }, agent.skills.map((s) => h("li", { key: s }, s))))))),
    flash ? h("p", { class: "form-notice", role: "status" }, flash) : null,
    h(Card, { title: t("agents.actions") },
      h("ul", { class: "plain-list a-actions" },
        !canManage
          ? h(Blocked, { id: "ag-r-pause", label: t("agents.action.pause"), reason: roleReason })
          : state === "active"
            ? h("li", { class: "a-action" }, h("button", { type: "button", class: "btn", disabled: busy, onClick: handlePause }, t("agents.action.pause")))
            : state === "paused"
              ? h("li", { class: "a-action" }, h("button", { type: "button", class: "btn", disabled: busy, onClick: handleResume }, t("agents.action.resume")))
              : h(Blocked, { id: "ag-r-pause", label: t("agents.action.pause"), reason: t("agents.reason.archiveFirst") }),
        !canManage
          ? h(Blocked, { id: "ag-r-archive", label: t("agents.action.archive"), reason: roleReason })
          : state === "archived"
            ? h("li", { class: "a-action" }, h("button", { type: "button", class: "btn", disabled: busy, onClick: handleUnarchive }, t("agents.action.unarchive")))
            : h("li", { class: "a-action" }, h("button", { type: "button", class: "btn", disabled: busy, onClick: handleArchive }, t("agents.action.archive"))),
        !canManage
          ? h(Blocked, { id: "ag-r-export", label: t("agents.action.export"), reason: roleReason })
          : h("li", { class: "a-action" }, h("button", { type: "button", class: "btn", disabled: busy, onClick: handleExport }, t("agents.action.export"))),
        canDelete
          ? h("li", { class: "a-action" }, h("button", { type: "button", class: "btn btn-danger", onClick: () => { setDeleting(true); } }, t("agents.action.delete")))
          : h(Blocked, { id: "ag-r-delete", label: t("agents.action.delete"), reason: canManage ? t("agents.reason.archiveFirst") : roleReason }))),
    deleting
      ? h(ConfirmDialog, {
        title: t("agents.delete.title", { name: agent.name }), confirmLabel: t("agents.delete.confirm"), danger: true, expected: agent.name,
        onConfirm: handleDeleteConfirm,
        onClose: () => { setDeleting(false); },
      },
        h("p", {}, t("agents.delete.body")),
        h("div", { class: "a-action" },
          h("p", {}, t("agents.delete.exportFirst")),
          h("button", { type: "button", class: "btn", onClick: handleExport }, t("agents.action.export"))))
      : null);
}
