// Log viewer (K8, tab "Logs" of /logs): logs.query with filters and cursor paging, live tail over logs.tail (long poll) with
// Pause/Resume, a virtual list, a detail dialog and export of the loaded view. Everything is read-only; the server redacts, the
// viewer only marks what it was sent. States: loading, empty, error, forbidden (role or E_DENIED), unavailable (no RPC).
import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { PageState } from "../../components/page-state.ts";
import { icon } from "../../icons.ts";
import { formatNumber, t, type Key } from "../../i18n.ts";
import { query } from "../../router.ts";
import { currentRole, roleIn } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { createAnnouncer, type Announcer } from "./viewer/announce.ts";
import { DetailDialog } from "./viewer/detail.ts";
import { FilterBar } from "./viewer/filters.ts";
import { LogList } from "./viewer/list.ts";
import { buildQuery, DEFAULT_FILTERS, exportName, isDefaultFilters, toJson, toNdjson, type BuildError, type Filters } from "./viewer/model.ts";
import { useLogData, type Row } from "./viewer/use-log.ts";

const plural = (n: number, one: Key, other: Key): string => (n === 1 ? t(one) : t(other, { n: formatNumber(n) }));

function download(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 30_000);
}

function Viewer(): View {
  const initial = useMemo<Filters>(() => ({
    ...DEFAULT_FILTERS, trace: query.value.get("trace") ?? "", text: query.value.get("q") ?? "",
    stream: query.value.get("stream") === "audit" ? "audit" : "diagnostic",
  }), []);
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  const [reload, setReload] = useState(0);
  const [paused, setPaused] = useState(false);
  const [formError, setFormError] = useState<BuildError | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  const [exported, setExported] = useState("");
  const [announced, setAnnounced] = useState("");
  const announcer = useRef<Announcer | null>(null);
  const data = useLogData(applied, reload, paused);

  useEffect(() => { announcer.current = createAnnouncer(setAnnounced); return () => { announcer.current?.stop(); }; }, []);

  const apply = (next: Filters): void => {
    const b = buildQuery(next, Date.now());
    if (!b.ok) { setFormError(b.error); return; }
    setFormError(null);
    setExported("");
    setApplied({ ...next });
  };

  // Status text for the polite live region (rate limited): tail state, and the paused counter.
  const tailText = data.tail === "retrying" ? t("logs.tail.retrying")
    : data.tail === "unavailable" ? t("logs.tail.unavailable")
    : data.tail === "forbidden" ? t("logs.tail.forbidden")
    : data.tail === "off" ? t("logs.tail.off")
    : paused ? t("logs.tail.paused") : t("logs.tail.live");
  const newText = data.buffered > 0 ? plural(data.buffered, "logs.tail.new.one", "logs.tail.new.other") : "";
  const droppedText = data.dropped > 0 ? t("logs.tail.dropped", { n: formatNumber(data.dropped) }) : "";
  const speak = paused && data.buffered > 0 ? `${newText}${droppedText ? ` ${droppedText}` : ""}` : data.tail === "starting" ? "" : data.tail === "off" ? "" : tailText;
  useEffect(() => { if (speak !== "") announcer.current?.say(speak); }, [speak]);

  const tailOn = data.tail === "live" || data.tail === "retrying" || data.tail === "starting";
  const { phase } = data;
  const nothing = phase.kind === "ready" && data.rows.length === 0;
  const exportAs = (kind: "ndjson" | "json"): void => {
    const recs = data.rows.map((r) => r.rec);
    download(exportName(Date.now(), kind), kind === "ndjson" ? "application/x-ndjson" : "application/json", kind === "ndjson" ? toNdjson(recs) : toJson(recs));
    setExported(t("logs.export.done", { n: formatNumber(recs.length) }));
  };

  let body: View;
  if (phase.kind === "loading") body = h(PageState, { state: "loading" });
  else if (phase.kind === "fail") body = h(FailureState, { failure: phase.failure, unavailable: t("logs.unavailable.title"), onRetry: () => { setReload((n) => n + 1); } });
  else if (nothing) {
    const plain = isDefaultFilters(applied);
    body = h(PageState, { state: "empty", title: plain ? t("state.empty.title") : t("logs.empty.title"), detail: plain ? t("logs.empty.none") : t("logs.empty.body") },
      plain ? null : h("button", { type: "button", class: "btn", onClick: () => { setDraft(DEFAULT_FILTERS); setFormError(null); setApplied({ ...DEFAULT_FILTERS }); } }, t("logs.f.clear")));
  } else {
    const newer = applied.order === "asc";
    body = h("div", { class: "logs-results" },
      h(LogList, { rows: data.rows, hasMore: data.hasMore && !data.trimmed, onOpen: setOpen }),
      data.trimmed ? h("p", { class: "notice", "data-tone": "warn" }, t("logs.trimmed")) : null,
      data.corrupt > 0 ? h("p", { class: "notice" }, t("logs.corrupt", { n: formatNumber(data.corrupt) })) : null,
      data.truncated && data.hasMore ? h("p", { class: "notice" }, t("logs.truncated")) : null,
      data.more === "error" ? h("p", { class: "form-error", role: "alert" }, t("logs.more.error")) : null,
      data.hasMore && !data.trimmed
        ? h("div", { class: "logs-more" }, h("button", { type: "button", class: "btn", disabled: data.more === "loading", "aria-busy": data.more === "loading", onClick: data.loadMore },
          data.more === "loading" ? t("logs.more.loading") : t(newer ? "logs.more.newer" : "logs.more.older")))
        : h("p", { class: "logs-end" }, t("logs.end")));
  }

  return h("section", { class: "logs-viewer" },
    h(FilterBar, { draft, error: formError, onChange: (p) => { setDraft((d) => ({ ...d, ...p })); }, onApply: () => { apply(draft); }, onClear: () => { setDraft(DEFAULT_FILTERS); setFormError(null); setApplied({ ...DEFAULT_FILTERS }); } }),
    h("div", { class: "logs-toolbar", role: "group", "aria-label": t("logs.tail.statusLabel") },
      h("button", { type: "button", class: "btn", "aria-pressed": paused, disabled: !tailOn, onClick: () => { setPaused((p) => !p); } }, icon(paused ? "back" : "recurring", 16), t("logs.tail.pause")),
      h("span", { class: "logs-tail-state", "data-state": data.tail === "live" && paused ? "paused" : data.tail }, tailText),
      data.buffered > 0 ? h("span", { class: "logs-new" }, newText, droppedText ? ` ${droppedText}` : "") : null,
      phase.kind === "ready" ? h("span", { class: "logs-count" }, plural(data.rows.length, "logs.count.one", "logs.count.other")) : null,
      h("span", { class: "logs-toolbar-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onClick: () => { setReload((n) => n + 1); } }, t("logs.reload")),
        h("button", { type: "button", class: "btn btn-quiet", "aria-describedby": "logs-export-note", disabled: data.rows.length === 0, onClick: () => { exportAs("ndjson"); } }, t("logs.export.ndjson")),
        h("button", { type: "button", class: "btn btn-quiet", "aria-describedby": "logs-export-note", disabled: data.rows.length === 0, onClick: () => { exportAs("json"); } }, t("logs.export.json")))),
    h("p", { id: "logs-export-note", class: "field-hint" }, t("logs.export.note")),
    h("p", { class: "logs-exported", role: "status" }, exported),
    h("p", { class: "logs-announce sr-only", "aria-live": "polite", "aria-atomic": "true" }, announced),
    body,
    open ? h(DetailDialog, { rec: open.rec, onClose: () => { setOpen(null); } }) : null);
}

/** The Logs tab. A role that docs/rbac.md does not allow `logs.query` sees the forbidden state without any call. */
export function LogViewer(): View {
  if (!roleIn(currentRole(), ["owner", "admin"])) return h(PageState, { state: "forbidden" });
  return h(Viewer, {});
}
