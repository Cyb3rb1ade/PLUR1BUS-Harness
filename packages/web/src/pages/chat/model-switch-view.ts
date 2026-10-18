import { h } from "preact";
import { useId, useState } from "preact/hooks";
import { t } from "../../i18n.ts";
import { getApi } from "../../api/shared.ts";
import type { View } from "../../view.ts";
import { confirmModelSwitch, previewModelSwitch, type ModelSwitchPreview } from "./model-switch.ts";
export function ModelSwitch({ sessionId, running }: { sessionId: string; running: boolean }): View {
  const id = useId(), [profile, setProfile] = useState(""), [preview, setPreview] = useState<ModelSwitchPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [done, setDone] = useState(false);
  const request = async (confirm: boolean) => {
    if (busy || running) return;
    setBusy(true); setError(false); setDone(false);
    try {
      if (confirm && preview) { await confirmModelSwitch(getApi(), preview); setPreview(null); setDone(true); }
      else setPreview(await previewModelSwitch(getApi(), sessionId, profile.trim()));
    } catch { setPreview(null); setError(true); }
    finally { setBusy(false); }
  };
  return h("section", { "aria-label": t("chat.model.label") },
    h("label", { for: id }, t("chat.model.label")),
    h("input", { id, value: profile, disabled: busy || running || preview !== null, onInput: (e: Event) => { setProfile((e.target as HTMLInputElement).value); setDone(false); } }),
    h("button", { type: "button", class: "btn", disabled: busy || running || !profile.trim() || preview !== null, onClick: () => { void request(false); } }, t("chat.model.preview")),
    preview ? h("div", { role: "group", "aria-label": t("chat.model.confirm") },
      h("p", { role: "alert" }, t("chat.model.warning", { profile: preview.profile })),
      h("button", { type: "button", class: "btn", disabled: busy || running, onClick: () => { void request(true); } }, t("chat.model.confirm")),
      h("button", { type: "button", class: "btn", disabled: busy, onClick: () => { setPreview(null); } }, t("chat.model.cancel"))) : null,
    error ? h("p", { role: "alert" }, t("chat.model.error")) : null,
    done ? h("p", { role: "status" }, t("chat.model.done")) : null);
}
