// Skills & Plugins Page: ext.list, ext.show, ext.enable/disable, ext.uninstall, ext.restore, ext.install file upload, live watch.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card, type BadgeTone } from "../../components/card.ts";
import { Dialog } from "../../components/dialog.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Tabs } from "../../components/tabs.ts";
import { t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/extensions.ts";
import { FailureState } from "../common/states.ts";
import { currentRole, getApi, roleIn, useLoad } from "../common/load.ts";
import type { PageProps } from "../registry.ts";
import { navigate } from "../../router.ts";
import type {
  ExtItem,
  ExtDetail,
  ExtInspection,
  ExtKind,
  ExtOverlay,
  ExtTrustTier,
} from "../common/surfaces-rpc.ts";

import { RightsList } from "./rights.ts";

import "../../styles/extensions.css";

registerArea("extensions", area);

function overlayTone(overlay: ExtOverlay): BadgeTone {
  switch (overlay) {
    case "needs-setup":
      return "warn";
    case "incompatible":
      return "warn";
    case "revoked":
    case "tampered":
    case "error":
      return "err";
    default:
      return "neutral";
  }
}

function trustTone(tier: ExtTrustTier): BadgeTone {
  switch (tier) {
    case "release":
    case "first-party":
      return "ok";
    case "unknown-signer":
    case "unsigned":
      return "warn";
    case "imported":
    case "dev":
      return "info";
    default:
      return "neutral";
  }
}

/** Key order does not matter when two capability objects are compared. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

function UninstallDialog({
  name,
  onClose,
  onDone,
}: {
  name: string;
  onClose: () => void;
  onDone: () => void;
}): View {
  const [purge, setPurge] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr("");
    try {
      await getApi().rpc("ext.uninstall", { name, purge, cascade });
      setBusy(false);
      onDone();
      onClose();
    } catch (e) {
      setBusy(false);
      const o = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setErr(o.message || t("extensions.error.required"));
    }
  };

  return h(
    Dialog,
    {
      title: t("extensions.uninstall.title"),
      onClose,
      actions: h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-err",
            disabled: busy,
            onClick: () => { void submit(); },
          },
          t("extensions.action.uninstall"),
        ),
      ),
    },
    h(
      "div",
      { class: "dialog-content" },
      h("p", { class: "reading" }, t("extensions.uninstall.confirm", { name })),
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
      h(
        "div",
        { class: "field" },
        h(
          "label",
          { class: "checkbox-label" },
          h("input", {
            type: "checkbox",
            checked: purge,
            onChange: (e: Event) => setPurge((e.target as HTMLInputElement).checked),
          }),
          " ",
          t("extensions.uninstall.purge"),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h(
          "label",
          { class: "checkbox-label" },
          h("input", {
            type: "checkbox",
            checked: cascade,
            onChange: (e: Event) => setCascade((e.target as HTMLInputElement).checked),
          }),
          " ",
          t("extensions.uninstall.cascade"),
        ),
      ),
    ),
  );
}

function InstallDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}): View {
  const [stage, setStage] = useState<"file" | "inspecting" | "disclosed">("file");
  const [filePath, setFilePath] = useState("");
  const [inspection, setInspection] = useState<ExtInspection | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inFlight = useRef(false);

  const inspect = async (path: string): Promise<void> => {
    setBusy(true);
    setErr("");
    setStage("inspecting");
    try {
      const res = (await getApi().rpc("ext.inspect", { source: { path } }, { write: false })) as ExtInspection;
      setInspection(res);
      setStage("disclosed");
    } catch (e) {
      setStage("file");
      const o = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setErr(o.message || t("extensions.install.inspectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const path = file.name;
    setFilePath(path);
    void inspect(path);
  };

  const install = async (): Promise<void> => {
    if (!inspection || inFlight.current || inspection.checks.some((c) => c.status === "fail")) return;
    inFlight.current = true;
    setBusy(true);
    setErr("");
    try {
      const acks: ("unsigned" | "unknown-signer" | "downgrade" | "capabilities")[] = [];
      if (inspection.trust.tier === "unsigned") acks.push("unsigned");
      if (inspection.trust.tier === "unknown-signer") acks.push("unknown-signer");
      acks.push("capabilities");
      await getApi().rpc("ext.install", {
        inspectionId: inspection.inspectionId,
        acknowledge: acks,
      });
      setBusy(false);
      onDone();
      onClose();
    } catch (e) {
      setBusy(false);
      const o = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setErr(o.message || t("extensions.error.required"));
    } finally {
      inFlight.current = false;
    }
  };
  const blocked = inspection?.checks.some((c) => c.status === "fail") ?? false;

  return h(
    Dialog,
    {
      title: t("extensions.install.title"),
      onClose,
      actions: h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
        stage === "disclosed"
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                disabled: busy || !ack || blocked,
                onClick: () => { void install(); },
              },
              t("extensions.install.submit"),
            )
          : null,
      ),
    },
    h(
      "div",
      { class: "dialog-content" },
      err ? h("p", { class: "form-error", role: "alert" }, err) : null,
      stage === "file" || stage === "inspecting"
        ? h(
            "div",
            { class: "field" },
            h("label", { for: "ext-file-input" }, t("extensions.action.installFile")),
            h("input", {
              id: "ext-file-input",
              type: "file",
              accept: ".p1x,.zip,.skill",
              disabled: busy,
              onChange: handleFileChange,
            }),
            stage === "inspecting" ? h("p", { role: "status", "aria-live": "polite" }, t("extensions.install.inspect")) : null,
          )
        : null,
      stage === "disclosed" && inspection
        ? h(
            "div",
            { class: "inspection-disclosure" },
            h("p", { class: "reading" }, t("extensions.install.ready", { id: String((inspection.manifest as { id?: unknown }).id ?? "?"), version: String((inspection.manifest as { version?: unknown }).version ?? "?") })),
            h("p", { class: "reading", "data-install": "trust" }, t("extensions.install.trust", { tier: inspection.trust.tier, sha: inspection.sha256.slice(0, 12) })),
            h(
              "ul",
              { class: "plain-list", "data-install": "checks" },
              inspection.checks.map((c) => h("li", { key: c.id, class: c.status === "fail" ? "form-error" : undefined, role: c.status === "fail" ? "alert" : undefined }, `${c.id}: ${t(`extensions.install.check.${c.status}` as Key)} – ${c.detail}`)),
            ),
            inspection.scripts.length
              ? h("div", { "data-install": "scripts" }, h("h3", null, t("extensions.install.scripts")), h("ul", { class: "plain-list" }, inspection.scripts.map((sc) => h("li", { key: sc.path }, `${sc.path} (${sc.size} B)`))))
              : null,
            h("h3", null, t("extensions.install.capabilities")),
            h(RightsList, { caps: inspection.capabilities }),
            inspection.replaces && inspection.replaces.capabilityDiff.changed.length > 0
              ? h("p", { class: "form-notice", role: "status" }, t("extensions.install.widens", { list: inspection.replaces.capabilityDiff.changed.join(", ") }))
              : null,
            h(
              "div",
              { class: "field" },
              h(
                "label",
                { class: "checkbox-label" },
                h("input", {
                  type: "checkbox",
                  checked: ack,
                  onChange: (e: Event) => setAck((e.target as HTMLInputElement).checked),
                }),
                " ",
                t("extensions.install.acknowledge"),
              ),
            ),
          )
        : null,
    ),
  );
}

function EnableDialog({
  name,
  caps,
  changed,
  onClose,
  onConfirm,
  busy,
}: {
  name: string;
  caps: unknown;
  /** The rights differ from what the person saw a moment ago: they are shown again and must be acknowledged again. */
  changed: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}): View {
  const [ack, setAck] = useState(false);
  return h(
    Dialog,
    {
      title: t("extensions.enable.title"),
      onClose,
      actions: h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: onClose }, t("shared.confirm.cancel")),
        h("button", { type: "button", class: "btn btn-primary", disabled: busy || !ack, onClick: onConfirm }, t("extensions.enable.submit")),
      ),
    },
    h(
      "div",
      { class: "dialog-content" },
      changed ? h("p", { class: "form-error", role: "alert" }, t("extensions.enable.changed")) : null,
      h("p", { class: "reading" }, t("extensions.enable.intro", { name })),
      h(RightsList, { caps }),
      h(
        "div",
        { class: "field" },
        h(
          "label",
          { class: "checkbox-label" },
          h("input", { type: "checkbox", checked: ack, onChange: (e: Event) => setAck((e.target as HTMLInputElement).checked) }),
          " ",
          t("extensions.enable.acknowledge"),
        ),
      ),
    ),
  );
}

