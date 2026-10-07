// The virtual log list: a grid of fixed-height rows where only the visible window (plus the active row) is in the DOM. The grid
// element itself scrolls and takes focus; the active row is exposed with aria-activedescendant, so a screen reader follows the
// arrow keys without every row being focusable. Not a live region: new lines are announced by the viewer's own status region.
import { h } from "preact";
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { icon } from "../../../icons.ts";
import { t } from "../../../i18n.ts";
import { hasRedaction, messageOf, type LogRecord } from "./model.ts";
import type { Row } from "./use-log.ts";

const OVERSCAN = 6;
const fmtTime = (ts: string): string => (ts.length >= 23 ? `${ts.slice(5, 10)} ${ts.slice(11, 23)}` : ts);

function LevelBadge({ rec }: { rec: LogRecord }): View {
  return rec.level === null ? h("span", { class: "logs-level", "data-level": "none" }, "–") : h("span", { class: "logs-level", "data-level": rec.level }, t(`logs.level.${rec.level}`));
}

export type LogListProps = { rows: readonly Row[]; hasMore: boolean; onOpen: (row: Row) => void };

export function LogList({ rows, hasMore, onOpen }: LogListProps): View {
  const el = useRef<HTMLDivElement>(null);
  const headEl = useRef<HTMLDivElement>(null);
  const descId = useId();
  const [view, setView] = useState({ top: 0, height: 480, rowH: 36, headH: 32 });
  const [activeId, setActiveId] = useState<number | null>(null);
  const prevFirst = useRef<number | null>(null);

  const measure = (): void => {
    const g = el.current;
    if (!g) return;
    const rowH = parseFloat(getComputedStyle(g).getPropertyValue("--logs-row-h")) || 36;
    setView({ top: g.scrollTop, height: g.clientHeight, rowH, headH: headEl.current?.offsetHeight ?? 32 });
  };
  useLayoutEffect(() => {
    measure();
    const g = el.current;
    if (!g || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(g);
    return () => { ro.disconnect(); };
  }, []);

  // Lines prepended by the tail must not move what the reader is looking at: shift the scroll position by their height.
  useLayoutEffect(() => {
    const g = el.current, first = rows[0]?.id ?? null;
    if (g && prevFirst.current !== null && first !== null && first !== prevFirst.current && g.scrollTop > 0) {
      const k = rows.findIndex((r) => r.id === prevFirst.current);
      if (k > 0) { g.scrollTop += k * view.rowH; measure(); }
    }
    prevFirst.current = first;
    if (activeId !== null && !rows.some((r) => r.id === activeId)) setActiveId(null);
  }, [rows]);

  const { top, height, rowH, headH } = view;
  const activeIndex = activeId === null ? -1 : rows.findIndex((r) => r.id === activeId);
  const first = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
  const last = Math.min(rows.length - 1, Math.ceil((top + height - headH) / rowH) + OVERSCAN);
  const activeShown = activeIndex >= first && activeIndex <= last;

  const reveal = (i: number): void => {
    const g = el.current;
    if (!g) return;
    const y = i * rowH;
    if (y < g.scrollTop) g.scrollTop = y;
    else if (y + rowH > g.scrollTop + g.clientHeight - headH) g.scrollTop = y + rowH - g.clientHeight + headH;
    measure();
  };
  const move = (i: number): void => {
    if (rows.length === 0) return;
    const k = Math.max(0, Math.min(rows.length - 1, i));
    setActiveId(rows[k]!.id);
    reveal(k);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = activeIndex < 0 ? 0 : activeIndex;
    const page = Math.max(1, Math.floor((el.current?.clientHeight ?? height) / rowH) - 2);
    switch (e.key) {
      case "ArrowDown": move(activeIndex < 0 ? 0 : at + 1); break;
      case "ArrowUp": move(at - 1); break;
      case "PageDown": move(at + page); break;
      case "PageUp": move(at - page); break;
      case "Home": move(0); break;
      case "End": move(rows.length - 1); break;
      case "Enter": case " ": { const r = rows[at]; if (r) onOpen(r); break; }
      default: return;
    }
    e.preventDefault();
  };

  return h("div", { class: "logs-list" },
    h("p", { id: descId, class: "sr-only" }, t("logs.list.help")),
    h("div", {
    ref: el, class: "logs-viewport", role: "grid", tabIndex: 0, "aria-label": t("logs.list"), "aria-describedby": descId,
    "aria-rowcount": hasMore ? -1 : rows.length + 1, "aria-colcount": 4,
    ...(activeShown ? { "aria-activedescendant": `logs-row-${rows[activeIndex]!.id}` } : {}),
    onScroll: measure, onKeyDown,
    onFocus: () => { if (activeId === null && rows.length > 0) setActiveId(rows[0]!.id); },
  },
    h("div", { ref: headEl, class: "logs-row logs-head", role: "row", "aria-rowindex": 1 },
      (["time", "level", "component", "message"] as const).map((c) => h("div", { key: c, role: "columnheader", class: `c-${c}` }, t(`logs.col.${c}`)))),
    h("div", { role: "rowgroup", class: "logs-body" },
      h(Spacer, { rows: Math.max(0, first), rowH }),
      Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => {
        const i = first + k, row = rows[i]!, rec = row.rec;
        return h("div", {
          key: row.id, id: `logs-row-${row.id}`, class: row.id === activeId ? "logs-row is-active" : "logs-row", role: "row", "data-row": "", "data-level": rec.level ?? "none",
          "aria-rowindex": i + 2,
          onClick: () => { setActiveId(row.id); onOpen(row); },
        },
          h("div", { role: "gridcell", class: "c-time" }, fmtTime(rec.ts)),
          h("div", { role: "gridcell", class: "c-level" }, h(LevelBadge, { rec })),
          h("div", { role: "gridcell", class: "c-component" }, rec.component),
          h("div", { role: "gridcell", class: "c-message" },
            h("span", { class: "logs-msg" }, messageOf(rec)),
            hasRedaction(rec) ? h("span", { class: "logs-redacted-tag" }, icon("lock", 12), h("span", {}, t("logs.redacted"))) : null));
      }),
      h(Spacer, { rows: Math.max(0, rows.length - 1 - last), rowH }))));
}

/** Empty space for the rows outside the window. Sized with the width/height attributes of an SVG: the page's CSP has no inline
 *  styles and a row count is not a class. */
function Spacer({ rows, rowH }: { rows: number; rowH: number }): View | null {
  return rows === 0 ? null : h("svg", { class: "logs-spacer", width: 1, height: rows * rowH, "aria-hidden": "true", focusable: "false" });
}
