// Switchboard: list of connected channels, host state, effective configuration with secrets as names only,
// enable/disable, field edit with schema validation & secret rejection, health test & send-owner, link-help.
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/switchboard.ts";
import { FailureState } from "../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../common/load.ts";
import type { PageProps } from "../registry.ts";
import { navigate } from "../../router.ts";

registerArea("switchboard", area);

export type ChannelSummary = {
  id: string;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  state: "not-registered" | "stopped" | "waiting" | "starting" | "running" | "backoff" | "failed";
  health: "ok" | "failing" | "unknown";
  lastError?: string;
};

export type ChannelDetail = ChannelSummary & {
  configurable: boolean;
  restart: string;
  missing: string[];
  secrets: { key: string; name: string; present: boolean }[];
  config: Record<string, unknown>;
  attempts: number;
  linkHelp: string;
  probe?: { ok: boolean; detail?: string };
};

type ListData = {
  host: boolean;
  channels: ChannelSummary[];
};

async function loadChannels(signal: AbortSignal): Promise<ListData> {
  const api = getApi();
  const res = (await api.rpc("channel.list", {}, { write: false, signal })) as {
    host: boolean;
    channels: ChannelSummary[];
  };
  return {
    host: res.host ?? false,
    channels: res.channels ?? [],
  };
}

function stateLabel(state: string, host: boolean): string {
  if (!host || state === "not-registered") return t("switchboard.state.notRegistered");
  switch (state) {
    case "running":
      return t("switchboard.state.running");
    case "stopped":
      return t("switchboard.state.stopped");
    case "starting":
      return t("switchboard.state.starting");
    case "waiting":
      return t("switchboard.state.waiting");
    case "backoff":
      return t("switchboard.state.backoff");
    case "failed":
      return t("switchboard.state.failed");
    default:
      return state;
  }
}

function healthTone(health: string): "ok" | "warn" | "neutral" {
  if (health === "ok") return "ok";
  if (health === "failing") return "warn";
  return "neutral";
}

function EditDialog({
  channelId,
  initialKey,
  initialValue,
  onClose,
  onSaved,
}: {
  channelId: string;
  initialKey: string;
  initialValue: unknown;
  onClose: () => void;
  onSaved: () => void;
}): View {
  const [key, setKey] = useState(initialKey);
  const [val, setVal] = useState(
    typeof initialValue === "string" ? initialValue : JSON.stringify(initialValue ?? "")
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [isSecretErr, setIsSecretErr] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr("");
    setIsSecretErr(false);
    try {
      let parsedVal: unknown = val;
      try {
        parsedVal = JSON.parse(val);
      } catch {
        parsedVal = val;
      }
      await getApi().rpc("channel.set", { id: channelId, key, value: parsedVal });
      setBusy(false);
      onSaved();
      onClose();
    } catch (e) {
      setBusy(false);
      const o = (typeof e === "object" && e !== null ? e : {}) as {
        reason?: string;
        errorCode?: string;
        message?: string;
      };
      const reason = o.reason ?? o.errorCode ?? "";
      if (reason === "secret-value") {
        setIsSecretErr(true);
        setErr(t("switchboard.edit.secretError"));
      } else {
        setErr(o.message || "Could not update setting.");
      }
    }
  };

  return h(
    Dialog,
    {
      title: t("switchboard.edit.title"),
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
            onClick: () => { void save(); },
          },
          t("switchboard.action.save"),
        ),
      ),
    },
    h(
      "form",
      { id: "channel-set-form", onSubmit: (e: Event) => { e.preventDefault(); void save(); } },
      err
        ? h(
            "div",
            { class: "form-error", role: "alert" },
            h("p", null, err),
            isSecretErr
              ? h(
                  "p",
                  { class: "field-hint" },
                  h(
                    "a",
                    { href: "#/settings/secrets", class: "btn btn-quiet" },
                    t("switchboard.action.secretsLink"),
                  ),
                )
              : null,
          )
        : null,
      h(
        "div",
        { class: "field" },
        h("label", { for: "channel-set-key" }, t("switchboard.edit.key")),
        h("input", {
          id: "channel-set-key",
          type: "text",
          value: key,
          onInput: (e: Event) => setKey((e.target as HTMLInputElement).value),
        }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "channel-set-val" }, t("switchboard.edit.value")),
        h("input", {
          id: "channel-set-val",
          type: "text",
          value: val,
          onInput: (e: Event) => setVal((e.target as HTMLInputElement).value),
        }),
      ),
    ),
  );
}