function ExtensionDetailView({
  name,
  onRefresh,
  changes,
}: {
  name: string;
  onRefresh: () => void;
  /** Counts `ext.changed` events: the detail (and the rights it shows) is read again whenever it grows. */
  changes: number;
}): View {
  const { state, reload } = useLoad(
    (signal) =>
      getApi().rpc("ext.show", { name }, { write: false, signal }) as Promise<ExtDetail>,
    [name],
    changes,
  );
  const [busy, setBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const [uninstalling, setUninstalling] = useState(false);
  // The rights the person is looking at in the enable dialog; `n` restarts the dialog (and its acknowledgement) when they change.
  const [consent, setConsent] = useState<{ caps: unknown; changed: boolean; n: number } | null>(null);
  const inFlight = useRef(false);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, {
      failure: state.failure,
      unavailable: t("state.unavailable.title"),
      onRetry: reload,
    });

  const detail = state.data;
  const item = detail.item;

  const toggle = async (enable: boolean): Promise<void> => {
    setBusy(true);
    setActionNotice("");
    try {
      if (enable) {
        await getApi().rpc("ext.enable", { name: item.name, acknowledge: ["capabilities"] });
      } else {
        await getApi().rpc("ext.disable", { name: item.name });
      }
      reload();
      onRefresh();
    } catch (e) {
      const o = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setActionNotice(o.message || t("extensions.error.required"));
    } finally {
      setBusy(false);
    }
  };

  /** Confirm: what the server holds now must be what was on screen. Otherwise nothing is enabled and the new rights are shown. */
  const confirmEnable = async (): Promise<void> => {
    if (inFlight.current || !consent) return;
    inFlight.current = true;
    setBusy(true);
    try {
      let fresh: ExtDetail;
      try {
        fresh = (await getApi().rpc("ext.show", { name: item.name }, { write: false })) as ExtDetail;
      } catch (e) {
        setConsent(null);
        const o = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
        setActionNotice(o.message || t("extensions.error.required"));
        return;
      }
      if (canonical(fresh.capabilities) !== canonical(consent.caps)) {
        setConsent({ caps: fresh.capabilities, changed: true, n: consent.n + 1 });
        reload();
        return;
      }
      setConsent(null);
      await toggle(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const restoreTrash = async (trashId: string): Promise<void> => {
    setBusy(true);
    setActionNotice("");
    try {
      await getApi().rpc("ext.restore", { trashId });
      reload();
      onRefresh();
    } catch (e) {
      const o = (typeof e === "object" && e !== null ? e : {}) as { message?: string };
      setActionNotice(o.message || t("extensions.error.required"));
    } finally {
      setBusy(false);
    }
  };

  const agentsDisplay = item.agents === "all" ? t("extensions.agents.all") : t("extensions.agents.selected", { count: item.agents.length });

  return h(
    "div",
    { class: "extension-detail" },
    h(
      "div",
      { class: "card-head" },
      h(
        "div",
        null,
        h("h2", { class: "card-title" }, item.name),
        h(
          "div",
          { class: "chip-row" },
          h(
            Badge,
            { tone: item.enabled ? "ok" : "neutral" },
            item.enabled ? t("extensions.status.enabled") : t("extensions.status.disabled"),
          ),
          h(
            Badge,
            { tone: trustTone(item.trust) },
            item.trust,
          ),
          h(
            Badge,
            { tone: "neutral" },
            item.kind,
          ),
          item.overlays.map((o) =>
            h(Badge, { key: o, tone: overlayTone(o) }, o)
          ),
        ),
      ),
      h(
        "div",
        { class: "chip-row" },
        item.enabled
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                disabled: busy,
                onClick: () => { void toggle(false); },
              },
              t("extensions.action.disable"),
            )
          : h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                disabled: busy,
                onClick: () => setConsent({ caps: detail.capabilities, changed: false, n: 0 }),
              },
              t("extensions.action.enable"),
            ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-err",
            disabled: busy,
            onClick: () => setUninstalling(true),
          },
          t("extensions.action.uninstall"),
        ),
      ),
    ),
    actionNotice
      ? h("p", { class: "form-notice", role: "status", "aria-live": "polite" }, actionNotice)
      : null,
    h(
      Card,
      null,
      h(
        "div",
        { class: "extension-meta-grid" },
        h(
          "div",
          { class: "extension-meta-item" },
          h("span", { class: "extension-meta-label" }, t("extensions.detail.version")),
          h("span", { class: "extension-meta-value" }, item.version),
        ),
        h(
          "div",
          { class: "extension-meta-item" },
          h("span", { class: "extension-meta-label" }, t("extensions.detail.source")),
          h("span", { class: "extension-meta-value" }, item.source),
        ),
        h(
          "div",
          { class: "extension-meta-item" },
          h("span", { class: "extension-meta-label" }, t("extensions.detail.agents")),
          h("span", { class: "extension-meta-value" }, agentsDisplay),
        ),
        h(
          "div",
          { class: "extension-meta-item" },
          h("span", { class: "extension-meta-label" }, t("extensions.detail.files", { count: detail.files.count, bytes: detail.files.bytes })),
        ),
      ),
    ),
    h(
      Card,
      { title: t("extensions.detail.permissions") },
      h(RightsList, { caps: detail.capabilities }),
    ),
    detail.dependents.length > 0
      ? h(
          Card,
          { title: t("extensions.detail.dependents") },
          h("ul", { class: "permission-list" }, detail.dependents.map((d) => h("li", { key: d }, d))),
        )
      : null,
    detail.trash && detail.trash.length > 0
      ? h(
          Card,
          { title: t("extensions.detail.trash") },
          h(
            "ul",
            { class: "plain-list" },
            detail.trash.map((tr) =>
              h(
                "li",
                { key: tr.trashId, class: "chip-row" },
                h("span", null, `${tr.version} (${tr.removedAt})`),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-quiet",
                    disabled: busy,
                    onClick: () => { void restoreTrash(tr.trashId); },
                  },
                  t("extensions.action.restore"),
                ),
              )
            ),
          ),
        )
      : null,
    consent
      ? h(EnableDialog, {
          key: consent.n,
          name: item.name,
          caps: consent.caps,
          changed: consent.changed,
          busy,
          onClose: () => setConsent(null),
          onConfirm: () => { void confirmEnable(); },
        })
      : null,
    uninstalling
      ? h(UninstallDialog, {
          name: item.name,
          onClose: () => setUninstalling(false),
          onDone: () => {
            reload();
            onRefresh();
          },
        })
      : null,
  );
}

