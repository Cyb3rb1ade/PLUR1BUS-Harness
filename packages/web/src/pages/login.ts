import { passkeyLogin } from "../passkeys.ts";
import { h } from "preact";
import type { View } from "../view.ts";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { PreferenceControls } from "../components/controls.ts";
import { t } from "../i18n.ts";
import { icon } from "../icons.ts";
import { sessionNotice, signIn, signInAccount, type LoginFailure } from "../session.ts";

function failureText(f: LoginFailure): string {
  switch (f.kind) {
    case "invalid-token": return t("login.error.invalid");
    case "rate-limited":
      if (f.retryAfterSeconds === null) return t("login.error.rateUnknown");
      return f.retryAfterSeconds >= 120 ? t("login.error.rateMinutes", { minutes: Math.ceil(f.retryAfterSeconds / 60) }) : t("login.error.rate", { seconds: f.retryAfterSeconds });
    case "network": return t("login.error.network");
    case "server": return t("login.error.server", { status: f.status });
  }
}

type Err = { kind: "required" } | { kind: "failure"; failure: LoginFailure };

export function LoginPage(): View {
  const [webAuthnFactor, setWebAuthnFactor] = useState(false); const [account, setAccount] = useState(false); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [challenge, setChallenge] = useState<string | null>(null); const [code, setCode] = useState(""); const submitting = useRef(false);
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  // Layout effect: the field has the focus in the draw that shows the form. A passive effect runs after the paint, when the form is
  // already operable, and its late focus() would pull the focus back from a key or click that came first.
  useLayoutEffect(() => { tokenRef.current?.focus(); }, []);

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (submitting.current) return;
    if (account && challenge && webAuthnFactor) { submitting.current = true; setPending(true); try { await passkeyLogin(username, challenge); } catch { setError({ kind: "failure", failure: { kind: "invalid-token" } }); } finally { submitting.current = false; setPending(false); } return; }
    if (account ? challenge ? code.trim() === "" : username.trim() === "" || password === "" : token.trim() === "") {
      setError({ kind: "required" });
      tokenRef.current?.focus();
      return;
    }
    setError(null);
    submitting.current = true; setPending(true);
    const result = account ? await signInAccount(challenge ? { challenge, code } : { username, password }) : await signIn(token.trim());
    submitting.current = false; setPassword(""); setCode("");
    setPending(false);
    setToken(""); // the token lives in this field only until it has been sent, after a failure too
    setReveal(false); // and the next attempt starts masked
    if (!result.ok && "challenge" in result) { setChallenge(result.challenge); setWebAuthnFactor(result.mfa === "webauthn"); return; }
    if (!result.ok) {
      setError({ kind: "failure", failure: result.failure });
      tokenRef.current?.focus();
    }
  };

  const message = error === null ? "" : error.kind === "required" ? t(account ? "login.account.required" : "login.error.required") : account && error.failure.kind === "invalid-token" ? t("login.account.invalid") : failureText(error.failure);
  const invalid = error !== null;
  const describedBy = invalid ? "login-error" : undefined;

  return h("div", { class: "login" },
    h("header", { class: "login-tools" }, h(PreferenceControls, { idPrefix: "login" })),
    h("main", { class: "login-card", id: "main" },
      h("p", { class: "wordmark big", "aria-hidden": "true" }, "PLUR", h("span", { class: "one" }, "1"), "BUS"),
      h("h1", { tabIndex: -1 }, t("login.title")),
      h("p", { class: "lead" }, t("login.lead")),
      h("a", { href: "#/setup", class: "btn btn-quiet" }, t("join.title")),
      sessionNotice.value === "expired" ? h("p", { class: "form-notice", role: "status" }, t("login.notice.expired")) : null,
      h("button", { type: "button", class: "btn btn-quiet", disabled: pending, onClick: () => { setAccount(!account); setChallenge(null); setError(null); setToken(""); setPassword(""); setCode(""); } }, t(account ? "login.account.owner" : "login.account.use")),
      h("button", { type: "button", class: "btn", disabled: pending || !username.trim(), onClick: async () => { if (submitting.current) return; submitting.current = true; setPending(true); try { await passkeyLogin(username, challenge ?? undefined); } catch { setError({ kind: "failure", failure: { kind: "invalid-token" } }); } finally { submitting.current = false; setPending(false); } } }, t("passkeys.login")),
      h("form", { noValidate: true, onSubmit },
        account ? h("div", null,
          challenge ? webAuthnFactor ? h("p", { role: "status" }, t("passkeys.login")) : h("label", { for: "login-totp" }, t("login.account.code"), h("input", { id: "login-totp", value: code, autocomplete: "one-time-code", onInput: (e: Event) => setCode((e.target as HTMLInputElement).value) })) : [
            h("label", { for: "login-username" }, t("login.account.username"), h("input", { id: "login-username", value: username, autocomplete: "username", onInput: (e: Event) => setUsername((e.target as HTMLInputElement).value) })),
            h("label", { for: "login-password" }, t("login.account.password"), h("input", { id: "login-password", type: "password", value: password, autocomplete: "current-password", onInput: (e: Event) => setPassword((e.target as HTMLInputElement).value) })),
          ]) : h("div", { class: "field" },
          h("label", { for: "login-token" }, t("login.token")),
          h("div", { class: "password-row" },
            h("input", {
              id: "login-token", name: "token", type: reveal ? "text" : "password", ref: tokenRef, value: token,
              autoComplete: "current-password", autoCapitalize: "none", spellcheck: false, required: true, "aria-invalid": invalid, "aria-describedby": describedBy,
              onInput: (e: Event) => setToken((e.target as HTMLInputElement).value),
            }),
            h("button", { type: "button", class: "icon-btn", onClick: () => setReveal(!reveal) },
              icon(reveal ? "eyeOff" : "eye"), h("span", { class: "sr-only" }, reveal ? t("login.hide") : t("login.show"))))),
        h("div", { id: "login-error", class: "form-error", role: "alert" }, message),
        h("button", { type: "submit", class: "btn btn-primary", disabled: pending, "aria-disabled": pending }, pending ? t("login.submitting") : t("login.submit")))));
}
