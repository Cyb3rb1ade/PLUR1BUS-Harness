import { h } from "preact";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import type { MediaFailure } from "./media-model.ts";

/** Text of a failure with its code, for places that only take a string (a confirm dialog's message). */
export function failureText(f: MediaFailure): string {
  const code = f.reason && f.reason !== f.code ? `${f.code}, ${f.reason}` : f.code;
  return `${t(`libmedia.fail.${f.text}`)} (${code})`;
}

/** A media failure as an alert: what happened in words, and the code and reason of docs/errors.md beside it. Nothing is hidden. */
export function FailureNote({ failure }: { failure: MediaFailure }): View {
  return h("div", { class: "notice libmedia-fail", "data-tone": "error", role: "alert" },
    h("p", { class: "libmedia-fail-text" }, t(`libmedia.fail.${failure.text}`)),
    h("p", { class: "libmedia-fail-code" },
      h("code", {}, t("libmedia.fail.code", { code: failure.code })),
      failure.reason && failure.reason !== failure.code ? [" ", h("code", {}, t("libmedia.fail.reason", { reason: failure.reason }))] : null));
}
