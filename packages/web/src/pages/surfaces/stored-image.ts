import { h } from "preact";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import { useLoad } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { rpc, imageUrl } from "./data.ts";
import "../../styles/surfaces.css";

export function StoredImage({
  id,
  download = false,
  alt,
}: {
  id: string;
  download?: boolean;
  /** What the picture shows. Without it the alternative text stays the job label the other pages (chat, library) show. */
  alt?: string;
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
      alt: alt ?? t("media.job", { id }),
      loading: "lazy",
      class: "stored-image",
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
