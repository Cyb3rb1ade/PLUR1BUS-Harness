import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { PageState } from "../../components/page-state.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n.ts";
import { Field } from "../common/field.ts";
import { useLoad, currentRole } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { rpc, type IdentityList } from "./data.ts";
import "../../styles/identities.css";

export function IdentitiesPage(): View {
  const { state, reload } = useLoad(
    (signal) => rpc<IdentityList>("identity.link.list", {}, signal),
    [],
  );
  const [channel, setChannel] = useState("telegram"),
    [code, setCode] = useState<{ code: string; expiresAt: number } | null>(
      null,
    ),
    [remove, setRemove] = useState<string | null>(null),
    [error, setError] = useState(false),
    [principals, setPrincipals] = useState<string[]>([]);
  const title = t("nav.identities");
  const mutate = async (method: string, params: object) => {
    try {
      setError(false);
      await rpc(method, params, undefined, true);
      reload();
    } catch {
      setError(true);
    }
  };
  if (state.status === "loading")
    return h(Page, { title }, h(PageState, { state: "loading" }));
  if (state.status === "fail")
    return h(
      Page,
      { title },
      h(FailureState, {
        failure: state.failure,
        unavailable: t("surfaces.unavailable"),
        onRetry: reload,
      }),
    );
  const write = currentRole() !== "viewer";
  return h(
    Page,
    { title },
    state.data.links.length
      ? h(
          "ul",
          {},
          state.data.links.map((link) =>
            h(
              "li",
              { key: link.id },
              link.channel,
              " · ",
              link.accountId,
              " · ",
              link.userId,
              write
                ? h(
                    "button",
                    {
                      class: "btn btn-danger",
                      onClick: () => setRemove(link.id),
                    },
                    t("surfaces.remove"),
                  )
                : null,
            ),
          ),
        )
      : h(PageState, { state: "empty", title: t("surfaces.empty") }),
    write
      ? h(
          "form",
          {
            onSubmit: async (e: Event) => {
              e.preventDefault();
              setCode(null);
              try {
                setCode(
                  await rpc(
                    "identity.link.request",
                    { channel },
                    undefined,
                    true,
                  ),
                );
                reload();
              } catch {
                setError(true);
              }
            },
          },
          h(
            Field,
            { id: "identity-channel", label: t("identity.channel") },
            h("input", {
              id: "identity-channel",
              value: channel,
              required: true,
              onInput: (e: Event) =>
                setChannel((e.currentTarget as HTMLInputElement).value),
            }),
          ),
          h(
            "button",
            { class: "btn btn-primary", type: "submit" },
            t("identity.request"),
          ),
        )
      : null,
    code
      ? h(
          "p",
          { role: "status" },
          t("identity.code", { code: code.code }),
          " · ",
          t("identity.expires", {
            at: new Date(code.expiresAt).toLocaleString(),
          }),
        )
      : null,
    h(
      "ul",
      {},
      state.data.pairings.map((pair) =>
        h(
          "li",
          { key: pair.id },
          pair.channel,
          " · ",
          pair.state,
          write && pair.state === "claimed"
            ? h(
                "span",
                {},
                h(
                  "button",
                  {
                    class: "btn",
                    onClick: () =>
                      void mutate("identity.link.approve", {
                        pairingId: pair.id,
                      }),
                  },
                  t("identity.approve"),
                ),
                h(
                  "button",
                  {
                    class: "btn",
                    onClick: () =>
                      void mutate("identity.link.decline", {
                        pairingId: pair.id,
                      }),
                  },
                  t("identity.decline"),
                ),
              )
            : null,
        ),
      ),
    ),
    h(
      "button",
      {
        class: "btn",
        onClick: async () => {
          try {
            const result = await rpc<{ principals: string[] }>(
              "identity.principals",
            );
            setPrincipals(result.principals);
          } catch {
            setError(true);
          }
        },
      },
      t("identity.principals"),
    ),
    principals.length ? h("pre", {}, principals.join("\n")) : null,
    error ? h("p", { role: "alert" }, t("surfaces.error")) : null,
    remove
      ? h(
          ConfirmDialog,
          {
            title: t("surfaces.confirm"),
            confirmLabel: t("surfaces.remove"),
            danger: true,
            onClose: () => setRemove(null),
            onConfirm: async () => {
              try {
                await rpc(
                  "identity.link.remove",
                  { linkId: remove },
                  undefined,
                  true,
                );
                reload();
                return { ok: true as const };
              } catch {
                return { ok: false as const, message: t("surfaces.error") };
              }
            },
          },
          t("identity.unlinkBody"),
        )
      : null,
  );
}
