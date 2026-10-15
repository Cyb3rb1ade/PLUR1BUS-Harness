// Requested rights of an extension, as ext.show / ext.inspect return them in `capabilities`.
// Shown before any confirmation (D109 order). Only what the result contains is listed; hostBridge and mcpApps get their own highlighted row.
import { h } from "preact";
import type { View } from "../../view.ts";
import { Badge, type BadgeTone } from "../../components/card.ts";
import { t, type Key } from "../../i18n.ts";

export type RightRisk = "low" | "medium" | "high";
export type RightRow = { id: string; label: Key; value: string; risk: RightRisk; highlight: boolean; explain?: Key };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Rows for a capabilities object; unknown keys are kept as raw rows so nothing requested stays hidden. */
export function rightRows(caps: unknown): RightRow[] {
  if (!isObj(caps)) return [];
  const rows: RightRow[] = [];
  const known = new Set(["network", "filesystem", "processes", "secrets", "hostBridge", "harness", "tools", "mcpApps"]);

  if ("network" in caps) {
    const n = caps.network;
    const mode = typeof n === "string" ? n : isObj(n) && typeof n.mode === "string" ? n.mode : "";
    const hosts = isObj(n) ? strs(n.hosts) : [];
    if (mode === "none") rows.push({ id: "network", label: "extensions.rights.network", value: t("extensions.rights.network.none"), risk: "low", highlight: false });
    else if (mode === "any") rows.push({ id: "network", label: "extensions.rights.network", value: t("extensions.rights.network.any"), risk: "high", highlight: false });
    else rows.push({ id: "network", label: "extensions.rights.network", value: hosts.length ? hosts.join(", ") : JSON.stringify(n), risk: "medium", highlight: false });
  }
  if ("filesystem" in caps && Array.isArray(caps.filesystem)) {
    for (const f of caps.filesystem) {
      if (typeof f === "string") rows.push({ id: `fs:${f}`, label: "extensions.rights.filesystem", value: f, risk: "medium", highlight: false });
      else if (isObj(f)) {
        const scope = String(f.scope ?? "");
        const where = typeof f.path === "string" ? `${scope}: ${f.path}` : scope;
        const access = String(f.access ?? "");
        rows.push({ id: `fs:${where}:${access}`, label: "extensions.rights.filesystem", value: `${where} (${access})`, risk: access === "read-write" || scope === "home" || scope === "path" ? "high" : "medium", highlight: false });
      }
    }
  }
  if (isObj(caps.processes)) {
    const cmds = strs(caps.processes.commands);
    if (caps.processes.spawn === true || cmds.length) {
      rows.push({ id: "processes", label: "extensions.rights.processes", value: cmds.length ? cmds.join(", ") : t("extensions.rights.processes.spawn"), risk: "high", highlight: false });
    }
  }
  if (Array.isArray(caps.secrets)) {
    for (const s of caps.secrets) {
      if (!isObj(s) || typeof s.slot !== "string") continue;
      rows.push({ id: `secret:${s.slot}`, label: "extensions.rights.secrets", value: s.required === true ? `${s.slot} (${t("extensions.rights.required")})` : s.slot, risk: "medium", highlight: false });
    }
  }
  if (isObj(caps.harness) && typeof caps.harness.authority === "string" && caps.harness.authority !== "none") {
    const rpc = strs(caps.harness.rpc);
    rows.push({ id: "harness", label: "extensions.rights.harness", value: rpc.length ? `${caps.harness.authority}: ${rpc.join(", ")}` : caps.harness.authority, risk: caps.harness.authority === "full" ? "high" : "medium", highlight: false });
  }
  if (Array.isArray(caps.tools)) {
    for (const x of caps.tools) {
      if (!isObj(x) || typeof x.name !== "string") continue;
      const effect = String(x.effect ?? "");
      rows.push({ id: `tool:${x.name}`, label: "extensions.rights.tools", value: `${x.name} (${effect})`, risk: effect === "destructive" ? "high" : effect === "write" ? "medium" : "low", highlight: false });
    }
  }
  if (Array.isArray(caps.hostBridge) && caps.hostBridge.length) {
    rows.push({ id: "hostBridge", label: "extensions.rights.hostBridge", value: strs(caps.hostBridge).join(", "), risk: "high", highlight: true, explain: "extensions.rights.hostBridge.explain" });
  }
  if (caps.mcpApps === true) {
    rows.push({ id: "mcpApps", label: "extensions.rights.mcpApps", value: t("extensions.rights.mcpApps.value"), risk: "medium", highlight: true, explain: "extensions.rights.mcpApps.explain" });
  }
  for (const [k, v] of Object.entries(caps)) {
    if (!known.has(k)) rows.push({ id: `other:${k}`, label: "extensions.rights.other", value: `${k}: ${JSON.stringify(v)}`, risk: "medium", highlight: false });
  }
  return rows;
}

const riskTone = (r: RightRisk): BadgeTone => (r === "high" ? "err" : r === "medium" ? "warn" : "neutral");

/** The list itself. `data-right` carries the row id for tests; hostBridge / mcpApps rows are highlighted with a risk note. */
export function RightsList({ caps }: { caps: unknown }): View {
  const rows = rightRows(caps);
  if (!rows.length) return h("p", { class: "reading", "data-rights": "empty" }, t("extensions.rights.none"));
  return h(
    "ul",
    { class: "rights-list", "data-rights": "list" },
    rows.map((r) =>
      h(
        "li",
        { key: r.id, class: r.highlight ? "right-row right-row-risk" : "right-row", "data-right": r.id },
        h("span", { class: "right-label" }, t(r.label)),
        h("span", { class: "right-value" }, r.value),
        h(Badge, { tone: riskTone(r.risk) }, t(`extensions.rights.risk.${r.risk}` as Key)),
        r.explain ? h("p", { class: "right-explain" }, t(r.explain)) : null,
      ),
    ),
  );
}
