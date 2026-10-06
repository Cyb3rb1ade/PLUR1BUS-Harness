import { h } from "preact";
import type { View } from "../view.ts";
import { useEffect, useRef, useState } from "preact/hooks";
import { PreferenceControls } from "../components/controls.ts";
import { t } from "../i18n.ts";
import { icon } from "../icons.ts";
import { signIn, type LoginFailure } from "../session.ts";

function failureText(f: LoginFailure): string {
  switch (f.kind) {
    case "invalid-credentials": return t("login.error.invalid");
    case "rate-limited": return f.retryAfterSeconds === null ? t("login.error.rateUnknown") : t("login.error.rate", { seconds: f.retryAfterSeconds });
    case "network": return t("login.error.network");
    case "server": return t("login.error.server", { status: f.status });
  }
}

type Err = { kind: "required" } | { kind: "failure"; failure: LoginFailure };

export function LoginPage(): View {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  useEffect(() => { userRef.current?.focus(); }, []);

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    if (username.trim() === "" || password === "") {
      setError({ kind: "required" });
      (username.trim() === "" ? userRef : passRef).current?.focus();
      return;
    }
    setError(null);
    setPending(true);
    const result = await signIn(username.trim(), password);
    setPending(false);
    if (!result.ok) {
      setError({ kind: "failure", failure: result.failure });
      setPassword("");
      passRef.current?.focus();
    }
  };

  const message = error === null ? "" : error.kind === "required" ? t("login.error.required") : failureText(error.failure);
  const invalid = error !== null;
  const describedBy = invalid ? "login-error" : undefined;

  return h("div", { class: "login" },
    h("header", { class: "login-tools" }, h(PreferenceControls, { idPrefix: "login" })),
    h("main", { class: "login-card", id: "main" },
      h("p", { class: "wordmark big", "aria-hidden": "true" }, "PLUR", h("span", { class: "one" }, "1"), "BUS"),
      h("h1", { tabIndex: -1 }, t("login.title")),
      h("p", { class: "lead" }, t("login.lead")),
      h("form", { noValidate: true, onSubmit },
        h("div", { class: "field" },
          h("label", { for: "login-username" }, t("login.username")),
          h("input", {
            id: "login-username", name: "username", type: "text", ref: userRef, value: username, autoComplete: "username",
            autoCapitalize: "none", spellcheck: false, required: true, "aria-invalid": invalid, "aria-describedby": describedBy,
            onInput: (e: Event) => setUsername((e.target as HTMLInputElement).value),
          })),
        h("div", { class: "field" },
          h("label", { for: "login-password" }, t("login.password")),
          h("div", { class: "password-row" },
            h("input", {
              id: "login-password", name: "password", type: reveal ? "text" : "password", ref: passRef, value: password,
              autoComplete: "current-password", required: true, "aria-invalid": invalid, "aria-describedby": describedBy,
              onInput: (e: Event) => setPassword((e.target as HTMLInputElement).value),
            }),
            h("button", { type: "button", class: "icon-btn", onClick: () => setReveal(!reveal) },
              icon(reveal ? "eyeOff" : "eye"), h("span", { class: "sr-only" }, reveal ? t("login.hide") : t("login.show"))))),
        h("div", { id: "login-error", class: "form-error", role: "alert" }, message),
        h("button", { type: "submit", class: "btn btn-primary", "aria-disabled": pending }, pending ? t("login.submitting") : t("login.submit")))));
}