function DetailView({
  channelId,
  host,
  onRefresh,
}: {
  channelId: string;
  host: boolean;
  onRefresh: () => void;
}): View {
  const { state, reload } = useLoad(
    (signal) =>
      getApi().rpc("channel.get", { id: channelId }, { write: false, signal }) as Promise<ChannelDetail>,
    [channelId]
  );
  const [editTarget, setEditTarget] = useState<{ key: string; value: unknown } | null>(null);
  const [actionNotice, setActionNotice] = useState("");
  const [busy, setBusy] = useState(false);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, {
      failure: state.failure,
      unavailable: t("state.unavailable.title"),
      onRetry: reload,
    });

  const d = state.data;

  const toggle = async (enable: boolean): Promise<void> => {
    setBusy(true);
    setActionNotice("");
    try {
      if (enable) await getApi().rpc("channel.enable", { id: d.id });
      else await getApi().rpc("channel.disable", { id: d.id });
      reload();
      onRefresh();
    } catch {
      setActionNotice(t("state.error.title"));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (sendOwner = false): Promise<void> => {
    setBusy(true);
    setActionNotice("");
    try {
      const res = (await getApi().rpc("channel.test", { id: d.id, ...(sendOwner ? { sendOwner: true } : {}) })) as {
        ok: boolean;
        state: string;
        detail?: string;
        sent?: boolean;
        sentTo?: { linkId: string };
      };
      if (sendOwner) {
        if (res.sent && res.sentTo?.linkId) {
          setActionNotice(t("switchboard.test.sentOwner", { linkId: res.sentTo.linkId }));
        } else {
          setActionNotice(t("switchboard.test.sendOwnerFailed", { detail: res.detail ?? "unknown" }));
        }
      } else {
        if (res.ok) {
          setActionNotice(t("switchboard.test.success", { detail: res.detail ?? res.state }));
        } else {
          setActionNotice(t("switchboard.test.failed", { detail: res.detail ?? res.state }));
        }
      }
    } catch (e) {
      setActionNotice((e as { message?: string }).message || t("state.error.title"));
    } finally {
      setBusy(false);
    }
  };

  const configEntries = Object.entries(d.config || {});

  return h(
    "div",
    { class: "channel-detail" },
    h(
      "div",
      { class: "card-head" },
      h(
        "div",
        null,
        h("h2", { class: "card-title" }, d.displayName),
        h(
          "div",
          { class: "chip-row" },
          h(
            Badge,
            { tone: d.enabled ? "ok" : "neutral" },
            d.enabled ? t("switchboard.status.enabled") : t("switchboard.status.disabled"),
          ),
          h(
            Badge,
            { tone: !host || d.state === "not-registered" ? "neutral" : healthTone(d.health) },
            stateLabel(d.state, host),
          ),
          h(
            Badge,
            { tone: d.configured ? "ok" : "warn" },
            d.configured ? t("switchboard.status.configured") : t("switchboard.status.missingSecrets"),
          ),
        ),
      ),
      h(
        "div",
        { class: "chip-row" },
        d.enabled
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                disabled: busy,
                onClick: () => void toggle(false),
              },
              t("switchboard.action.disable"),
            )
          : h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                disabled: busy,
              },
              h(
                "span",
                { onClick: () => void toggle(true) },
                t("switchboard.action.enable"),
              ),
            ),
        h(
          "button",
          {
            type: "button",
            class: "btn",
            disabled: busy,
            onClick: () => void runTest(false),
          },
          t("switchboard.action.test"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn",
            disabled: busy,
            onClick: () => void runTest(true),
          },
          t("switchboard.action.testOwner"),
        ),
      ),
    ),
    actionNotice
      ? h("p", { class: "form-notice", role: "status", "aria-live": "polite" }, actionNotice)
      : null,
    !host
      ? h(
          "div",
          { class: "form-notice", "data-tone": "warn" },
          h("strong", null, t("switchboard.host.missing")),
          h("p", { class: "field-hint" }, t("switchboard.host.hint")),
        )
      : null,
    d.lastError
      ? h(
          "div",
          { class: "form-error" },
          h("strong", null, t("switchboard.detail.lastError")),
          h("p", null, d.lastError),
        )
      : null,
    h(
      "section",
      { class: "card" },
      h("h3", { class: "card-title" }, t("switchboard.detail.config")),
      h(
        "table",
        { class: "data-table channel-config-table" },
        h(
          "thead",
          null,
          h("tr", null, h("th", null, "Key"), h("th", null, "Value"), h("th", null, "Action")),
        ),
        h(
          "tbody",
          null,
          configEntries.map(([k, v]) => {
            const secretRef = d.secrets?.find((s) => s.key === k);
            const valDisplay = secretRef
              ? `${secretRef.name} (${secretRef.present ? "stored" : "missing"})`
              : typeof v === "object"
              ? JSON.stringify(v)
              : String(v ?? "");
            return h(
              "tr",
              { key: k },
              h("th", { scope: "row" }, k),
              h("td", null, valDisplay),
              h(
                "td",
                null,
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-quiet",
                    onClick: () => setEditTarget({ key: k, value: v }),
                  },
                  t("switchboard.action.edit"),
                ),
              ),
            );
          }),
        ),
      ),
    ),
    d.linkHelp
      ? h(
          "section",
          { class: "card" },
          h("h3", { class: "card-title" }, t("switchboard.detail.linkHelp")),
          h("p", { class: "reading" }, d.linkHelp),
        )
      : null,
    d.restart
      ? h(
          "p",
          { class: "field-hint" },
          `${t("switchboard.detail.restart")}: ${d.restart}`,
        )
      : null,
    editTarget
      ? h(EditDialog, {
          channelId: d.id,
          initialKey: editTarget.key,
          initialValue: editTarget.value,
          onClose: () => setEditTarget(null),
          onSaved: () => {
            reload();
            onRefresh();
          },
        })
      : null,
  );
}

