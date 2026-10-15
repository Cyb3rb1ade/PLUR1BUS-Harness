import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { Card } from "../../components/card.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import { area } from "./area.ts";
import { getActiveExternalLinks } from "./links.ts";
import { getApi } from "../../api/shared.ts";
import { failureOf } from "../common/load.ts";
import { Notice } from "../common/states.ts";
import "../../styles/home.css";

registerArea("homeHelpLibrary", area);

type SystemStatus = {
  /** Only what the harness reported: no number is made up when nothing was reported. */
  version?: string;
  coreReachable: boolean;
  engineReady?: boolean;
  engineDegraded?: boolean;
  modelsReady?: boolean;
  uptimeSeconds?: number;
  processState?: string;
};

/** `ok`: at least one source answered. `forbidden`: every source refused this role (health needs `doctor.read`), which says
 *  nothing about the core. `down`: nothing answered and not because of the role. */
type Phase = { kind: "loading" } | { kind: "ok"; status: SystemStatus } | { kind: "forbidden" } | { kind: "down" };

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v : undefined);

/** Reads what the two answers say, whatever shape they have: a field of the wrong type is skipped, never a reason to fail. */
export function readStatus(health: unknown, core: unknown, healthOk: boolean, coreOk: boolean): SystemStatus {
  const s: SystemStatus = { coreReachable: coreOk };
  if (healthOk) {
    const body = rec(health); const version = text(rec(body?.api)?.version, 64); if (version) s.version = version;
    const c = rec(body?.core);
    if (c?.reachable === true) s.coreReachable = true;
    if (typeof c?.uptimeMs === "number" && Number.isFinite(c.uptimeMs) && c.uptimeMs >= 0) s.uptimeSeconds = Math.floor(c.uptimeMs / 1000);
    if (typeof c?.engineReady === "boolean") s.engineReady = c.engineReady;
    if (typeof c?.degraded === "boolean") s.engineDegraded = c.degraded;
  }
  if (coreOk) {
    const body = rec(core); const state = text(rec(body?.process)?.state, 40); if (state) s.processState = state;
    const engine = rec(body?.engine);
    if (typeof engine?.ready === "boolean") s.engineReady = engine.ready;
    if (engine && engine.degraded !== undefined) s.engineDegraded = engine.degraded !== null;
    const models = rec(engine?.models);
    if (models) s.modelsReady = Object.values(models).every((m) => rec(m)?.state === "ready");
  }
  return s;
}

async function loadStatus(): Promise<Phase> {
  const api = getApi();
  const [health, core] = await Promise.allSettled([api.get("/api/v1/health"), api.rpc("core.status", undefined, { write: false })]);
  if (health.status === "fulfilled" || core.status === "fulfilled") {
    return { kind: "ok", status: readStatus(health.status === "fulfilled" ? health.value : undefined, core.status === "fulfilled" ? core.value : undefined, health.status === "fulfilled", core.status === "fulfilled") };
  }
  const failures = [health, core].map((r) => failureOf((r as PromiseRejectedResult).reason));
  return failures.every((f) => f.kind === "forbidden") ? { kind: "forbidden" } : { kind: "down" };
}

const yesNo = (v: boolean): string => (v ? t("home.status.yes") : t("home.status.no"));
const fact = (label: string, value: View | string, key: string): View =>
  h("div", { class: "status-fact", key }, h("span", { class: "status-key" }, label), typeof value === "string" ? h("span", { class: "status-val" }, value) : value);
const badge = (ok: boolean, label: string): View => h("span", { class: `status-badge ${ok ? "status-ok" : "status-warn"}` }, label);

function StatusFacts({ status }: { status: SystemStatus }): View {
  return h("div", { class: "home-status-facts" },
    fact(t("home.version"), status.version ?? "—", "version"),
    fact(t("home.coreStatus"), badge(status.coreReachable, status.coreReachable ? t("home.status.connected") : t("home.status.disconnected")), "core"),
    status.processState ? fact(t("home.processState"), status.processState, "process") : null,
    status.engineReady !== undefined ? fact(t("home.engineReady"), badge(status.engineReady, yesNo(status.engineReady)), "engine") : null,
    status.uptimeSeconds !== undefined ? fact(t("home.uptime"), t("home.uptimeSeconds", { seconds: String(status.uptimeSeconds) }), "uptime") : null);
}

export function HomePage(): View {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setPhase({ kind: "loading" });
    // A status that cannot be read is a state of its own card; it never takes the links with it.
    loadStatus().then((p) => { if (active) setPhase(p); }, () => { if (active) setPhase({ kind: "down" }); });
    return () => { active = false; };
  }, [attempt]);

  const activeLinks = getActiveExternalLinks();

  return h(
    Page,
    { title: t("home.title"), lead: t("home.tagline"), width: "settings" },
    h(
      "div",
      { class: "home-grid" },
      h(
        Card,
        { title: t("home.section.quickLinks") },
        h(
          "ul",
          { class: "home-links-list" },
          activeLinks.map((link) => {
            const isExternal = /^https?:\/\//i.test(link.url);
            return h(
              "li",
              { key: link.id, class: "home-link-item" },
              h(
                "a",
                {
                  href: link.url,
                  class: "home-link",
                  ...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {}),
                },
                t(link.labelKey),
                isExternal ? h("span", { class: "external-badge", "aria-hidden": "true" }, " ↗") : null,
              ),
            );
          }),
        ),
      ),
      h(
        Card,
        { title: t("home.section.status") },
        phase.kind === "loading" ? h(PageLoading, { label: t("state.loading") })
          : phase.kind === "forbidden" ? h(Notice, {}, t("home.status.forbidden"))
          : phase.kind === "down" ? h("div", { class: "home-status-facts" },
              fact(t("home.coreStatus"), badge(false, t("home.status.disconnected")), "core"),
              h("div", { class: "state-actions" }, h("button", { type: "button", class: "btn", onClick: () => setAttempt((n) => n + 1) }, t("state.retry"))))
          : h(StatusFacts, { status: phase.status }),
      ),
    ),
  );
}
