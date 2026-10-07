// Rights per agent for Member and Operator: the agent list comes from `config.get agents`. Used by the section (simple mode off)
// and by the invite dialog. A draft only: there is no RPC that stores rights.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { PageLoading } from "../../../components/page-state.ts";
import { t } from "../../../i18n.ts";
import { getApi, useLoad } from "../../common/load.ts";
import { FailureState } from "../../common/states.ts";
import { agentIds, toggleRight, type Rights } from "./model.ts";

async function loadAgents(signal: AbortSignal): Promise<string[]> {
  const r = await getApi().rpc("config.get", { key: "agents" }, { write: false, signal });
  return agentIds(r.value);
}

export function RightsMatrix({ role, rights, onChange, idPrefix }: { role: "member" | "operator"; rights: Rights; onChange: (r: Rights) => void; idPrefix: string }): View {
  const { state, reload } = useLoad(loadAgents, []);
  if (state.status === "loading") return h(PageLoading, { label: t("users.rights.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, onRetry: reload });
  const agents = state.data;
  const operator = role === "operator";
  return h("div", { class: "users-rights" },
    h("p", { class: "field-hint" }, t(operator ? "users.rights.operator" : "users.rights.member")),
    agents.length === 0 ? h("p", { class: "users-empty" }, t("users.rights.none")) : h("div", { class: "users-matrix-wrap" },
      h("table", { class: "users-matrix" },
        h("caption", { class: "sr-only" }, t("users.rights.title")),
        h("thead", null, h("tr", null,
          h("th", { scope: "col" }, t("users.rights.agent")),
          h("th", { scope: "col" }, t("users.rights.use")),
          operator ? null : h("th", { scope: "col" }, t("users.rights.manage")))),
        h("tbody", null, agents.map((a, i) => h("tr", { key: a },
          h("th", { scope: "row" }, a),
          h("td", null, h("input", { type: "checkbox", id: `${idPrefix}-use-${i}`, checked: rights[a] !== undefined, "aria-label": t("users.rights.cell", { right: t("users.rights.use"), agent: a }), onChange: (e: Event) => { onChange(toggleRight(rights, a, "use", (e.target as HTMLInputElement).checked)); } })),
          operator ? null : h("td", null, h("input", { type: "checkbox", id: `${idPrefix}-manage-${i}`, checked: rights[a] === "manage", "aria-label": t("users.rights.cell", { right: t("users.rights.manage"), agent: a }), onChange: (e: Event) => { onChange(toggleRight(rights, a, "manage", (e.target as HTMLInputElement).checked)); } }))))))),
    h("p", { class: "field-hint" }, t("users.rights.byRole")),
    h("p", { class: "form-notice", role: "note" }, t("users.rights.draft")));
}

/** The rights editor of the section: pick the role it is for, then the matrix. */
export function RightsPanel(): View {
  const [role, setRole] = useState<"member" | "operator">("member");
  const [rights, setRights] = useState<Rights>({});
  return h("section", { class: "card users-block", "aria-labelledby": "users-rights-h" },
    h("h2", { id: "users-rights-h", class: "card-title" }, t("users.rights.title")),
    h("p", { class: "field-hint" }, t("users.rights.lead")),
    h("div", { class: "field" },
      h("label", { for: "users-rights-role" }, t("users.rights.role")),
      h("select", { id: "users-rights-role", value: role, onChange: (e: Event) => { setRole((e.target as HTMLSelectElement).value as "member" | "operator"); setRights({}); } },
        (["member", "operator"] as const).map((r) => h("option", { key: r, value: r, selected: r === role }, t(`users.preset.${r}.name`)))))
    , h(RightsMatrix, { role, rights, onChange: setRights, idPrefix: "users-rights" }));
}