function SwitchboardContent({ sub }: { sub?: string }): View {
  const { state, reload } = useLoad(loadChannels, []);
  const [selectedId, setSelectedId] = useState<string | null>(sub ?? null);

  useEffect(() => {
    if (sub) setSelectedId(sub);
  }, [sub]);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, {
      failure: state.failure,
      unavailable: t("state.unavailable.title"),
      onRetry: reload,
    });

  const { host, channels } = state.data;
  const selected = selectedId || channels[0]?.id || null;

  const select = (id: string): void => {
    setSelectedId(id);
    navigate(`/switchboard/${id}`);
  };

  const listPane = h(
    "div",
    { class: "channels-list" },
    channels.length === 0
      ? h(PageState, {
          state: "empty",
          title: t("switchboard.empty.title"),
          detail: t("switchboard.empty.body"),
        })
      : h(
          "ul",
          { class: "plain-list channels-items" },
          channels.map((c) =>
            h(
              "li",
              { key: c.id },
              h(
                "button",
                {
                  type: "button",
                  class: "nav-link",
                  "aria-current": selected === c.id ? "true" : undefined,
                  onClick: () => select(c.id),
                },
                h(
                  "div",
                  { class: "channel-item-info" },
                  h("strong", { class: "channel-item-title" }, c.displayName),
                  h(
                    "div",
                    { class: "chip-row" },
                    h(
                      Badge,
                      { tone: c.enabled ? "ok" : "neutral" },
                      c.enabled
                        ? t("switchboard.status.enabled")
                        : t("switchboard.status.disabled"),
                    ),
                    h(
                      Badge,
                      { tone: !host || c.state === "not-registered" ? "neutral" : healthTone(c.health) },
                      stateLabel(c.state, host),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
  );

  const detailPane = selected
    ? h(DetailView, { channelId: selected, host, onRefresh: reload })
    : h(
        "div",
        null,
        h(PageState, {
          state: "empty",
          title: t("switchboard.empty.title"),
          detail: t("switchboard.empty.body"),
        }),
      );

  return h(
    "div",
    { class: "switchboard" },
    h(ListDetail, {
      list: listPane,
      detail: detailPane,
      selected: Boolean(selected),
      listLabel: t("switchboard.list.title"),
      detailLabel: t("switchboard.title"),
      onBack: () => {
        setSelectedId(null);
        navigate("/switchboard");
      },
    }),
  );
}

export function SwitchboardPage({ sub }: PageProps): View {
  const allowed = roleIn(currentRole(), ["owner", "admin"]);
  return h(
    Page,
    { title: t("switchboard.title"), lead: t("switchboard.intro"), width: "full" },
    allowed ? h(SwitchboardContent, sub !== undefined ? { sub } : {}) : h(PageState, { state: "forbidden" }),
  );
}
