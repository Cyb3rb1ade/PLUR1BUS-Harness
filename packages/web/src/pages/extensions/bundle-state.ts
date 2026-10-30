/** Installed bundle membership is read-only metadata; lifecycle actions stay on the native group transaction. */
import { h } from "preact";
import type { View } from "../../view.ts";
import { Badge, Card } from "../../components/card.ts";
import { t } from "../../i18n.ts";
import type { ExtBundleMember } from "../../../../rpc-schema/generated/types.ts";

/** Shows each installed member's real version, digest, activation and agent subset. */
export function BundleState({ members }: { members: readonly ExtBundleMember[] }): View {
  return h(
    Card,
    { title: t("extensions.bundle.title") },
    h(
      "ul",
      { class: "plain-list" },
      members.map((member) =>
        h(
          "li",
          { key: member.name },
          h("strong", null, `${member.name} · ${member.kind} · ${member.version}`),
          h(
            "div",
            { class: "chip-row" },
            h(
              Badge,
              { tone: member.enabled ? "ok" : "neutral" },
              t(member.enabled ? "extensions.status.enabled" : "extensions.status.disabled"),
            ),
            h(Badge, {}, t(member.optional ? "extensions.bundle.optional" : "extensions.bundle.required")),
          ),
          h(
            "p",
            null,
            t("extensions.detail.agents"),
            ": ",
            member.agents === "all"
              ? t("extensions.agents.all")
              : member.agents.length
                ? member.agents.join(", ")
                : t("extensions.bundle.noAgents"),
          ),
          h("p", { class: "mono" }, "SHA-256 ", member.sha256),
        ),
      ),
    ),
  );
}
