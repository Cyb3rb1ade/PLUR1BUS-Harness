import { h } from "preact";
import type { View } from "../../view.ts";
import { icon } from "../../icons.ts";
import { t } from "../../i18n.ts";
import type { BreakglassListResult } from "./rpc-types.ts";

export type BreakglassGrant = BreakglassListResult["grants"][number];

export function formatRemaining(expiresAt: number, now: number): string {
  const diffMs = Math.max(0, expiresAt - now);
  const totalSec = Math.floor(diffMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec < 10 ? "0" : ""}${sec}s`;
}

export type BreakglassWarningBannerProps = {
  grants: readonly BreakglassGrant[];
  now: number;
  onRevoke: (grant: BreakglassGrant) => void;
};

export function BreakglassWarningBanner({ grants, now, onRevoke }: BreakglassWarningBannerProps): View | null {
  if (grants.length === 0) return null;

  return h(
    "div",
    { class: "bg-banner", role: "alert", "aria-live": "assertive" },
    grants.map((g) => {
      const remaining = formatRemaining(g.expiresAt, now);
      return h(
        "div",
        { key: g.id, class: "bg-banner-item" },
        h(
          "div",
          { class: "bg-banner-header" },
          icon("alert"),
          h("span", {}, t("breakglass.banner.title")),
        ),
        h(
          "div",
          { class: "bg-banner-body" },
          h(
            "div",
            { class: "bg-banner-info" },
            h("span", {}, t("breakglass.banner.activeText", { target: g.targetUserId, remaining })),
            g.reason ? h("span", { class: "bg-reason-cell" }, `${t("breakglass.table.reason")}: ${g.reason}`) : null,
          ),
          h(
            "div",
            { class: "bg-banner-action" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                onClick: () => { onRevoke(g); },
              },
              t("breakglass.banner.revoke"),
            ),
          ),
        ),
      );
    }),
  );
}
