/** Shared package disclosures: wrapper and every bundle child retain their own trust, rights and executable metadata. */
import { h } from "preact";
import type { View } from "../../view.ts";
import { lang, t, type Key } from "../../i18n.ts";
import type { ExtInspection } from "../common/surfaces-rpc.ts";
import { RightsList } from "./rights.ts";

type InspectionData = Pick<
  ExtInspection,
  "manifest" | "trust" | "checks" | "capabilities" | "scripts" | "requires" | "sha256" | "replaces"
>;
export const inspectionText = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
function localized(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const translations = value as Record<string, unknown>;
    return inspectionText(translations[lang.value] ?? translations.en ?? translations.de ?? value);
  }
  return inspectionText(value);
}

/** Displays the original signer/publisher and every requested permission; a bundle signature never rewrites child trust. */
export function InspectionDisclosure({
  inspection,
  nested = false,
}: {
  inspection: InspectionData;
  nested?: boolean;
}): View {
  const manifest = inspection.manifest as Record<string, unknown>, heading = nested ? "h4" : "h3";
  return h(
    "div",
    { class: "inspection-disclosure" },
    h("p", null, localized(manifest.summary ?? "")),
    h(
      "dl",
      { class: "extension-meta-grid" },
      h("dt", null, t("extensions.detail.kind")),
      h("dd", null, inspectionText(manifest.kind)),
      h("dt", null, t("extensions.detail.trust")),
      h("dd", null, inspection.trust.tier),
      h("dt", null, t("extensions.install.signer")),
      h(
        "dd",
        null,
        inspection.trust.subject ??
          inspection.trust.keyId ??
          inspection.trust.label ??
          t("extensions.install.notDeclared"),
      ),
      inspection.trust.keyId ? h("dt", null, t("extensions.install.keyId")) : null,
      inspection.trust.keyId ? h("dd", { class: "mono" }, inspection.trust.keyId) : null,
      h("dt", null, t("extensions.install.publisher")),
      h(
        "dd",
        null,
        inspectionText(manifest.publisher ?? t("extensions.install.notDeclared")),
        ` (${t("extensions.install.unverified")})`,
      ),
      h("dt", null, t("extensions.install.license")),
      h("dd", null, inspectionText(manifest.licence ?? manifest.license ?? t("extensions.install.notDeclared"))),
      h("dt", null, "SHA-256"),
      h("dd", { class: "mono" }, inspection.sha256),
    ),
    h(
      "ul",
      { class: "plain-list", "data-install": "checks" },
      inspection.checks.map((check) =>
        h(
          "li",
          { key: check.id, class: check.status === "fail" ? "form-error" : undefined },
          `${check.id}: ${t(`extensions.install.check.${check.status}` as Key)} — ${check.detail}`,
        ),
      ),
    ),
    h(heading, null, t("extensions.install.capabilities")),
    h(RightsList, { caps: inspection.capabilities }),
    h(heading, null, t("extensions.install.scripts")),
    h(
      "ul",
      { class: "plain-list" },
      inspection.scripts.map((script) =>
        h(
          "li",
          { key: script.path },
          h("strong", null, `${script.path} (${script.size} B)`),
          h(
            "p",
            null,
            `${t("extensions.install.license")}: ${script.license ?? inspectionText(manifest.licence ?? manifest.license ?? t("extensions.install.notDeclared"))}`,
          ),
          h(
            "p",
            null,
            `${t("extensions.install.shebang")}: `,
            h("code", null, script.firstLine ?? t("extensions.install.notDeclared")),
          ),
        ),
      ),
    ),
    h(heading, null, t("extensions.install.runtime")),
    h("pre", { class: "reading" }, JSON.stringify(inspection.requires, null, 2)),
    h("p", { class: "field-hint" }, t("extensions.install.secretHint")),

    inspection.replaces
      ? h(
          "div",
          {},
          h(
            "p",
            { class: "form-notice" },
            t("extensions.bundle.replacementFrom", { version: inspection.replaces.version }),
          ),
          h(
            "ul",
            { class: "plain-list" },
            inspection.replaces.capabilityDiff.changed.map((change) => h("li", { key: change }, change)),
          ),
        )
      : null,
  );
}
