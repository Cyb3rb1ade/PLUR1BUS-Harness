// Settings > Users & roles (`/settings/users`).
// Wired to user.list, user.role.set, user.invite.*, agent.rights.* and breakglass.*.
// Protected against demoting the last owner. Owner and Admin only; others get "forbidden".
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { BreakGlassDialog } from "../../../components/break-glass.ts";
import { Badge, Card } from "../../../components/card.ts";
import { PageState } from "../../../components/page-state.ts";
import { formatDateTime, t, type Key } from "../../../i18n.ts";
import { sessionState } from "../../../session.ts";
import { currentRole, ROLE_PRESETS, roleIn, useLoad, type RolePreset } from "../../common/load.ts";
import { FailureState } from "../../common/states.ts";
import { InviteDialog } from "../users/invite.ts";
import {
  fetchUsers, listGrants, listInvites, presetName, revokeGrant, revokeInvite,
  setUserRole, type Row,
} from "../users/model.ts";
import type { BreakglassListResult, UserInviteListResult } from "../../common/admin-rpc.ts";
import { RightsPanel } from "../users/rights.ts";
import type { SectionProps } from "../page.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as usersArea from "../../../i18n/users.ts";
import "../../../styles/users.css";

registerArea("users", usersArea);

const CAN = ["can1", "can2", "can3"] as const;
const NOT = ["not1", "not2"] as const;
const key = (r: string, part: string): Key => `users.preset.${r}.${part}` as Key;

function PersonRow({
  row, canManage, onRoleChange, onBreakGlass,
}: {
  row: Row;
  canManage: boolean;
  onRoleChange: (r: Row, newRole: RolePreset) => void;
  onBreakGlass: (r: Row) => void;
}): View {
  return h("li", { class: "users-row", "data-user": row.id },
    h("div", { class: "users-who" },
      h("strong", { class: "users-name" }, row.name, row.self ? h("span", { class: "users-you" }, ` (${t("users.you")})`) : null),
      h("span", { class: "users-id" }, t("users.id"), ": ", h("code", null, row.id))),
    h("div", { class: "users-meta" },
      canManage && !row.self && row.role !== null
        ? h("select", {
            class: "users-role-select",
            value: row.role,
            "aria-label": t("users.role.set"),
            onChange: (e: Event) => {
              const val = (e.target as HTMLSelectElement).value as RolePreset;
              if (val) onRoleChange(row, val);
            },
          },
            ROLE_PRESETS.map((r) => h("option", { key: r, value: r, selected: r === row.role }, presetName(r))))
        : h(Badge, { tone: row.role === null ? "neutral" : "info" }, row.role === null ? t("users.role.unknown") : presetName(row.role)),
      row.statusKeys.map((s) => h(Badge, { key: s.key, tone: s.key === "users.status.signedIn" ? "ok" : "neutral" }, s.n === undefined ? t(s.key) : t(s.key, { n: s.n })))),
    row.self ? null : h("button", { type: "button", class: "btn btn-quiet", onClick: () => { onBreakGlass(row); } }, t("users.bg.action", { name: row.name })));
}

function People({
  self, canManage, onInvite, onBreakGlass,
}: {
  self: { id: string; role: string };
  canManage: boolean;
  onInvite: () => void;
  onBreakGlass: (r: Row) => void;
}): View {
  const { state, reload } = useLoad((signal) => fetchUsers(self, signal), [self.id]);
  const [roleOverrides, setRoleOverrides] = useState<Record<string, RolePreset>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const handleRoleChange = async (target: Row, newRole: RolePreset): Promise<void> => {
    setNotice(null);
    const prevRole = roleOverrides[target.id] ?? target.role;
    setRoleOverrides((prev) => ({ ...prev, [target.id]: newRole }));
    const outcome = await setUserRole(target.id, newRole);
    if (!outcome.ok) {
      if (prevRole) setRoleOverrides((prev) => ({ ...prev, [target.id]: prevRole }));
      if (outcome.error === "last-owner") {
        setNotice(t("users.role.lastOwner"));
      } else {
        setNotice(outcome.message ?? t("users.role.lastOwner"));
      }
    } else {
      setNotice(t("users.role.success"));
    }
  };

  const head = h("div", { class: "card-head" },
    h("h2", { id: "users-people-h", class: "card-title" }, t("users.list.title")),
    canManage ? h("button", { type: "button", class: "btn btn-primary", onClick: onInvite }, t("users.invite")) : null);

  let body: View;
  if (state.status === "loading") body = h(PageState, { state: "loading" });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("users.unavailable.title"), onRetry: reload });
  else {
    const rows = state.data.map((r) => r.id in roleOverrides ? { ...r, role: roleOverrides[r.id] ?? null } : r);
    body = h("div", null,
      notice ? h("p", { class: "form-notice", role: "alert" }, notice) : null,
      h("ul", { class: "plain-list users-list", "aria-label": t("users.list.label") },
        rows.map((r) => h(PersonRow, { key: r.id, row: r, canManage, onRoleChange: handleRoleChange, onBreakGlass }))),
      rows.length === 1 ? h("p", { class: "users-empty" }, t("users.empty")) : null);
  }

  return h("section", { class: "card users-block", "aria-labelledby": "users-people-h" }, head, body);
}

