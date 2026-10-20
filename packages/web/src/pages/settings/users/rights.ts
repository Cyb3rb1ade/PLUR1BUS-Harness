// Rights per agent for Member and Operator: the agent list comes from `config.get agents`.
// Wired to agent.rights.get and agent.rights.set: rights belong to one person and one agent, the panel loads what the person holds and
// sends only what changed (a right taken away goes as null).
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
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

/** The rights editor of the section: pick the person, then the matrix with what they hold now. */
export function RightsPanel({ self }: { self: { id: string; role: string } }): View {
  const people = useLoad((signal) => fetchUsers(self, signal), [self.id, self.role]);
  const agents = useLoad(loadAgents, []);
  const [picked, setPicked] = useState<string | null>(null);
  const [rights, setRights] = useState<Rights>({});
  const [base, setBase] = useState<Held>({});
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const list = people.state.status === "ok" ? people.state.data.filter(editable) : [];
  const person = list.find((p) => p.id === picked) ?? list[0];
  const agentList = agents.state.status === "ok" ? agents.state.data : [];
  const held = useLoad((signal) => (person && agentList.length ? loadHeld(person.id, agentList, signal) : Promise.resolve({} as Held)), [person?.id ?? "", agentList.join("\n")]);
  // The editable copy is taken from what was loaded in an effect, i.e. after the render that first shows the loaded data. The matrix
  // is drawn only once that copy belongs to the answer for this person and this list of agents, so no frame shows empty (or the
  // previous person's) boxes that a click or a test would then act on before they are replaced.
  const heldKey = `${person?.id ?? ""}\n${agentList.join("\n")}`;
  const [synced, setSynced] = useState<{ key: string; data: Held } | null>(null);
  useEffect(() => { if (held.state.status === "ok") { setBase(held.state.data); setRights(held.state.data); setSynced({ key: heldKey, data: held.state.data }); } }, [held.state]);
  const ready = held.state.status === "ok" && synced !== null && synced.data === held.state.data && synced.key === heldKey;

  const save = async (): Promise<void> => {
    if (!person) return;
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

  let body: View;
  if (people.state.status === "loading" || agents.state.status === "loading") body = h(PageLoading, { label: t("users.rights.loading") });
  else if (people.state.status === "fail") body = h(FailureState, { failure: people.state.failure, onRetry: people.reload });
  else if (agents.state.status === "fail") body = h(FailureState, { failure: agents.state.failure, onRetry: agents.reload });
  else if (!person) body = h("p", { class: "users-empty" }, t("users.rights.noPeople"));
  else if (agentList.length === 0) body = h("p", { class: "users-empty" }, t("users.rights.none"));
  else if (held.state.status === "fail") body = h(FailureState, { failure: held.state.failure, onRetry: held.reload });
  else if (!ready) body = h(PageLoading, { label: t("users.rights.loadingHeld") });
  else {
    const role = person.role === "operator" ? "operator" : "member";
    body = h("div", null,
      h(RightsTable, { role, rights, agents: agentList, draft: false, idPrefix: "users-rights", onChange: (r) => { setRights(r); setSaved(null); } }),
      h("div", { class: "users-rights-actions" },
        h("button", { type: "button", class: "btn btn-primary", disabled: saving, onClick: () => { void save(); } }, saving ? t("shared.confirm.working") : t("users.rights.save")),
        saved ? h("p", { class: "form-notice", role: saved.ok ? "status" : "alert" }, saved.text) : null));
  }

  return h("section", { class: "card users-block", "aria-labelledby": "users-rights-h" },
    h("h2", { id: "users-rights-h", class: "card-title" }, t("users.rights.title")),
    h("p", { class: "field-hint" }, t("users.rights.lead")),
    list.length ? h("div", { class: "field" },
      h("label", { for: "users-rights-person" }, t("users.rights.person")),
      h("select", { id: "users-rights-person", value: person?.id ?? "", onChange: (e: Event) => { setPicked((e.target as HTMLSelectElement).value); setSaved(null); } },
        list.map((p) => h("option", { key: p.id, value: p.id, selected: p.id === person?.id }, p.name)))) : null,
    body);
}
