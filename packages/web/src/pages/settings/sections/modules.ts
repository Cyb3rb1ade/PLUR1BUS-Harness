// Settings > Modules & Updates (`/settings/modules`). module.list and module.graph give the installed modules and what depends on
// what; Owner and Admin can start, stop and restart (each behind a confirmation that names the modules a stop or restart takes
// down with it), and only the Owner can install from a host directory or uninstall (typed name). module.watch only hints that the
// state changed: the list is reloaded with module.list, never built from the notification. There is no update hint: neither
// module.list nor module.status carries an available version (rpc schema 1.3.0), so none is shown.
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { t, type Key } from "../../../i18n.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as modulesArea from "../../../i18n/modules.ts";
import { FailureState, Notice } from "../../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../../common/load.ts";
import type { SectionProps } from "../page.ts";
import { ActionConfirm, InstallDialog, UninstallConfirm } from "../modules/dialogs.ts";
import { ModuleList } from "../modules/list.ts";
import { fetchModules, watchModules, type ModuleAction, type ModuleEntry } from "../modules/model.ts";
import "../../../styles/modules.css";

registerArea("modules", modulesArea);

type Dlg = null | { kind: "action"; action: ModuleAction; name: string } | { kind: "uninstall"; name: string } | { kind: "install" };

const NOTICE: Record<ModuleAction, Key> = { start: "modules.notice.started", stop: "modules.notice.stopped", restart: "modules.notice.restarted" };

export function ModulesSection({ section }: SectionProps): View {
  const role = currentRole();
  const canOperate = roleIn(role, ["owner", "admin"]);
  const canInstall = roleIn(role, ["owner"]);
  const { state, reload } = useLoad((signal) => fetchModules(signal), []);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  // Live hint only: a module.state notification shows a reload button; it never changes the list by itself.
  useEffect(() => {
    let stream: { close(): void } | null = null;
    try {
      stream = getApi().events({
        onEvent: (ev) => { if (ev.event === "module.state") setChanged(true); },
      });
    } catch {
      // events are not served on this harness; the list still loads on demand
    }
    void watchModules().catch(() => undefined);
    return () => { stream?.close(); };
  }, []);

  const finish = (text: string): void => {
    setNotice(text);
    setChanged(false);
    reload();
  };

  const head = h("div", { class: "card-head" },
    h("h2", { id: "modules-list-h", class: "card-title" }, t("modules.list.title")),
    canInstall ? h("button", { type: "button", class: "btn btn-primary", onClick: () => { setDlg({ kind: "install" }); } }, t("modules.action.install")) : null);

  let body: View;
  if (state.status === "loading") body = h(PageLoading, { label: t("state.loading") });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("modules.unavailable.title"), onRetry: reload });
  else {
    const { modules, graph } = state.data;
    body = h("div", null,
      notice ? h("p", { class: "form-notice", role: "status" }, notice) : null,
      changed ? h("div", { class: "modules-live", role: "status" },
        h("span", null, t("modules.live.changed")),
        h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setChanged(false); reload(); } }, t("modules.live.reload")))
        : null,
      graph === null ? h(Notice, { tone: "warn" }, t("modules.graph.unavailable")) : null,
      modules.length === 0
        ? h(PageState, { state: "empty", title: t("modules.empty.title"), detail: t("modules.empty.body") })
        : h(ModuleList, {
          rows: modules, graph, canOperate, canInstall,
          onAction: (action, m) => { setDlg({ kind: "action", action, name: m.name }); },
          onUninstall: (m) => { setDlg({ kind: "uninstall", name: m.name }); },
        }),
      !canOperate ? h(Notice, {}, t("modules.readonly")) : null,
      canOperate && !canInstall ? h(Notice, {}, t("modules.install.ownerOnly")) : null);
  }

  const current = state.status === "ok" ? state.data : null;
  const target: ModuleEntry | undefined = dlg?.kind === "uninstall" ? current?.modules.find((m) => m.name === dlg.name) : undefined;

  return h("section", { "data-section": section.id, "aria-labelledby": "modules-h", class: "modules" },
    h("h2", { id: "modules-h", class: "modules-title" }, t("modules.title")),
    h("p", { class: "modules-lead" }, t("modules.lead")),
    h("section", { class: "card modules-block", "aria-labelledby": "modules-list-h" }, head, body),
    dlg?.kind === "action" && canOperate && current
      ? h(ActionConfirm, {
        action: dlg.action, name: dlg.name, graph: current.graph,
        onClose: () => { setDlg(null); },
        onDone: (action, name) => { finish(t(NOTICE[action], { name })); },
      })
      : null,
    dlg?.kind === "uninstall" && canInstall && current && target
      ? h(UninstallConfirm, {
        module: target, graph: current.graph,
        onClose: () => { setDlg(null); },
        onDone: (name) => { finish(t("modules.notice.uninstalled", { name })); },
      })
      : null,
    dlg?.kind === "install" && canInstall
      ? h(InstallDialog, {
        onClose: () => { setDlg(null); },
        onDone: (r) => { finish(r.replaced
          ? t("modules.notice.replaced", { name: r.name, version: r.version })
          : t("modules.notice.installed", { name: r.name, version: r.version })); },
      })
      : null);
}
