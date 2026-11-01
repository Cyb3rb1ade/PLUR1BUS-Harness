// Server-reported model support and encoder installation are independent; old status responses make no support claim.
import { h } from "preact";
import type { View } from "../../view.ts";
import { t, formatNumber, type Key } from "../../i18n.ts";
import type { MediaCapabilities, MediaEncoderStatus } from "../../../../rpc-schema/generated/types.ts";

type Props = {
  model: string;
  capabilities?: MediaCapabilities | undefined;
  encoders?: readonly MediaEncoderStatus[] | undefined;
};
const MODALITIES = ["text", "image", "audio", "video"] as const;

/** Display only the model named by the status response, never a locally inferred capability of a pending choice. */
export function ModelCapabilities({ model, capabilities, encoders }: Props): View {
  const supported = capabilities ? MODALITIES.filter((kind) => capabilities[kind] === true) : [];
  return h("div", { class: "model-capabilities" },
    h("p", { class: "field-hint" }, t("mediasearch.capabilities.model", { model })),
    capabilities ? h("p", { class: "model-support" }, t("mediasearch.capabilities.support", {
      kinds: supported.length
        ? supported.map((kind) => t(`mediasearch.capabilities.kind.${kind}` as Key)).join(", ")
        : t("mediasearch.capabilities.none"),
    })) : null,
    h("p", { class: "field-hint" }, t("mediasearch.capabilities.installation", {
      state: encoders?.length ? t("mediasearch.capabilities.reported") : t("mediasearch.capabilities.unknown"),
    })),
    encoders?.length ? h("ul", { class: "plain-list" }, encoders.map((encoder) => h("li", { key: encoder.role },
      `${t(`mediasearch.capabilities.role.${encoder.role}` as Key)} · ${encoder.dtype}: ${t(`mediasearch.capabilities.state.${encoder.state}` as Key)}`,
      h("p", { class: "field-hint" }, t("mediasearch.capabilities.download", {
        size: encoder.downloadBytes === undefined
          ? t("mediasearch.capabilities.unknown")
          : t("mediasearch.capabilities.bytes", { n: formatNumber(encoder.downloadBytes) }),
      })),
      encoder.revision ? h("p", { class: "field-hint" }, t("mediasearch.capabilities.revision", { revision: encoder.revision })) : null,
    ))) : null);
}
