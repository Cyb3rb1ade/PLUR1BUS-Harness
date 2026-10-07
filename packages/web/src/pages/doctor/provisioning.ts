// Provisioning results (acceptance 8, L16 UI half): the machine-readable `1staid.check/1` document, shown as a table with
// a status, the message and the remedy, plus Copy / Download of the UNCHANGED raw text.
// There is no RPC or route that serves this document (it is printed by `plur1bus 1staid check --json`), so the only
// source is a file the owner loads. It is read with File.text() in this browser; nothing is sent anywhere, and the free-form
// `detail` of a check (it may hold paths) is never shown.
import { h } from "preact";
import { useId, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, Card, type BadgeTone } from "../../components/card.ts";
import { t, type Key } from "../../i18n.ts";
import { CHECK_SCHEMA, MAX_CHECK_BYTES, parseCheckDoc, type CheckItem, type CheckParse, type CheckStatus } from "./model.ts";
import { DataTable, type Col } from "./views.ts";

export const DOWNLOAD_NAME = "1staid-check.json";
const TONE: Record<CheckStatus, BadgeTone> = { ok: "ok", info: "info", warn: "warn", fail: "err", skip: "neutral" };

/** Hands the exact text to the browser as a file. Blob + object URL: no dependency, no request. */
export function downloadText(raw: string, name = DOWNLOAD_NAME): void {
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type Loaded = Extract<CheckParse, { ok: true }>;
type ErrKey = "too-large" | "not-json" | "wrong-schema" | "malformed" | "read";
// i18n keys are camelCase segments (test/i18n.test.ts), the parse reasons are kebab-case.
const ERR_TEXT = { "too-large": "doctor.prov.err.tooLarge", "not-json": "doctor.prov.err.notJson", "wrong-schema": "doctor.prov.err.wrongSchema", malformed: "doctor.prov.err.malformed", read: "doctor.prov.err.read" } as const satisfies Record<ErrKey, Key>;

async function readFile(file: File): Promise<Loaded | { error: ErrKey }> {
  if (file.size > MAX_CHECK_BYTES) return { error: "too-large" };
  let text: string;
  try { text = await file.text(); } catch { return { error: "read" }; }
  const r = parseCheckDoc(text);
  return r.ok ? r : { error: r.reason };
}

export function ProvisioningCard(): View {
  const inputId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<ErrKey | null>(null);
  const [note, setNote] = useState("");

  const onFile = async (e: Event): Promise<void> => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const r = await readFile(file);
    input.value = "";
    setNote("");
    if ("error" in r) { setLoaded(null); setError(r.error); } else { setError(null); setLoaded(r); }
  };
  const copy = async (): Promise<void> => {
    if (!loaded) return;
    try { await navigator.clipboard.writeText(loaded.raw); setNote(t("doctor.prov.copied")); } catch { setNote(t("doctor.prov.copyFailed")); }
  };

  const cols: Col<CheckItem>[] = [
    { head: t("doctor.prov.col.check"), cell: (c) => c.id },
    { head: t("doctor.prov.col.status"), cell: (c) => h(Badge, { tone: TONE[c.status] }, t(`doctor.prov.status.${c.status}`)) },
    { head: t("doctor.prov.col.message"), cell: (c) => c.summary },
    { head: t("doctor.prov.col.remedy"), cell: (c) => c.hint ?? t("doctor.none") },
  ];

  return h(Card, { title: t("doctor.prov.title") },
    h("p", { class: "reading" }, t("doctor.prov.intro")),
    h("div", { class: "field" },
      h("label", { for: inputId }, t("doctor.prov.file")),
      h("input", { id: inputId, type: "file", accept: ".json,application/json", onChange: (e: Event) => { void onFile(e); } })),
    error ? h("p", { class: "form-error", role: "alert" }, t(ERR_TEXT[error])) : null,
    loaded
      ? h("div", null,
          h("p", null, h(Badge, { tone: loaded.doc.ok ? "ok" : "err" }, CHECK_SCHEMA), " ", t(loaded.doc.ok ? "doctor.prov.summaryOk" : "doctor.prov.summaryFail")),
          h(DataTable<CheckItem>, { label: t("doctor.prov.table"), cols, rows: loaded.doc.checks, rowKey: (c) => c.id }),
          h("div", { class: "state-actions" },
            h("button", { type: "button", class: "btn", onClick: () => { void copy(); } }, t("doctor.prov.copy")),
            h("button", { type: "button", class: "btn", onClick: () => { downloadText(loaded.raw); } }, t("doctor.prov.download")),
            h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setLoaded(null); setNote(""); } }, t("doctor.prov.clear"))))
      : null,
    h("p", { role: "status" }, note));
}
