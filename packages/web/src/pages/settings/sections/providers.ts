// Settings > Providers: list of provider credentials (auth.credentials.list, auth.status),
// OAuth sign-in flow (auth.login.start, await, cancel), headless port forwarding & callback paste,
// API key storage via secret.set (write-only, masked, never echoed), and logout (auth.logout).
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Badge } from "../../../components/card.ts";
import { ConfirmDialog } from "../../../components/confirm-dialog.ts";
import { Dialog } from "../../../components/dialog.ts";
import { PageLoading, PageState } from "../../../components/page-state.ts";
import { formatDateTime, t, type Key } from "../../../i18n.ts";
import { FailureState } from "../../common/states.ts";
import { currentRole, failureOf, getApi, roleIn, useLoad } from "../../common/load.ts";
import type { SectionProps } from "../page.ts";

export type AuthCredential = {
  id: string;
  person: string;
  workspace: string;
  kind: string;
  billingPath: string;
  expiresAt: number | null;
  needsLogin: boolean;
  provider?: string;
};

type ProviderRow = {
  id: string;
  provider: string;
  route: string;
  workspace: string;
  expiresAt: number | null;
  needsLogin: boolean;
  isSecret?: boolean;
};

type Data = {
  credentials: AuthCredential[];
  pendingLogins: number;
  apiKeys: string[];
};

const when = (ms: number | null): string => {
  if (ms === null || ms === 0) return "—";
  const d = new Date(ms > 1e11 ? ms : ms * 1000);
  return Number.isNaN(d.getTime()) ? "—" : formatDateTime(d);
};

async function load(signal: AbortSignal): Promise<Data> {
  const api = getApi();
  const [credRes, statusRes, secretsRes] = await Promise.all([
    api.rpc("auth.credentials.list", {}, { write: false, signal }) as Promise<{ credentials: AuthCredential[] }>,
    (api.rpc("auth.status", {}, { write: false, signal }) as Promise<{ credentials: AuthCredential[]; pendingLogins: number }>).catch(() => null),
    (api.rpc("secret.list", {}, { write: false, signal }) as Promise<{ secrets: { name: string }[] }>).catch(() => null),
  ]);

  const credentials = credRes?.credentials ?? [];
  const pendingLogins = statusRes?.pendingLogins ?? 0;
  const apiKeys = (secretsRes?.secrets ?? [])
    .map((s) => s.name)
    .filter((n) => n.endsWith("/api-key") || n.endsWith(".apiKey") || n.endsWith(".key"));

  return { credentials, pendingLogins, apiKeys };
}

function LoginDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (provider: string) => void;
}): View {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [callbackPort, setCallbackPort] = useState<number | null>(null);
  const [pastedUrl, setPastedUrl] = useState("");
  const [pasteNotice, setPasteNotice] = useState("");
  const [err, setErr] = useState("");
  const [awaiting, setAwaiting] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let active = true;
    getApi()
      .rpc("auth.login.start", { provider: "openai" })
      .then((res) => {
        if (!active) return;
        const r = res as { attemptId: string; authorizeUrl: string; callbackPort: number };
        setAttemptId(r.attemptId);
        setAuthorizeUrl(r.authorizeUrl);
        setCallbackPort(r.callbackPort);
        // Try to open authorization window automatically
        try {
          if (r.authorizeUrl) globalThis.window?.open(r.authorizeUrl, "_blank");
        } catch {
          // Popup blocked, user can click the link
        }
      })
      .catch((e) => {
        if (active) setErr(String((e as { message?: string }).message ?? e));
      });

    return () => {
      active = false;
    };
  }, []);

  const triggerAwait = async (attId: string): Promise<void> => {
    setAwaiting(true);
    setErr("");
    try {
      await getApi().rpc("auth.login.await", { attemptId: attId });
      if (!cancelledRef.current) {
        onSuccess("OpenAI");
        onClose();
      }
    } catch (e) {
      if (cancelledRef.current) return;
      const o = (typeof e === "object" && e !== null ? e : {}) as {
        reason?: string;
        errorCode?: string;
        message?: string;
      };
      const reason = o.reason ?? o.errorCode ?? "";
      if (reason === "login-timeout") setErr(t("providers.login.err.timeout"));
      else if (reason === "state-mismatch") setErr(t("providers.login.err.mismatch"));
      else if (reason === "access-denied" || reason === "scope-denied") setErr(t("providers.login.err.denied"));
      else if (reason === "port-in-use") setErr(t("providers.login.err.port"));
      else if (reason === "login-cancelled") {
        /* silent */
      } else setErr(o.message ? o.message : t("providers.login.err.generic", { reason: reason || "unknown" }));
    } finally {
      setAwaiting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    cancelledRef.current = true;
    if (attemptId) {
      try {
        await getApi().rpc("auth.login.cancel", { attemptId });
      } catch {
        /* silent */
      }
    }
    onClose();
  };

  const submitPaste = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!attemptId || !pastedUrl.trim()) return;
    try {
      await getApi().rpc("auth.login.callback", { attemptId, url: pastedUrl.trim() });
      setPastedUrl("");
      setPasteNotice(t("providers.login.waiting"));
    } catch {
      setPasteNotice(t("providers.login.pasteNotSupported"));
    }
  };

  return h(
    Dialog,
    {
      title: t("providers.login.title"),
      onClose: cancel,
      actions: h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: cancel }, t("shared.confirm.cancel")),
        attemptId
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                disabled: awaiting,
                onClick: () => {
                  void triggerAwait(attemptId);
                },
              },
              awaiting ? t("providers.login.waiting") : t("providers.action.refresh"),
            )
          : null,
      ),
    },
    h(
      "div",
      { class: "providers-login-dlg" },
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
      authorizeUrl
        ? h(
            "p",
            { class: "providers-authorize-link" },
            h(
              "a",
              {
                href: authorizeUrl,
                target: "_blank",
                rel: "noopener noreferrer",
                class: "btn btn-primary",
              },
              t("providers.login.authorize"),
            ),
          )
        : h(PageLoading, { label: t("providers.login.waiting") }),
      callbackPort
        ? h(
            "div",
            { class: "providers-headless-box" },
            h("p", { class: "field-hint" }, t("providers.login.headless")),
            h(
              "pre",
              { class: "code-block", tabIndex: 0 },
              h("code", null, `ssh -L ${callbackPort}:127.0.0.1:${callbackPort} user@this-host`),
            ),
          )
        : null,
      attemptId
        ? h(
            "form",
            { class: "providers-paste-form", onSubmit: (e: Event) => void submitPaste(e) },
            h(
              "label",
              { for: "provider-paste-url", class: "field-label" },
              t("providers.login.pasteLabel"),
            ),
            h("div", { class: "password-row" },
              h("input", {
                id: "provider-paste-url",
                type: "text",
                placeholder: "/auth/callback?code=...",
                value: pastedUrl,
                onInput: (e: Event) => setPastedUrl((e.target as HTMLInputElement).value),
              }),
              h("button", { type: "submit", class: "btn" }, t("providers.login.pasteSubmit")),
            ),
            pasteNotice ? h("p", { class: "field-hint", role: "status" }, pasteNotice) : null,
          )
        : null,
    ),
  );
}

function KeyDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, value: string) => Promise<boolean>;
}): View {
  const [provider, setProvider] = useState("openai");
  const [name, setName] = useState("openai/api-key");
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const handleProviderChange = (p: string): void => {
    setProvider(p);
    setName(`${p}/api-key`);
  };

  const submit = async (): Promise<void> => {
    if (!val.trim()) {
      setErr("Enter a value.");
      return;
    }
    setBusy(true);
    setErr("");
    const secretVal = val;
    setVal(""); // Clear value immediately
    const ok = await onSave(name.trim(), secretVal);
    setBusy(false);
    if (!ok) setErr("Failed to save secret.");
  };

  return h(
    Dialog,
    {
      title: t("providers.key.title"),
      onClose,
      actions: h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            disabled: busy,
            onClick: () => { void submit(); },
          },
          t("providers.key.save"),
        ),
      ),
    },
    h(
      "form",
      { id: "store-key-form", onSubmit: (e: Event) => { e.preventDefault(); void submit(); } },
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
      h(
        "div",
        { class: "field" },
        h("label", { for: "key-provider" }, t("providers.key.provider")),
        h(
          "select",
          {
            id: "key-provider",
            value: provider,
            onChange: (e: Event) => handleProviderChange((e.target as HTMLSelectElement).value),
          },
          h("option", { value: "openai" }, "OpenAI"),
          h("option", { value: "anthropic" }, "Anthropic"),
          h("option", { value: "google" }, "Google / Gemini"),
          h("option", { value: "xai" }, "xAI"),
          h("option", { value: "openrouter" }, "OpenRouter"),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "key-name" }, t("providers.key.name")),
        h("input", {
          id: "key-name",
          type: "text",
          value: name,
          onInput: (e: Event) => setName((e.target as HTMLInputElement).value),
        }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "key-value" }, t("providers.key.value")),
        h("input", {
          id: "key-value",
          type: "password",
          autocomplete: "off",
          value: val,
          onInput: (e: Event) => setVal((e.target as HTMLInputElement).value),
        }),
      ),
    ),
  );
}

