// Search with explanation. memory.recall has no "explain" switch (docs/rpc.md): every answer carries `trace`, `timing`,
// `deferrals` and `degraded`, and that is what the "Why these results" block shows, with a plain note saying so.
import { h } from "preact";
import { useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { PageState } from "../../components/page-state.ts";
import { formatNumber, t } from "../../i18n.ts";
import { Facts, FailureState, Panel, S, duration } from "./common.ts";
import { caller, getApi, useLoad } from "./data.ts";
import type { RecallResult } from "./rpc-types.ts";

function Explanation({ r }: { r: RecallResult }): View {
  const phases = r.timing.phases && typeof r.timing.phases === "object" ? Object.entries(r.timing.phases) : [];
  return h("details", {},
    h("summary", { style: { minHeight: "var(--control-h)", display: "flex", alignItems: "center", cursor: "pointer", fontWeight: "600" } }, t("memory.search.why")),
    h("div", { style: S.stack },
      h("p", { style: S.muted }, t("memory.search.whyNote")),
      h(Facts, { rows: [
        [t("memory.search.time"), duration(r.timing.totalMs)],
        ...phases.map(([k, v]) => [`${t("memory.search.phase")} ${k}`, typeof v === "number" ? duration(v) : JSON.stringify(v)] as const),
        [t("memory.search.cap"), r.capChars === null ? t("memory.search.uncapped") : `${formatNumber(r.capChars)} ${t("memory.search.chars")}`],
      ] }),
      r.deferrals.length > 0
        ? h("div", {}, h("h3", { style: { margin: "0 0 4px", fontSize: "14px" } }, t("memory.search.deferrals")),
          h("ul", { style: { margin: "0", paddingLeft: "20px" } }, r.deferrals.map((d, i) => h("li", { key: i }, t("memory.search.deferral", { block: d.block, kind: d.kind, from: d.from, to: d.to, reason: d.reason })))))
        : h("p", { style: S.muted }, t("memory.search.noDeferrals")),
      r.trace === undefined
        ? h("p", { style: S.muted }, t("memory.search.noTrace"))
        : h("div", {}, h("h3", { style: { margin: "0 0 4px", fontSize: "14px" } }, t("memory.search.trace")),
          h("pre", { style: S.pre, tabIndex: 0, "aria-label": t("memory.search.trace") }, JSON.stringify(r.trace, null, 2)))));
}

function Results({ agentId, query, run }: { agentId: string; query: string; run: number }): View {
  const { state, reload } = useLoad((signal) => getApi().rpc("memory.recall", { caller: caller(), agentId, query, joined: false }, { write: false, signal }), [agentId, query, run]);
  if (state.status === "loading") return h(PageState, { state: "loading", title: t("memory.search.running") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, unavailable: t("memory.search.unavailable"), onRetry: reload });
  const r = state.data;
  const blocks = r.blocks.filter((b) => b.text.trim() !== "");
  if (blocks.length === 0) {
    return h("div", { style: S.stack }, h(PageState, { state: "empty", title: t("memory.search.none"), detail: t("memory.search.noneDetail") }), h(Explanation, { r }));
  }
  return h("div", { style: S.stack },
    r.degraded ? h("p", {}, h(Badge, { tone: "warn" }, t("memory.list.degraded", { reason: r.degraded.reason }))) : null,
    blocks.map((b) => h("div", { key: b.name },
      h("h3", { style: { margin: "0 0 4px", fontSize: "14px" } }, b.name, " ", h(Badge, {}, t("memory.search.blockChars", { n: b.chars }))),
      h("p", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, b.text))),
    h(Explanation, { r }));
}

export function Search({ agentId }: { agentId: string }): View {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sent, setSent] = useState<{ query: string; run: number } | null>(null);
  const submit = (e: Event): void => {
    e.preventDefault();
    const query = q.trim();
    if (query === "") { input.current?.focus(); return; }
    setSent((s) => ({ query, run: (s?.run ?? 0) + 1 }));
  };
  return h(Panel, { title: t("memory.search.title") },
    h("div", { style: S.stack },
      h("form", { role: "search", onSubmit: submit },
        h("div", { class: "field" },
          h("label", { for: "memory-search" }, t("memory.search.label")),
          h("input", { id: "memory-search", ref: input, type: "search", value: q, autocomplete: "off", onInput: (e: Event) => setQ((e.target as HTMLInputElement).value) })),
        h("button", { type: "submit", class: "btn btn-primary" }, t("memory.search.go"))),
      sent ? h("section", { "aria-label": t("memory.search.results"), key: "res" }, h(Results, { agentId, query: sent.query, run: sent.run })) : null));
}
