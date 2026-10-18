// "No decision model set" hint. Without `modelRoles.decision` the built-in rule triage runs (a normal mode, nothing is broken),
// but the features that build on a decision model are limited. One component for the setup wizard (model step and summary) and
// the Models & providers settings section, so both name the same features. The CLI (`plur1bus setup`) and the `models.decision`
// check of `1staid check` carry the same three (crates/plur1bus/src/commands/model.rs).
import { h } from "preact";
import type { View } from "../../view.ts";
import { getApi } from "../../api/shared.ts";
import { t, type Key } from "../../i18n.ts";
import { useLoad } from "./load.ts";

/** The limited features, in the order they are listed. Keys are camelCase segments (test/i18n.test.ts). */
export const DECISION_FEATURES = [
  { id: "triage", text: "shared.decisionHint.triage" },
  { id: "tools", text: "shared.decisionHint.tools" },
  { id: "classes", text: "shared.decisionHint.classes" },
] as const satisfies readonly { id: string; text: Key }[];

/** Where the hint stands: the wizard names the Settings route and the command, the settings section only the command. */
export type DecisionHintWhere = "wizard" | "settings";

/** `true` unless `modelRoles.decision` is a non-empty string. `config` is the whole configuration (`config.get` without a key). */
export function decisionRoleMissing(config: unknown): boolean {
  const roles = typeof config === "object" && config !== null ? (config as { modelRoles?: unknown }).modelRoles : undefined;
  const role = typeof roles === "object" && roles !== null ? (roles as { decision?: unknown }).decision : undefined;
  return !(typeof role === "string" && role.trim() !== "");
}

/** The notice itself (no data access): what is limited without a decision model and how to set the role later. */
export function DecisionHint({ where }: { where: DecisionHintWhere }): View {
  return h("div", { class: "form-notice decision-hint", "data-tone": "info", role: "note", "data-decision-hint": where },
    h("p", {}, h("strong", {}, t("shared.decisionHint.title"))),
    h("p", {}, t("shared.decisionHint.lead")),
    h("ul", {}, DECISION_FEATURES.map((f) => h("li", { key: f.id }, t(f.text)))),
    h("p", {}, t(where === "wizard" ? "shared.decisionHint.how" : "shared.decisionHint.howHere")));
}

/** The hint for a page that has not loaded the configuration: reads `modelRoles.decision` once. It shows nothing while loading and
 * whenever the role is set; a failed read (unavailable, forbidden) still shows it, because setup never sets the role. */
export function DecisionHintIfMissing({ where }: { where: DecisionHintWhere }): View | null {
  const { state } = useLoad(async (signal) => {
    const res = await getApi().rpc("config.get", { key: "modelRoles.decision" }, { write: false, signal }) as { value?: unknown } | null;
    return typeof res?.value === "string" && res.value.trim() !== "";
  }, []);
  if (state.status === "loading") return null;
  if (state.status === "ok" && state.data) return null;
  return h(DecisionHint, { where });
}
