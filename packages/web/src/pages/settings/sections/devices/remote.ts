import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../../../view.ts";
import { Card } from "../../../../components/card.ts";
import { t, type Key } from "../../../../i18n.ts";
import { getApi } from "../../../common/load.ts";

export interface RemoteStatus {
  publish: "local" | "tailnet" | "network"; tls: "self-signed" | "company-ca"; publicOrigin?: string;
  bind: { address?: string; port?: number; allowPublicInterface?: boolean }; allowSubnets: string[];
  noticeRequired: boolean; noticeItems: { code: string; text: string }[];
  status: { state: "local" | "ready" | "unavailable" | "not-started"; reason?: string };
}
export function RemoteControls({ remote, onSaved, certificateActivated = false }: { remote: RemoteStatus; onSaved(): void; certificateActivated?: boolean }): View {
  const [publish, setPublish] = useState(remote.publish); const [tls, setTls] = useState(remote.tls);
  const [origin, setOrigin] = useState(remote.publicOrigin ?? ""); const [address, setAddress] = useState(remote.bind.address ?? "127.0.0.1");
  const [port, setPort] = useState(String(remote.bind.port ?? 8765)); const [subnets, setSubnets] = useState(remote.allowSubnets.join("\n"));
  const [cert, setCert] = useState<File | null>(null); const [key, setKey] = useState<File | null>(null);
  const certInput = useRef<HTMLInputElement>(null); const keyInput = useRef<HTMLInputElement>(null);
  const [companyReady, setCompanyReady] = useState(remote.tls === "company-ca"); const [certificateNotice, setCertificateNotice] = useState("");
  const [ack, setAck] = useState(false); const [publicBind, setPublicBind] = useState(remote.bind.allowPublicInterface === true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const network = publish === "network"; const unrestricted = address === "0.0.0.0" || address === "::";
  const numberPort = Number(port); const validPort = Number.isInteger(numberPort) && numberPort >= 1024 && numberPort <= 65535;
  const blocked = network && (!ack || !validPort || (unrestricted && !publicBind) || (tls === "company-ca" && !companyReady && !certificateActivated));
  async function upload() {
    if (!cert || !key || lock.current) return;
    if (cert.size > 32768 || key.size > 16384) { setError(t("devices.remote.certificate.large")); return; }
    lock.current = true; setBusy(true); setError("");
    try {
      const response = await getApi().post<{ certPin: string; staged?: boolean }>("/api/v1/remote/certificate", { certPem: await cert.text(), keyPem: await key.text() });
      setCompanyReady(response.staged !== true || remote.tls === "company-ca"); setCertificateNotice(t(response.staged ? "devices.remote.certificate.staged" : "devices.remote.certificate.saved"));
      setCert(null); setKey(null); if (certInput.current) certInput.current.value = ""; if (keyInput.current) keyInput.current.value = "";
    } catch (err) { setError(message(err, true)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function submit(e: Event) {
    e.preventDefault(); if (blocked || lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      if (network) await getApi().post("/api/v1/remote/confirm", { confirmed: true, version: 1 });
      await getApi().patch("/api/v1/remote", { publish, ...(network ? {
        tls, bind: { address: address.trim(), port: numberPort, allowPublicInterface: publicBind },
        allowSubnets: subnets.split(/[\n,]/).map(s => s.trim()).filter(Boolean), ...(origin.trim() ? { publicOrigin: origin.trim() } : {}),
      } : {}) });
      setAck(false); onSaved();
    } catch (err) { setError(message(err)); }
    finally { lock.current = false; setBusy(false); }
  }
  function message(err: unknown, certificate = false): string {
    const value = (typeof err === "object" && err !== null ? err : {}) as { kind?: string; errorCode?: string };
    if (value.kind === "forbidden" || value.errorCode === "E_DENIED") return t("devices.err.denied");
    return t(certificate ? "devices.remote.certificate.failed" : "devices.remote.failed");
  }
  const field = (id: string, key: Key, value: string, update: (value: string) => void, attrs: object = {}) => h("label", { class: "field", for: id },
    h("span", { class: "field-label", id: `${id}-label` }, t(key)), h("input", { id, "aria-labelledby": `${id}-label`, class: "input", value, disabled: busy, ...attrs, onInput: (e: Event) => update((e.target as HTMLInputElement).value) }));
  const check = (key: Key, checked: boolean, toggle: () => void) => h("button", { type: "button", role: "checkbox", class: "btn", "aria-checked": String(checked), "aria-disabled": String(busy), onClick: () => { if (!lock.current) toggle(); } }, t(key));
  return h(Card, { title: t("devices.remote.configure"), level: 3 },
    h("p", { role: "status" }, t(`devices.remote.status.${remote.status.state}` as Key)),
    h("form", { class: "devices-pair-form", onSubmit: (e: Event) => { void submit(e); } },
      h("label", { class: "field", for: "remote-publish" }, h("span", { class: "field-label", id: "remote-publish-label" }, t("devices.remote.publish")),
        h("select", { id: "remote-publish", "aria-labelledby": "remote-publish-label", value: publish, disabled: busy, onChange: (e: Event) => { setPublish((e.target as HTMLSelectElement).value as RemoteStatus["publish"]); setAck(false); } },
          ...["local", "tailnet", "network"].map(mode => h("option", { value: mode, key: mode }, t(`devices.remote.mode.${mode}` as Key))))),
      network ? h("div", { class: "devices-pair-form" },
        h("label", { class: "field", for: "remote-tls" }, h("span", { class: "field-label", id: "remote-tls-label" }, t("devices.remote.tls")),
          h("select", { id: "remote-tls", "aria-labelledby": "remote-tls-label", value: tls, disabled: busy, onChange: (e: Event) => setTls((e.target as HTMLSelectElement).value as RemoteStatus["tls"]) },
            h("option", { value: "self-signed" }, t("devices.remote.tls.self")), h("option", { value: "company-ca" }, t("devices.remote.tls.company")))),
        tls === "company-ca" ? h("div", { class: "devices-pair-form" },
          h("p", { class: "field-hint" }, t("devices.remote.certificate.hint")),
          h("label", { class: "field", for: "remote-cert" }, h("span", { class: "field-label", id: "remote-cert-label" }, t("devices.remote.certificate.cert")), h("input", { id: "remote-cert", "aria-labelledby": "remote-cert-label", ref: certInput, type: "file", class: "input", disabled: busy, accept: ".pem,.crt", onChange: (e: Event) => setCert((e.target as HTMLInputElement).files?.[0] ?? null) })),
          h("label", { class: "field", for: "remote-key" }, h("span", { class: "field-label", id: "remote-key-label" }, t("devices.remote.certificate.key")), h("input", { id: "remote-key", "aria-labelledby": "remote-key-label", ref: keyInput, type: "file", class: "input", disabled: busy, accept: ".pem,.key", onChange: (e: Event) => setKey((e.target as HTMLInputElement).files?.[0] ?? null) })),
          h("button", { type: "button", class: "btn", disabled: !cert || !key, "aria-disabled": String(busy || !cert || !key), onClick: () => { void upload(); } }, t("devices.remote.certificate.upload")),
          certificateNotice ? h("p", { role: "status" }, certificateNotice) : null) : null,
        field("remote-bind", "devices.remote.bind", address, setAddress, { maxLength: 128, required: true }),
        field("remote-port", "devices.remote.port", port, setPort, { type: "number", min: 1024, max: 65535, required: true }),
        field("remote-origin", "devices.remote.origin", origin, setOrigin, { type: "url", placeholder: "https://harness.example", maxLength: 512 }),
        h("label", { class: "field", for: "remote-subnets" }, h("span", { class: "field-label", id: "remote-subnets-label" }, t("devices.remote.subnets")), h("textarea", { id: "remote-subnets", "aria-labelledby": "remote-subnets-label", class: "input", rows: 3, value: subnets, disabled: busy, onInput: (e: Event) => setSubnets((e.target as HTMLTextAreaElement).value) })),
        unrestricted ? check("devices.remote.publicBind", publicBind, () => setPublicBind(!publicBind)) : null,
        h("div", { role: "region", "aria-label": t("devices.remote.notice") },
          h("p", {}, t("devices.remote.notice.body")),
          h("ul", {}, remote.noticeItems.map(item => h("li", { key: item.code }, t((`devices.remote.notice.${item.code}`) as Key)))),
          check("devices.remote.ack", ack, () => setAck(!ack)))) : null,
      error ? h("p", { class: "form-error", role: "alert" }, error) : null,
      h("button", { type: "submit", class: "btn btn-primary", disabled: blocked, "aria-disabled": String(busy || blocked) }, t("devices.remote.save"))));
}
