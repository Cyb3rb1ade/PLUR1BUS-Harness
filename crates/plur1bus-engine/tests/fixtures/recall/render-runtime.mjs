// Execute the immutable assembler; fixture collaborators stop at the T5 boundary.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT, NOW, id, row, scenarios } from "./render-scenarios.mjs";
import { captureHelpers } from "./render-helper-cases.mjs";

export async function captureRender(engineRoot, options = {}) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [NOW]));
    }
    static now() {
      return NOW;
    }
  };
  const load = (name) => import(pathToFileURL(path.join(engineRoot, name)));
  const [assembler, warm, params, budget, supplement, crr, disclosure, versions, emotion, acl, maintenance] =
    await Promise.all([
      load("engine/recall/assemble-prompt-context.js"),
      load("engine/recall/warm-recall-path.js"),
      load("engine/recall/namespace-recall.js"),
      load("lib/inject-budget.js"),
      load("engine/recall/system-supplement.js"),
      load("lib/conversation-reactivation-recall.js"),
      load("lib/contradiction-disclosure.js"),
      load("lib/memory-text-contradiction.js"),
      load("lib/emotion.js"),
      load("lib/acl-middleware.js"),
      load("engine/recall/minimal-maintenance.js"),
    ]);
  emotion.setEmotionConfig({ tier: "t1", t2: { enabled: false }, t3: { enabled: false } });
  const results = {};
  try {
    for (const [name, cases] of Object.entries(options.scenarios || scenarios())) {
      results[name] = [];
      for (const input of cases) {
        if (name === "system-supplement") {
          const lines = supplement.buildSystemSupplement({ neoEnabled: input.neo });
          results[name].push({ input, lines, rawLine: JSON.stringify(lines) });
        } else {
          results[name].push(await captureCase(input));
        }
      }
    }
    if (options.scenarios) return results;
    const textAt = (name, variant) => results[name].find((c) => c.input.variant === variant).rawLine;
    assert.notEqual(textAt("render-confidence-framing", "enabled"), textAt("render-confidence-framing", "disabled"));
    assert.notEqual(textAt("render-reactivation-boost", "enabled"), textAt("render-reactivation-boost", "disabled"));
    assert(textAt("render-reactivation-boost", "enabled").includes("memory-reactivation"));
    assert(textAt("render-plain", "fulltext-surrogate").includes("\\ud83d"));
    const helpers = await captureHelpers(load);
    for (const [name, cases] of Object.entries(helpers)) results[name].push(...cases);
    return results;
  } finally {
    globalThis.Date = RealDate;
  }

  async function captureCase(spec, enforceLensAcl = true) {
    const scratch = mkdtempSync(path.join(tmpdir(), "plur1bus-render-"));
    const workspace = path.join(scratch, "workspace");
    mkdirSync(workspace, { recursive: true });
    const calls = { leases: [], embeds: [], pipelines: [], writes: [], llm: 0, neo: [] };
    const warnings = [];
    const logger = {
      info(message) {
        warnings.push(String(message));
      },
      debug(message) {
        warnings.push(String(message));
      },
      warn(message) {
        warnings.push(String(message));
      },
    };
    const rows = structuredClone(spec.rows || []);
    const cfg = spec.cfg || {};
    const memoryCtx = {
      agentId: AGENT,
      workspaceIdentity: "",
      userPrincipal: spec.userPrincipal || "",
      workspaceAliases: { paths: [], aliases: [] },
    };
    const hook = { agentId: AGENT, workspaceDir: workspace, sessionKey: spec.variant };
    if (spec.noWorkspace) delete hook.workspaceDir;
    const event = {
      prompt: spec.prompt ?? "Continue dashboard architecture decisions",
      messages: [],
      ...(spec.internal ? { origin: "internal" } : {}),
    };
    if (spec.overlays?.length) {
      const { InterpretationOverlayStore } = await load("lib/interpretation-overlay.js");
      const overlays = new InterpretationOverlayStore(workspace);
      for (const overlay of spec.overlays) await overlays.append(overlay);
    }
    let crrIndex = null;
    if (spec.previous != null) {
      writeFileSync(
        path.join(workspace, "run-state.json"),
        JSON.stringify({
          sessionTime: { [workspace]: { [AGENT]: { lastActivityAt: spec.previous } } },
        }),
      );
    }
    if (spec.notice) {
      mkdirSync(path.join(scratch, "state"), { recursive: true });
      writeFileSync(
        path.join(scratch, "state", "plur1bus-pending-notice.json"),
        JSON.stringify({
          kind: "plur1bus_start_notice",
          text: spec.notice,
          createdAt: new Date(NOW).toISOString(),
          ttlMs: 60_000,
        }),
      );
    }
    if (spec.pending?.length) {
      const pending = await load("lib/reminder-pending.js");
      await pending.writePendingReminders(workspace, workspace, AGENT, {
        pending: Object.fromEntries(spec.pending.map((r) => [r.id, r])),
      });
    }
    if (spec.reactivation) {
      const memories = [31, 32, 33, 34].map(
        (n) =>
          row(n, {
            text: "Dashboard architecture decisions include boundary " + n,
            summary: "Dashboard architecture decisions boundary " + n,
            agentId: spec.crrWrongOwner ? "other-agent" : AGENT,
            storedBy: spec.crrWrongOwner ? "other-agent" : AGENT,
            memoryStrength: spec.crrFaded ? 0.1 : 0.9,
            ...(n === 34 ? { status: "archived" } : {}),
          }).entry,
      );
      mkdirSync(path.join(workspace, ".plur1bus"), { recursive: true });
      crrIndex = {
        communities: [{ id: "c1", representativeMemoryIds: memories.map((m) => m.id) }],
        memories,
        entries: {},
      };
      writeFileSync(path.join(workspace, ".plur1bus", "semantic-lens-index.json"), JSON.stringify(crrIndex));
      crr.markUserTurn(AGENT, spec.variant, NOW - 3_600_000);
      if (spec.crrCooldown) crr.markCrrRun(AGENT, spec.variant, NOW - 60_000);
    }
    if (spec.lensIndex) {
      mkdirSync(path.join(workspace, ".plur1bus"), { recursive: true });
      writeFileSync(path.join(workspace, ".plur1bus", "semantic-lens-index.json"), JSON.stringify(spec.lensIndex));
    }
    const query = {
      where() {
        return this;
      },
      limit() {
        return this;
      },
      async toArray() {
        return structuredClone(spec.reminders || []);
      },
    };
    const db = {
      async init() {
        return !spec.missingTable;
      },
      table: spec.missingTable
        ? null
        : {
            query: () => query,
            async update(change) {
              calls.writes.push(change);
            },
          },
      async getById(memoryId) {
        const memory = [...rows.map((r) => r.entry), ...(spec.hydratedRows || [])].find((r) => r.id === memoryId);
        // Controller-approved exception: the same checkAccess guard as CRR hydration.
        // No denial data, ID, counter or log is emitted by this boundary.
        return memory && (!enforceLensAcl || acl.checkAccess(memoryCtx, memory).allowed) ? memory : null;
      },
    };
    const pool = {
      async withWriteDb(_agent, work) {
        calls.leases.push("write");
        return work(db);
      },
      async withDb(_agent, work) {
        calls.leases.push("maintenance");
        return work(db);
      },
      async withReadDbs(_agent, work) {
        calls.leases.push("read");
        return work([{ db, namespace: null }]);
      },
      async withReadOnlyReadDbs(_agent, work) {
        calls.leases.push("read-only");
        if (spec.readLeaseError) throw new Error("synthetic read lease unavailable");
        return work([{ db, namespace: null }]);
      },
    };
    const neoItems = [
      {
        id: id(41),
        statement: "Dashboard architecture decisions use explicit fixture boundaries",
        category: "architecture_decision",
        status: "active",
        confidence: 0.9,
        importance: 0.9,
        agentId: AGENT,
        scope: "agent_private",
        origin: { scope: "agent_private", trustLevel: "user_asserted" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const neoStore = {
      recordHook() {
        calls.neo.push("record-hook");
      },
      readGraphEdges: () => [],
      readPatterns: () => [],
      readCandidates: () => neoItems,
      readBehaviorCards: () => [],
      appendRetrievalLedger() {
        throw new Error("fixture pipeline must not write a ledger");
      },
    };
    const emo = {
      hydrateOnce() {},
      applyEmotionScore() {},
      updateFromMessages() {},
      describeMood: () => spec.mood ?? null,
      serializeState: () => ({}),
    };
    const embeddings = {
      async embedQuery(_text, options) {
        calls.embeds.push({ persist: options?.persist ?? null, agentId: options?.agentId ?? null });
        return [1, 0];
      },
    };
    const ctx = {
      cfg,
      ...(options.stats ? { recallStats: { record(agent, ids, query, now) {
        (calls.stats ||= []).push({ agent, ids, query, now });
        if (spec.statsError) throw new Error("synthetic statistics unavailable");
      } } } : {}),
      host: { stateDir: scratch, logger },
      stateDir: scratch,
      pool,
      sharedMemoryPool: {
        withUserReadDb: async (_ctx, work) => work(null),
        withWorkspaceReadDb: async (_ctx, work) => work(null),
      },
      embeddings,
      automaticWorkspacePolicyDecision: () => ({ allowed: !spec.denied }),
      workspacePolicyGuard: { automatic: () => ({ allowed: true }) },
      emotionalPool: { get: () => emo, describe: () => spec.mood ?? null },
      runtimeScheduler: {
        config: { recallTimeoutMs: 600 },
        async runRecall({ signal, phaseTimer }, work) {
          try {
            const value = spec.cachedResult ? structuredClone(spec.cachedResult) : await work(signal, phaseTimer);
            return { ok: true, value, fromCache: !!spec.cachedResult };
          } catch (error) {
            return { ok: false, error };
          }
        },
      },
      neoEnabled: !!spec.neo,
      neoWorkerRuntime: {
        warmUp() {
          calls.neo.push("warm");
        },
      },
      getNeoStore: () => neoStore,
      peekNeoStore: () => neoStore,
      markNeoRecallInjection: () => (spec.neoAlreadyInjected ? null : "fixture-turn"),
      neoRequester: () => ({ requesterAgentId: AGENT }),
      neoGlobalRecall: { embedTimeoutMs: 100, dedupeThreshold: 0.85 },
      runNeoGlobalSearch: () => null,
      NEO_EMBED_TIMEOUT: Symbol("timeout"),
      NEO_RECALL_PRELUDE_LOG_MS: Infinity,
      namespaceLayout: { recallReadNamespaces: [null] },
      adaptiveBudgetCfg: cfg.adaptiveBudget,
      maxPromptMemories: params.normalizeBoundedRecallInteger(cfg.recall?.maxPromptMemories, 12, 1, 100),
      resolveRuntimeRecallBudget: params.resolveRuntimeRecallBudget,
      normalizeBoundedRecallInteger: params.normalizeBoundedRecallInteger,
      rerankerCfg: {},
      summaryMaxWords: cfg.summaryMaxWords ?? 150,
      traceEnabled: !!spec.trace,
      traceInPrompt: !!spec.trace,
      traceCfg: {},
      semanticCompressionCfg: cfg.semanticCompression || {},
      semanticLensCfg: cfg.semanticLens || cfg.recall?.semanticLens || {},
      makeQuerySummarizer: () => null,
      softBudgetMs: 400,
      gcEnabled: false,
      replyOutcomeEnabled: false,
      temporalContextEnabled: !!spec.temporal,
      schicht15Enabled: false,
      skillMinerEnabled: false,
      skillLedgerDirForAgent: () => null,
      detectReactionsCapabilityCached: () => false,
      buildMaintenanceNudges: () => ({ knowledgeNudge: spec.knowledgeNudge || "", conflictNudge: "" }),
      resolveCommandLocaleRecall: () => ({ lang: spec.lang || "en", tone: "neutral" }),
      mergingEnabled: !!spec.contradictions,
      memoryTextContradictionLlmCfg: { kind: "direct-override" },
      async callLlm() {
        calls.llm++;
        return "yes";
      },
      dbg() {},
      normalizedLlmErrorClass: () => "fixture",
      async runMergedNamespaceRecall(_dbs, options, trace) {
        calls.pipelines.push({
          topN: options.topN,
          summaryMaxWords: options.summaryMaxWords,
          readOnly: options.readOnly,
          hasRetrievalLogger: typeof options.retrievalLogger === "function",
          hasQuerySummarizer: typeof options.querySummarizer === "function",
          hasEmotionalState: !!options.emotionalState,
        });
        await options.embeddings.embedQuery(options.query, { agentId: AGENT });
        if (spec.pipelineError) throw new Error(spec.pipelineErrorDetail || "synthetic pipeline unavailable");
        return { memories: rows.slice(0, options.topN), canonical: structuredClone(spec.canonical || []), trace };
      },
    };
    ctx.warmRecallPath = warm.createWarmRecallPath(ctx);
    try {
      const result = spec.minimal
        ? await maintenance.createMinimalMaintenance(ctx)(event, hook)
        : await assembler.createPromptContextAssembler(ctx)(event, hook, {
            signal: new AbortController().signal,
            memoryCtx,
            agentContext: { origin: "user", background: false },
            warmOnly: !!spec.warm,
          });
      delete result.timing; // T6 owns wall-clock phases; all T5 fields remain verbatim.
      assert(
        !result.degraded || spec.pipelineError || spec.readLeaseError,
        "unexpected fixture degradation: " + JSON.stringify(result.degraded),
      );
      const joined = budget.planGlobalInjectBudget({ blocks: result.blocks, maxChars: result.capChars });
      const output = {
        input: spec,
        result,
        rawLine: JSON.stringify(result),
        blockTexts: result.blocks.map((b) => b.text),
        joined,
        joinedLine: JSON.stringify(joined),
        calls,
      };
      output.dependencies = {
        neoPrelude: result.blocks.find((b) => b.name === "neo")?.text || "",
        reactivationIndex: crrIndex,
        reactivationIndexLine: JSON.stringify(crrIndex),
        lastUserTurnAt: spec.reactivation ? NOW - 3_600_000 : null,
        lastCrrAt: spec.crrCooldown ? NOW - 60_000 : null,
      };
      if (spec.lensSecurity && enforceLensAcl) {
        const denied = spec.hydratedRows[0];
        const safe =
          !output.rawLine.includes(denied.id) &&
          !output.rawLine.includes(denied.text) &&
          !warnings.some((message) => message.includes(denied.id) || message.includes(denied.text));
        assert(safe, "Lens must not expose denied row data");
        assert(output.rawLine.includes(rows[0].entry.id), "authorized base must remain");
        output.securityChecks = { deniedAbsent: safe, authorizedBasePresent: true, lensLogsContainDeniedData: false };
        const pin = await captureCase(spec, false);
        if (pin.rawLine !== output.rawLine) {
          output.parityException = {
            id: "RE-04-T5-LENS-ACL",
            controllerDecision: "2026-11-01",
            stopReport: "docs/superpowers/plans/rust-engine/RE-04-T5-semantic-lens-acl-stop.md",
            boundary: "canonical request checkAccess on hydrated Lens rows",
            pinDiffers: true,
          };
        }
      }
      if (spec.contradictions) {
        const [a, b] = rows.map((r) => r.entry);
        const winner = versions.resolveContradictionWinner(a, b);
        const pairs = [{ winner, loser: winner === a ? b : a }];
        output.disclosure = disclosure.formatContradictionDisclosure(pairs, cfg.contradictionDisclosure || {});
        output.disclosureLine = JSON.stringify(output.disclosure);
        output.winnerId = winner.id;
      }
      if (spec.warm) assert.equal(calls.writes.length, 0);
      return output;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
