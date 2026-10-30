/** Human setup: secret writes are write-only; OAuth starts only from this person's explicit button. */
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Card } from "../../components/card.ts";
import { t, type Key } from "../../i18n.ts";
import { sessionState } from "../../session.ts";
import { currentRole, getApi, useLoad } from "../common/load.ts";
import { Notice } from "../common/states.ts";
import type { AdminExtensionsSetupGetResult, ExtAuthAttempt } from "../../../../rpc-schema/generated/types.ts";

const active = (attempt: ExtAuthAttempt | null) =>
  attempt && ["starting", "awaiting-callback", "awaiting-device"].includes(attempt.status);
function external(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function OAuthSetup({ name, onChanged }: { name: string; onChanged(): void }): View {
  const [clientId, setClientId] = useState(""),
    [redirectUri, setRedirectUri] = useState(""),
    [callback, setCallback] = useState("");
  const [attempt, setAttempt] = useState<ExtAuthAttempt | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const changing = useRef(false),
    state = sessionState.value;
  const person = state.status === "authenticated" ? state.user.id : "";
  const storageKey = `p1x.auth.${encodeURIComponent(person)}.${encodeURIComponent(name)}`;
  const remember = (value: ExtAuthAttempt): void => {
    setAttempt(value);
    try {
      if (active(value))
        sessionStorage.setItem(storageKey, JSON.stringify({ attemptId: value.attemptId, expiresAt: value.expiresAt }));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* private browser storage is optional; Core retains the person-bound attempt */
    }
    if (value.status === "authorized") onChanged();
  };
  useEffect(() => {
    const controller = new AbortController();
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as {
        attemptId?: unknown;
        expiresAt?: unknown;
      } | null;
      if (
        saved &&
        typeof saved.attemptId === "string" &&
        saved.attemptId.length <= 128 &&
        typeof saved.expiresAt === "number" &&
        saved.expiresAt > Date.now()
      ) {
        void getApi()
          .rpc(
            "admin.extensions.auth.status",
            { name, attemptId: saved.attemptId },
            { write: false, signal: controller.signal },
          )
          .then((value) => {
            if (!controller.signal.aborted) remember(value as ExtAuthAttempt);
          })
          .catch(() => {
            if (!controller.signal.aborted) {
              try {
                sessionStorage.removeItem(storageKey);
              } catch {
                /* browser storage is optional */
              }
            }
          });
      }
    } catch {
      /* no remembered attempt is not a login action */
    }
    return () => controller.abort();
  }, [storageKey]);
  useEffect(() => {
    if (!active(attempt)) return;
    const controller = new AbortController();
    let pending = false;
    const timer = setInterval(() => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      void getApi()
        .rpc(
          "admin.extensions.auth.status",
          { name, attemptId: attempt!.attemptId },
          { write: false, signal: controller.signal },
        )
        .then((value) => {
          if (!controller.signal.aborted) remember(value as ExtAuthAttempt);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(t("extensions.auth.failed"));
        })
        .finally(() => {
          pending = false;
        });
    }, 1000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [attempt?.attemptId, attempt?.status]);
  const change = async (method: "start" | "submit" | "cancel"): Promise<void> => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setError("");
    const pasted = callback;
    if (method === "submit") setCallback("");
    try {
      const api = getApi();
      let result: unknown;
      if (method === "start") {
        if (!!clientId.trim() !== !!redirectUri.trim()) throw new Error("both registration fields required");
        result = await api.rpc("admin.extensions.auth.start", {
          name,
          pasteCallback: true,
          ...(clientId.trim() ? { clientId: clientId.trim(), redirectUri: redirectUri.trim() } : {}),
        });
      } else {
        if (!attempt) return;
        result = await api.rpc(`admin.extensions.auth.${method}`, {
          name,
          attemptId: attempt.attemptId,
          ...(method === "submit" ? { callbackUrl: pasted } : {}),
        });
      }
      remember(result as ExtAuthAttempt);
    } catch {
      setError(t("extensions.auth.failed"));
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };
  const url = external(
    attempt?.authorizationUrl ?? attempt?.device?.verificationUriComplete ?? attempt?.device?.verificationUri,
  );
  return h(
    Card,
    { title: t("extensions.auth.title") },
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,
    !active(attempt)
      ? h(
          "form",
          {
            onSubmit: (event: Event) => {
              event.preventDefault();
              void change("start");
            },
          },
          h(
            "div",
            { class: "field" },
            h("label", { for: `oauth-client-${name}` }, t("extensions.auth.clientId")),
            h("input", {
              id: `oauth-client-${name}`,
              type: "text",
              value: clientId,
              disabled: busy,
              maxLength: 4096,
              onInput: (event: Event) => setClientId((event.target as HTMLInputElement).value),
            }),
          ),
          h(
            "div",
            { class: "field" },
            h("label", { for: `oauth-redirect-${name}` }, t("extensions.auth.redirect")),
            h("input", {
              id: `oauth-redirect-${name}`,
              type: "url",
              value: redirectUri,
              disabled: busy,
              maxLength: 2048,
              onInput: (event: Event) => setRedirectUri((event.target as HTMLInputElement).value),
            }),
          ),
          h("button", { type: "submit", class: "btn btn-primary", disabled: busy }, t("extensions.auth.start")),
        )
      : null,
    attempt
      ? h(
          "div",
          {},
          h(
            "p",
            { role: "status" },
            t(
              `extensions.auth.status.${attempt.status === "awaiting-callback" ? "awaitingCallback" : attempt.status === "awaiting-device" ? "awaitingDevice" : attempt.status}` as Key,
            ),
          ),
          attempt.device ? h("p", null, t("extensions.auth.code", { code: attempt.device.userCode })) : null,
          url
            ? h(
                "a",
                { href: url, target: "_blank", rel: "noopener noreferrer", class: "btn btn-quiet" },
                t("extensions.auth.open"),
              )
            : null,
          attempt.sshHint ? h("pre", { class: "reading" }, attempt.sshHint) : null,
          attempt.status === "awaiting-callback" && attempt.method === "paste_callback"
            ? h(
                "form",
                {
                  onSubmit: (event: Event) => {
                    event.preventDefault();
                    void change("submit");
                  },
                },
                h(
                  "div",
                  { class: "field" },
                  h("label", { for: `oauth-callback-${name}` }, t("extensions.auth.callback")),
                  h("input", {
                    id: `oauth-callback-${name}`,
                    type: "password",
                    value: callback,
                    required: true,
                    autoComplete: "off",
                    disabled: busy,
                    maxLength: 16384,
                    onInput: (event: Event) => setCallback((event.target as HTMLInputElement).value),
                  }),
                ),
                h("button", { type: "submit", class: "btn", disabled: busy }, t("extensions.auth.submit")),
              )
            : null,
          active(attempt)
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn-quiet",
                  disabled: busy,
                  onClick: () => {
                    void change("cancel");
                  },
                },
                t("extensions.auth.cancel"),
              )
            : null,
        )
      : null,
  );
}

