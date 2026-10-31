/** Prompt-based memory import wizard: provider selection, copy prompt, paste answer, preview & target curation, apply and rollback. */
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Card, Badge } from "../../components/card.ts";
import { t, type Key } from "../../i18n.ts";
import { getApi } from "../common/load.ts";
import { FailureState, Notice } from "../common/states.ts";

export type Provider = "chatgpt" | "claude" | "gemini" | "grok" | "copilot" | "lechat" | "other";

export interface EntryRow {
  category: "Instructions" | "Identity" | "Career" | "Projects" | "Preferences" | "Other";
  sourceType: "memory" | "chat" | "unknown";
  recordedAt?: string;
  text: string;
  raw: string;
  warnings: string[];
  idempotencyKey: string;
  target: "skip" | "user" | "agent" | "workspace" | "propose-rule";
  agentIds?: string[];
  workspaceId?: string;
}

const PROVIDERS: readonly Provider[] = [
  "chatgpt",
  "claude",
  "gemini",
  "grok",
  "copilot",
  "lechat",
  "other",
];

export function PromptImportWizard(): View {
  const [provider, setProvider] = useState<Provider>("chatgpt");
  const [promptText, setPromptText] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const [inputText, setInputText] = useState<string>("");
  const [extraParts, setExtraParts] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"complete" | "more" | "unrecognized">("complete");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [hasPreviewed, setHasPreviewed] = useState<boolean>(false);
  const [appliedRun, setAppliedRun] = useState<{
    runId: string;
    imported: number;
    linked: number;
    proposedRules: number;
    skipped: number;
    reportPath: string;
  } | null>(null);
  const [rollbackResult, setRollbackResult] = useState<{
    rolledBack: number;
    discardedProposals: number;
  } | null>(null);

  // Fetch initial prompt from core on mount
  useEffect(() => {
    let active = true;
    void getApi()
      .rpc("memory.importText.preview", { text: "" })
      .then((res: any) => {
        if (active && res && typeof res.prompt === "string" && res.prompt.length > 0) {
          setPromptText(res.prompt);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const copyPrompt = () => {
    if (promptText) {
      void navigator.clipboard?.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePreview = async () => {
    const fullText = [inputText, ...extraParts].filter((s) => s.trim().length > 0).join("\n\n");
    if (!fullText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res: any = await getApi().rpc("memory.importText.preview", { text: fullText });
      if (res.prompt && !promptText) setPromptText(res.prompt);
      setStatus(res.status ?? "complete");
      setWarnings(res.warnings ?? []);
      const dupSet = new Set<string>(res.duplicates ?? []);
      setDuplicates(Array.from(dupSet));

      const rows: EntryRow[] = (res.entries ?? []).map((e: any) => {
        const hasSecret = e.warnings?.includes("secret-redacted");
        const isInstruction = e.category === "Instructions";
        let defaultTarget: EntryRow["target"] = "skip";
        if (!hasSecret && !isInstruction) {
          defaultTarget = "user";
        } else if (isInstruction && !hasSecret) {
          defaultTarget = "propose-rule";
        }
        return {
          category: e.category,
          sourceType: e.sourceType,
          recordedAt: e.recordedAt,
          text: e.text,
          raw: e.raw,
          warnings: e.warnings ?? [],
          idempotencyKey: e.idempotencyKey,
          target: defaultTarget,
        };
      });
      setEntries(rows);
      setHasPreviewed(true);
    } catch (err: any) {
      setError(err?.message ?? t("imports.failure"));
    } finally {
      setLoading(false);
    }
  };

  const applyRecommendations = () => {
    setEntries((current) =>
      current.map((row) => {
        const hasSecret = row.warnings.includes("secret-redacted");
        if (hasSecret) {
          return { ...row, target: "skip" };
        }
        if (row.category === "Instructions") {
          return { ...row, target: "propose-rule" };
        }
        return { ...row, target: "user" };
      }),
    );
  };

  const setCategoryTarget = (cat: EntryRow["category"], target: EntryRow["target"]) => {
    setEntries((current) =>
      current.map((row) => (row.category === cat ? { ...row, target } : row)),
    );
  };

  const updateRowTarget = (index: number, target: EntryRow["target"]) => {
    setEntries((current) =>
      current.map((r, i) => (i === index ? { ...r, target } : r)),
    );
  };

  const handleApply = async () => {
    setLoading(true);
    setError(null);
    try {
      const targets = entries.map((e) => ({
        target: e.target,
        ...(e.agentIds ? { agentIds: e.agentIds } : {}),
        ...(e.workspaceId ? { workspaceId: e.workspaceId } : {}),
      }));
      const res: any = await getApi().rpc("memory.importText.apply", {
        entries,
        targets,
        dryRun: false,
      });
      setAppliedRun(res);
    } catch (err: any) {
      setError(err?.message ?? t("imports.failure"));
    } finally {
      setLoading(false);
    }
  };

  const handleRollback = async () => {
    if (!appliedRun?.runId) return;
    setLoading(true);
    setError(null);
    try {
      const res: any = await getApi().rpc("memory.importText.rollback", {
        runId: appliedRun.runId,
      });
      setRollbackResult(res);
    } catch (err: any) {
      setError(err?.message ?? t("imports.failure"));
    } finally {
      setLoading(false);
    }
  };

  return h(
    "div",
    { class: "prompt-import-wizard" },
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,

    // Step 1: Provider selection & prompt
    h(
      Card,
      { title: t("imports.prompt.chooseProvider") },
      h(
        "div",
        { class: "field" },
        h("label", { for: "provider-select" }, t("imports.prompt.chooseProvider")),
        h(
          "select",
          {
            id: "provider-select",
            value: provider,
            onChange: (e: Event) => setProvider((e.target as HTMLSelectElement).value as Provider),
          },
          PROVIDERS.map((p) =>
            h("option", { key: p, value: p }, t(`imports.prompt.provider.${p}` as Key)),
          ),
        ),
      ),
      h("p", { class: "field-hint" }, t(`imports.prompt.hint.${provider}` as Key)),
      promptText
        ? h(
            "div",
            {},
            h("pre", { class: "prompt-display", "aria-label": t("imports.prompt.title") }, promptText),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                onClick: copyPrompt,
              },
              copied ? t("imports.prompt.copiedPrompt") : t("imports.prompt.copyPrompt"),
            ),
          )
        : null,
    ),

    // Step 2: Paste answer
    h(
      Card,
      { title: t("imports.prompt.pasteLabel") },
      h(
        "div",
        { class: "field" },
        h("label", { for: "import-text-input" }, t("imports.prompt.pasteLabel")),
        h("textarea", {
          id: "import-text-input",
          rows: 8,
          value: inputText,
          onInput: (e: Event) => setInputText((e.target as HTMLTextAreaElement).value),
          placeholder: "PLUR1BUS-MEMORY-EXPORT v1\n...",
        }),
      ),
      extraParts.map((part, idx) =>
        h(
          "div",
          { key: idx, class: "field" },
          h("label", { for: `import-text-part-${idx}` }, `${t("imports.prompt.addPart")} ${idx + 2}`),
          h("textarea", {
            id: `import-text-part-${idx}`,
            rows: 6,
            value: part,
            onInput: (e: Event) => {
              const val = (e.target as HTMLTextAreaElement).value;
              setExtraParts((cur) => cur.map((p, i) => (i === idx ? val : p)));
            },
          }),
        ),
      ),
      status === "more" || extraParts.length > 0
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-quiet",
              onClick: () => setExtraParts((cur) => [...cur, ""]),
            },
            t("imports.prompt.addPart"),
          )
        : null,
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary",
          disabled: loading || !inputText.trim(),
          onClick: handlePreview,
        },
        t("imports.prompt.previewAction"),
      ),
    ),

    // Step 3: Preview and target curation
    hasPreviewed && entries.length > 0 && !appliedRun
      ? h(
          Card,
          { title: t("imports.prompt.previewTitle") },
          h(
            "div",
            { class: "chip-row" },
            h(
              "button",
              { type: "button", class: "btn btn-quiet", onClick: applyRecommendations },
              t("imports.prompt.applyRecommendations"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                onClick: () => setCategoryTarget("Preferences", "user"),
              },
              t("imports.prompt.bulkPreferences"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                onClick: () => setCategoryTarget("Identity", "user"),
              },
              t("imports.prompt.bulkIdentity"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                onClick: () => setCategoryTarget("Career", "user"),
              },
              t("imports.prompt.bulkCareer"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                onClick: () => setCategoryTarget("Projects", "user"),
              },
              t("imports.prompt.bulkProjects"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                onClick: () => setCategoryTarget("Instructions", "propose-rule"),
              },
              t("imports.prompt.bulkInstructions"),
            ),
          ),
          h(
            "table",
            { class: "prompt-entry-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", null, "Kategorie"),
                h("th", null, "Datum"),
                h("th", null, "Quelle / Hinweise"),
                h("th", null, "Erinnerung"),
                h("th", null, "Ziel"),
              ),
            ),
            h(
              "tbody",
              null,
              entries.map((entry, idx) => {
                const isDup = duplicates.includes(entry.idempotencyKey);
                const hasSecret = entry.warnings.includes("secret-redacted");
                const isRule = entry.category === "Instructions";
                const isChat = entry.sourceType === "chat";
                const dateUnknown = !entry.recordedAt;

                return h(
                  "tr",
                  { key: entry.idempotencyKey || idx },
                  h("td", null, h("strong", null, entry.category)),
                  h(
                    "td",
                    null,
                    entry.recordedAt
                      ? entry.recordedAt.slice(0, 10)
                      : h(Badge, { tone: "neutral" }, t("imports.prompt.badge.unknownDate")),
                  ),
                  h(
                    "td",
                    null,
                    isDup ? h(Badge, { tone: "info" }, t("imports.prompt.badge.duplicate")) : null,
                    hasSecret ? h(Badge, { tone: "warn" }, t("imports.prompt.badge.secret")) : null,
                    isRule ? h(Badge, { tone: "neutral" }, t("imports.prompt.badge.rule")) : null,
                    isChat ? h(Badge, { tone: "neutral" }, t("imports.prompt.badge.chat")) : null,
                  ),
                  h(
                    "td",
                    null,
                    h("span", { class: "reading" }, entry.text),
                    entry.target === "agent" && (entry.category === "Identity" || entry.category === "Career")
                      ? h(Notice, {}, t("imports.prompt.warningAgentPrivate"))
                      : null,
                    entry.target === "workspace"
                      ? h("p", { class: "field-hint" }, t("imports.prompt.warningWorkspace"))
                      : null,
                  ),
                  h(
                    "td",
                    null,
                    h(
                      "select",
                      {
                        "aria-label": `Ziel für Eintrag ${idx + 1}`,
                        value: entry.target,
                        onChange: (e: Event) =>
                          updateRowTarget(idx, (e.target as HTMLSelectElement).value as EntryRow["target"]),
                      },
                      h("option", { value: "skip" }, t("imports.prompt.target.none")),
                      isRule
                        ? [
                            h(
                              "option",
                              { key: "prop-user", value: "propose-rule" },
                              t("imports.prompt.target.userProposal"),
                            ),
                          ]
                        : [
                            h("option", { key: "user", value: "user" }, t("imports.prompt.target.user")),
                            h("option", { key: "agent", value: "agent" }, t("imports.prompt.target.agent")),
                            ...(entry.category === "Projects"
                              ? [
                                  h(
                                    "option",
                                    { key: "workspace", value: "workspace" },
                                    t("imports.prompt.target.workspace"),
                                  ),
                                ]
                              : []),
                          ],
                    ),
                  ),
                );
              }),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-primary",
              disabled: loading,
              onClick: handleApply,
            },
            t("imports.prompt.apply"),
          ),
        )
      : null,

    hasPreviewed && entries.length === 0 && !appliedRun
      ? h(Notice, {}, t("imports.prompt.empty"))
      : null,

    // Step 4: Outcome & Rollback
    appliedRun
      ? h(
          Card,
          { title: t("imports.prompt.success") },
          h(
            "p",
            null,
            t("imports.prompt.resultCounts", {
              imported: appliedRun.imported,
              linked: appliedRun.linked,
              proposedRules: appliedRun.proposedRules,
              skipped: appliedRun.skipped,
              runId: appliedRun.runId,
            }),
          ),
          !rollbackResult
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn-err",
                  disabled: loading,
                  onClick: handleRollback,
                },
                t("imports.prompt.rollback"),
              )
            : h(
                Notice,
                {},
                t("imports.prompt.rollbackSuccess", {
                  rolledBack: rollbackResult.rolledBack,
                  discardedProposals: rollbackResult.discardedProposals,
                }),
              ),
        )
      : null,
  );
}
