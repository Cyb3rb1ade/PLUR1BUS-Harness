// Settings > Devices & remote. Gate: `config.get` key `remote.publish`. Hidden (with a short note) at `local` and when the key is
// unknown or unserved (Owner/Admin read it). `pairing.qr` formats an existing pairing offer as a QR code and link. `device.list/rename/revoke`
// show the paired devices: Owner/Admin see all, everyone else only their own (the server filters; see ./devices/list.ts).
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Card } from "../../../components/card.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { formatDateTime, t } from "../../../i18n.ts";
import { FailureState, Notice } from "../../common/states.ts";
import { currentRole, failureOf, getApi, roleIn, useLoad } from "../../common/load.ts";
import type { SectionProps } from "../page.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as devicesArea from "../../../i18n/devices.ts";
import "../../../styles/devices.css";
import { QrCodeView } from "./devices/qr.ts";
import { DeviceList, deviceErrorKey } from "./devices/list.ts";
import { RemoteControls, type RemoteStatus } from "./devices/remote.ts";
import { TrustCard } from "./devices/trust.ts";
import "../../common/admin-rpc.ts";
import type { PairingQrResult } from "../../common/admin-rpc.ts";

registerArea("devices", devicesArea);

type Gate = { mode: string | null; remote?: RemoteStatus };
async function loadGate(signal: AbortSignal): Promise<Gate> {
  try {
    const remote = await getApi().get<RemoteStatus>("/api/v1/remote", { signal });
    if (!["local", "tailnet", "network"].includes(remote.publish)) return { mode: null };
    return { mode: remote.publish === "local" ? null : remote.publish, remote };
  } catch (e) {
    const failure = failureOf(e);
    if (failure.kind === "unavailable" || failure.kind === "not-found") return { mode: null };
    throw e;
  }
}

function PairCard(): View {
  const [link, setLink] = useState("");
  const [qr, setQr] = useState<PairingQrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState(""); const lock = useRef(false);
  const offered = useLoad(signal => getApi().get<{ pairingAvailable: boolean }>("/api/v1/devices/pairing", { signal }), []);
  async function createOffer() {
    if (lock.current) return; lock.current = true; setLoading(true); setError(null);
    try {
      const result = await getApi().post<PairingQrResult & { fingerprint: string }>("/api/v1/devices/pairing", {});
      setQr(result); setFingerprint(result.fingerprint);
    } catch (err) { setError(t(deviceErrorKey(err))); }
    finally { lock.current = false; setLoading(false); }
  }

  const fetchQr = async (targetLink: string): Promise<void> => {
    if (!targetLink) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getApi().rpc("pairing.qr", { link: targetLink }, { write: false });
      setQr(res);
    } catch (e: unknown) {
      // Never the server's text: a refusal can quote the pairing link, and the link carries the pairing code.
      const err = e as { kind?: string; errorCode?: string };
      if (err.kind === "unavailable" || err.errorCode === "E_NOT_AVAILABLE") {
        setError(t("devices.pair.unavailable"));
      } else {
        setError(t("devices.pair.failed", { detail: err.errorCode === "E_INVALID_PARAMS" ? t("devices.pair.invalidLink") : t(deviceErrorKey(e)) }));
      }
    } finally {
      setLoading(false);
    }
  };

  return h(Card, { title: t("devices.pair"), level: 3 },
    qr
      ? h("div", { class: "devices-qr-wrap" },
          h(QrCodeView, { text: qr.qr.text, label: t("devices.pair.scan") }),
          h("p", { class: "field-hint" }, t("devices.pair.scan")),
          h("p", { class: "field-hint" }, t("devices.pair.expires", { when: formatDateTime(new Date(qr.expiresAt)) })),
          h("p", { class: "a-mono" }, h("a", { href: qr.link }, qr.link)),
          fingerprint ? h("div", {}, h("p", {}, t("devices.pair.fingerprint")), h("p", { class: "a-mono" }, fingerprint)) : null)
      : h("div", { class: "devices-pair-form" },
          offered.state.status === "ok" && offered.state.data.pairingAvailable
            ? h("button", { type: "button", class: "btn btn-primary", "aria-disabled": String(loading), onClick: () => { void createOffer(); } }, t("devices.pair.create"))
            : h(Notice, {}, t("devices.pair.unavailable")),
          h("form", {
            class: "form-row",
            onSubmit: (e: Event) => {
              e.preventDefault();
              void fetchQr(link.trim());
            },
          },
            h("input", {
              type: "text",
              class: "input",
              placeholder: "plur1bus://pair?...",
              "aria-label": t("devices.pair.inputLink"),
              value: link,
              onInput: (e: Event) => { setLink((e.target as HTMLInputElement).value); },
            }),
            h("button", {
              type: "submit",
              class: "btn btn-primary",
              disabled: loading || !link.trim(),
            }, loading ? "..." : t("devices.pair.loadQr"))),
          error ? h("p", { class: "form-error", role: "alert" }, error) : null));
}

function Loaded(): View {
  const { state, reload } = useLoad(loadGate, []);
  const [changed, setChanged] = useState(false); const [certificateActivated, setCertificateActivated] = useState(false);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, onRetry: reload });
  const mode = state.data.mode;
  return h("div", { class: "devices" },
    changed ? h("p", { role: "status" }, t("devices.remote.saved")) : null,
    state.data.remote ? h(RemoteControls, { remote: state.data.remote, certificateActivated, onSaved: () => { setChanged(true); reload(); } }) : null,
    mode === null ? h(PageState, { state: "empty", title: t("devices.off.title"), detail: t("devices.off.body") }) : [
      h(Card, { key: "mode", title: t("devices.mode"), level: 3 }, h("p", {}, t("devices.mode.value", { mode }))),
      h(DeviceList, { key: "list" }), h(PairCard, { key: "pair" }), h(TrustCard, { key: "trust", onActivated: () => setCertificateActivated(true) }),
    ]);
}

export function DevicesSection({ section }: SectionProps): View {
  const privileged = roleIn(currentRole(), ["owner", "admin"]);
  return h("section", { "data-section": section.id, "aria-labelledby": "devices-h" },
    h("h2", { id: "devices-h" }, t("devices.title")),
    privileged ? h(Loaded, {}) : h(DeviceList, {}));
}
