import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { Field } from "../common/field.ts";
import { t } from "../../i18n.ts";
import { getApi } from "../common/load.ts";
import { columnTitle } from "./model.ts";
import type { BoardColumn } from "./rpc-types.ts";

export interface CardDialogProps {
  projectId: string;
  columns: readonly BoardColumn[];
  defaultColumnId?: string | undefined;
  onClose: () => void;
  onCreated: () => void;
  onAnnounce: (msg: string) => void;
}

export function CardDialog({
  projectId,
  columns,
  defaultColumnId,
  onClose,
  onCreated,
  onAnnounce,
}: CardDialogProps): View {
  const [title, setTitle] = useState("");
  const [columnId, setColumnId] = useState(defaultColumnId || columns[0]?.id || "");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"none" | "low" | "normal" | "high" | "urgent">("normal");
  const [dueAtStr, setDueAtStr] = useState("");
  const [labelsStr, setLabelsStr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!title.trim() || !columnId || busy) return;

    try {
      setBusy(true);
      setError(null);
      const api = getApi();

      const labels = labelsStr
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const dueAt = dueAtStr ? new Date(dueAtStr).getTime() : null;

      await api.rpc(
        "project.card.create",
        {
          projectId,
          columnId,
          title: title.trim(),
          description: description.trim(),
          priority,
          labels,
          dueAt: dueAt !== null && !isNaN(dueAt) ? dueAt : null,
        },
        { write: true },
      );

      const col = columns.find((c) => c.id === columnId);
      onAnnounce(
        t("projects.a11y.cardMoved", {
          card: title.trim(),
          column: col ? columnTitle(col) : "",
        }),
      );
      onCreated();
    } catch (err: any) {
      if (err?.errorCode === "E_PROJECT_WIP_LIMIT") {
        const col = columns.find((c) => c.id === columnId);
        setError(
          t("projects.error.wipLimit", {
            column: col ? columnTitle(col) : "",
            limit: String(col?.wipLimit ?? "?"),
          }),
        );
      } else {
        setError(err instanceof Error ? err.message : t("projects.error.generic"));
      }
    } finally {
      setBusy(false);
    }
  };

  return h(
    Dialog,
    {
      title: t("projects.card.create"),
      onClose,
    },
    h(
      "form",
      { class: "card-create-form", onSubmit: handleSubmit },
      error ? h("div", { class: "alert alert-error", role: "alert" }, error) : null,

      h(
        Field,
        { id: "new-card-title", label: t("projects.card.title") },
        h("input", {
          id: "new-card-title",
          required: true,
          value: title,
          onInput: (e: Event) => setTitle((e.currentTarget as HTMLInputElement).value),
        }),
      ),

      h(
        Field,
        { id: "new-card-column", label: t("projects.column.title") },
        h(
          "select",
          {
            id: "new-card-column",
            required: true,
            value: columnId,
            onChange: (e: Event) =>
              setColumnId((e.currentTarget as HTMLSelectElement).value),
          },
          columns.map((col) =>
            h("option", { key: col.id, value: col.id }, columnTitle(col)),
          ),
        ),
      ),

      h(
        Field,
        { id: "new-card-priority", label: t("projects.card.priority") },
        h(
          "select",
          {
            id: "new-card-priority",
            value: priority,
            onChange: (e: Event) =>
              setPriority(
                (e.currentTarget as HTMLSelectElement).value as typeof priority,
              ),
          },
          h("option", { value: "none" }, t("projects.card.priorityNone")),
          h("option", { value: "low" }, t("projects.card.priorityLow")),
          h("option", { value: "normal" }, t("projects.card.priorityNormal")),
          h("option", { value: "high" }, t("projects.card.priorityHigh")),
          h("option", { value: "urgent" }, t("projects.card.priorityUrgent")),
        ),
      ),

      h(
        Field,
        { id: "new-card-due", label: t("projects.card.dueAt") },
        h("input", {
          id: "new-card-due",
          type: "datetime-local",
          value: dueAtStr,
          onInput: (e: Event) =>
            setDueAtStr((e.currentTarget as HTMLInputElement).value),
        }),
      ),

      h(
        Field,
        { id: "new-card-labels", label: t("projects.card.labels") },
        h("input", {
          id: "new-card-labels",
          placeholder: "bug, frontend, urgent",
          value: labelsStr,
          onInput: (e: Event) =>
            setLabelsStr((e.currentTarget as HTMLInputElement).value),
        }),
      ),

      h(
        Field,
        { id: "new-card-desc", label: t("projects.card.description") },
        h("textarea", {
          id: "new-card-desc",
          rows: 4,
          value: description,
          onInput: (e: Event) =>
            setDescription((e.currentTarget as HTMLTextAreaElement).value),
        }),
      ),

      h(
        "div",
        { class: "btn-row" },
        h(
          "button",
          { type: "submit", class: "btn btn-primary", disabled: busy || !title.trim() },
          t("projects.card.create"),
        ),
        h(
          "button",
          { type: "button", class: "btn btn-quiet", onClick: onClose },
          t("projects.cancel"),
        ),
      ),
    ),
  );
}
