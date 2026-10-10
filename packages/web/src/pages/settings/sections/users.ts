// Settings > Users & roles (`/settings/users`). Real data: the signed-in principal (whoami) and `identity.list`. Role presets and
// the rights matrix are display only, and invite and break-glass end in an explicit "not available" message, because no RPC
// assigns roles, invites people or grants break-glass (docs/web-ui.md F40, F41). Owner and Admin only; others get "forbidden".
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { BreakGlassDialog } from "../../../components/break-glass.ts";
import { Badge } from "../../../components/card.ts";
import { PageState } from "../../../components/page-state.ts";
import { t, type Key } from "../../../i18n.ts";
import { sessionState } from "../../../session.ts";
import { currentRole, getApi, ROLE_PRESETS, roleIn, useLoad } from "../../common/load.ts";
import { FailureState } from "../../common/states.ts";
import { InviteDialog } from "../users/invite.ts";
import { buildRows, presetName, type IdentityList, type Row } from "../users/model.ts";
import { RightsPanel } from "../users/rights.ts";
import type { SectionProps } from "../page.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as usersArea from "../../../i18n/users.ts";
import "../../../styles/users.css";

registerArea("users", usersArea);

const CAN = ["can1", "can2", "can3"] as const;
const NOT = ["not1", "not2"] as const;
const key = (r: string, part: string): Key => `users.preset.${r}.${part}` as Key;

function PersonRow({ row, onBreakGlass }: { row: Row; onBreakGlass: (r: Row) => void }): View {
  return h("li", { class: "users-row" },
    h("div", { class: "users-who" },
      h("strong", { class: "users-name" }, row.name, row.self ? h("span", { class: "users-you" }, ` (${t("users.you")})`) : null),
      h("span", { class: "users-id" }, t("users.id"), ": ", h("code", null, row.id))),
    h("div", { class: "users-meta" },
      h(Badge, { tone: row.role === null ? "neutral" : "info" }, row.role === null ? t("users.role.unknown") : presetName(row.role)),
      row.statusKeys.map((s) => h(Badge, { key: s.key, tone: s.key === "users.status.signedIn" ? "ok" : "neutral" }, s.n === undefined ? t(s.key) : t(s.key, { n: s.n })))),
    row.self ? null : h("button", { type: "button", class: "btn btn-quiet", onClick: () => { onBreakGlass(row); } }, t("users.bg.action", { name: row.name })));
}

function People({ self, onInvite }: { self: { id: string; role: string }; onInvite: () => void }): View {
  const { state, reload } = useLoad((signal) => getApi().rpc("identity.list", {}, { write: false, signal }) as Promise<IdentityList>, []);
  const [target, setTarget] = useState<Row | null>(null);
  const head = h("div", { class: "card-head" },
    h("h2", { id: "users-people-h", class: "card-title" }, t("users.list.title")),
    h("button", { type: "button", class: "btn btn-primary", onClick: onInvite }, t("users.invite")));
  let body: View;
  if (state.status === "loading") body = h(PageState, { state: "loading" });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("users.unavailable.title"), onRetry: reload });
  else {
    const rows = buildRows(self, state.data);
    body = h("div", null,
      h("ul", { class: "plain-list users-list", "aria-label": t("users.list.label") }, rows.map((r) => h(PersonRow, { key: r.id, row: r, onBreakGlass: setTarget }))),
      rows.length === 1 ? h("p", { class: "users-empty" }, t("users.empty")) : null);
  }
  return h("section", { class: "card users-block", "aria-labelledby": "users-people-h" },
    head, body,
    target ? h(BreakGlassDialog, { targetLabel: target.name, onClose: () => { setTarget(null); } }) : null);
}

function Presets(): View {
  const [sel, setSel] = useState<string>("member");
  return h("section", { class: "card users-block", "aria-labelledby": "users-presets-h" },
    h("h2", { id: "users-presets-h", class: "card-title" }, t("users.presets.title")),
    h("p", { class: "field-hint" }, t("users.presets.hint")),
    h("fieldset", { class: "users-presets" },
      h("legend", null, t("users.presets.legend")),
      ROLE_PRESETS.map((r) => h("label", { key: r, class: "users-preset", "data-selected": r === sel ? "true" : "false" },
        h("input", { type: "radio", name: "users-preset", value: r, checked: r === sel, onChange: () => { setSel(r); } }),
        h("span", { class: "users-preset-text" }, h("strong", null, t(key(r, "name"))), h("span", null, t(key(r, "summary"))))))),
    h("div", { class: "users-detail", "aria-live": "polite" },
      h("h3", null, presetName(sel)),
      h("div", { class: "users-can" },
        h("div", null, h("h4", null, t("users.presets.can")), h("ul", null, CAN.map((c) => h("li", { key: c }, t(key(sel, c)))))),
        h("div", null, h("h4", null, t("users.presets.cannot")), h("ul", null, NOT.map((c) => h("li", { key: c }, t(key(sel, c)))))))),
    h("p", { class: "form-notice", role: "note" }, t("users.presets.unavailable")));
}

export function UsersSection({ section }: SectionProps): View {
  const role = currentRole();
  const s = sessionState.value;
  const [simple, setSimple] = useState(true);
  const [inviting, setInviting] = useState(false);
  if (!roleIn(role, ["owner", "admin"])) {
    return h("section", { "data-section": section.id, "aria-labelledby": "users-h" },
      h("h2", { id: "users-h", class: "users-title" }, t("users.title")),
      h(PageState, { state: "forbidden", title: t("users.forbidden.title"), detail: t("users.forbidden.detail", { role: role === undefined ? "" : presetName(role) }) }));
  }
  const self = s.status === "authenticated" ? { id: s.user.id, role: s.user.role } : { id: "", role: role ?? "" };
  return h("section", { "data-section": section.id, "aria-labelledby": "users-h", class: "users" },
    h("h2", { id: "users-h", class: "users-title" }, t("users.title")),
    h("p", { class: "users-lead" }, t("users.lead")),
    h(People, { self, onInvite: () => { setInviting(true); } }),
    h("div", { class: "users-mode" },
      h("label", { class: "users-switch" },
        h("input", { type: "checkbox", id: "users-simple", checked: simple, "aria-describedby": "users-simple-hint", onChange: (e: Event) => { setSimple((e.target as HTMLInputElement).checked); } }),
        h("span", null, t("users.mode.simple"))),
      h("p", { id: "users-simple-hint", class: "field-hint" }, t("users.mode.hint"))),
    h(Presets, {}),
    simple ? null : h(RightsPanel, {}),
    inviting ? h(InviteDialog, { onClose: () => { setInviting(false); } }) : null);
}