export function ExtensionSetup({ name, oauth, onChanged }: { name: string; oauth: boolean; onChanged(): void }): View {
  const { state, reload } = useLoad(
    (signal) =>
      getApi().rpc(
        "admin.extensions.setup.get",
        { name },
        { write: false, signal },
      ) as Promise<AdminExtensionsSetupGetResult>,
    [name],
  );
  const [values, setValues] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const owner = currentRole() === "owner",
    changing = useRef(false);
  const save = async (slot: string): Promise<void> => {
    if (!owner || changing.current || !values[slot]) return;
    changing.current = true;
    setBusy(true);
    setError("");
    const value = values[slot]!;
    setValues((current) => {
      const next = { ...current };
      delete next[slot];
      return next;
    });
    try {
      await getApi().rpc("admin.extensions.setup.set", { name, slot, value });
      reload();
      onChanged();
    } catch {
      setError(t("extensions.setup.failed"));
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };
  return h(
    "div",
    { class: "extension-setup" },
    state.status === "ok" && state.data.slots.length
      ? h(
          Card,
          { title: t("extensions.setup.title") },
          !state.data.available ? h(Notice, { tone: "warn" }, t("extensions.setup.backend")) : null,
          !owner ? h(Notice, {}, t("extensions.setup.ownerOnly")) : null,
          error ? h("p", { role: "alert", class: "form-error" }, error) : null,
          state.data.slots.map((slot) =>
            h(
              "form",
              {
                key: slot.slot,
                onSubmit: (event: Event) => {
                  event.preventDefault();
                  void save(slot.slot);
                },
              },
              h(
                "div",
                { class: "field" },
                h(
                  owner && state.data.available ? "label" : "strong",
                  owner && state.data.available ? { for: `secret-${name}-${slot.slot}` } : {},
                  slot.slot,
                  slot.required ? ` (${t("extensions.setup.required")})` : "",
                ),
                h(
                  "p",
                  { class: "field-hint" },
                  slot.present
                    ? t("extensions.setup.present")
                    : slot.present === false
                      ? t("extensions.setup.missing")
                      : t("shared.unavailable.inline"),
                ),
                owner && state.data.available
                  ? h("input", {
                      id: `secret-${name}-${slot.slot}`,
                      type: "password",
                      autoComplete: "new-password",
                      maxLength: 65536,
                      value: values[slot.slot] ?? "",
                      disabled: busy,
                      onInput: (event: Event) => {
                        const value = (event.target as HTMLInputElement).value;
                        setValues((current) => ({ ...current, [slot.slot]: value }));
                      },
                    })
                  : null,
              ),
              owner && state.data.available
                ? h(
                    "button",
                    { type: "submit", class: "btn", disabled: busy || !values[slot.slot] },
                    t("extensions.setup.save"),
                  )
                : null,
            ),
          ),
        )
      : null,
    oauth ? h(OAuthSetup, { name, onChanged }) : null,
  );
}
