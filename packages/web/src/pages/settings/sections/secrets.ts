// Settings > Secrets: names and metadata from secret.list / secret.status; create and rotate (secret.set) and delete
// (secret.delete, typed name). Values are write-only: nothing here reads, keeps or logs one (see secrets/dialogs.ts).
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Badge } from "../../../components/card.ts";
import { ConfirmDialog } from "../../../components/confirm-dialog.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { formatDateTime, t, type Key } from "../../../i18n.ts";
import { FailureState } from "../../common/states.ts";
import { currentRole, failureOf, getApi, roleIn, useLoad } from "../../common/load.ts";
import type { SectionProps } from "../page.ts";
import { SecretDialog, type SaveResult } from "../secrets/dialogs.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as secretsArea from "../../../i18n/secrets.ts";
import "../../../styles/secrets.css";

registerArea("secrets", secretsArea);

type Meta = { name: string; backend: string; createdAt: string; updatedAt: string };
type Status = { backend: string; degraded: boolean; count: number | null; activeLeases: number };
type Data = { secrets: Meta[]; status: Status | null };
type Dlg = null | { kind: "create" } | { kind: "rotate"; name: string } | { kind: "delete"; name: string };

const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : formatDateTime(d); };
const backendLabel = (b: string): string => (["keyring", "file", "memory", "none"].includes(b) ? t(`secrets.backend.${b}` as Key) : b);

async function load(signal: AbortSignal): Promise<Data> {
  const api = getApi();
  const [list, status] = await Promise.all([
    api.rpc("secret.list", {}, { write: false, signal }) as Promise<{ secrets: Meta[] }>,
    (api.rpc("secret.status", {}, { write: false, signal }) as Promise<Status>).catch(() => null),
  ]);
  return { secrets: [...list.secrets].sort((a, b) => a.name.localeCompare(b.name)), status };
}

const saveFailure = (e: unknown): SaveResult => {
  const f = failureOf(e);
  return { ok: false, message: f.kind === "forbidden" ? t("secrets.err.forbidden") : f.kind === "unavailable" ? t("shared.unavailable.inline") : t("secrets.err.save") };
};

function Body({ data, reload }: { data: Data; reload: () => void }): View {
  const [dlg, setDlg] = useState<Dlg>(null);
  const [notice, setNotice] = useState("");
  const close = (): void => { setDlg(null); };
  const names = data.secrets.map((s) => s.name);

  const save = async (name: string, value: string): Promise<SaveResult> => {
    try { await getApi().rpc("secret.set", { name, value }); } catch (e) { return saveFailure(e); }
    setNotice(t("secrets.saved", { name })); reload();
    return { ok: true };
  };
  const remove = (name: string) => async () => {
    try { await getApi().rpc("secret.delete", { name }); } catch (e) {
      const f = failureOf(e);
      return { ok: false as const, message: f.kind === "forbidden" ? t("secrets.err.forbidden") : f.kind === "unavailable" ? t("shared.unavailable.inline") : t("secrets.delete.failed") };
    }
    setNotice(t("secrets.deleted", { name })); reload();
    return { ok: true as const };
  };

  const s = data.status;
  return h("div", { class: "secrets" },
    s ? h("section", { class: "card secrets-store", "aria-labelledby": "secrets-store-h" },
      h("h3", { id: "secrets-store-h", class: "card-title" }, t("secrets.store")),
      h("dl", { class: "facts facts-cols" },
        h("div", {}, h("dt", {}, t("secrets.store.backend")), h("dd", {}, backendLabel(s.backend), s.degraded ? [" ", h(Badge, { tone: "warn" }, t("secrets.store.degraded"))] : null)),
        s.count !== null ? h("div", {}, h("dt", {}, t("secrets.store.count")), h("dd", {}, String(s.count))) : null,
        h("div", {}, h("dt", {}, t("secrets.store.leases")), h("dd", {}, String(s.activeLeases))))) : null,
    h("div", { class: "secrets-head" },
      h("h3", { class: "card-title" }, t("secrets.list")),
      h("button", { type: "button", class: "btn btn-primary", onClick: () => { setDlg({ kind: "create" }); } }, t("secrets.create"))),
    h("p", { class: "secrets-notice", role: "status", "aria-live": "polite" }, notice),
    data.secrets.length === 0
      ? h(PageState, { state: "empty", title: t("secrets.empty.title"), detail: t("secrets.empty.body") })
      : h("div", {}, h("table", { class: "data-table secrets-table" },
        h("thead", {}, h("tr", {}, ["name", "backend", "created", "updated", "actions"].map((c) => h("th", { key: c, scope: "col" }, t(`secrets.col.${c}` as Key))))),
        h("tbody", {}, data.secrets.map((m) => h("tr", { key: m.name },
          h("th", { scope: "row", class: "secret-name" }, m.name),
          h("td", { "data-label": t("secrets.col.backend") }, backendLabel(m.backend)), h("td", { "data-label": t("secrets.col.created") }, when(m.createdAt)), h("td", { "data-label": t("secrets.col.updated") }, when(m.updatedAt)),
          h("td", { class: "secret-actions" },
            h("button", { type: "button", class: "btn", "aria-label": t("secrets.rotate.label", { name: m.name }), onClick: () => { setDlg({ kind: "rotate", name: m.name }); } }, t("secrets.rotate")),
            h("button", { type: "button", class: "btn btn-quiet", "aria-label": t("secrets.delete.label", { name: m.name }), onClick: () => { setDlg({ kind: "delete", name: m.name }); } }, t("secrets.delete")))))))),
    dlg?.kind === "create" ? h(SecretDialog, { existing: names, onSave: save, onClose: close }) : null,
    dlg?.kind === "rotate" ? h(SecretDialog, { rotate: dlg.name, existing: names, onSave: save, onClose: close }) : null,
    dlg?.kind === "delete" ? h(ConfirmDialog, { title: t("secrets.delete.title", { name: dlg.name }), confirmLabel: t("secrets.delete.confirm"), danger: true, expected: dlg.name, onConfirm: remove(dlg.name), onClose: close },
      h("p", {}, t("secrets.delete.body"))) : null);
}

function Loaded(): View {
  const { state, reload } = useLoad(load, []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("secrets.unavailable.title"), onRetry: reload });
  return h(Body, { data: state.data, reload });
}

export function SecretsSection({ section }: SectionProps): View {
  const allowed = roleIn(currentRole(), ["owner", "admin"]);
  return h("section", { "data-section": section.id, "aria-labelledby": "secrets-h" },
    h("h2", { id: "secrets-h" }, t("secrets.title")),
    h("p", { class: "field-hint" }, t("secrets.intro")),
    allowed ? h(Loaded, {}) : h(PageState, { state: "forbidden" }));
}
