// Settings > Devices & remote. Gate: `config.get` key `remote.publish`. Hidden (with a short note) at `local` and when the key is
// unknown or unserved; Owner/Admin only. No RPC lists paired devices, makes a QR code or deep link, or removes a device (F44),
// so those three parts are shown as unavailable and nothing is sent for them.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { Card } from "../../../components/card.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { t } from "../../../i18n.ts";
import { FailureState, Notice } from "../../common/states.ts";
import { currentRole, failureOf, getApi, roleIn, useLoad, type Failure } from "../../common/load.ts";
import type { SectionProps } from "../page.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as devicesArea from "../../../i18n/devices.ts";
import "../../../styles/devices.css";

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

function Loaded(): View {
  const { state, reload } = useLoad(loadGate, []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, onRetry: reload });
  const mode = state.data.mode;
  if (mode === null) return h(PageState, { state: "empty", title: t("devices.off.title"), detail: t("devices.off.body") });
  return h("div", { class: "devices" },
    h(Card, { title: t("devices.mode"), level: 3 }, h("p", {}, t("devices.mode.value", { mode }))),
    h(Card, { title: t("devices.list"), level: 3 }, h(Notice, {}, t("devices.list.unavailable"))),
    h(Card, { title: t("devices.pair"), level: 3 }, h(Notice, {}, t("devices.pair.unavailable"))),
    h(Card, { title: t("devices.remove"), level: 3 }, h(Notice, {}, t("devices.remove.unavailable"))));
}

export function DevicesSection({ section }: SectionProps): View {
  const allowed = roleIn(currentRole(), ["owner", "admin"]);
  return h("section", { "data-section": section.id, "aria-labelledby": "devices-h" },
    h("h2", { id: "devices-h" }, t("devices.title")),
    allowed ? h(Loaded, {}) : h(PageState, { state: "forbidden" }));
}
