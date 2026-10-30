import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/extensions.ts";
import { navigate } from "../../router.ts";
import { getApi } from "../common/load.ts";
import type { ExtInspection } from "../common/surfaces-rpc.ts";
import { archiveFolder } from "./folder.ts";

registerArea("extensions", area);
export function InstallDialog({ onClose, onDone }: { onClose(): void; onDone?(): void }): View {
  const [folder, setFolder] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const selected = async (files: readonly File[]): Promise<void> => {
    if (!files.length || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    try {
      const api = getApi();
      if (!api.upload) throw new Error(t("shared.unavailable.inline"));
      const blob = folder ? await archiveFolder(files, { signal: controller.signal }) : files[0]!;
      const upload = await api.upload<{ uploadId: string }>(
        "/api/v1/extensions/upload",
        blob,
        folder ? "folder.zip" : files[0]!.name,
        { signal: controller.signal },
      );
      if (!upload || !/^[A-Za-z0-9_-]{43}$/.test(upload.uploadId))
        throw new Error(t("extensions.install.inspectFailed"));
      const inspection = (await api.rpc(
        "ext.inspect",
        { source: { upload: upload.uploadId } },
        { signal: controller.signal },
      )) as ExtInspection;
      if (
        !inspection ||
        typeof inspection.inspectionId !== "string" ||
        !inspection.inspectionId ||
        inspection.inspectionId.length > 128
      )
        throw new Error(t("extensions.install.inspectFailed"));
      onDone?.();
      onClose();
      navigate(`/extensions/confirm?inspection=${encodeURIComponent(inspection.inspectionId)}`);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          folder
            ? t("extensions.install.folderInvalid")
            : failure instanceof Error
              ? failure.message
              : t("extensions.install.inspectFailed"),
        );
    } finally {
      if (active.current === controller) active.current = null;
      setBusy(false);
    }
  };
  return h(
    Dialog,
    {
      title: t("extensions.install.title"),
      onClose,
      actions: h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
    },
    h(
      "div",
      { class: "dialog-content" },
      error ? h("p", { role: "alert", class: "form-error" }, error) : null,
      h(
        "fieldset",
        { disabled: busy },
        h("legend", null, t("extensions.action.installFile")),
        h(
          "label",
          { class: "checkbox-label" },
          h("input", {
            type: "radio",
            name: "extension-input-kind",
            checked: !folder,
            onChange: () => setFolder(false),
          }),
          " ",
          t("extensions.install.file"),
        ),
        h(
          "label",
          { class: "checkbox-label" },
          h("input", { type: "radio", name: "extension-input-kind", checked: folder, onChange: () => setFolder(true) }),
          " ",
          t("extensions.install.folder"),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "ext-file-input" }, t(folder ? "extensions.install.folder" : "extensions.install.file")),
        h("input", {
          key: folder ? "folder" : "file",
          id: "ext-file-input",
          type: "file",
          disabled: busy,
          ...(folder ? { webkitdirectory: "", multiple: true } : { accept: ".p1x,.zip,.skill,.mcpb,.dxt" }),
          onChange: (event: Event) => {
            const files = Array.from((event.target as HTMLInputElement).files ?? []);
            void selected(files);
          },
        }),
      ),
      busy
        ? h("p", { role: "status", "aria-live": "polite", "aria-busy": "true" }, t("extensions.install.uploading"))
        : null,
      h(
        "a",
        {
          href: "#/import",
          class: "btn btn-quiet",
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            onClose();
            navigate("/import");
          },
        },
        t("extensions.install.import"),
      ),
    ),
  );
}
