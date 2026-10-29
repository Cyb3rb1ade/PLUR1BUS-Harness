/** Explicit NC model consent uses the existing ledger method; the preflight still verifies actor/model/revision/use class. */
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import { sessionState } from "../../session.ts";
import { getApi, useLoad } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import { MODEL_CHOICES } from "../setup/licences.ts";

interface LicencePort {
  rpc(method: string, params: object): Promise<unknown>;
}
/** Returns the real licence selector only after the existing ledger confirms this actor and the pinned model revision. */
export async function confirmImportLicence(
  port: LicencePort,
  modelId: string,
  actor: string,
  expectedRevision?: string,
): Promise<string> {
  const model = MODEL_CHOICES.find((choice) => choice.kind === "embedding" && choice.nc && choice.model === modelId);
  if (!model || (expectedRevision !== undefined && expectedRevision !== model.revision))
    throw new Error("licence-model");
  const result = (await port.rpc("model.licence.confirm", { model: model.model, accepted: true })) as {
    acceptance?: {
      who?: unknown;
      at?: unknown;
      licence?: unknown;
      model?: unknown;
      revision?: unknown;
      source?: unknown;
    };
  };
  const accepted = result?.acceptance;
  if (
    !accepted ||
    accepted.who !== actor ||
    accepted.model !== model.model ||
    accepted.revision !== model.revision ||
    accepted.licence !== model.licence ||
    accepted.source !== "memory" ||
    typeof accepted.at !== "string" ||
    !Number.isFinite(Date.parse(accepted.at))
  )
    throw new Error("licence-result");
  return model.licence;
}
/** Only explicit authorization refusals direct the human to a broader account session; availability is not authority. */
export function licenceAuthorityDenied(error: unknown): boolean {
  const value = error as { kind?: unknown; errorCode?: unknown } | null;
  return !!value && (value.kind === "forbidden" || (value.kind === "rpc-error" && value.errorCode === "E_DENIED"));
}
interface LicencePolicyPort {
  rpc(method: string, params: { key: string }, options: { write: false; signal?: AbortSignal }): Promise<unknown>;
}
/** The global acknowledgement is a separate settings decision; this import review only reads it. */
export async function readImportLicencePolicy(
  port: LicencePolicyPort,
  signal?: AbortSignal,
): Promise<{
  authorityDenied: boolean;
  useClass?: string;
  acceptedNcLicence?: boolean;
}> {
  try {
    const options = { write: false as const, ...(signal ? { signal } : {}) };
    const [use, accepted] = await Promise.all([
      port.rpc("config.get", { key: "embedding.useClass" }, options),
      port.rpc("config.get", { key: "embedding.acceptedNcLicence" }, options),
    ]);
    const useClass = (use as { value?: unknown } | null)?.value;
    const acknowledged = (accepted as { value?: unknown } | null)?.value;
    return {
      authorityDenied: false,
      ...(typeof useClass === "string" ? { useClass } : {}),
      acceptedNcLicence: acknowledged === true,
    };
  } catch (error) {
    if (licenceAuthorityDenied(error)) return { authorityDenied: true };
    throw error;
  }
}
/** Offers a deliberate ledger write for a catalogued NC embedding; commercial or unknown use classes fail closed. */
export function ImportModelLicence({
  modelId,
  onConfirmed,
  expectedRevision,
  source = false,
}: {
  modelId: string;
  expectedRevision?: string;
  source?: boolean;
  onConfirmed(model: string, selector: string): void;
}): View | null {
  const model = MODEL_CHOICES.find((choice) => choice.kind === "embedding" && choice.nc && choice.model === modelId);
  const config = useLoad<Awaited<ReturnType<typeof readImportLicencePolicy>>>(
    (signal) => (model ? readImportLicencePolicy(getApi(), signal) : Promise.resolve({ authorityDenied: false })),
    [modelId],
  );
  const [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [denied, setDenied] = useState(false);
  const active = useRef(modelId + "\0" + (expectedRevision ?? ""));
  active.current = modelId + "\0" + (expectedRevision ?? "");
  useEffect(() => {
    setAccepted(false);
    setConfirmed(false);
    setFailed(false);
    setDenied(false);
    setBusy(false);
  }, [modelId, expectedRevision]);
  useEffect(
    () => () => {
      active.current = "";
    },
    [],
  );
  if (!model) return null;
  const auth = sessionState.value;
  const actor =
    auth.status === "authenticated"
      ? auth.user.id === "owner" && auth.user.role === "owner"
        ? "local-owner"
        : auth.user.id
      : "";
  const authorityDenied = denied || (config.state.status === "ok" && config.state.data.authorityDenied === true);
  const revisionMatches = expectedRevision === undefined || expectedRevision === model.revision;
  const permitted =
    revisionMatches &&
    config.state.status === "ok" &&
    ["general", "research"].includes(String(config.state.data.useClass));
  const confirm = async (): Promise<void> => {
    if (!accepted || !permitted || busy || !actor) return;
    setBusy(true);
    setFailed(false);
    setDenied(false);
    const subject = active.current;
    try {
      const selector = await confirmImportLicence(getApi(), modelId, actor, expectedRevision);
      if (active.current !== subject) return;
      setConfirmed(true);
      onConfirmed(modelId, selector);
    } catch (error) {
      if (active.current !== subject) return;
      setDenied(licenceAuthorityDenied(error));
      setFailed(true);
    } finally {
      if (active.current === subject) setBusy(false);
    }
  };
  return h(
    "fieldset",
    { disabled: busy },
    h("legend", null, t(source ? "imports.sourceLicenceTitle" : "imports.licenceTitle")),
    h("p", null, `${model.name} · ${model.licence}`),
    h("p", null, t("imports.licenceRevision"), ": ", h("code", null, model.revision)),
    h(
      "a",
      { href: "https://creativecommons.org/licenses/by-nc/4.0/", target: "_blank", rel: "noopener noreferrer" },
      t("imports.licenceTerms"),
    ),
    authorityDenied
      ? h(
          Notice,
          { tone: "warn" },
          t("imports.licenceAuthority"),
          " ",
          h("a", { href: "#/import" }, t("imports.licenceReturn")),
        )
      : null,
    !revisionMatches ? h(Notice, { tone: "warn" }, t("imports.licenceRevisionMismatch")) : null,
    !permitted && !authorityDenied ? h(Notice, { tone: "warn" }, t("imports.licenceUseClass")) : null,
    config.state.status === "fail" ? h(FailureState, { failure: config.state.failure, onRetry: config.reload }) : null,
    config.state.status === "ok" && !authorityDenied && config.state.data.acceptedNcLicence !== true
      ? h(
          Notice,
          { tone: "warn" },
          t("imports.licenceGlobal"),
          " ",
          h("a", { href: "#/settings/memory?focus=embedding.acceptedNcLicence" }, t("imports.licenceSettings")),
          " ",
          h("button", { type: "button", class: "btn", onClick: config.reload }, t("imports.licenceReload")),
        )
      : null,
    !permitted && !authorityDenied
      ? h("a", { href: "#/settings/memory?focus=embedding.useClass" }, t("imports.licenceUseSettings"))
      : null,
    failed ? h("p", { role: "alert", class: "form-error" }, t("imports.licenceFailed")) : null,
    confirmed
      ? h(Notice, {}, t("imports.licenceRecorded"))
      : h(
          "div",
          {},
          h(
            "label",
            { class: "checkbox-label" },
            h("input", {
              type: "checkbox",
              checked: accepted,
              disabled: !permitted,
              onChange: (event: Event) => setAccepted((event.target as HTMLInputElement).checked),
            }),
            " ",
            t("imports.licenceAccept"),
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn",
              disabled: busy || !permitted || !accepted,
              onClick: () => {
                void confirm();
              },
            },
            t("imports.licenceConfirm"),
          ),
        ),
  );
}
