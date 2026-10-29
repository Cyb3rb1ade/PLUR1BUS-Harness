import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../view.ts";
import { Page } from "../components/page.ts";
import { t, formatDateTime } from "../i18n.ts";
import { registerArea } from "../i18n/index.ts";
import * as area from "../i18n/devices.ts";
import { signOut } from "../session.ts";
import { DesktopApprovalClient, type DesktopApproval } from "./desktop-approval-model.ts";
import type { PageProps } from "./registry.ts";
registerArea("devices", area);

export function DesktopApprovalPage({ sub }: PageProps): View {
  const [code, setCode] = useState(""), [value, setValue] = useState<DesktopApproval | null>(null);
  const [pending, setPending] = useState(false), [failure, setFailure] = useState("");
  const client = useRef(new DesktopApprovalClient()), busy = useRef(false);
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => { setFailure("expired"); setValue(null); }, Math.max(0, value.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [value]);
  const act = async (decision?: "approve" | "decline"): Promise<void> => {
    if (busy.current) return;
    busy.current = true; setPending(true); setFailure("");
    try { setValue(decision ? await client.current.decide(value!.userCode, decision) : await client.current.lookup(code)); }
    catch (error) { setFailure(error instanceof Error && ["invalid-code", "expired", "fresh-mfa", "denied", "network"].includes(error.message) ? error.message : "unavailable"); }
    finally { busy.current = false; setPending(false); }
  };
  if (sub !== "approve") return h(Page, { title: t("devices.stepup.title") }, h("p", { role: "alert" }, t("devices.stepup.unavailable")));
  return h(Page, { title: t("devices.stepup.title"), lead: t("devices.stepup.lead") },
    h("p", { class: "reading" }, t("devices.stepup.origin", { origin: globalThis.location?.origin ?? "" })),
    h("form", { onSubmit: (event: Event) => { event.preventDefault(); void act(); } },
      h("label", { for: "desktop-approval-code" }, t("devices.stepup.code")),
      h("input", { id: "desktop-approval-code", value: code, maxLength: 32, autocomplete: "off", spellcheck: false,
        disabled: pending, onInput: (event: Event) => { setCode((event.target as HTMLInputElement).value); setValue(null); setFailure(""); } }),
      h("button", { type: "submit", class: "btn", disabled: pending || !code.trim() }, t("devices.stepup.review"))),
    failure ? h("p", { role: "alert", class: "form-error" }, t(`devices.stepup.${failure as "invalid-code" | "expired" | "fresh-mfa" | "denied" | "network" | "unavailable"}`)) : null,
    failure === "fresh-mfa" ? h("button", { type: "button", class: "btn", onClick: () => { void signOut(); } }, t("devices.stepup.login")) : null,
    value ? h("section", { "aria-live": "polite" },
      h("h2", null, t("devices.stepup.review")),
      h("p", null, t("devices.stepup.device", { device: value.deviceId })),
      h("p", null, t(`devices.stepup.purpose.${value.purpose}`)),
      h("p", null, t("devices.stepup.expires", { when: formatDateTime(new Date(value.expiresAt)) })),
      value.state === "pending" ? h("div", { class: "form-actions" },
        h("button", { type: "button", class: "btn", disabled: pending, onClick: () => { void act("approve"); } }, t("devices.stepup.approve")),
        h("button", { type: "button", class: "btn btn-quiet", disabled: pending, onClick: () => { void act("decline"); } }, t("devices.stepup.decline")))
        : h("p", { role: "status" }, t(`devices.stepup.${value.state}`))) : null);
}
