// Settings > Devices & remote. Gate: `config.get` key `remote.publish`. Hidden (with a short note) at `local` and when the key is
// unknown or unserved (Owner/Admin read it). `pairing.qr` formats an existing pairing offer as a QR code and link. `device.list/rename/revoke`
// show the paired devices: Owner/Admin see all, everyone else only their own (the server filters; see ./devices/list.ts).
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Card } from "../../../components/card.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { formatDateTime, t } from "../../../i18n.ts";
import { FailureState, Notice } from "../../common/states.ts";
import { currentRole, failureOf, getApi, roleIn, useLoad, type Failure } from "../../common/load.ts";
import type { SectionProps } from "../page.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as devicesArea from "../../../i18n/devices.ts";
import "../../../styles/devices.css";
import { QrCodeView } from "./devices/qr.ts";
import { DeviceList } from "./devices/list.ts";
import "../../common/admin-rpc.ts";
import type { PairingQrResult } from "../../common/admin-rpc.ts";

registerArea("devices", devicesArea);

type Gate = { mode: string | null };
const UNKNOWN_KEY = new Set(["E_NOT_FOUND", "E_CONFIG_INVALID", "E_NOT_AVAILABLE", "E_INVALID_PARAMS"]);

async function loadGate(signal: AbortSignal): Promise<Gate> {
  try {
    const r = await getApi().rpc("config.get", { key: "remote.publish" }, { write: false, signal }) as { value?: unknown };
    return { mode: typeof r.value === "string" && r.value !== "" && r.value !== "local" ? r.value : null };
  } catch (e) {
    const f: Failure = failureOf(e);
    const code = (e as { errorCode?: string | null }).errorCode;
    if (f.kind === "unavailable" || f.kind === "not-found" || (code && UNKNOWN_KEY.has(code))) return { mode: null };
    throw e;
  }
}

function PairCard(): View {
  const [link, setLink] = useState("");
  const [qr, setQr] = useState<PairingQrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchQr = async (targetLink: string): Promise<void> => {
    if (!targetLink) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getApi().rpc("pairing.qr", { link: targetLink }, { write: false });
      setQr(res);
    } catch (e: unknown) {
      const err = e as { kind?: string; errorCode?: string; message?: string };
      if (err.kind === "unavailable" || err.errorCode === "E_NOT_AVAILABLE") {
        setError(t("devices.pair.unavailable"));
      } else {
        setError(t("devices.pair.failed", { detail: err.message ?? err.errorCode ?? String(e) }));
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
          h("p", { class: "a-mono" }, qr.link))
      : h("div", { class: "devices-pair-form" },
          h(Notice, {}, t("devices.pair.unavailable")),
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
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, onRetry: reload });
  const mode = state.data.mode;
  if (mode === null) return h(PageState, { state: "empty", title: t("devices.off.title"), detail: t("devices.off.body") });
  return h("div", { class: "devices" },
    h(Card, { title: t("devices.mode"), level: 3 }, h("p", {}, t("devices.mode.value", { mode }))),
    h(DeviceList, {}),
    h(PairCard, {}));
}

export function DevicesSection({ section }: SectionProps): View {
  const privileged = roleIn(currentRole(), ["owner", "admin"]);
  return h("section", { "data-section": section.id, "aria-labelledby": "devices-h" },
    h("h2", { id: "devices-h" }, t("devices.title")),
    privileged ? h(Loaded, {}) : h(DeviceList, {}));
}
