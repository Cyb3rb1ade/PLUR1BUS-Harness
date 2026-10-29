/** Owned inspection consent; installation rechecks the exact disclosure before mutation. */
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Card } from "../../components/card.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { navigate, query, routePath } from "../../router.ts";
import { getApi, useLoad } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import type { ExtInspection } from "../common/surfaces-rpc.ts";
import { InspectionDisclosure, inspectionText } from "./disclosure.ts";
import {
  inspectionIdentity,
  installationButton,
  installationParams,
  installationRequirements,
  type InstallationAcknowledgement,
} from "./install-model.ts";

type Agent = { agentId: string; name?: string };
const empty: InstallationAcknowledgement = { capabilities: false, trust: false, replacement: false };
const text = inspectionText;

function Consent({
  inspection,
  onChanged,
}: {
  inspection: ExtInspection;
  onChanged(value: ExtInspection): void;
}): View {
  const [accepted, setAccepted] = useState(empty),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [all, setAll] = useState(true),
    [selected, setSelected] = useState<string[]>([]),
    [changed, setChanged] = useState(false);
  const [members, setMembers] = useState<string[]>(() =>
    (inspection.members ?? []).filter((member) => !member.optional).map((member) => member.name),
  );
  const bundle = (inspection.manifest as { kind?: unknown }).kind === "bundle";
  const inFlight = useRef(false),
    identity = inspectionIdentity(inspection),
    needs = installationRequirements(inspection, bundle ? members : undefined);
  useEffect(() => {
    setAccepted(empty);
    setMembers((inspection.members ?? []).filter((member) => !member.optional).map((member) => member.name));
  }, [identity]);
  const agents = useLoad(
    (signal) => getApi().rpc("agent.list", {}, { write: false, signal }) as Promise<{ agents: Agent[] }>,
    [],
  );
  const manifest = inspection.manifest as Record<string, unknown>,
    scoped = ["skill", "mcp-server", "bundle"].includes(String(manifest.kind));
  const allowed =
    !needs.blocked &&
    accepted.capabilities &&
    (!needs.trust || accepted.trust) &&
    (!needs.replacement || accepted.replacement);
  const acknowledge = (field: keyof InstallationAcknowledgement, value: boolean): void =>
    setAccepted((current) => ({ ...current, [field]: value }));
  const install = async (activate: boolean): Promise<void> => {
    if (inFlight.current || !allowed) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const fresh = (await getApi().rpc(
        "ext.inspection.get",
        { inspectionId: inspection.inspectionId },
        { write: false },
      )) as ExtInspection;
      if (inspectionIdentity(fresh) !== identity) {
        onChanged(fresh);
        setChanged(true);
        return;
      }
      const params = installationParams(
        fresh,
        accepted,
        activate ? (!scoped || all ? "all" : selected) : undefined,
        bundle ? members : undefined,
      );
      const result = (await getApi().rpc("ext.install", params)) as { name: string };
      navigate(routePath("plugins", result.name));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("extensions.error.required"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const control = (field: keyof InstallationAcknowledgement, label: string) =>
    h(
      "label",
      { class: "checkbox-label" },
      h("input", {
        type: "checkbox",
        checked: accepted[field],
        disabled: busy,
        onChange: (event: Event) => acknowledge(field, (event.target as HTMLInputElement).checked),
      }),
      " ",
      label,
    );
  return h(
    "div",
    { class: "extension-confirm", "data-inspection": inspection.inspectionId },
    h(
      Card,
      {
        title: t("extensions.install.ready", {
          id: text(manifest.id ?? manifest.name ?? "?"),
          version: text(manifest.version ?? "?"),
        }),
      },
      h(InspectionDisclosure, { inspection }),
      needs.firstParty ? h("p", { role: "note", class: "form-notice" }, t("extensions.install.firstParty")) : null,
    ),
    bundle
      ? h(
          Card,
          { title: t("extensions.bundle.title") },
          needs.missingMembers
            ? h("p", { role: "alert", class: "form-error" }, t("extensions.bundle.unavailable"))
            : null,
          h(
            "fieldset",
            { disabled: busy },
            h("legend", null, t("extensions.bundle.choose")),
            (inspection.members ?? []).map((member) =>
              h(
                "section",
                { key: member.name, class: "bundle-inspection-member" },
                h(
                  "label",
                  { class: "checkbox-label" },
                  h("input", {
                    type: "checkbox",
                    "aria-label": t("extensions.bundle.include", { name: member.name }),
                    checked: members.includes(member.name),
                    disabled: busy || !member.optional,
                    onChange: (event: Event) => {
                      const checked = (event.target as HTMLInputElement).checked;
                      setMembers((current) =>
                        checked ? [...current, member.name] : current.filter((name) => name !== member.name),
                      );
                      setAccepted(empty);
                    },
                  }),
                  " ",
                  member.name,
                  " · ",
                  t(member.optional ? "extensions.bundle.optional" : "extensions.bundle.required"),
                ),
                h("h3", null, `${member.name} · ${member.kind} · ${member.version}`),
                h(InspectionDisclosure, { inspection: member, nested: true }),
              ),
            ),
          ),
        )
      : null,
    changed ? h("p", { role: "alert", class: "form-error" }, t("extensions.install.changed")) : null,
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,
    h(
      Card,
      {},
      h(
        "fieldset",
        { disabled: busy },
        h("legend", null, t("extensions.action.confirm")),
        control("capabilities", t(bundle ? "extensions.bundle.permissionsAck" : "extensions.install.permissionsAck")),
        needs.trust
          ? control(
              "trust",
              t(
                bundle
                  ? "extensions.bundle.trustAck"
                  : needs.unsigned
                    ? "extensions.install.unsignedAck"
                    : "extensions.install.unknownAck",
              ),
            )
          : null,
        needs.replacement
          ? control(
              "replacement",
              inspection.replaces
                ? t("extensions.install.replacementAck", { version: inspection.replaces.version })
                : t("extensions.bundle.replacementAck"),
            )
          : null,
      ),
      !needs.firstParty
        ? h(
            "fieldset",
            { disabled: busy },
            h("legend", null, t("extensions.agents.enableFor")),
            scoped
              ? h(
                  "label",
                  { class: "checkbox-label" },
                  h("input", {
                    type: "checkbox",
                    checked: all,
                    onChange: (event: Event) => setAll((event.target as HTMLInputElement).checked),
                  }),
                  " ",
                  t("extensions.agents.all"),
                )
              : h("p", null, t("extensions.agents.all")),
            scoped && !all && agents.state.status === "ok"
              ? agents.state.data.agents.map((agent) =>
                  h(
                    "label",
                    { key: agent.agentId, class: "checkbox-label" },
                    h("input", {
                      type: "checkbox",
                      checked: selected.includes(agent.agentId),
                      onChange: (event: Event) => {
                        const checked = (event.target as HTMLInputElement).checked;
                        setSelected((current) =>
                          checked ? [...current, agent.agentId] : current.filter((id) => id !== agent.agentId),
                        );
                      },
                    }),
                    " ",
                    agent.name ?? agent.agentId,
                  ),
                )
              : null,
            scoped && !all && agents.state.status === "fail"
              ? h(FailureState, { failure: agents.state.failure, onRetry: agents.reload })
              : null,
            scoped && !all && !selected.length
              ? h("p", { class: "field-hint" }, t("extensions.agents.noneSelected"))
              : null,
          )
        : null,
      h(
        "div",
        { class: "dialog-actions" },
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary",
            disabled: busy || !allowed,
            onClick: () => {
              void install(false);
            },
          },
          t(installationButton(inspection)),
        ),
        !needs.firstParty
          ? h(
              "button",
              {
                type: "button",
                class: "btn",
                disabled: busy || !allowed || (scoped && !all && !selected.length),
                onClick: () => {
                  void install(true);
                },
              },
              t("extensions.install.activate"),
            )
          : null,
      ),
    ),
  );
}

export function ExtensionConfirmPage(): View {
  const id = query.value.get("inspection"),
    [fresh, setFresh] = useState<ExtInspection | null>(null);
  useEffect(() => setFresh(null), [id]);
  const { state, reload } = useLoad(
    (signal) =>
      id
        ? (getApi().rpc("ext.inspection.get", { inspectionId: id }, { write: false, signal }) as Promise<ExtInspection>)
        : Promise.resolve(null),
    [id],
  );
  let content: View;
  if (state.status === "loading") content = h(PageLoading, { label: t("state.loading") });
  else if (state.status === "fail") content = h(FailureState, { failure: state.failure, onRetry: reload });
  else if (!state.data) content = h(PageState, { state: "empty", title: t("extensions.confirm.missing") });
  else content = h(Consent, { key: id, inspection: fresh ?? state.data, onChanged: setFresh });
  return h(Page, { title: t("extensions.install.confirmTitle"), width: "settings" }, content);
}
