// Detail dialog of one log entry: every field of the record as text, a copy button per field and for the whole record, and the
// server's redaction markers shown with an icon and the word "Redacted" (never colour alone).
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { Badge } from "../../../components/card.ts";
import { Dialog } from "../../../components/dialog.ts";
import { icon } from "../../../icons.ts";
import { t } from "../../../i18n.ts";
import { fieldRows, redactionRules, splitRedacted, type LogRecord } from "./model.ts";

function Value({ text }: { text: string }): View[] {
  return splitRedacted(text).map((p, i) => (p.redacted
    ? h("span", { key: i, class: "logs-redacted" }, icon("lock", 14), h("span", {}, p.text))
    : h("span", { key: i }, p.text)));
}

export function DetailDialog({ rec, onClose }: { rec: LogRecord; onClose: () => void }): View {
  const [note, setNote] = useState("");
  const rules = redactionRules(rec);
  const copy = (text: string, what: string): void => {
    const write = globalThis.navigator?.clipboard?.writeText(text);
    if (!write) { setNote(t("logs.detail.copyFailed")); return; }
    write.then(() => { setNote(t("logs.detail.copied", { what })); }, () => { setNote(t("logs.detail.copyFailed")); });
  };
  const fields = [{ key: "component", value: rec.component, block: false }, { key: "stream", value: rec.stream, block: false }, ...fieldRows(rec)];
  return h(Dialog, {
    title: t("logs.detail.title"), onClose,
    actions: h("button", { type: "button", class: "btn", onClick: () => { copy(JSON.stringify(rec.record, null, 2), t("logs.detail.record")); } }, t("logs.detail.copyAll")),
  },
    rules.length > 0 ? h("p", { class: "notice", "data-tone": "warn" }, icon("lock", 14), " ", t("logs.detail.redactedNote", { rules: rules.join(", ") })) : null,
    h("dl", { class: "logs-fields" }, fields.map((f) => {
      const redacted = f.value.includes("[REDACTED:");
      return h("div", { key: f.key, class: "logs-field" },
        h("dt", {}, f.key),
        h("dd", {},
          f.block ? h("pre", { class: "logs-pre" }, h(Value, { text: f.value })) : h("span", { class: "logs-val" }, h(Value, { text: f.value })),
          h("span", { class: "logs-field-tools" },
            redacted ? h(Badge, { tone: "warn" }, t("logs.detail.redactedField")) : null,
            h("button", { type: "button", class: "btn btn-quiet logs-copy", "aria-label": t("logs.detail.copy", { field: f.key }), onClick: () => { copy(f.value, f.key); } }, t("logs.detail.copyShort")))));
    })),
    h("p", { class: "logs-copied", role: "status" }, note));
}
