import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../../i18n.ts";
import { getApi } from "../../common/load.ts";
import { enrollPasskey } from "../../../passkeys.ts";
import { initSession } from "../../../session.ts";
import type { View } from "../../../view.ts";
export function PasskeysPanel(): View {
  const [keys, setKeys] = useState<{ id: string; name: string }[]>([]), [name, setName] = useState(""), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [totp, setTotp] = useState(false), [secret, setSecret] = useState(""), [code, setCode] = useState(""), [backup, setBackup] = useState<string[]>([]);
  useEffect(() => { const api = getApi(); void Promise.all([api.get<{ keys: { id: string; name: string }[] }>("/api/v1/me/passkeys"), api.get<{ enabled: boolean }>("/api/v1/me/totp")]).then(([p, f]) => { setKeys(p.keys); setTotp(f.enabled); }).catch(() => setFailed(true)); }, []);
  const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setFailed(false); try { await fn(); } catch { setFailed(true); } finally { setBusy(false); setCode(""); } };
  const change = (id: string, next?: string) => run(async () => { await getApi().post("/api/v1/me/passkeys/change", { id, ...(next ? { name: next } : {}) }); await initSession(); });
  return h("section", { "aria-labelledby": "passkeys-heading" }, h("h3", { id: "passkeys-heading" }, t("passkeys.title")),
    h("label", { for: "passkey-name" }, t("passkeys.name")), h("input", { id: "passkey-name", value: name, maxlength: 80, onInput: (e: Event) => setName((e.target as HTMLInputElement).value) }),
    h("button", { type: "button", disabled: busy || !name.trim(), onClick: () => run(() => enrollPasskey(getApi(), name)) }, t("passkeys.add")),
    h("ul", {}, keys.map(k => h("li", { key: k.id }, k.name, " ", h("button", { type: "button", disabled: busy || !name.trim(), onClick: () => change(k.id, name) }, t("passkeys.rename")), " ", h("button", { type: "button", disabled: busy, onClick: () => change(k.id) }, t("passkeys.revoke"))))),
    h("h3", {}, t("passkeys.totp")),
    h("label", { for: "factor-code" }, t("passkeys.code")), h("input", { id: "factor-code", value: code, autocomplete: "one-time-code", onInput: (e: Event) => setCode((e.target as HTMLInputElement).value) }),
    !totp ? h("button", { type: "button", disabled: busy, onClick: () => run(async () => { const r = await getApi().post<{ secret: string }>("/api/v1/me/totp/setup", {}); setSecret(r.secret); }) }, t("passkeys.setupTotp")) : h("button", { type: "button", disabled: busy || !code, onClick: () => run(async () => { await getApi().post("/api/v1/me/totp/disable", { code }); await initSession(); }) }, t("passkeys.disableTotp")),
    secret ? [h("output", {}, secret), h("button", { type: "button", disabled: busy || !code, onClick: () => run(async () => { const r = await getApi().post<{ backupCodes: string[] }>("/api/v1/me/totp/confirm", { code }); setBackup(r.backupCodes); setSecret(""); setTotp(true); }) }, t("passkeys.confirmTotp"))] : null,
    backup.length ? h("output", { role: "status" }, backup.join("\n")) : null,
    failed ? h("p", { role: "alert" }, t("passkeys.failure")) : null);
}
