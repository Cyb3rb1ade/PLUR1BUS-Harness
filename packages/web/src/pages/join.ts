import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import { t } from "../i18n.ts";
import type { View } from "../view.ts";
export function JoinPage(): View {
  const [code, setCode] = useState(() => (location.hash.startsWith("#/invite/") ? location.hash.slice("#/invite/".length) : null) ?? new URLSearchParams(location.search).get("code") ?? new URLSearchParams(location.hash.split("?")[1]).get("code") ?? "");
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false); const lock = useRef(false); const [done, setDone] = useState(false); const [error, setError] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault(); if (lock.current) return; setError("");
    if (password !== repeat) { setError(t("join.invalid")); return; }
    lock.current = true; setBusy(true);
    history.replaceState(null, "", `${location.pathname}#/join`);
    try {
      const res = await fetch("/api/v1/invitations/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ code, username, password }) });
      if (res.ok) { setDone(true); setPassword(""); setRepeat(""); setCode(""); }
      else { const body = await res.json().catch(() => ({})) as { error?: string }; setError(t(res.status === 429 ? "join.rate" : body.error === "E_INVITE_INVALID" ? "join.used" : body.error === "E_CONFLICT" ? "join.exists" : "join.invalid")); }
    } catch { setError(t("join.invalid")); } finally { lock.current = false; setBusy(false); }
  };
  const field = (id: string, label: string, value: string, set: (v: string) => void, type = "text") => h("label", { for: id }, label, h("input", { id, type, required: true, value, autocomplete: type === "password" ? "new-password" : id === "join-username" ? "username" : "off", onInput: (e: Event) => set((e.target as HTMLInputElement).value) }));
  return h("main", { class: "login" }, h("h1", null, t("join.title")), done ? h("div", { role: "status" }, t("join.success"), h("a", { href: "#/login" }, t("join.login"))) : h("form", { onSubmit: submit }, field("join-code", t("join.code"), code, setCode), field("join-username", t("join.username"), username, setUsername), field("join-password", t("join.password"), password, setPassword, "password"), field("join-repeat", t("join.repeat"), repeat, setRepeat, "password"), error ? h("p", { role: "alert" }, error) : null, h("button", { type: "submit", disabled: busy }, t("join.submit"))));
}
