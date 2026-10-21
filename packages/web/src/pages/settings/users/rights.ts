// Rights per agent for Member and Operator: the agent list comes from `config.get agents`.
// Wired to agent.rights.get and agent.rights.set: rights belong to one person and one agent, the panel loads what the person holds and
// sends only what changed (a right taken away goes as null).
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { PageLoading } from "../../../components/page-state.ts";
import { t } from "../../../i18n.ts";
import { getApi, useLoad } from "../../common/load.ts";
import { FailureState } from "../../common/states.ts";
import { agentIds, fetchUsers, getAgentRights, setAgentRight, toggleRight, type Rights, type Row } from "./model.ts";

async function loadAgents(signal: AbortSignal): Promise<string[]> {
  const r = await getApi().rpc("config.get", { key: "agents" }, { write: false, signal });
  return agentIds(r.value);
}

type MatrixProps = { role: "member" | "operator"; rights: Rights; onChange: (r: Rights) => void; idPrefix: string; draft?: boolean };

export function RightsMatrix(props: MatrixProps): View {
  const { state, reload } = useLoad(loadAgents, []);
  if (state.status === "loading") return h(PageLoading, { label: t("users.rights.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, onRetry: reload });
  return h(RightsTable, { ...props, agents: state.data });
}

function RightsTable({ role, rights, onChange, idPrefix, agents, draft = true }: MatrixProps & { agents: string[] }): View {
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
    draft ? h("p", { class: "form-notice", role: "note" }, t("users.rights.draft")) : null);
}

type Held = Rights;

async function loadHeld(userId: string, agents: string[], signal: AbortSignal): Promise<Held> {
  const held: Held = {};
  for (const agent of agents) {
    if (signal.aborted) break;
    const res = await getAgentRights(agent);
    const list = (res as { rights?: unknown }).rights;
    for (const r of Array.isArray(list) ? list : []) {
      const o = r as { userId?: unknown; right?: unknown };
      if (o.userId === userId && (o.right === "use" || o.right === "manage")) held[agent] = o.right;
    }
  }
  return held;
}

/** Owner and Admin hold Manage on every agent through the role; their rights are not edited here. */
const editable = (r: Row): boolean => r.role !== "owner" && r.role !== "admin";

/** What a load found, tagged with the person and agent list it was loaded for: the loader keeps the previous answer on screen for one
 *  draw after its inputs change, and that answer must never be shown for the new person (or for an agent list it does not cover). */
type HeldFor = { key: string; rights: Held };

/** The matrix of one person with a save button. It starts from the rights that were loaded (its initial state, not an effect that copies
 *  them in later), so the first draw already shows what the person holds; the panel mounts it anew for every person and every load. */
function RightsEditor({ person, agents, initial }: { person: Row; agents: string[]; initial: Held }): View {
  const [rights, setRights] = useState<Rights>(initial);
  const [base, setBase] = useState<Held>(initial);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(null);
    try {
      for (const agent of new Set([...Object.keys(base), ...Object.keys(rights)])) {
        if (base[agent] !== rights[agent]) await setAgentRight(agent, person.id, rights[agent] ?? null);
      }
      setBase(rights);
      setSaved({ ok: true, text: t("users.rights.saved") });
    } catch {
      setSaved({ ok: false, text: t("users.rights.failed") });
    } finally {
      setSaving(false);
    }
  };

  return h("div", null,
    h(RightsTable, { role: person.role === "operator" ? "operator" : "member", rights, agents, draft: false, idPrefix: "users-rights", onChange: (r) => { setRights(r); setSaved(null); } }),
    h("div", { class: "users-rights-actions" },
      h("button", { type: "button", class: "btn btn-primary", disabled: saving, onClick: () => { void save(); } }, saving ? t("shared.confirm.working") : t("users.rights.save")),
      saved ? h("p", { class: "form-notice", role: saved.ok ? "status" : "alert" }, saved.text) : null));
}

/** The rights editor of the section: pick the person, then the matrix with what they hold now. */
export function RightsPanel({ self }: { self: { id: string; role: string } }): View {
  const people = useLoad((signal) => fetchUsers(self, signal), [self.id, self.role]);
  const agents = useLoad(loadAgents, []);
  const [picked, setPicked] = useState<string | null>(null);

  const list = people.state.status === "ok" ? people.state.data.filter(editable) : [];
  const person = list.find((p) => p.id === picked) ?? list[0];
  const agentList = agents.state.status === "ok" ? agents.state.data : [];
  const key = `${person?.id ?? ""}\n${agentList.join("\n")}`;
  const held = useLoad(async (signal): Promise<HeldFor> => ({ key, rights: person && agentList.length ? await loadHeld(person.id, agentList, signal) : {} }), [key]);
  const current = held.state.status === "ok" && held.state.data.key === key ? held.state.data : null;

  let body: View;
  if (people.state.status === "loading" || agents.state.status === "loading") body = h(PageLoading, { label: t("users.rights.loading") });
  else if (people.state.status === "fail") body = h(FailureState, { failure: people.state.failure, onRetry: people.reload });
  else if (agents.state.status === "fail") body = h(FailureState, { failure: agents.state.failure, onRetry: agents.reload });
  else if (!person) body = h("p", { class: "users-empty" }, t("users.rights.noPeople"));
  else if (agentList.length === 0) body = h("p", { class: "users-empty" }, t("users.rights.none"));
  else if (held.state.status === "fail") body = h(FailureState, { failure: held.state.failure, onRetry: held.reload });
  else if (!current) body = h(PageLoading, { label: t("users.rights.loadingHeld") });
  else body = h(RightsEditor, { key: current.key, person, agents: agentList, initial: current.rights });

  return h("section", { class: "card users-block", "aria-labelledby": "users-rights-h" },
    h("h2", { id: "users-rights-h", class: "card-title" }, t("users.rights.title")),
    h("p", { class: "field-hint" }, t("users.rights.lead")),
    list.length ? h("div", { class: "field" },
      h("label", { for: "users-rights-person" }, t("users.rights.person")),
      h("select", { id: "users-rights-person", value: person?.id ?? "", onChange: (e: Event) => { setPicked((e.target as HTMLSelectElement).value); } },
        list.map((p) => h("option", { key: p.id, value: p.id, selected: p.id === person?.id }, p.name)))) : null,
    body);
}
