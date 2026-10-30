/** Explicit Owner SSH configuration. Public-key instructions are metadata; private keys never enter this component. */
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Card } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { currentRole, getApi, useLoad } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import type {
  AdminImportSshConnectionsListResult,
  AdminImportSshHostKeyProbeResult,
  SshConnection,
  SshKeyStatus,
} from "../../../../rpc-schema/generated/types.ts";
import {
  sshConnectionInput,
  initialSshForm,
  sameSshConnection,
  sshEgressApproval,
  egressConsentSubject,
  type SshEgressSnapshot,
  type SshForm,
} from "./ssh-model.ts";

const displayHost = (host: string): string => (host.includes(":") ? `[${host}]` : host);
type HostSuggestion = import("../../../../api/src/import-routes.ts").ImportSourcesResult["sshHostSuggestion"];
const call = <T>(method: string, params: object = {}, write = true): Promise<T> =>
  getApi().rpc(method, params, { write }) as Promise<T>;

/** Mount only after explicit setup selection; the backend independently enforces Owner and current action scopes. */
export function SshSetup({ onChanged, suggestion }: { onChanged(): void; suggestion: HostSuggestion }): View {
  if (currentRole() !== "owner") return h("span", { hidden: true });
  return h(OwnerSshSetup, { onChanged, suggestion });
}
function OwnerSshSetup({ onChanged, suggestion }: { onChanged(): void; suggestion: HostSuggestion }): View {
  const data = useLoad(async () => {
    const [key, connections] = await Promise.all([
      call<SshKeyStatus>("admin.import.ssh.key.status", {}, false),
      call<AdminImportSshConnectionsListResult>("admin.import.ssh.connections.list", {}, false),
    ]);
    return { key, connections: connections.connections };
  }, []);
  const policy = useLoad(() => call<SshEgressSnapshot>("config.get", { key: "egress" }, false), []);
  const [form, setForm] = useState<SshForm>(() => initialSshForm(suggestion)),
    [consent, setConsent] = useState("");
  const [probe, setProbe] = useState<(AdminImportSshHostKeyProbeResult & { endpoint: string }) | null>(null);
  const [verified, setVerified] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ action: "rotate" | "delete-key" | "delete-connection"; id?: string } | null>(
    null,
  );
  const lock = useRef(false);
  const refresh = (): void => {
    data.reload();
    policy.reload();
    setConsent("");
    onChanged();
  };
  const act = async (operation: () => Promise<void>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch {
      setError(t("imports.ssh.failed"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const patch = (next: Partial<SshForm>): void => {
    setForm((current) => ({ ...current, ...next }));
    setConsent("");
  };
  let connection: ReturnType<typeof sshConnectionInput> | undefined;
  try {
    connection = sshConnectionInput(form);
  } catch {
    /* incomplete metadata is never submitted */
  }
  const snapshot = policy.state.status === "ok" ? policy.state.data : undefined;
  let subject = "";
  try {
    if (snapshot && connection) subject = egressConsentSubject(snapshot, connection);
  } catch {
    /* invalid policy fails closed */
  }
  const save = (): void => {
    void act(async () => {
      if (!connection || !snapshot || !subject || consent !== subject) throw new Error("ssh-consent");
      await call("config.set", sshEgressApproval(snapshot, connection, consent));
      try {
        await call("admin.import.ssh.connections.set", { connection });
      } catch {
        setError(t("imports.ssh.policySaved"));
        policy.reload();
        setConsent("");
        return;
      }
      setProbe(null);
      setVerified(false);
      refresh();
    });
  };
  const inspect = (saved: SshConnection): void => {
    void act(async () => {
      setProbe(null);
      setVerified(false);
      const found = await call<AdminImportSshHostKeyProbeResult>("admin.import.ssh.hostKey.probe", { id: saved.id });
      if (found.connectionId !== saved.id) throw new Error("ssh-probe-binding");
      const fresh = await call<AdminImportSshConnectionsListResult>("admin.import.ssh.connections.list", {}, false);
      if (
        !sameSshConnection(
          saved,
          fresh.connections.find((connection) => connection.id === saved.id),
        )
      ) {
        data.reload();
        setError(t("imports.ssh.connectionChanged"));
        return;
      }
      setProbe({ ...found, endpoint: `${displayHost(saved.host)}:${saved.port}` });
    });
  };
  const trust = (): void => {
    void act(async () => {
      if (!probe || !verified) return;
      await call("admin.import.ssh.hostKey.trust", {
        connectionId: probe.connectionId,
        probeId: probe.probeId,
        hostKeySha256: probe.hostKeySha256,
      });
      setProbe(null);
      setVerified(false);
      refresh();
    });
  };
  const destructive = (): void => {
    const pending = confirm;
    if (!pending) return;
    setConfirm(null);
    void act(async () => {
      if (pending.action === "rotate") await call("admin.import.ssh.key.rotate");
      else if (pending.action === "delete-key") await call("admin.import.ssh.key.delete");
      else await call("admin.import.ssh.connections.delete", { id: pending.id });
      setProbe(null);
      setVerified(false);
      refresh();
    });
  };
  const field = (name: keyof Pick<SshForm, "id" | "host" | "port" | "user" | "roots">, label: string): View =>
    h(
      "div",
      { class: "field" },
      h("label", { for: `import-ssh-${name}` }, label),
      h(name === "roots" ? "textarea" : "input", {
        id: `import-ssh-${name}`,
        value: form[name],
        ...(name === "port" ? { type: "number", min: 1, max: 65535 } : {}),
        onInput: (event: Event) => patch({ [name]: (event.target as HTMLInputElement).value }),
      }),
    );
  const edit = (saved: SshConnection): void => {
    setForm({
      id: saved.id,
      host: saved.host,
      port: String(saved.port),
      user: saved.user,
      roots: saved.roots.join("\n"),
      allowPrivate: saved.allowPrivate,
    });
    setConsent("");
  };

  return h(
    Card,
    { title: t("imports.ssh.setup"), level: 3 },
    h("p", { class: "field-hint" }, t("imports.ssh.ownerSession")),
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,
    data.state.status === "loading"
      ? h(PageLoading, { label: t("state.loading") })
      : data.state.status === "fail"
        ? h(FailureState, { failure: data.state.failure, onRetry: data.reload })
        : h(
            "fieldset",
            { disabled: busy },
            h("legend", null, t("imports.ssh.key")),
            data.state.data.key.configured
              ? h(
                  "div",
                  null,
                  h("label", { for: "import-ssh-public-key" }, t("imports.ssh.publicKey")),
                  h("textarea", {
                    id: "import-ssh-public-key",
                    readOnly: true,
                    rows: 3,
                    value: data.state.data.key.publicKey ?? "",
                  }),
                  h("p", null, h("code", null, data.state.data.key.fingerprint ?? "")),
                  h(
                    "pre",
                    { class: "reading", "data-ssh": "readonly-instructions" },
                    data.state.data.key.instructions ?? "",
                  ),
                  h(
                    "button",
                    { type: "button", class: "btn btn-quiet", onClick: () => setConfirm({ action: "rotate" }) },
                    t("imports.ssh.rotate"),
                  ),
                  h(
                    "button",
                    { type: "button", class: "btn btn-err", onClick: () => setConfirm({ action: "delete-key" }) },
                    t("imports.ssh.deleteKey"),
                  ),
                )
              : h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-primary",
                    onClick: () => {
                      void act(async () => {
                        await call("admin.import.ssh.key.generate");
                        refresh();
                      });
                    },
                  },
                  t("imports.ssh.generate"),
                ),
            h("h4", null, t("imports.ssh.connections")),
            h(
              "ul",
              { class: "plain-list" },
              data.state.data.connections.map((saved) =>
                h(
                  "li",
                  { key: saved.id },
                  h("strong", null, `${saved.id} · ${saved.user}@${displayHost(saved.host)}:${saved.port}`),
                  h("p", null, saved.roots.join(", ")),
                  saved.hostKey ? h("code", null, saved.hostKey.sha256) : h("p", null, t("imports.ssh.untrusted")),
                  h(
                    "div",
                    { class: "chip-row" },
                    h(
                      "button",
                      { type: "button", class: "btn btn-quiet", onClick: () => edit(saved) },
                      t("imports.ssh.edit"),
                    ),
                    h(
                      "button",
                      { type: "button", class: "btn btn-quiet", onClick: () => inspect(saved) },
                      t("imports.ssh.probe"),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn-err",
                        onClick: () => setConfirm({ action: "delete-connection", id: saved.id }),
                      },
                      t("imports.ssh.remove"),
                    ),
                  ),
                ),
              ),
            ),
          ),
    probe
      ? h(
          "fieldset",
          { disabled: busy },
          h("legend", null, t("imports.ssh.verify", { endpoint: probe.endpoint })),
          probe.changed ? h(Notice, { tone: "warn" }, t("imports.ssh.changed")) : null,
          h("p", null, probe.hostKeyAlgorithm ?? ""),
          h("code", null, probe.hostKeySha256),
          h(
            "label",
            { class: "checkbox-label" },
            h("input", {
              type: "checkbox",
              checked: verified,
              onChange: (event: Event) => setVerified((event.target as HTMLInputElement).checked),
            }),
            " ",
            t("imports.ssh.verifyAck"),
          ),
          h(
            "button",
            { type: "button", class: "btn btn-primary", disabled: !verified, onClick: trust },
            t("imports.ssh.trust"),
          ),
        )
      : null,
    h(
      "fieldset",
      { disabled: busy },
      h("legend", null, t("imports.ssh.connectionForm")),
      field("id", t("imports.ssh.id")),
      field("host", t("imports.ssh.host")),
      suggestion
        ? h(
            "div",
            {},
            h("p", { class: "field-hint" }, t("imports.ssh.dockerHostHint")),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                onClick: () => patch({ host: initialSshForm(suggestion).host }),
              },
              t("imports.ssh.dockerHostUse"),
            ),
          )
        : null,
      field("port", t("imports.ssh.port")),
      field("user", t("imports.ssh.user")),
      field("roots", t("imports.ssh.roots")),
      h(
        "label",
        { class: "checkbox-label" },
        h("input", {
          type: "checkbox",
          checked: form.allowPrivate,
          onChange: (event: Event) => patch({ allowPrivate: (event.target as HTMLInputElement).checked }),
        }),
        " ",
        t("imports.ssh.private"),
      ),
      policy.state.status === "loading"
        ? h(PageLoading, { label: t("state.loading") })
        : policy.state.status === "fail"
          ? h(FailureState, {
              failure: policy.state.failure,
              onRetry: () => {
                setConsent("");
                policy.reload();
              },
            })
          : h(
              "div",
              null,
              h(
                "p",
                null,
                t("imports.ssh.currentHosts"),
                ": ",
                h("code", null, snapshot?.value.allowHosts.join(", ") || t("imports.ssh.none")),
              ),
              h(
                "p",
                null,
                t("imports.ssh.currentPorts"),
                ": ",
                h("code", null, snapshot?.value.allowPorts.join(", ") || t("imports.ssh.none")),
              ),
              connection
                ? h(
                    "p",
                    { class: "form-notice" },
                    t("imports.ssh.endpoint", { host: displayHost(connection.host), port: connection.port ?? 22 }),
                  )
                : null,
              h("p", { class: "field-hint" }, t("imports.ssh.globalPolicy")),
              h(
                "label",
                { class: "checkbox-label" },
                h("input", {
                  type: "checkbox",
                  disabled: !subject,
                  checked: !!subject && consent === subject,
                  onChange: (event: Event) => setConsent((event.target as HTMLInputElement).checked ? subject : ""),
                }),
                " ",
                t("imports.ssh.egressAck"),
              ),
            ),
      h(
        "button",
        { type: "button", class: "btn btn-primary", disabled: !subject || consent !== subject, onClick: save },
        t("imports.ssh.save"),
      ),
    ),
    confirm
      ? h(
          Dialog,
          {
            title: t("imports.ssh.confirmTitle"),
            onClose: () => setConfirm(null),
            actions: h(
              "div",
              { class: "dialog-actions" },
              h(
                "button",
                { type: "button", class: "btn btn-quiet", onClick: () => setConfirm(null) },
                t("shared.confirm.cancel"),
              ),
              h(
                "button",
                { type: "button", class: "btn btn-err", onClick: destructive },
                t("imports.ssh.confirmButton"),
              ),
            ),
          },
          h(
            "p",
            null,
            t(confirm.action === "delete-connection" ? "imports.ssh.removeWarning" : "imports.ssh.keyWarning"),
          ),
        )
      : null,
  );
}
