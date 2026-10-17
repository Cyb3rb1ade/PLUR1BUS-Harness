// Bootstrap is loaded only when the account step is shown, keeping the wizard page within its existing budget.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import { sessionState, signInAccount } from "../../session.ts";
import { Field, bad } from "../common/field.ts";
import type { StepProps } from "./steps.ts";
import "../../styles/setup.css";

export function AccountStep({ errors }: StepProps): View {
  const s = sessionState.value;
  const [token, setToken] = useState("");
  const [failed, setFailed] = useState(false);
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [pending, setPending] = useState(false);
  if (s.status === "authenticated") {
    return h("div", {}, h("p", { role: "status" }, t("setup.account.signedIn", { user: s.user.id, role: s.user.role })), h("p", { class: "field-hint" }, t("setup.account.hint")));
  }
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (pending) return; setPending(true); setFailed(false);
    try {
      const response = await fetch("/api/v1/accounts/bootstrap", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof: token.trim(), username, password }) });
      if (!response.ok) throw new Error("bootstrap failed"); const r = await signInAccount({ username, password }); setFailed(!r.ok);
    } catch { setFailed(true); } finally { setToken(""); setPassword(""); setPending(false); }
  };
  const error = failed ? t("setup.account.failed") : errors.account ? t("setup.account.needSignIn") : undefined;
  return h("form", { noValidate: true, onSubmit: (e: Event) => { void submit(e); } },
    h(Field, { id: "setup-token", label: t("setup.account.token"), hint: t("setup.account.hint"), error },
      h("input", { id: "setup-token", type: "password", autocomplete: "off", spellcheck: false, value: token, ...bad(error, "setup-token"), onInput: (e: Event) => { setToken((e.target as HTMLInputElement).value); } })),
    h(Field, { id: "setup-username", label: t("login.account.username") }, h("input", { id: "setup-username", value: username, autocomplete: "username", onInput: (e: Event) => setUsername((e.target as HTMLInputElement).value) })),
    h(Field, { id: "setup-password", label: t("join.password") }, h("input", { id: "setup-password", type: "password", value: password, autocomplete: "new-password", onInput: (e: Event) => setPassword((e.target as HTMLInputElement).value) })),
    h("button", { type: "submit", class: "btn", disabled: pending }, t("join.submit")));
}

