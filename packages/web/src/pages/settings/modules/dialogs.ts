// Settings > Modules & Updates dialogs: the confirmation of start, stop and restart (it names the modules a stop or restart takes
// down with it), the typed confirmation of an uninstall, and the install dialog, which takes a directory on the host.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { ConfirmDialog, type ConfirmResult } from "../../../components/confirm-dialog.ts";
import { Dialog } from "../../../components/dialog.ts";
import { t } from "../../../i18n.ts";
import { affected, installModule, messageOf, runAction, uninstallModule, type ModuleAction, type ModuleEntry } from "./model.ts";
import type { ModuleGraph, ModuleInstallResult } from "./rpc-types.ts";

const ACTION_TITLE = { start: "modules.confirm.start.title", stop: "modules.confirm.stop.title", restart: "modules.confirm.restart.title" } as const;
const ACTION_BODY = { start: "modules.confirm.start.body", stop: "modules.confirm.stop.body", restart: "modules.confirm.restart.body" } as const;
const ACTION_LABEL = { start: "modules.action.start", stop: "modules.action.stop", restart: "modules.action.restart" } as const;

export type ActionConfirmProps = {
  action: ModuleAction;
  name: string;
  graph: ModuleGraph | null;
  onClose: () => void;
  onDone: (action: ModuleAction, name: string) => void;
};

/** start, stop or restart. A stop or restart lists the modules that depend on it, directly or through others. */
export function ActionConfirm({ action, name, graph, onClose, onDone }: ActionConfirmProps): View {
  const others = action === "start" ? [] : affected(graph, name);
  return h(ConfirmDialog, {
    title: t(ACTION_TITLE[action], { name }),
    confirmLabel: t(ACTION_LABEL[action]),
    danger: action === "stop",
    onClose,
    onConfirm: async (): Promise<ConfirmResult> => {
      try {
        await runAction(action, name);
        onDone(action, name);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: t("modules.action.failed", { message: messageOf(e) }) };
      }
    },
  },
    h("p", null, t(ACTION_BODY[action], { name })),
    action === "start" ? null
      : graph === null ? h("p", { class: "field-hint" }, t("modules.graph.unavailable"))
      : others.length === 0 ? h("p", { class: "field-hint" }, t("modules.confirm.noDependents", { name }))
      : h("div", null,
        h("p", null, t("modules.confirm.dependents", { name })),
        h("ul", { class: "modules-affected" }, others.map((o) => h("li", { key: o }, o)))));
}

export type UninstallConfirmProps = { module: ModuleEntry; graph: ModuleGraph | null; onClose: () => void; onDone: (name: string) => void };

/** Uninstall: the module name has to be typed before the confirm button works. */
export function UninstallConfirm({ module, graph, onClose, onDone }: UninstallConfirmProps): View {
  const others = affected(graph, module.name);
  return h(ConfirmDialog, {
    title: t("modules.confirm.uninstall.title", { name: module.name }),
    confirmLabel: t("modules.action.uninstall"),
    danger: true,
    expected: module.name,
    onClose,
    onConfirm: async (): Promise<ConfirmResult> => {
      try {
        await uninstallModule(module.name);
        onDone(module.name);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: t("modules.action.failed", { message: messageOf(e) }) };
      }
    },
  },
    h("p", null, t("modules.confirm.uninstall.body", { name: module.name })),
    others.length > 0 ? h("div", null,
      h("p", null, t("modules.confirm.dependents", { name: module.name })),
      h("ul", { class: "modules-affected" }, others.map((o) => h("li", { key: o }, o)))) : null);
}

export type InstallDialogProps = { onClose: () => void; onDone: (r: ModuleInstallResult) => void };

/** Install from a directory on the host. The browser sends only the path; the harness reads the directory itself. */
export function InstallDialog({ onClose, onDone }: InstallDialogProps): View {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = path.trim() !== "" && !busy;

  const run = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true); setError("");
    try {
      const r = await installModule(path.trim());
      onDone(r);
      onClose();
    } catch (e) {
      setError(t("modules.action.failed", { message: messageOf(e) }));
      setBusy(false);
    }
  };

  return h(Dialog, {
    title: t("modules.install.title"), onClose,
    actions: [
      h("button", { key: "cancel", type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
      h("button", { key: "go", type: "button", class: "btn btn-primary", disabled: !ready, "aria-disabled": !ready, onClick: () => { void run(); } }, busy ? t("shared.confirm.working") : t("modules.install.submit")),
    ],
  },
    h("p", null, t("modules.install.body")),
    h("div", { class: "field" },
      h("label", { for: "modules-install-path" }, t("modules.install.path")),
      h("input", {
        id: "modules-install-path", type: "text", autocomplete: "off", spellcheck: false, value: path,
        "aria-describedby": "modules-install-hint",
        onInput: (e: Event) => { setPath((e.target as HTMLInputElement).value); },
      }),
      h("p", { id: "modules-install-hint", class: "field-hint" }, t("modules.install.hint"))),
    error ? h("p", { class: "form-error", role: "alert" }, error) : null);
}
