import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { Field } from "../common/field.ts";
import { t } from "../../i18n.ts";
import { getApi } from "../common/load.ts";
import { columnTitle } from "./model.ts";
import type { BoardColumn } from "./rpc-types.ts";

export interface ColumnDialogProps {
  projectId: string;
  columns: readonly BoardColumn[];
  onClose: () => void;
  onUpdate: () => void;
}

export function ColumnDialog({
  projectId,
  columns,
  onClose,
  onUpdate,
}: ColumnDialogProps): View {
  const [newTitle, setNewTitle] = useState("");
  const [newWipLimit, setNewWipLimit] = useState<string>("");
  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editWipLimit, setEditWipLimit] = useState<string>("");
  const [deletingColId, setDeletingColId] = useState<string | null>(null);
  const [targetColId, setTargetColId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    if (!newTitle.trim() || busy) return;
    try {
      setBusy(true);
      setError(null);
      const api = getApi();
      const limit = newWipLimit.trim() ? parseInt(newWipLimit.trim(), 10) : null;
      await api.rpc(
        "project.column.create",
        {
          projectId,
          title: newTitle.trim(),
          wipLimit: Number.isSafeInteger(limit) && (limit ?? 0) > 0 ? limit : null,
        },
        { write: true },
      );
      setNewTitle("");
      setNewWipLimit("");
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async (colId: string) => {
    if (!editTitle.trim() || busy) return;
    try {
      setBusy(true);
      setError(null);
      const api = getApi();
      const limit = editWipLimit.trim() ? parseInt(editWipLimit.trim(), 10) : null;
      await api.rpc(
        "project.column.update",
        {
          projectId,
          columnId: colId,
          title: editTitle.trim(),
          wipLimit: Number.isSafeInteger(limit) && (limit ?? 0) > 0 ? limit : null,
        },
        { write: true },
      );
      setEditingColId(null);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleMove = async (colId: string, newPos: number) => {
    if (busy) return;
    try {
      setBusy(true);
      setError(null);
      const api = getApi();
      await api.rpc(
        "project.column.move",
        { projectId, columnId: colId, position: newPos },
        { write: true },
      );
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (colId: string) => {
    if (busy) return;
    try {
      setBusy(true);
      setError(null);
      const api = getApi();
      await api.rpc(
        "project.column.delete",
        {
          projectId,
          columnId: colId,
          ...(targetColId ? { targetColumnId: targetColId } : {}),
        },
        { write: true },
      );
      setDeletingColId(null);
      setTargetColId("");
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  return h(
    Dialog,
    {
      title: t("projects.column.manage"),
      onClose,
    },
    h(
      "div",
      { class: "column-dialog-content" },
      error ? h("div", { class: "alert alert-error", role: "alert" }, error) : null,

      // Column list
      h(
        "ul",
        { class: "column-manage-list" },
        columns.map((col, idx) => {
          const isEditing = editingColId === col.id;
          const isDeleting = deletingColId === col.id;
          const otherCols = columns.filter((c) => c.id !== col.id);

          return h(
            "li",
            { key: col.id, class: "column-manage-item" },
            isEditing
              ? h(
                  "div",
                  { class: "column-edit-form" },
                  h(
                    Field,
                    { id: `edit-title-${col.id}`, label: t("projects.column.title") },
                    h("input", {
                      id: `edit-title-${col.id}`,
                      value: editTitle,
                      onInput: (e: Event) =>
                        setEditTitle((e.currentTarget as HTMLInputElement).value),
                    }),
                  ),
                  h(
                    Field,
                    { id: `edit-wip-${col.id}`, label: t("projects.column.wipLimitField") },
                    h("input", {
                      id: `edit-wip-${col.id}`,
                      type: "number",
                      min: 1,
                      value: editWipLimit,
                      onInput: (e: Event) =>
                        setEditWipLimit((e.currentTarget as HTMLInputElement).value),
                    }),
                  ),
                  h(
                    "div",
                    { class: "btn-row" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn-primary",
                        disabled: busy,
                        onClick: () => handleSaveEdit(col.id),
                      },
                      t("surfaces.save"),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn-quiet",
                        onClick: () => setEditingColId(null),
                      },
                      t("projects.cancel"),
                    ),
                  ),
                )
              : isDeleting
                ? h(
                    "div",
                    { class: "column-delete-form" },
                    otherCols.length > 0
                      ? h(
                          Field,
                          {
                            id: `target-col-${col.id}`,
                            label: t("projects.column.targetColumn"),
                            help: t("projects.column.targetColumnHint"),
                          },
                          h(
                            "select",
                            {
                              id: `target-col-${col.id}`,
                              value: targetColId,
                              onChange: (e: Event) =>
                                setTargetColId(
                                  (e.currentTarget as HTMLSelectElement).value,
                                ),
                            },
                            h("option", { value: "" }, "—"),
                            otherCols.map((c) =>
                              h("option", { key: c.id, value: c.id }, columnTitle(c)),
                            ),
                          ),
                        )
                      : null,
                    h(
                      "div",
                      { class: "btn-row" },
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn btn-danger",
                          disabled: busy,
                          onClick: () => handleDelete(col.id),
                        },
                        t("projects.column.deleteColumn"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn btn-quiet",
                          onClick: () => setDeletingColId(null),
                        },
                        t("projects.cancel"),
                      ),
                    ),
                  )
                : h(
                    "div",
                    { class: "column-row-view" },
                    h(
                      "span",
                      { class: "column-name" },
                      columnTitle(col),
                      col.wipLimit !== null ? ` (WIP: ${col.wipLimit})` : "",
                    ),
                    h(
                      "div",
                      { class: "column-actions" },
                      idx > 0
                        ? h(
                            "button",
                            {
                              type: "button",
                              class: "btn-quiet",
                              disabled: busy,
                              "aria-label": `${t("projects.column.moveLeft")} ${columnTitle(col)}`,
                              onClick: () => handleMove(col.id, idx - 1),
                            },
                            "←",
                          )
                        : null,
                      idx < columns.length - 1
                        ? h(
                            "button",
                            {
                              type: "button",
                              class: "btn-quiet",
                              disabled: busy,
                              "aria-label": `${t("projects.column.moveRight")} ${columnTitle(col)}`,
                              onClick: () => handleMove(col.id, idx + 1),
                            },
                            "→",
                          )
                        : null,
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn-quiet",
                          onClick: () => {
                            setEditingColId(col.id);
                            setEditTitle(col.title || (col.titleKey ? t(col.titleKey as any) : ""));
                            setEditWipLimit(col.wipLimit !== null ? String(col.wipLimit) : "");
                          },
                        },
                        t("projects.column.editColumn"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn-quiet btn-danger",
                          onClick: () => {
                            setDeletingColId(col.id);
                            setTargetColId(otherCols[0]?.id ?? "");
                          },
                        },
                        t("projects.column.deleteColumn"),
                      ),
                    ),
                  ),
          );
        }),
      ),

      // Create new column form
      h(
        "form",
        { class: "column-add-form", onSubmit: handleCreate },
        h("h3", {}, t("projects.column.newColumn")),
        h(
          Field,
          { id: "new-col-title", label: t("projects.column.title") },
          h("input", {
            id: "new-col-title",
            required: true,
            value: newTitle,
            onInput: (e: Event) =>
              setNewTitle((e.currentTarget as HTMLInputElement).value),
          }),
        ),
        h(
          Field,
          { id: "new-col-wip", label: t("projects.column.wipLimitField") },
          h("input", {
            id: "new-col-wip",
            type: "number",
            min: 1,
            value: newWipLimit,
            onInput: (e: Event) =>
              setNewWipLimit((e.currentTarget as HTMLInputElement).value),
          }),
        ),
        h(
          "button",
          { type: "submit", class: "btn btn-primary", disabled: busy || !newTitle.trim() },
          t("projects.column.newColumn"),
        ),
      ),
    ),
  );
}
