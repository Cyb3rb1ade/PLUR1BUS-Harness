// Synthetic selected rows are the T3/T4 boundary, never expected render output.
export const NOW = Date.UTC(2026, 0, 13, 12);
export const AGENT = "render-fixture";
export const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
export function row(n, overrides = {}) {
  return {
    entry: {
      id: id(n),
      text: "Dashboard architecture notes: quote <section> & verify 👩🏽‍💻. " + "Detail sentence. ".repeat(40),
      summary: "Dashboard architecture notes <summary> & decisions",
      category: "project",
      origin: "dm",
      memoryStrength: 1,
      createdAt: NOW - 3_600_000,
      epistemicStatus: "user_asserted",
      status: "active",
      scope: "agent-private",
      agentId: AGENT,
      storedBy: AGENT,
      ...overrides,
    },
    score: 0.9,
    source: "vector",
    depth: 0,
  };
}
const ordinary = () => [
  row(1),
  { ...row(2, { memoryStrength: 0.2 }), score: 0.5 },
  { ...row(3, { memoryStrength: 0.1, origin: "group" }), score: 0.2, source: "graph", depth: 3 },
];
const variants = (names, make) => names.map((variant) => ({ variant, ...make(variant) }));

export function scenarios() {
  const lensCases = [undefined, true, false].flatMap((enabled) =>
    [true, false].map((compression) => ({
      variant: "lens-" + String(enabled) + "-compression-" + compression,
      lensSecurity: true,
      userPrincipal: "user:v2:" + "a".repeat(64),
      rows: [row(1)],
      cfg: {
        ...(enabled === undefined ? {} : { semanticLens: { enabled } }),
        semanticCompression: { enabled: compression },
      },
      lensIndex: {
        version: 1,
        memoryToCommunity: { [id(1)]: "lens-community" },
        communities: {
          "lens-community": {
            id: "lens-community",
            bridgeMemoryIds: [id(91), id(92)],
            representativeMemoryIds: [id(91)],
            fadedCandidateMemoryIds: [id(91)],
          },
        },
      },
      hydratedRows: [
        row(91, {
          text: "Dashboard architecture denied fixture evidence",
          summary: "Dashboard architecture denied fixture evidence",
          scope: "user",
          ownerUserId: "user:v2:" + "b".repeat(64),
        }).entry,
        row(92, {
          text: "Dashboard architecture authorized lens evidence",
          summary: "Dashboard architecture authorized lens evidence",
          scope: "user",
          ownerUserId: "user:v2:" + "a".repeat(64),
        }).entry,
      ],
    })),
  );
  return {
    "render-plain": [
      ...lensCases,
      ...["default", "enabled", "disabled", "continuity-disabled", "no-workspace"].map((mode) => ({
        variant: "overlay-" + mode,
        rows: [row(1)],
        noWorkspace: mode === "no-workspace",
        cfg:
          mode === "default"
            ? {}
            : {
                continuityEngine: {
                  enabled: mode !== "continuity-disabled",
                  overlays: { enabled: mode !== "disabled" },
                },
              },
        overlays: [
          {
            id: id(75),
            targetMemoryId: id(1),
            shiftType: "meaning",
            shiftDescription: "Authorized architecture interpretation",
            triggerContext: "fixture turn",
            status: "active",
            confidence: 0.8,
            createdAt: NOW - 1000,
            provenance: { triggerMemoryIds: [id(1)] },
          },
        ],
      })),
      ...["4.0", "4e0", "4.5", "0", "-1"].map((encoding) => ({
        variant: "summary-number-" + encoding,
        summaryEncoding: encoding,
        rows: [row(1, { summary: "", text: "architecture details ".repeat(120) })],
        cfg: {
          summaryMaxWords: JSON.parse(encoding),
          recall: { fullTextTopRecords: 0 },
          semanticCompression: { enabled: false },
        },
      })),

      { variant: "defaults", rows: ordinary() },
      {
        variant: "controls-off",
        rows: ordinary(),
        cfg: {
          styleDirective: { timeOfDay: false, opinion: false, askBack: false },
          semanticCompression: { enabled: false },
          recallHedging: { enabled: false },
          recall: { fullTextTopRecords: 0 },
        },
      },
      {
        variant: "compression-on",
        rows: ordinary(),
        cfg: { semanticCompression: { enabled: true, tokenBudget: 7 }, recall: { fullTextTopRecords: 0 } },
      },
      {
        variant: "fulltext-on-trace",
        rows: ordinary(),
        trace: true,
        cfg: { recall: { fullTextTopRecords: 2, fullTextMaxChars: 400 }, semanticCompression: { enabled: false } },
      },
      { variant: "top-n-one", rows: ordinary(), cfg: { recall: { maxPromptMemories: 1 } } },
      ...[undefined, 4].map((words) => ({
        variant: "summary-words-" + String(words),
        rows: [row(1, { summary: "", text: "architecture details ".repeat(120) })],
        cfg: {
          ...(words === undefined ? {} : { summaryMaxWords: words }),
          recall: { fullTextTopRecords: 0 },
          semanticCompression: { enabled: false },
        },
      })),
      {
        variant: "canonical-dream",
        rows: [row(4, { memoryClass: "dream", createdAt: NOW - 86_400_000 })],
        canonical: [
          {
            heading: "  Build\n guide  ",
            text: "# Build guide\nUse the documented compiler and architecture.",
            mtimeMs: NOW - 86_400_000,
            score: 0.615,
          },
        ],
      },
      {
        variant: "canonical-heading-surrogate",
        rows: [],
        canonical: [
          {
            heading: "x".repeat(79) + "😀tail",
            text: "Architecture details remain evidence.",
            mtimeMs: NOW - 86_400_000,
            score: 0.9,
          },
        ],
        cfg: { semanticCompression: { enabled: true, tokenBudget: 12 } },
      },
      {
        variant: "validity-version",
        rows: [
          row(5, {
            versionNumber: 3.9,
            supersededBy: id(6),
            status: "superseded-in-context",
            updateSource: "tool:result",
            validFrom: NOW - 1000,
            validUntil: NOW + 1000,
          }),
        ],
      },
      { variant: "continuity-off", rows: ordinary(), cfg: { continuityEngine: { enabled: false } } },
      {
        variant: "fulltext-surrogate",
        rows: [row(1, { text: "a".repeat(399) + "😀tail" })],
        cfg: { recall: { fullTextMaxChars: 400 } },
      },
      {
        variant: "mood-style",
        rows: [],
        mood: { dominant: "joy", intensity: "hoch", trend: "steigend" },
        cfg: {
          styleDirective: { timezone: "Pacific/Honolulu" },
          emotion: { temperaments: { [AGENT]: { preset: "warm" } } },
        },
      },
    ],
    "render-memories-cap-clips": variants(["record-boundary", "tiny", "operational-warning", "utf16-cut"], (v) => ({
      rows:
        v === "operational-warning"
          ? [row(1, { text: "Stop production service and delete deployment files", createdAt: 0 })]
          : v === "utf16-cut"
            ? [row(1, { text: "a".repeat(399) + "😀tail" })]
            : ordinary(),
      cfg: {
        recall: { memoriesMaxChars: v === "record-boundary" ? 1600 : v === "tiny" ? 10 : 200, fullTextMaxChars: 400 },
        semanticCompression: { enabled: false },
      },
    })),
    "render-global-cap-drops": variants(
      ["record-clip", "drop-memories-start", "uncapped", "nondroppable-overflow"],
      (v) => ({
        rows: ordinary(),
        notice: "Fixture startup notice 👋",
        temporal: true,
        cfg: {
          recall: {
            globalInjectMaxChars:
              v === "record-clip" ? 4200 : v === "drop-memories-start" ? 2400 : v === "uncapped" ? 0 : 1,
          },
        },
      }),
    ),
    "render-neo-prelude": variants(["enabled", "disabled", "already-injected"], (v) => ({
      rows: ordinary().slice(0, 1),
      neo: v !== "disabled",
      neoAlreadyInjected: v === "already-injected",
    })),
    "render-temporal-block": variants(
      [
        "disabled",
        "new-session",
        "immediate",
        "recent",
        "same-day",
        "overnight",
        "multi-day",
        "stale",
        "future",
        "german",
      ],
      (v) => ({
        rows: [],
        temporal: v !== "disabled",
        lang: v === "german" ? "de" : "en",
        previous:
          {
            immediate: NOW - 60_000,
            recent: NOW - 300_000,
            "same-day": NOW - 3_600_000,
            overnight: NOW - 43_200_000,
            "multi-day": NOW - 129_600_000,
            stale: NOW - 604_800_000,
            future: NOW + 60_000,
            german: NOW - 3_660_000,
          }[v] ?? null,
      }),
    ),
    "render-reminder-block": variants(["none", "english", "german", "dedupe-pending"], (v) => ({
      rows: [],
      lang: v === "german" ? "de" : "en",
      reminders:
        v === "none"
          ? []
          : [
              { id: id(21), text: "Review <architecture> & 'quotes' \"now\" 😀", remindAt: NOW - 3_660_000 },
              { id: id(22), text: "Check the fixture", remindAt: NOW + 10_000 },
            ],
      pending: v === "dedupe-pending" ? [{ id: id(21), text: "Pending copy wins", remindAt: NOW - 60_000 }] : [],
    })),
    "render-reactivation-boost": variants(
      [
        "default",
        "enabled",
        "disabled",
        "visible-hints",
        "faded-cap",
        "cooldown",
        "wrong-owner",
        "trace-enabled",
        "trace-faded",
        "trace-empty",
      ],
      (v) => ({
        rows: [row(1)],
        reactivation: true,
        trace: v.startsWith("trace-"),
        cfg:
          v === "default"
            ? {}
            : { conversationReactivationRecall: { enabled: v !== "disabled", visibleHints: v === "visible-hints" } },
        crrCooldown: v === "cooldown",
        crrWrongOwner: ["wrong-owner", "trace-empty"].includes(v),
        crrFaded: ["faded-cap", "trace-faded"].includes(v),
      }),
    ),
    "render-contradiction-disclosure": variants(["default", "enabled", "disabled", "entity-cut"], (v) => ({
      rows: [
        row(1, { text: v === "entity-cut" ? "&".repeat(150) : "Architecture uses approach A", versionNumber: 1 }),
        row(2, { text: v === "entity-cut" ? "<".repeat(150) : "Architecture uses approach B", versionNumber: 2 }),
      ],
      contradictions: true,
      cfg: v === "default" ? {} : { contradictionDisclosure: { enabled: v !== "disabled" } },
    })),
    "render-confidence-framing": variants(
      ["default", "enabled", "disabled", "clustered-strong", "clustered-weak", "absolute-floor-off"],
      (v) => ({
        rows: ordinary().map((r, i) => ({
          ...r,
          source: "vector",
          score:
            v === "clustered-strong"
              ? [0.95, 0.94, 0.93][i]
              : ["clustered-weak", "absolute-floor-off"].includes(v)
                ? [0.38, 0.36, 0.35][i]
                : [0.9, 0.5, 0.2][i],
        })),
        cfg:
          v === "default"
            ? {}
            : {
                recallHedging: {
                  enabled: v !== "disabled",
                  ...(v === "absolute-floor-off" ? { absoluteFloor: 0 } : {}),
                },
              },
      }),
    ),
    "warm-only-path": [
      ...variants(
        [
          "warm",
          "normal",
          "missing-table",
          "pipeline-error",
          "pipeline-error-surrogate",
          "short-prompt",
          "neo-warm",
          "read-lease-error",
        ],
        (v) => ({
          rows: [row(1)],
          warm: v !== "normal",
          missingTable: v === "missing-table",
          pipelineError: v.startsWith("pipeline-error"),
          ...(v === "pipeline-error-surrogate" ? { pipelineErrorDetail: "x".repeat(199) + "😀tail" } : {}),
          readLeaseError: v === "read-lease-error",
          prompt: v === "short-prompt" ? "hi" : undefined,
          neo: v === "neo-warm",
        }),
      ),
      ...variants(["maintenance", "maintenance-internal", "maintenance-denied", "maintenance-no-workspace"], (v) => ({
        minimal: true,
        variant: v,
        rows: [],
        temporal: true,
        notice: "Fixture maintenance notice",
        internal: v === "maintenance-internal",
        denied: v === "maintenance-denied",
        noWorkspace: v === "maintenance-no-workspace",
        reminders: [{ id: id(21), text: "Review the fixture", remindAt: NOW - 60_000 }],
        knowledgeNudge: "\n<knowledge-update-reminder>Fixture update</knowledge-update-reminder>",
      })),
    ],
    "system-supplement": [
      { variant: "neo-off", neo: false },
      { variant: "neo-on", neo: true },
    ],
  };
}
