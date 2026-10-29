/** Source candidates are disclosure only; actual host status and preflight bind the eventual target model. */
import { h } from "preact";
import type { View } from "../../view.ts";
import type { ModelMemoryStatusResult } from "../../../../rpc-schema/generated/types.ts";
import { t } from "../../i18n.ts";
import { getApi, useLoad } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import { PageLoading } from "../../components/page-state.ts";
import { MODEL_CHOICES } from "../setup/licences.ts";
import { ImportModelLicence, licenceAuthorityDenied } from "./licence.ts";
import type { SourceStore } from "./store-mappings.ts";

interface ModelReadPort {
  rpc(method: string, params: object, options: { write: false }): Promise<unknown>;
}
interface CurrentTarget {
  authorityDenied: boolean;
  embedding?: ModelMemoryStatusResult["embedding"];
}
/** A refused model read has no inferred role/model fallback and never requests or adds settings scopes. */
export async function currentImportTarget(port: ModelReadPort): Promise<CurrentTarget> {
  let result: ModelMemoryStatusResult;
  try {
    result = (await port.rpc("model.memory.status", {}, { write: false })) as ModelMemoryStatusResult;
  } catch (error) {
    if (licenceAuthorityDenied(error)) return { authorityDenied: true };
    throw error;
  }
  const embedding = result?.embedding;
  if (
    !embedding ||
    typeof embedding.provider !== "string" ||
    !embedding.provider ||
    embedding.provider.length > 128 ||
    typeof embedding.model !== "string" ||
    !embedding.model ||
    embedding.model.length > 512 ||
    !Number.isInteger(embedding.dimensions) ||
    embedding.dimensions <= 0 ||
    embedding.dimensions > 65536 ||
    typeof embedding.configured !== "boolean"
  )
    throw new Error("target-model-metadata");
  return {
    authorityDenied: false,
    embedding: {
      provider: embedding.provider,
      model: embedding.model,
      dimensions: embedding.dimensions,
      configured: embedding.configured,
    },
  };
}
/** Reviews both ends of the temporary source-model transfer without treating candidate metadata as vector proof. */
export function ImportStoreModels({
  store,
  reembed,
  targetModel,
  onConfirmed,
}: {
  store: SourceStore | undefined;
  reembed: boolean;
  targetModel: string;
  onConfirmed(role: "source" | "target", model: string, selector: string): void;
}): View | null {
  const actual = useLoad(
    () =>
      reembed && !targetModel.trim()
        ? currentImportTarget(getApi())
        : Promise.resolve<CurrentTarget>({ authorityDenied: false }),
    [reembed, targetModel],
  );
  if (!store && !reembed) return null;
  const source = store?.sourceModelCandidate;
  const sourceChoice = MODEL_CHOICES.find((choice) => choice.kind === "embedding" && choice.model === source?.model);
  const current = actual.state.status === "ok" ? actual.state.data.embedding : undefined;
  const target = targetModel.trim() || current?.model;
  const targetChoice = MODEL_CHOICES.find((choice) => choice.kind === "embedding" && choice.model === target);
  return h(
    "div",
    {},
    store
      ? h(
          "section",
          {},
          h("h3", null, t("imports.sourceModel")),
          source
            ? h(
                "div",
                {},
                h(
                  "p",
                  null,
                  h("code", null, source.model),
                  " · ",
                  t("imports.modelDimensions", { dimensions: source.dimensions }),
                ),
                h(
                  "p",
                  null,
                  t("imports.licenceRevision"),
                  ": ",
                  h("code", null, source.revision),
                  " · ",
                  source.licence,
                ),
                h("p", { class: "field-hint" }, t("imports.sourceModelCandidate")),
                source.nonCommercial || sourceChoice?.nc
                  ? sourceChoice?.nc
                    ? h(ImportModelLicence, {
                        key: `source:${source.model}:${source.revision}`,
                        source: true,
                        modelId: source.model,
                        expectedRevision: source.revision,
                        onConfirmed: (model, selector) => onConfirmed("source", model, selector),
                      })
                    : h(Notice, { tone: "warn" }, t("imports.licenceUnavailable"))
                  : null,
              )
            : h(Notice, {}, t("imports.sourceModelUnknown")),
        )
      : null,
    reembed
      ? h(
          "section",
          {},
          h("h3", null, t("imports.targetModel")),
          actual.state.status === "loading" && !targetModel.trim()
            ? h(PageLoading, { label: t("state.loading") })
            : null,
          actual.state.status === "fail"
            ? h(FailureState, { failure: actual.state.failure, onRetry: actual.reload })
            : null,
          actual.state.status === "ok" && actual.state.data.authorityDenied
            ? h(
                Notice,
                { tone: "warn" },
                t("imports.licenceAuthority"),
                " ",
                h("a", { href: "#/import" }, t("imports.licenceReturn")),
              )
            : null,
          target
            ? h(
                "div",
                {},
                h(
                  "p",
                  null,
                  h("code", null, target),
                  current?.model === target
                    ? ` · ${t("imports.modelDimensions", { dimensions: current.dimensions })}`
                    : "",
                ),
                !targetModel.trim() ? h("p", { class: "field-hint" }, t("imports.currentTargetModel")) : null,
                !targetChoice ||
                  (current &&
                    (current.provider !== "local-transformers" || current.dimensions !== targetChoice.dimensions))
                  ? h(Notice, { tone: "warn" }, t("imports.targetModelUnsupported"))
                  : null,
                targetChoice?.nc
                  ? h(ImportModelLicence, {
                      key: `target:${target}`,
                      modelId: target,
                      expectedRevision: targetChoice.revision,
                      onConfirmed: (model, selector) => onConfirmed("target", model, selector),
                    })
                  : null,
              )
            : null,
        )
      : null,
  );
}
