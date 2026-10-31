/** Human import flow: sealed-source preview, explicit preflight consent and native maintenance progress. */
import { h } from "preact";
import { useState } from "preact/hooks";
import "../../styles/imports.css";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { Card } from "../../components/card.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/imports.ts";
import { currentRole } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";
import { terminalRun } from "./model.ts";
import { useImportFlow, importCall as call } from "./use-flow.ts";
import { SourcePicker } from "./source-picker.ts";
import { ImportOptions } from "./options.ts";
import { PromptImportWizard } from "./prompt-wizard.ts";
import type {
  AdminImportPlanParams,
  AdminImportPlanResult,
  AdminImportPreflightResult,
  AdminImportSkillsResult,
  ImportCounts,
  ImportIssue,
  ImportRun,
} from "../../../../rpc-schema/generated/types.ts";

registerArea("imports", area);
const countText = (counts: ImportCounts): string => t("imports.counts", { ...counts });
const issues = (values: ImportIssue[]): View =>
  h(
    "ul",
    { class: "plain-list" },
    values.map((issue, index) =>
      h("li", { key: index }, `${issue.code}: ${issue.reason}${issue.itemId ? ` (${issue.itemId})` : ""}`),
    ),
  );

/** Runs the same source-to-maintenance flow in its own page or setup F37. */
export function ImportWizard(): View {
  const [wizardMode, setWizardMode] = useState<"installation" | "prompt">("installation");
  const flow = useImportFlow();
  const {
    catalog,
    source,
    setSource,
    detected,
    discovery,
    setDiscovery,
    setDetected,
    agents,
    setAgents,
    options,
    setOptions,
    plan,
    setPlan,
    preflight,
    setPreflight,
    preflightOperation,
    conflicts,
    setConflicts,
    accepted,
    setAccepted,
    run,
    setRun,
    runId,
    setRunId,
    history,
    setHistory,
    skills,
    setSkills,
    skillsAccepted,
    setSkillsAccepted,
    skillsEnable,
    setSkillsEnable,
    busy,
    error,
    setError,
    aborting,
    owner,
    act,
    readStatus,
    remember,
    detect,
    createPlan,
    inspectPlan,
    apply,
    rollback,
    abort,
    skillsOnly,
  } = flow;
  const checkbox = (label: string, checked: boolean, set: (value: boolean) => void, disabled = false): View =>
    h(
      "label",
      { class: "checkbox-label" },
      h("input", {
        type: "checkbox",
        checked,
        disabled: busy || disabled,
        onChange: (event: Event) => set((event.target as HTMLInputElement).checked),
      }),
      " ",
      label,
    );
  const catalogData = catalog.state.status === "ok" ? catalog.state.data : null;
  if (!runId && catalog.state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (!runId && catalog.state.status === "fail")
    return h(FailureState, { failure: catalog.state.failure, onRetry: catalog.reload });
  if (!runId && catalogData?.sources.length === 0) return h(PageState, { state: "empty", title: t("imports.empty") });
  return h(
    "div",
    { class: "import-wizard" },
    h("p", { class: "reading" }, t("imports.lead")),
    h(
      "div",
      { class: "import-source-tiles", role: "tablist", "aria-label": t("imports.source") },
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": wizardMode === "installation",
          class: `import-source-tile ${wizardMode === "installation" ? "active" : ""}`,
          onClick: () => setWizardMode("installation"),
        },
        t("imports.tileInstallation"),
      ),
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": wizardMode === "prompt",
          class: `import-source-tile ${wizardMode === "prompt" ? "active" : ""}`,
          onClick: () => setWizardMode("prompt"),
        },
        t("imports.tilePrompt"),
      ),
    ),
    wizardMode === "prompt"
      ? h(PromptImportWizard, {})
      : [
          error
            ? h(FailureState, {
                failure: error,
                onRetry: () => {
                  if (runId) void act(() => readStatus(runId));
                  else setError(null);
                },
              })
            : null,
    h(
      "div",
      { class: "chip-row" },
      h(
        "button",
        {
          type: "button",
          class: "btn btn-quiet",
          disabled: busy,
          onClick: () => {
            void act(async () => {
              setHistory((await call<{ runs: ImportRun[] }>("admin.import.runs", { limit: 25 }, false)).runs);
            });
          },
        },
        t("imports.history"),
      ),
      runId
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-quiet",
              onClick: () => {
                void act(() => readStatus(runId));
              },
            },
            t("imports.savedRun"),
          )
        : null,
    ),
    history
      ? h(
          Card,
          { title: t("imports.history") },
          h(
            "ul",
            { class: "plain-list" },
            history.map((item) =>
              h(
                "li",
                { key: item.runId },
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-quiet",
                    onClick: () => {
                      remember(item);
                      setHistory(null);
                      setPreflight(null);
                      setAccepted(false);
                    },
                  },
                  `${item.createdAt} · ${item.sourceType} · ${item.state}`,
                ),
              ),
            ),
          ),
        )
      : null,
    runId
      ? h(
          Card,
          { title: t("imports.progress") },
          run
            ? h(
                "div",
                {},
                h(
                  "p",
                  { role: "status", "aria-live": "polite" },
                  t(
                    `imports.state.${run.state.replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase())}` as Key,
                  ),
                ),
                run.progress
                  ? h(
                      "div",
                      {},
                      h(
                        "p",
                        null,
                        `${run.progress.phase}: ${run.progress.completed}${run.progress.total === undefined ? "" : ` / ${run.progress.total}`}`,
                      ),
                      h("progress", {
                        "aria-label": t("imports.progress"),
                        value: run.progress.completed,
                        max: Math.max(1, run.progress.total ?? run.progress.completed + 1),
                      }),
                    )
                  : null,
                run.restored ? h(Notice, {}, t("imports.restored")) : null,
                run.error ? issues([run.error]) : null,
                run.report
                  ? h(
                      "p",
                      null,
                      t("imports.report", {
                        schema: run.report.schema,
                        bytes: run.report.bytes,
                        sha: run.report.sha256,
                      }),
                    )
                  : null,
                run.resumable
                  ? h(
                      "button",
                      { type: "button", class: "btn", disabled: busy, onClick: () => inspectPlan() },
                      t("imports.preflight"),
                    )
                  : null,
                run.rollbackAvailable
                  ? h(
                      "button",
                      { type: "button", class: "btn", disabled: busy, onClick: () => inspectPlan("rollback") },
                      t("imports.rollback"),
                    )
                  : null,
              )
            : h(PageLoading, { label: t("state.loading") }),
          aborting ? h(Notice, {}, t("imports.aborting")) : null,
          !run || !terminalRun(run.state)
            ? h(
                "button",
                { type: "button", class: "btn btn-err", disabled: busy || aborting, onClick: abort },
                t("imports.abort"),
              )
            : null,
          h(
            "button",
            {
              type: "button",
              class: "btn btn-quiet",
              disabled: busy,
              onClick: () => {
                void act(() => readStatus(runId));
              },
            },
            t("imports.refresh"),
          ),
        )
      : null,
    catalogData && (!runId || (run && terminalRun(run.state)))
      ? h(
          Card,
          { title: t("imports.source") },
          h(SourcePicker, {
            catalog: catalogData!,
            value: source,
            set: (value) => {
              setSource(value);
              setDetected(null);
              setDiscovery(null);
              setPlan(null);
              setPreflight(null);
              setSkills(null);
              setAccepted(false);
            },
            busy,
          }),
          h(
            "button",
            { type: "button", class: "btn btn-primary", disabled: busy || !source.family, onClick: () => detect() },
            t("imports.detect"),
          ),
          ["path", "wsl", "ssh"].includes(source.mode)
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn-quiet",
                  disabled: busy || !source.family || !source.path.trim(),
                  onClick: () => detect(undefined, true),
                },
                t("imports.discoverAction"),
              )
            : null,
        )
      : null,
    discovery && !runId
      ? h(
          Card,
          { title: t("imports.discovered") },
          issues(discovery.warnings),
          discovery.candidates.length
            ? h(
                "ul",
                { class: "plain-list" },
                discovery.candidates.map((candidate) =>
                  h(
                    "li",
                    { key: candidate.id },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn-quiet",
                        disabled: busy,
                        onClick: () => detect(candidate.source),
                      },
                      candidate.displayName,
                    ),
                  ),
                ),
              )
            : h("p", null, t("imports.noCandidates")),
          discovery.stores?.length
            ? h(
                "section",
                {},
                h("h3", null, t("imports.discoveredStores")),
                h("p", { class: "field-hint" }, t("imports.storeDiscoveryHint")),
                h(
                  "ul",
                  { class: "plain-list" },
                  discovery.stores.map((store) =>
                    h(
                      "li",
                      { key: store.id },
                      h("strong", null, store.displayName),
                      " · ",
                      h("code", null, store.path),
                      h(
                        "p",
                        null,
                        store.candidateId
                          ? t("imports.storeAssociated", {
                              source:
                                discovery.candidates.find((candidate) => candidate.id === store.candidateId)
                                  ?.displayName ?? t("imports.source"),
                            })
                          : t("imports.storeUnassigned"),
                      ),
                    ),
                  ),
                ),
              )
            : null,
        )
      : null,
    detected && !runId
      ? h(
          Card,
          { title: t("imports.detected") },
          h("p", null, countText(detected.counts)),
          h("p", null, t("imports.fingerprint"), ": ", h("code", null, detected.sourceSha256)),
          issues(detected.warnings),
          detected.unsupported.length
            ? h(Notice, {}, t("imports.unsupported", { items: detected.unsupported.join(", ") }))
            : null,
          h(
            "fieldset",
            { disabled: busy },
            h("legend", null, t("imports.selectAgents")),
            detected.agents.length
              ? detected.agents.map((agent) =>
                  h(
                    "div",
                    { key: agent.id },
                    checkbox(
                      `${agent.displayName} (${agent.skills} skills, ${agent.plugins} plugins, ${agent.mcpServers} MCP)`,
                      agents.includes(agent.id),
                      (checked) => {
                        setAgents((current) =>
                          checked ? [...current, agent.id] : current.filter((id) => id !== agent.id),
                        );
                        setPlan(null);
                        setPreflight(null);
                      },
                    ),
                  ),
                )
              : h("p", null, t("imports.noAgents")),
          ),
          detected.plugins.length
            ? h(
                "div",
                {},
                h("h3", null, t("imports.plugins")),
                h(
                  "ul",
                  {},
                  detected.plugins.map((plugin) =>
                    h("li", { key: plugin.id }, `${plugin.name}: ${plugin.classification} (${plugin.reason})`),
                  ),
                ),
              )
            : null,
          detected.mcpServers.length
            ? h(
                "div",
                {},
                h("h3", null, t("imports.mcp")),
                h(
                  "ul",
                  {},
                  detected.mcpServers.map((server) =>
                    h("li", { key: server.id }, `${server.name}: ${server.transport}`),
                  ),
                ),
              )
            : null,
        )
      : null,
    detected && !runId && catalogData
      ? h(ImportOptions, { flow, hostPathsAllowed: catalogData!.hostPathsAllowed })
      : null,
    plan && !runId
      ? h(
          Card,
          { title: t("imports.preview") },
          h("p", null, countText(plan.counts)),
          h("p", null, "SHA-256 ", h("code", null, plan.planSha256)),
          issues(plan.warnings),
          plan.conflicts.length
            ? h(
                "fieldset",
                { disabled: busy },
                h("legend", null, t("imports.conflicts")),
                plan.conflicts.map((conflict) =>
                  h(
                    "div",
                    { key: conflict.id, class: "field" },
                    h("label", { for: `import-conflict-${conflict.id}` }, `${conflict.entity}: ${conflict.itemId}`),
                    h(
                      "select",
                      {
                        id: `import-conflict-${conflict.id}`,
                        value: conflicts[conflict.id] ?? "",
                        onChange: (event: Event) =>
                          setConflicts((current) => ({
                            ...current,
                            [conflict.id]: (event.target as HTMLSelectElement).value as "skip" | "rename" | "replace",
                          })),
                      },
                      h("option", { value: "" }, t("imports.choose")),
                      conflict.choices.map((choice) => h("option", { value: choice }, t(`imports.${choice}` as Key))),
                    ),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn",
                    disabled: busy || plan.conflicts.some((conflict) => !conflicts[conflict.id]),
                    onClick: createPlan,
                  },
                  t("imports.replan"),
                ),
              )
            : null,
          h(
            "button",
            { type: "button", class: "btn", disabled: busy || plan.conflicts.length > 0, onClick: () => inspectPlan() },
            t("imports.preflight"),
          ),
        )
      : null,
    preflight
      ? h(
          Card,
          { title: t("imports.preflight") },
          issues(preflight.issues),
          preflight.ok
            ? h(
                "div",
                {},
                h(
                  "p",
                  { role: "status" },
                  t("imports.preflightReady", {
                    ms: preflight.estimatedDowntimeMs,
                    required: preflight.requiredBytes,
                    available: preflight.availableBytes,
                  }),
                ),
                checkbox(t("imports.downtime"), accepted, setAccepted),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-primary",
                    disabled: busy || !accepted,
                    onClick: () => {
                      if (preflightOperation === "rollback") rollback();
                      else apply(!!run?.resumable);
                    },
                  },
                  t(
                    preflightOperation === "rollback"
                      ? "imports.rollback"
                      : run?.resumable
                        ? "imports.resume"
                        : "imports.apply",
                  ),
                ),
              )
            : null,
        )
      : null,
    detected && !runId
      ? h(
          Card,
          { title: t("imports.skills") },
          h("p", null, t("imports.skillsNotice")),
          checkbox(t("imports.skillsEnable"), skillsEnable, (value) => {
            setSkillsEnable(value);
            setSkills(null);
          }),
          h(
            "button",
            { type: "button", class: "btn", disabled: busy, onClick: () => skillsOnly(false) },
            t("imports.skillsPreview"),
          ),
          skills
            ? h(
                "div",
                {},
                h(
                  "ul",
                  { class: "plain-list" },
                  skills.skills.map((skill) =>
                    h("li", { key: skill.id }, `${skill.id}: ${skill.action} (${skill.outcome})`),
                  ),
                ),
                issues(skills.warnings),
                issues(skills.errors),
                skills.mode === "dry-run"
                  ? h(
                      "div",
                      {},
                      checkbox(t("imports.skillsConfirm"), skillsAccepted, setSkillsAccepted),
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn",
                          disabled: busy || !skillsAccepted || skills.errors.length > 0,
                          onClick: () => skillsOnly(true),
                        },
                        t("imports.skillsApply"),
                      ),
                    )
                  : null,
              )
            : null,
        )
      : null,
        ],
  );
}
/** Owner/Admin page; other roles invoke no import methods. */
export function ImportPage(): View {
  const role = currentRole();
  return h(
    Page,
    { title: t("imports.title"), width: "settings" },
    role === "owner" || role === "admin" ? h(ImportWizard, {}) : h(PageState, { state: "forbidden" }),
  );
}