function Body({ data, reload }: { data: Data; reload: () => void }): View {
  const [dlg, setDlg] = useState<"login" | "key" | null>(null);
  const [logoutTarget, setLogoutTarget] = useState<ProviderRow | null>(null);
  const [notice, setNotice] = useState("");

  const rows: ProviderRow[] = [
    ...data.credentials.map((c) => ({
      id: c.id,
      provider: c.provider || "OpenAI",
      route: c.billingPath === "plan" ? t("providers.route.oauth") : c.kind,
      workspace: c.workspace,
      expiresAt: c.expiresAt,
      needsLogin: c.needsLogin,
    })),
    ...data.apiKeys.map((k) => {
      const parts = k.split(/[/.]/);
      const prov = parts[0] || "Unknown";
      return {
        id: k,
        provider: prov.charAt(0).toUpperCase() + prov.slice(1),
        route: t("providers.route.key"),
        workspace: "—",
        expiresAt: null,
        needsLogin: false,
        isSecret: true,
      };
    }),
  ];

  const handleSaveKey = async (secretName: string, secretValue: string): Promise<boolean> => {
    try {
      await getApi().rpc("secret.set", { name: secretName, value: secretValue });
      setNotice(t("providers.key.saved", { name: secretName }));
      setDlg(null);
      reload();
      return true;
    } catch {
      return false;
    }
  };

  const handleLogout = (row: ProviderRow) => async () => {
    try {
      await getApi().rpc("auth.logout", { id: row.id });
      setNotice(t("providers.logout.done", { provider: row.provider }));
      setLogoutTarget(null);
      reload();
      return { ok: true as const };
    } catch {
      return { ok: false as const, message: t("state.error.title") };
    }
  };

  return h(
    "div",
    { class: "providers" },
    h(
      "div",
      { class: "providers-head" },
      h("h3", { class: "card-title" }, t("providers.list.title")),
      h(
        "div",
        { class: "providers-head-actions" },
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            onClick: () => setDlg("login"),
          },
          t("providers.action.login"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn",
            onClick: () => setDlg("key"),
          },
          t("providers.action.storeKey"),
        ),
      ),
    ),
    notice
      ? h("p", { class: "form-notice", role: "status", "aria-live": "polite" }, notice)
      : null,
    rows.length === 0
      ? h(
          "div",
          null,
          h(PageState, {
            state: "empty",
            title: t("providers.empty.title"),
            detail: t("providers.empty.body"),
          }),
        )
      : h(
          "table",
          { class: "data-table providers-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              ["provider", "route", "workspace", "expires", "status", "actions"].map((c) =>
                h("th", { key: c, scope: "col" }, t(`providers.col.${c}` as Key)),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            rows.map((r) =>
              h(
                "tr",
                { key: r.id },
                h("th", { scope: "row" }, r.provider),
                h("td", { "data-label": t("providers.col.route") }, r.route),
                h("td", { "data-label": t("providers.col.workspace") }, r.workspace),
                h("td", { "data-label": t("providers.col.expires") }, when(r.expiresAt)),
                h(
                  "td",
                  { "data-label": t("providers.col.status") },
                  r.needsLogin
                    ? h(Badge, { tone: "warn" }, t("providers.status.needsLogin"))
                    : r.isSecret
                    ? h(Badge, { tone: "neutral" }, t("providers.status.configured"))
                    : h(Badge, { tone: "ok" }, t("providers.status.active")),
                ),
                h(
                  "td",
                  { class: "providers-actions" },
                  !r.isSecret
                    ? h(
                        "button",
                        {
                          type: "button",
                          class: "btn btn-quiet",
                          "aria-label": `${t("providers.action.logout")}: ${r.provider}`,
                          onClick: () => setLogoutTarget(r),
                        },
                        t("providers.action.logout"),
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),
    dlg === "login"
      ? h(LoginDialog, {
          onClose: () => setDlg(null),
          onSuccess: (p) => {
            setNotice(t("providers.login.success", { provider: p }));
            reload();
          },
        })
      : null,
    dlg === "key"
      ? h(KeyDialog, {
          onClose: () => setDlg(null),
          onSave: handleSaveKey,
        })
      : null,
    logoutTarget
      ? h(
          ConfirmDialog,
          {
            title: t("providers.logout.title"),
            confirmLabel: t("providers.logout.confirm"),
            danger: true,
            onClose: () => setLogoutTarget(null),
            onConfirm: handleLogout(logoutTarget),
          },
          h(
            "p",
            null,
            t("providers.logout.body", {
              provider: logoutTarget.provider,
              workspace: logoutTarget.workspace,
            }),
          ),
        )
      : null,
  );
}

function Loaded(): View {
  const { state, reload } = useLoad(load, []);
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, {
      failure: state.failure,
      unavailable: t("state.unavailable.title"),
      onRetry: reload,
    });
  return h(Body, { data: state.data, reload });
}

export function ProvidersSection({ section }: SectionProps): View {
  const allowed = roleIn(currentRole(), ["owner", "admin"]);
  return h(
    "section",
    { "data-section": section.id, "aria-labelledby": "providers-h" },
    h("h2", { id: "providers-h" }, t("providers.title")),
    h("p", { class: "field-hint" }, t("providers.intro")),
    allowed ? h(Loaded, {}) : h(PageState, { state: "forbidden" }),
  );
}
