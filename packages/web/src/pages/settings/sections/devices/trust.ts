import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../../../view.ts";
import { Card } from "../../../../components/card.ts";
import { formatDateTime, t } from "../../../../i18n.ts";
import { getApi, useLoad } from "../../../common/load.ts";
import { deviceErrorKey } from "./list.ts";
interface Trust {
  phase: "none" | "staged"; current: { kind: "cert" | "ca"; pin: string }; next?: { kind: "cert" | "ca"; pin: string }; stagedAt?: number;
  progress: { received: number; total: number; missing: { id: string; name: string }[] };
}
export function TrustCard({ onActivated }: { onActivated?: () => void }): View | null {
  const { state, reload } = useLoad(signal => getApi().get<Trust>("/api/v1/devices/trust", { signal }), []);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  useEffect(() => {
    const stream = getApi().events({ onEvent: e => {
      let named = e.event === "devices.trust.next";
      try { const body = JSON.parse(e.data) as { type?: string; method?: string }; named ||= body.type === "devices.trust.next" || body.method === "devices.trust.next"; } catch { /* only named notices trigger a reload */ }
      if (named) reload();
    } });
    return () => stream.close();
  }, [reload]);
  async function rotate(operation: "stage" | "activate" | "cancel") {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try { await getApi().post("/api/v1/devices/trust/rotate", { operation }); if (operation === "activate") onActivated?.(); reload(); }
    catch (err) { setError(t(deviceErrorKey(err))); }
    finally { lock.current = false; setBusy(false); }
  }
  if (state.status !== "ok") return null;
  const trust = state.data;
  return h(Card, { title: t("devices.trust.title"), level: 3 },
    h("p", {}, t("devices.trust.current")), h("p", { class: "a-mono" }, trust.current.pin),
    trust.phase === "staged" ? h("div", { role: "status" },
      h("p", {}, t("devices.trust.staged")), trust.next ? h("p", { class: "a-mono" }, trust.next.pin) : null,
      trust.stagedAt !== undefined ? h("p", {}, formatDateTime(new Date(trust.stagedAt))) : null,
      h("p", {}, t("devices.trust.progress", { received: trust.progress.received, total: trust.progress.total })),
      trust.progress.missing.length ? h("div", {}, h("p", {}, t("devices.trust.missing")), h("ul", {}, trust.progress.missing.map(device => h("li", { key: device.id }, device.name)))) : null) : null,
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,
    h("div", { class: "devices-actions" },
      h("button", { type: "button", class: "btn", onClick: reload }, t("devices.trust.refresh")),
      trust.phase === "none" ? h("button", { type: "button", class: "btn", "aria-disabled": String(busy), onClick: () => { void rotate("stage"); } }, t("devices.trust.stage")) : [
        h("button", { key: "activate", type: "button", class: "btn btn-primary", "aria-disabled": String(busy), onClick: () => { void rotate("activate"); } }, t("devices.trust.activate")),
        h("button", { key: "cancel", type: "button", class: "btn", "aria-disabled": String(busy), onClick: () => { void rotate("cancel"); } }, t("devices.trust.cancel")),
      ]));
}
