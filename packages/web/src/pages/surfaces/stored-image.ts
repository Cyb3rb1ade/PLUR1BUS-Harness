import { h } from "preact";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import { useLoad } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { rpc, imageUrl } from "./data.ts";

export function StoredImage({
  id,
  download = false,
}: {
  id: string;
  download?: boolean;
}): View | null {
  const { state } = useLoad(
    (signal) =>
      rpc<{ data?: string; mimeType?: string }>(
        "media.output.get",
        { id, file: 0 },
        signal,
      ),
    [id],
  );
  if (state.status === "fail")
    return h(FailureState, {
      failure: state.failure,
      unavailable: t("surfaces.unavailable"),
    });
  if (state.status !== "ok") return null;
  const src = imageUrl(state.data);
  if (!src) return null;
  return h(
    "div",
    {},
    h("img", {
      src,
      alt: t("media.job", { id }),
      loading: "lazy",
      style: "max-width:100%;height:auto",
    }),
    download
      ? h(
          "a",
          {
            class: "btn",
            href: src,
            download: `${id}.${state.data.mimeType?.split("/")[1] ?? "png"}`,
          },
          t("media.download"),
        )
      : null,
  );
}
