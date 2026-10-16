// Settings > Users & roles > Identities tab (#387): the person's channel accounts, formerly the hidden `/identities` route.
// Same calls as before: identity.link.list, identity.link.request|approve|decline|remove and identity.principals. The route's
// RBAC is unchanged: everyone who could open the page can open the tab; writing stays off for a Viewer.
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../../view.ts";
import { ConfirmDialog } from "../../../components/confirm-dialog.ts";
import { PageState } from "../../../components/page-state.ts";
import { t } from "../../../i18n.ts";
import { Field } from "../../common/field.ts";
import { currentRole, useLoad } from "../../common/load.ts";
import { FailureState } from "../../common/states.ts";
import { rpc, type IdentityList } from "../../surfaces/data.ts";
import "../../../styles/identities.css";

export function IdentitiesPanel(): View {
  const { state, reload } = useLoad((signal) => rpc<IdentityList>("identity.link.list", {}, signal), []);
  const [channel, setChannel] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [principals, setPrincipals] = useState<string[]>([]);

  const mutate = async (method: string, params: object): Promise<void> => {
    try {
      setError(false);
      await rpc(method, params, undefined, true);
      reload();
    } catch {
      setError(true);
    }
  };

  const title = t("nav.identities");
  let body: View;
  if (state.status === "loading") body = h(PageState, { state: "loading" });
  else if (state.status === "fail") body = h(FailureState, { failure: state.failure, unavailable: t("surfaces.unavailable"), onRetry: reload });
  else {
    const write = currentRole() !== "viewer";
    body = h("div", { class: "identities" },
      state.data.links.length
        ? h("ul", { class: "plain-list" }, state.data.links.map((link) =>
          h("li", { key: link.id }, `${link.channel} · ${link.accountId} · ${link.userId}`,
            write ? h("button", { type: "button", class: "btn btn-danger", "aria-label": t("identity.removeLabel", { name: `${link.channel} · ${link.accountId}` }), onClick: () => { setRemove(link.id); } }, t("surfaces.remove")) : null)))
        : h(PageState, { state: "empty", title: t("surfaces.empty") }),
      write
        ? h("form", {
          onSubmit: async (e: Event) => {
            e.preventDefault();
            setCode(null);
            setError(false);
            try {
              setCode(await rpc("identity.link.request", { channel }, undefined, true));
              reload();
            } catch {
              setError(true);
            }
          },
        },
          h(Field, { id: "identity-channel", label: t("identity.channel") },
            h("input", { id: "identity-channel", list: "identity-channels", value: channel, required: true, onInput: (e: Event) => { setChannel((e.currentTarget as HTMLInputElement).value); } })),
          h("datalist", { id: "identity-channels" }, [...new Set(state.data.links.map((l) => l.channel))].map((c) => h("option", { key: c, value: c }))),
          h("button", { class: "btn btn-primary", type: "submit" }, t("identity.request")))
        : null,
      code ? h("p", { role: "status" }, t("identity.code", { code: code.code }), " · ", t("identity.expires", { at: new Date(code.expiresAt).toLocaleString() })) : null,
      h("ul", { class: "plain-list" }, state.data.pairings.map((pair) =>
        h("li", { key: pair.id }, pair.channel, " · ", pair.state,
          write && pair.state === "claimed"
            ? h("span", null,
              h("button", { type: "button", class: "btn", onClick: () => { void mutate("identity.link.approve", { pairingId: pair.id }); } }, t("identity.approve")),
              h("button", { type: "button", class: "btn", onClick: () => { void mutate("identity.link.decline", { pairingId: pair.id }); } }, t("identity.decline")))
            : null))),
      h("button", {
        type: "button", class: "btn",
        onClick: async () => {
          try { setPrincipals((await rpc<{ principals: string[] }>("identity.principals")).principals); } catch { setError(true); }
        },
      }, t("identity.principals")),
      principals.length ? h("pre", null, principals.join("\n")) : null,
      error ? h("p", { role: "alert" }, t("surfaces.error")) : null,
      remove
        ? h(ConfirmDialog, {
          title: t("surfaces.confirm"), confirmLabel: t("surfaces.remove"), danger: true, onClose: () => { setRemove(null); },
          onConfirm: async () => {
            try {
              await rpc("identity.link.remove", { linkId: remove }, undefined, true);
              reload();
              return { ok: true as const };
            } catch {
              return { ok: false as const, message: t("surfaces.error") };
            }
          },
        }, t("identity.unlinkBody"))
        : null);
  }
  return h("section", { class: "card users-block", "aria-labelledby": "users-identities-h" }, h("h2", { id: "users-identities-h", class: "card-title" }, title), body);
}
