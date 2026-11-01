// Extra pure-helper oracles complement actual assembler cases; no expected text.
import { AGENT, NOW, id, row } from "./render-scenarios.mjs";

export function helperCases() {
  const memory = {
    id: id(70),
    category: "note/unsafe <attr>",
    source: "cron",
    display: "Text <&>\u0001\n\n\n     gap 😀",
    createdAt: NOW - 2 * 86_400_000,
    memoryStrength: 0.11,
    epistemicStatus: "tool_verified",
    relevanceScore: 0.615,
  };
  const pattern = {
    id: "pattern:fixture",
    memberIds: [id(70), id(71)],
    patternName: "Architecture <pattern>",
    description: "Observed & provisional",
    createdAt: NOW - 604_800_000,
    confidence: 0.9,
  };
  return {
    "render-plain": [
      {
        variant: "formatter-overlays-pattern-lens",
        kind: "formatter",
        memories: [memory],
        options: {
          overlays: [
            { targetMemoryId: id(70), status: "provisional", shiftDescription: "must not appear" },
            {
              targetMemoryId: id(70),
              shiftDescription: "First live interpretation <&>",
              shiftType: "meaning",
              confidence: 0.615,
              contradiction: true,
              createdAt: NOW - 604_800_000,
              provenance: { triggerMemoryIds: [id(71), "bad<id>"] },
            },
            { targetMemoryId: id(70), shiftDescription: "later ignored" },
          ],
          matchedPattern: { pattern, triggerIds: [id(70), id(71)], score: 0.615 },
          semanticLensMemories: [{ ...memory, id: id(71), display: "Lens candidate" }],
        },
      },
      {
        variant: "formatter-trace-fallback",
        kind: "formatter",
        memories: [memory],
        options: {
          decisionTrace: {
            candidates: [{ id: id(70), source: "graph", score: 0.615 }],
            decisions: [
              { memoryId: id(70), action: "inclusion", stage: "graph", reason: "derived <edge>" },
              { memoryId: id(71), action: "deduped", stage: "dedupe" },
              { memoryId: id(72), action: "merged", stage: "merge" },
            ],
            guards: [{ passed: true }, { passed: false }],
          },
          traceOptions: { includeInPrompt: true },
        },
      },
      {
        variant: "formatter-authoritative-operational",
        kind: "formatter",
        memories: [{ ...memory, display: "Stop production service", authoritative: true, memoryStrength: 1 }],
        options: {},
      },
      {
        variant: "formatter-unknown-age",
        kind: "formatter",
        memories: [{ ...memory, createdAt: 0, lastRetrievedAt: NOW, display: "Service was live" }],
        options: {},
      },
      {
        variant: "formatter-numeric-version",
        kind: "formatter",
        memories: [{ ...memory, versionNumber: "0x10", memoryStrength: 1 }],
        options: {},
      },
    ],
    "render-global-cap-drops": [
      {
        variant: "nested-unknown-wrapper",
        kind: "budget",
        cap: 210,
        blocks: [
          {
            name: "custom",
            droppable: true,
            text:
              "<outer><!-- ignore <x> --><trace-summary /><inner><memory-record>one</memory-record>" +
              "<memory-record>" +
              "second ".repeat(25) +
              "</memory-record></inner></outer>",
          },
        ],
      },
      {
        variant: "plain-droppable-whole",
        kind: "budget",
        cap: 5,
        blocks: [{ name: "plain", text: "notice too long", droppable: true }],
      },
      ...["\uFEFF", "\u0085"].map((whitespace) => ({
        variant: "tag-whitespace-" + whitespace.codePointAt(0),
        kind: "budget",
        cap: 160,
        blocks: [
          {
            name: "custom",
            droppable: true,
            text:
              "<outer" +
              whitespace +
              "id='x'><memory-record>one</memory-record><memory-record>" +
              "second ".repeat(25) +
              "</memory-record></outer>",
          },
        ],
      })),
    ],
    "render-confidence-framing": [
      {
        variant: "ties-stable-cap",
        kind: "confidence",
        memories: [0.9, 0.2, 0.2, 0.2, 0.8, 0.8].map((score, i) => ({ id: id(80 + i), relevanceScore: score })),
        options: { bottomFraction: 0.5, maxHedged: 2 },
      },
      {
        variant: "no-spread",
        kind: "confidence",
        memories: [0.2, 0.2, 0.2].map((score, i) => ({ id: id(80 + i), relevanceScore: score })),
        options: {},
      },
      {
        variant: "invalid-fraction",
        kind: "confidence",
        memories: [0.9, 0.5, 0.2].map((score, i) => ({ id: id(80 + i), relevanceScore: score })),
        options: { bottomFraction: "bad" },
      },
    ],
    "render-reactivation-boost": [
      {
        variant: "selector-community-and-caps",
        kind: "reactivation",
        prompt: "Continue dashboard architecture",
        baseRecallIds: [id(1)],
        cfg: { maxReactivationMemories: 99, maxFadedReactivationMemories: 99 },
        requestContext: {
          agentId: AGENT,
          workspaceIdentity: "",
          userPrincipal: "",
          workspaceAliases: { paths: [], aliases: [] },
        },
        memories: [31, 32, 33, 34].map((n) => ({
          id: id(n),
          category: "project",
          display: "Dashboard architecture decisions " + n,
          memoryStrength: n === 32 || n === 33 ? 0.1 : 0.9,
          scope: "agent-private",
          agentId: n === 34 ? "other-agent" : AGENT,
          storedBy: n === 34 ? "other-agent" : AGENT,
          createdAt: NOW - 3_600_000,
        })),
      },
      ...[
        "bound",
        "foreign-endpoint",
        "drifted-hydration",
        "legacy",
        "missing-nested",
        "conflicting-source",
        "conflicting-target",
        "sparse-bound",
      ].map((graphCase) => ({
        variant: "selector-graph-" + graphCase,
        graphCase,
        kind: "reactivation",
        prompt: "Unrelated question",
        baseRecallIds: [id(1)],
        cfg: {},
        memories: [],
        requestContext: {
          agentId: AGENT,
          workspaceIdentity: "",
          userPrincipal: "",
          workspaceAliases: { paths: [], aliases: [] },
        },
        hydrated: [
          row(62, {
            text: "Bound bridge fixture",
            summary: "Bound bridge fixture",
            ...(graphCase === "drifted-hydration" ? { scope: "user", ownerUserId: "user:v2:" + "a".repeat(64) } : {}),
          }).entry,
        ],
      })),
      ...["numeric", "prefixed", "array"].map((shape) => {
        const first = { id: "community-two", representativeMemoryIds: [id(64)] };
        const second = { id: "community-one", representativeMemoryIds: [id(65)] };
        const communities =
          shape === "array"
            ? JSON.stringify([first, second])
            : "{" +
              JSON.stringify(shape === "numeric" ? "2" : "prefix-2") +
              ":" +
              JSON.stringify(first) +
              "," +
              JSON.stringify(shape === "numeric" ? "1" : "prefix-1") +
              ":" +
              JSON.stringify(second) +
              "}";
        return {
          variant: "selector-object-order-" + shape,
          kind: "reactivation",
          memories: [],
          prompt: "Dashboard architecture",
          baseRecallIds: [],
          cfg: { maxCommunities: 1, maxReactivationMemories: 1 },
          requestContext: {
            agentId: AGENT,
            workspaceIdentity: "",
            userPrincipal: "",
            workspaceAliases: { paths: [], aliases: [] },
          },
          semanticLensLine:
            '{"communities":' +
            communities +
            ',"memories":' +
            JSON.stringify([row(64).entry, row(65).entry]) +
            ',"entries":{}}',
        };
      }),
      ...["array", "object"].map((shape) => ({
        variant: "selector-community-shape-" + shape,
        kind: "reactivation",
        prompt: "Dashboard architecture",
        baseRecallIds: [],
        cfg: {},
        memories: [],
        requestContext: {
          agentId: AGENT,
          workspaceIdentity: "",
          userPrincipal: "",
          workspaceAliases: { paths: [], aliases: [] },
        },
        semanticLens: {
          memories: [row(63).entry],
          entries: {},
          communities:
            shape === "array"
              ? [null, [], "invalid", 0, { id: "valid", representative: id(63) }]
              : { valid: { id: "valid", memoryIds: [id(63)] } },
        },
      })),
    ],
    "render-contradiction-disclosure": [
      {
        variant: "version-order-ties",
        kind: "versions",
        memories: [
          { id: "older", versionNumber: 2, status: "active", createdAt: 10 },
          { id: "authoritative", versionNumber: 2, status: "active", updateSource: "user_correction", createdAt: 1 },
          { id: "newest", versionNumber: 3, status: "superseded", createdAt: 0 },
          { id: "same", versionNumber: 2, status: "active", createdAt: 10 },
        ],
      },
      ...["preview", "apply", "unauthorized", "drift"].map((variant) => ({
        variant: "injected-conflicts-" + variant,
        kind: "injected-conflicts",
        action: variant,
        requester: { requesterAgentId: AGENT },
        cards: [
          {
            id: "injected",
            agentId: AGENT,
            status: "conflict",
            statement: "<relevant-memories>historical fixture</relevant-memories>",
            createdAt: NOW - 1000,
          },
          {
            id: "foreign",
            agentId: "other-agent",
            status: "conflict",
            statement: "<relevant-memories>foreign fixture</relevant-memories>",
          },
          { id: "ordinary", agentId: AGENT, status: "conflict", statement: "Ordinary behavior disagreement" },
        ],
      })),
    ],
  };
}

