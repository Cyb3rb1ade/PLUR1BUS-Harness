// Paired devices (device.list, device.rename, device.revoke). Owner/Admin get every device, everyone else their own; the server
// filters. Rename is for the device's own person only; revoke is own device or Owner/Admin (docs/rbac.md). Revoking ends live connections.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../../view.ts";
import { Badge, Card } from "../../../../components/card.ts";
import { ConfirmDialog, type ConfirmResult } from "../../../../components/confirm-dialog.ts";
import { Dialog } from "../../../../components/dialog.ts";
import { PageLoading, PageState } from "../../../../components/page-state.ts";
import { formatDateTime, t, type Key } from "../../../../i18n.ts";
import { sessionState } from "../../../../session.ts";
import { FailureState } from "../../../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../../../common/load.ts";
import type { Device } from "../../../common/admin-rpc.ts";

/** A readable reason for a refused device call, by error code (never the raw server text). */
export function deviceErrorKey(e: unknown): Key {
  const o = (typeof e === "object" && e !== null ? e : {}) as { kind?: string; errorCode?: string | null; reason?: string | null };
  if (o.kind === "unavailable" || o.errorCode === "E_NOT_AVAILABLE") return "devices.err.unavailable";
  if (o.reason === "device-owner") return "devices.err.owner";
  if (o.kind === "forbidden" || o.errorCode === "E_DENIED") return "devices.err.denied";
  if (o.errorCode === "E_NOT_FOUND") return "devices.err.notFound";
  if (o.errorCode === "E_INVALID_PARAMS") return "devices.err.invalid";
  if (o.errorCode === "E_CONFLICT") return "devices.err.conflict";
  if (o.errorCode === "E_STORAGE") return "devices.err.storage";
  return "devices.err.failed";
}

const when = (ms: number): string => formatDateTime(new Date(ms));

function RenameDialog({ device, onDone, onClose }: { device: Device; onDone: () => void; onClose: () => void }): View {
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim();
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy || trimmed === "") return;
    setBusy(true); setError("");
    try { await getApi().rpc("device.rename", { id: device.id, name: trimmed }); onDone(); onClose(); }
    catch (err) { setError(t(deviceErrorKey(err))); setBusy(false); }
  };
  return h(Dialog, { title: t("devices.rename.title"), onClose, actions: [
    h("button", { key: "c", type: "button", class: "btn", onClick: onClose }, t("shared.confirm.cancel")),
    h("button", { key: "s", type: "submit", form: "dev-rename-form", class: "btn btn-primary", disabled: busy || trimmed === "" }, t("devices.rename.save")),
  ] },
  h("form", { id: "dev-rename-form", onSubmit: (e: Event) => { void submit(e); } },
    h("label", { class: "field", for: "dev-rename-name" }, h("span", { class: "field-label" }, t("devices.field.name"))),
    h("input", { id: "dev-rename-name", type: "text", class: "input", maxLength: 200, value: name, autofocus: true, "aria-invalid": error ? "true" : undefined, onInput: (e: Event) => { setName((e.target as HTMLInputElement).value); } }),
    error ? h("p", { class: "form-error", role: "alert" }, error) : null));
}

function DeviceRow({ d, me, privileged, onRename, onRevoke }: { d: Device; me: string | undefined; privileged: boolean; onRename: (d: Device) => void; onRevoke: (d: Device) => void }): View {
  const mine = me !== undefined && d.pairedBy === me;
  return h("li", { class: "devices-row", "data-device": d.id },
    h("div", { class: "devices-who" },
      h("strong", {}, d.name),
      h("span", { class: "field-hint" }, `${t("devices.field.platform")}: ${d.platform}`)),
    h("dl", { class: "devices-facts" },
      h("div", {}, h("dt", {}, t("devices.field.pairedAt")), h("dd", {}, t("devices.pairedAtBy", { when: when(d.pairedAt), by: d.pairedBy }))),
      h("div", {}, h("dt", {}, t("devices.field.lastSeen")), h("dd", {}, when(d.lastSeenAt))),
      h("div", {}, h("dt", {}, t("devices.field.status")), h("dd", {}, d.revoked
        ? h(Badge, { tone: "neutral" }, t("devices.status.revoked"))
        : h(Badge, { tone: "ok" }, t("devices.status.active"))))),
    d.revoked ? null : h("div", { class: "devices-actions" },
      mine ? h("button", { type: "button", class: "btn", "aria-label": t("devices.rename.for", { name: d.name }), onClick: () => { onRename(d); } }, t("devices.rename")) : null,
      mine || privileged ? h("button", { type: "button", class: "btn btn-danger", "aria-label": t("devices.revoke.for", { name: d.name }), onClick: () => { onRevoke(d); } }, t("devices.revoke")) : null));
}

export function DeviceList(): View {
  const { state, reload } = useLoad(async (signal) => (await getApi().rpc("device.list", {}, { write: false, signal })).devices, []);
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [flash, setFlash] = useState("");
  const s = sessionState.value;
  const me = s.status === "authenticated" ? s.user.id : undefined;
  const privileged = roleIn(currentRole(), ["owner", "admin"]) && currentRole() !== undefined;

  const revoke = async (d: Device): Promise<ConfirmResult> => {
    try { await getApi().rpc("device.revoke", { id: d.id }); setFlash(t("devices.flash.revoked", { name: d.name })); reload(); return { ok: true }; }
    catch (e) { return { ok: false, message: t(deviceErrorKey(e)) }; }
  };

  let body: View;
  if (state.status === "loading") body = h(PageLoading, { label: t("state.loading") });
  else if (state.status === "fail") body = state.failure.kind === "forbidden" ? h(PageState, { state: "forbidden" })
    : h(FailureState, { failure: state.failure, unavailable: t("devices.list.unavailable"), onRetry: reload });
  else if (state.data.length === 0) body = h(PageState, { state: "empty", title: t("devices.empty.title"), detail: t("devices.empty.body") });
  else body = h("ul", { class: "plain-list devices-list", "aria-label": t("devices.list") },
    state.data.map((d) => h(DeviceRow, { key: d.id, d, me, privileged, onRename: setRenaming, onRevoke: setRevoking })));

  return h(Card, { title: t("devices.list"), level: 3 },
    flash ? h("p", { class: "form-notice", role: "status" }, flash) : null,
    body,
    renaming ? h(RenameDialog, { device: renaming, onDone: () => { setFlash(t("devices.flash.renamed")); reload(); }, onClose: () => { setRenaming(null); } }) : null,
    revoking ? h(ConfirmDialog, {
      title: t("devices.revoke.title", { name: revoking.name }), confirmLabel: t("devices.revoke.confirm"), danger: true,
      onConfirm: () => revoke(revoking), onClose: () => { setRevoking(null); },
    }, h("p", {}, t("devices.revoke.body"))) : null);
}