function OpenInvites({ reloadKey }: { reloadKey: number }): View | null {
  const [invites, setInvites] = useState<UserInviteListResult["invites"]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const res = await listInvites();
      setInvites(res.invites ?? []);
    } catch {
      // Gracefully ignore if server does not support invites
    }
  };

  useEffect(() => { void load(); }, [reloadKey]);

  const handleRevoke = async (inviteId: string): Promise<void> => {
    try {
      await revokeInvite(inviteId);
      setNotice(t("users.invites.revoked"));
      void load();
    } catch {
      // Ignore
    }
  };

  const pending = invites.filter((i) => i.state === "pending");
  if (pending.length === 0) return null;

  return h(Card, { title: t("users.invites.title"), level: 3 },
    notice ? h("p", { class: "form-notice", role: "status" }, notice) : null,
    h("ul", { class: "plain-list users-list" },
      pending.map((inv) => h("li", { key: inv.id, class: "users-row" },
        h("div", { class: "users-who" },
          h("strong", { class: "users-name" }, inv.userId || inv.id),
          h("span", { class: "users-id" }, t("users.invites.channel", { channel: inv.channel }))),
        h("div", { class: "users-meta" },
          h(Badge, { tone: "info" }, presetName(inv.role)),
          h(Badge, {}, t("users.invites.expires", { when: formatDateTime(new Date(inv.expiresAt)) }))),
        h("button", { type: "button", class: "btn btn-quiet", onClick: () => { void handleRevoke(inv.id); } }, t("users.invites.revoke"))))));
}

function ActiveGrants(): View | null {
  const [grants, setGrants] = useState<BreakglassListResult["grants"]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const res = await listGrants();
      setGrants(res.grants ?? []);
    } catch {
      // Gracefully ignore if server does not support breakglass.list
    }
  };

  useEffect(() => { void load(); }, []);

  const handleRevoke = async (grantId: string): Promise<void> => {
    try {
      await revokeGrant(grantId);
      setNotice(t("users.bg.revoked"));
      void load();
    } catch {
      // Ignore
    }
  };

  const active = grants.filter((g) => g.expiresAt > Date.now());
  if (active.length === 0) return null;

  return h(Card, { title: t("users.bg.activeGrants"), level: 3 },
    notice ? h("p", { class: "form-notice", role: "status" }, notice) : null,
    h("ul", { class: "plain-list users-list" },
      active.map((g) => {
        const remaining = Math.max(0, Math.ceil((g.expiresAt - Date.now()) / 60000));
        return h("li", { key: g.id, class: "users-row" },
          h("div", { class: "users-who" },
            h("strong", { class: "users-name" }, t("users.bg.target", { target: g.targetUserId })),
            h("span", { class: "field-hint" }, t("users.bg.reason", { reason: g.reason }))),
          h("div", { class: "users-meta" },
            h(Badge, { tone: "warn" }, t("users.bg.remaining", { minutes: remaining }))),
          h("button", { type: "button", class: "btn btn-quiet", onClick: () => { void handleRevoke(g.id); } }, t("users.bg.revoke")));
      })));
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
  const [invitesKey, setInvitesKey] = useState(0);
  const [target, setTarget] = useState<Row | null>(null);

  const canManage = roleIn(role, ["owner", "admin"]);
  if (!canManage) {
    return h("section", { "data-section": section.id, "aria-labelledby": "users-h" },
      h("h2", { id: "users-h", class: "users-title" }, t("users.title")),
      h(PageState, { state: "forbidden", title: t("users.forbidden.title"), detail: t("users.forbidden.detail", { role: role === undefined ? "" : presetName(role) }) }));
  }

  const self = s.status === "authenticated" ? { id: s.user.id, role: s.user.role } : { id: "", role: role ?? "" };

  return h("section", { "data-section": section.id, "aria-labelledby": "users-h", class: "users" },
    h("h2", { id: "users-h", class: "users-title" }, t("users.title")),
    h("p", { class: "users-lead" }, t("users.lead")),
    h(People, {
      self,
      canManage,
      onInvite: () => { setInviting(true); },
      onBreakGlass: setTarget,
    }),
    h(OpenInvites, { reloadKey: invitesKey }),
    h(ActiveGrants, {}),
    h("div", { class: "users-mode" },
      h("label", { class: "users-switch" },
        h("input", { type: "checkbox", id: "users-simple", checked: simple, "aria-describedby": "users-simple-hint", onChange: (e: Event) => { setSimple((e.target as HTMLInputElement).checked); } }),
        h("span", null, t("users.mode.simple"))),
      h("p", { id: "users-simple-hint", class: "field-hint" }, t("users.mode.hint"))),
    h(Presets, {}),
    simple ? null : h(RightsPanel, {}),
    inviting ? h(InviteDialog, { onClose: () => { setInviting(false); }, onCreated: () => { setInvitesKey((k) => k + 1); } }) : null,
    target ? h(BreakGlassDialog, {
      targetLabel: target.name,
      targetUserId: target.id,
      onClose: () => { setTarget(null); },
    }) : null);
}