function ExtensionsContent({
  initialKind,
  sub,
}: {
  initialKind?: "skill" | "plugin" | undefined;
  sub?: string | undefined;
}): View {
  const { state, reload } = useLoad(
    (signal) => getApi().rpc("ext.list", {}, { write: false, signal }) as Promise<{ items?: ExtItem[] } | ExtItem[]>,
    []
  );
  const [selectedName, setSelectedName] = useState<string | null>(sub ?? null);
  const [kindFilter, setKindFilter] = useState<"all" | "skill" | "plugin">(
    initialKind === "skill" ? "skill" : initialKind === "plugin" ? "plugin" : "all"
  );
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState(false);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    if (sub) setSelectedName(sub);
  }, [sub]);

  // Live updates via SSE / events if available
  useEffect(() => {
    try {
      const api = getApi();
      const stream = api.events({
        onEvent: (ev) => {
          if (ev.event === "ext.changed") {
            reload();
            setChanges((n) => n + 1);
          }
        },
      });
      return () => {
        stream.close();
      };
    } catch {
      // events not supported in test or environment
    }
  }, []);

  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail")
    return h(FailureState, {
      failure: state.failure,
      unavailable: t("state.unavailable.title"),
      onRetry: reload,
    });

  const raw = state.data;
  const items: ExtItem[] = Array.isArray(raw) ? raw : (raw as { items?: ExtItem[] }).items ?? [];

  const filtered = items.filter((it) => {
    if (kindFilter === "skill" && it.kind !== "skill") return false;
    if (kindFilter === "plugin" && it.kind === "skill") return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return it.name.toLowerCase().includes(q) || (it.id && it.id.toLowerCase().includes(q));
    }
    return true;
  });

  const selected = selectedName || filtered[0]?.name || null;

  const select = (name: string): void => {
    setSelectedName(name);
    navigate(`/skills/${name}`);
  };

  const listPane = h(
    "div",
    { class: "extensions-list-pane" },
    h(
      "div",
      { class: "extensions-toolbar" },
      h(
        "div",
        { class: "extensions-filters" },
        h(
          "button",
          {
            type: "button",
            class: `btn ${kindFilter === "all" ? "btn-primary" : "btn-quiet"}`,
            onClick: () => setKindFilter("all"),
          },
          t("extensions.tab.all"),
        ),
        h(
          "button",
          {
            type: "button",
            class: `btn ${kindFilter === "skill" ? "btn-primary" : "btn-quiet"}`,
            onClick: () => setKindFilter("skill"),
          },
          t("extensions.tab.skills"),
        ),
        h(
          "button",
          {
            type: "button",
            class: `btn ${kindFilter === "plugin" ? "btn-primary" : "btn-quiet"}`,
            onClick: () => setKindFilter("plugin"),
          },
          t("extensions.tab.plugins"),
        ),
      ),
      h("input", {
        type: "search",
        class: "extensions-search",
        placeholder: t("extensions.search"),
        value: search,
        onInput: (e: Event) => setSearch((e.target as HTMLInputElement).value),
      }),
    ),
    h(
      "div",
      { class: "extensions-actions-bar chip-row" },
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary",
          onClick: () => setInstalling(true),
        },
        t("extensions.action.installFile"),
      ),
    ),
    h(
      "div",
      { class: "extension-web-notice", role: "note" },
      t("extensions.webNotice"),
    ),
    filtered.length === 0
      ? h(PageState, {
          state: "empty",
          title: t("extensions.empty.title"),
          detail: t("extensions.empty.body"),
        })
      : h(
          "ul",
          { class: "plain-list extensions-list" },
          filtered.map((it) =>
            h(
              "li",
              { key: it.name },
              h(
                "button",
                {
                  type: "button",
                  class: "nav-link",
                  "aria-current": selected === it.name ? "true" : undefined,
                  onClick: () => select(it.name),
                },
                h(
                  "div",
                  { class: "extension-item-info" },
                  h("strong", { class: "extension-item-title" }, it.name),
                  h(
                    "div",
                    { class: "chip-row" },
                    h(
                      Badge,
                      { tone: it.enabled ? "ok" : "neutral" },
                      it.enabled ? t("extensions.status.enabled") : t("extensions.status.disabled"),
                    ),
                    h(Badge, { tone: "neutral" }, it.kind),
                    h(Badge, { tone: trustTone(it.trust) }, it.trust),
                    it.overlays.map((o) =>
                      h(Badge, { key: o, tone: overlayTone(o) }, o)
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
    installing
      ? h(InstallDialog, {
          onClose: () => setInstalling(false),
          onDone: () => reload(),
        })
      : null,
  );

  const detailPane = selected
    ? h(ExtensionDetailView, { name: selected, onRefresh: reload, changes })
    : h(PageState, {
        state: "empty",
        title: t("extensions.empty.title"),
        detail: t("extensions.empty.body"),
      });

  return h(
    "div",
    { class: "extensions-page" },
    h(ListDetail, {
      list: listPane,
      detail: detailPane,
      selected: Boolean(selected),
      listLabel: t("extensions.title"),
      detailLabel: selected ?? t("extensions.title"),
      onBack: () => {
        setSelectedName(null);
        navigate(initialKind === "plugin" ? "/plugins" : "/skills");
      },
    }),
  );
}

export function ExtensionsPage({ item, sub }: PageProps): View {
  const allowed = roleIn(currentRole(), ["owner", "admin", "operator", "member", "viewer"]);
  const initialKind = item.id === "plugins" ? "plugin" : item.id === "skills" ? "skill" : undefined;
  return h(
    Page,
    { title: t("extensions.title"), lead: t("extensions.intro"), width: "full" },
    allowed ? h(ExtensionsContent, { initialKind, sub }) : h(PageState, { state: "forbidden" }),
  );
}