export async function captureHelpers(load) {
  const [formatter, budget, confidence, versions, crr, injected, neo, graph] = await Promise.all([
    load("lib/relevant-memory-context.js"),
    load("lib/inject-budget.js"),
    load("lib/recall-confidence-framing.js"),
    load("lib/memory-text-contradiction.js"),
    load("lib/conversation-reactivation-recall.js"),
    load("lib/drop-injected-conflicts.js"),
    load("lib/neo-arch.js"),
    load("lib/memory-graph.js"),
  ]);
  const result = {};
  for (const [name, cases] of Object.entries(helperCases())) {
    result[name] = [];
    for (const input of cases) {
      let value;
      const deferrals = [];
      if (input.kind === "formatter") {
        value = formatter.formatRelevantMemoriesContext(input.memories, {
          ...structuredClone(input.options),
          now: NOW,
          onTruncate: (d) => deferrals.push(d),
        });
      } else if (input.kind === "budget") {
        value = budget.planGlobalInjectBudget({ blocks: input.blocks, maxChars: input.cap });
      } else if (input.kind === "confidence") {
        value = confidence.frameRecallConfidence(input.memories, input.options);
      } else if (input.kind === "versions") {
        value = versions.rankMemoryVersions(input.memories).map((m) => m.id);
      } else if (input.kind === "reactivation") {
        if (input.graphCase) {
          const source = row(1).entry;
          const target = row(
            62,
            input.graphCase === "foreign-endpoint" ? { agentId: "other-agent", storedBy: "other-agent" } : {},
          ).entry;
          input.graphEdges = [
            input.graphCase === "legacy"
              ? { source: source.id, target: target.id }
              : graph.createEdge(source.id, target.id, "semantic", 0.9, false, {
                  sourceOwnership: graph.canonicalGraphOwnership(source),
                  targetOwnership: graph.canonicalGraphOwnership(target),
                }),
          ];
        }
        if (input.graphCase && input.graphCase !== "legacy") {
          const edge = input.graphEdges[0];
          input.graphEdges[0] = {
            ...edge,
            sourceOwnership: { ...edge.sourceOwnership },
            targetOwnership: { ...edge.targetOwnership },
            ownership: { source: { ...edge.ownership.source }, target: { ...edge.ownership.target } },
          };
        }
        if (input.graphCase === "missing-nested") delete input.graphEdges[0].ownership;
        if (input.graphCase === "conflicting-source") input.graphEdges[0].ownership.source.agentId = "other-agent";
        if (input.graphCase === "conflicting-target")
          input.graphEdges[0].ownership.target.ownerUserId = "user:v2:" + "b".repeat(64);
        if (input.graphCase === "sparse-bound") {
          for (const tuple of [input.graphEdges[0].sourceOwnership, input.graphEdges[0].targetOwnership]) {
            delete tuple.workspaceIdentity;
            delete tuple.ownerUserId;
          }
        }
        const selected = await crr.selectReactivationMemories({
          ...input,
          semanticLens: input.semanticLensLine
            ? JSON.parse(input.semanticLensLine)
            : input.semanticLens || {
                memories: input.memories,
                communities: [{ id: "helper-community", representativeMemoryIds: input.memories.map((m) => m.id) }],
                entries: {},
              },
          graphEdges: input.graphEdges || [],
          now: NOW,
          getMemoryById: async (memoryId) => input.hydrated?.find((memory) => memory.id === memoryId) || null,
        });
        value = {
          ids: selected.memories.map((m) => m.id),
          text: crr.formatReactivationContext(selected.memories, {
            requestContext: input.requestContext,
            now: NOW,
            visibleHints: true,
          }),
        };
      } else if (input.kind === "injected-conflicts") {
        input.classified = input.cards.map((card) => neo.isInjectedContextText(card.statement));
        const updates = [];
        const store = {
          readBehaviorCards: () => input.cards,
          appendBehaviorCards: (cards) => {
            updates.push(...cards);
            return cards;
          },
        };
        const preview = injected.previewDropInjected(store, input.requester);
        const applied =
          input.action === "preview"
            ? null
            : injected.applyDropInjected(store, {
                authorized: input.action !== "unauthorized",
                requester: input.requester,
                expectedHash: input.action === "drift" ? "different" : preview.hash,
                expectedCount: preview.count,
              });
        value = { preview, applied, updates };
      }
      result[name].push({ input, value, rawLine: JSON.stringify(value), deferrals });
    }
  }
  return result;
}
