import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { Card } from "../../components/card.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import { area } from "./area.ts";
import { getActiveExternalLinks, type ExternalLink } from "./links.ts";
import { getApi } from "../../api/shared.ts";
import "../../styles/home.css";

registerArea("homeHelpLibrary", area);

type SystemStatus = {
  version: string;
  coreReachable: boolean;
  engineReady?: boolean;
  engineDegraded?: boolean;
  modelsReady?: boolean;
  uptimeSeconds?: number;
  processState?: string;
};

export function HomePage(): View {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const api = getApi();
    Promise.allSettled([
      api.get("/api/v1/health"),
      api.rpc("core.status", undefined, { write: false }),
    ]).then(([healthRes, coreRes]) => {
      if (!active) return;
      const s: SystemStatus = {
        version: "0.1.0",
        coreReachable: false,
      };

      if (healthRes.status === "fulfilled" && healthRes.value && typeof healthRes.value === "object") {
        const h = healthRes.value as Record<string, unknown>;
        const apiObj = h.api as { version?: string } | undefined;
        if (apiObj?.version) s.version = apiObj.version;
        const coreObj = h.core as { reachable?: boolean; uptimeMs?: number; engineReady?: boolean; degraded?: boolean } | undefined;
        if (coreObj) {
          s.coreReachable = coreObj.reachable === true;
          if (typeof coreObj.uptimeMs === "number") s.uptimeSeconds = Math.floor(coreObj.uptimeMs / 1000);
          if (typeof coreObj.engineReady === "boolean") s.engineReady = coreObj.engineReady;
          if (typeof coreObj.degraded === "boolean") s.engineDegraded = coreObj.degraded;
        }
      }

      if (coreRes.status === "fulfilled" && coreRes.value && typeof coreRes.value === "object") {
        const c = coreRes.value as Record<string, unknown>;
        const proc = c.process as { state?: string } | undefined;
        if (proc?.state) s.processState = proc.state;
        const eng = c.engine as { ready?: boolean; degraded?: unknown; models?: Record<string, { state?: string }> } | undefined;
        if (eng) {
          if (typeof eng.ready === "boolean") s.engineReady = eng.ready;
          if (eng.degraded !== undefined) s.engineDegraded = eng.degraded !== null;
          if (eng.models) {
            const allModelsOk = Object.values(eng.models).every((m) => m.state === "ready");
            s.modelsReady = allModelsOk;
          }
        }
      }

      setStatus(s);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, []);

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
        loading
          ? h(PageLoading, { label: t("state.loading") })
          : h(
              "div",
              { class: "home-status-facts" },
              h(
                "div",
                { class: "status-fact" },
                h("span", { class: "status-key" }, t("home.version")),
                h("span", { class: "status-val" }, status?.version || "0.1.0"),
              ),
              h(
                "div",
                { class: "status-fact" },
                h("span", { class: "status-key" }, t("home.coreStatus")),
                h(
                  "span",
                  {
                    class: `status-badge ${status?.coreReachable ? "status-ok" : "status-warn"}`,
                  },
                  status?.coreReachable ? "Connected" : "Disconnected",
                ),
              ),
              status?.processState
                ? h(
                    "div",
                    { class: "status-fact" },
                    h("span", { class: "status-key" }, t("home.processState")),
                    h("span", { class: "status-val" }, status.processState),
                  )
                : null,
              status?.engineReady !== undefined
                ? h(
                    "div",
                    { class: "status-fact" },
                    h("span", { class: "status-key" }, t("home.engineReady")),
                    h(
                      "span",
                      { class: `status-badge ${status.engineReady ? "status-ok" : "status-warn"}` },
                      status.engineReady ? "Yes" : "No",
                    ),
                  )
                : null,
              status?.uptimeSeconds !== undefined
                ? h(
                    "div",
                    { class: "status-fact" },
                    h("span", { class: "status-key" }, t("home.uptime")),
                    h("span", { class: "status-val" }, t("home.uptimeSeconds", { seconds: String(status.uptimeSeconds) })),
                  )
                : null,
            ),
      ),
    ),
  );
}
