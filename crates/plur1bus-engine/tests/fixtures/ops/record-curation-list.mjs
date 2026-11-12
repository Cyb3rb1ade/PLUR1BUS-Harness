// Actual A1 curation list over synthetic already-resolved human context and supplied store snapshots.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pin = "9b935ce1f970bd92a931aa99a58c620669c8085f";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const gitRoot = process.env.PLUR1BUS_ENGINE_GIT;
assert(source && gitRoot && process.version === "v24.21.0");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = execFileSync("git", ["-C", gitRoot, "ls-tree", "-r", "--name-only", pin], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((path) => path === "package.json" || /^(engine|lib)\/.*\.(js|json)$/.test(path));
const sourceHashes = paths.map((path) => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
const { createMemoryCuration } = await import(pathToFileURL(join(source, "engine/memory-ops/curation.js")).href);
const owner = "user:v2:" + sha("curation-owner");
const other = "user:v2:" + sha("other-owner");
const workspace = "workspace:v1:curation";
const requester = { agentId: "alpha", workspaceIdentity: workspace, ownerUserId: owner };
const row = (id, extra = {}) => ({
  id,
  agentId: "alpha",
  ownerUserId: owner,
  ownerId: owner,
  workspaceKey: workspace,
  scope: "agent_private",
  visibility: { scope: "agent_private" },
  createdAt: "2026-11-08T10:00:00.000Z",
  status: "conflict",
  statement: "Synthetic " + id,
  category: "fact",
  ...extra,
});
const inputs = [
  { name: "empty", candidates: [], behavior: [] },
  {
    name: "stable-order",
    candidates: [row("one"), row("two", { status: "candidate" })],
    behavior: [row("three", { status: "stale" })],
  },
  {
    name: "newest-resolved-hides-old",
    candidates: [row("one"), row("one", { status: "promoted", updatedAt: "2026-11-08T11:00:00.000Z" })],
    behavior: [],
  },
  {
    name: "newest-before-old",
    candidates: [row("one", { statement: "new", updatedAt: "2026-11-08T11:00:00.000Z" }), row("one")],
    behavior: [],
  },
  {
    name: "equal-time-later-wins",
    candidates: [row("one", { statement: "first" })],
    behavior: [row("one", { statement: "second" })],
  },
  {
    name: "replacement-keeps-position",
    candidates: [row("one"), row("two"), row("one", { statement: "new", updatedAt: 1800000000000 })],
    behavior: [],
  },
  {
    name: "zero-updated-falls-back-created",
    candidates: [row("one", { updatedAt: 0 }), row("one", { createdAt: 1, statement: "older" })],
    behavior: [],
  },
  {
    name: "absent-times-are-zero",
    candidates: [row("one", { createdAt: null }), row("one", { createdAt: 1, statement: "later" })],
    behavior: [],
  },
  {
    name: "hidden-statuses",
    candidates: [
      row("a", { status: "active" }),
      row("b", { status: "demoted" }),
      row("c", { hardDeleted: true }),
      row("d", { epistemicStatus: "invalidated" }),
    ],
    behavior: [],
  },
  { name: "foreign-agent", candidates: [row("one", { agentId: "other" })], behavior: [] },
  {
    name: "foreign-owner-d130",
    candidates: [row("one", { ownerUserId: other, ownerId: other })],
    behavior: [],
    nativeCandidates: [],
  },
  {
    name: "workspace-shared",
    candidates: [
      row("one", { agentId: "other", scope: "workspace_shared", visibility: { scope: "workspace_shared" } }),
    ],
    behavior: [],
  },
  {
    name: "global-user",
    candidates: [row("one", { agentId: "other", scope: "global_user", visibility: { scope: "global_user" } })],
    behavior: [],
  },
  {
    name: "foreign-global-user",
    candidates: [
      row("one", {
        agentId: "other",
        ownerId: other,
        ownerUserId: other,
        scope: "global_user",
        visibility: { scope: "global_user" },
      }),
    ],
    behavior: [],
  },
  {
    name: "string-coercion",
    candidates: [
      row("a", { statement: "", text: ["x", null, "y"], category: "" }),
      row("b", { statement: 12, category: null }),
      row("c", { statement: { nested: true } }),
    ],
    behavior: [],
  },
  {
    name: "opaque-text",
    candidates: [row("mem_🧠", { statement: "raw-\ud800-text", category: "note" })],
    behavior: [],
  },
  { name: "truncate", candidates: [row("one"), row("two")], behavior: [], query: { limit: 1 } },
  { name: "limit-exact", candidates: [row("one")], behavior: [], query: { limit: 1 } },
  ...[0, 101, 1.5, -1].map((limit) => ({ name: `limit-${limit}`, candidates: [], behavior: [], query: { limit } })),
  { name: "null-limit-default", candidates: [row("one")], behavior: [], query: { limit: null } },
];
async function invoke(input, candidates = input.candidates) {
  const calls = [];
  const ops = createMemoryCuration({
    opsContext: {
      resolve: async (_p, _a, options) => {
        assert.deepEqual(options, { destructive: true });
        return {
          agentId: "alpha",
          memoryCtx: { workspaceIdentity: workspace, userPrincipal: owner },
          workspaceDir: "/synthetic-unused-workspace",
        };
      },
    },
    getNeoStore: () => ({
      readCandidates: (limit) => {
        calls.push(["candidates", limit]);
        return candidates;
      },
      readBehaviorCards: (limit) => {
        calls.push(["behavior", limit]);
        return input.behavior;
      },
    }),
  });
  try {
    return { outputJson: JSON.stringify(await ops.list(input.query || {}, {}, {})), calls };
  } catch (error) {
    return { error: { code: error.code, message: error.message }, calls };
  }
}
async function capture() {
  const cases = [];
  const exceptions = [];
  for (const input of inputs) {
    const { nativeCandidates, ...raw } = input;
    cases.push({ inputJson: JSON.stringify(raw), ...(await invoke(input)) });
    if (nativeCandidates) {
      exceptions.push({
        index: cases.length - 1,
        name: input.name,
        reason:
          "D130 rejects contradictory private owner binding; actual Node rerun on the authorized empty source set",
        ...(await invoke(input, nativeCandidates)),
      });
    }
  }
  return { cases, exceptions };
}
globalThis.fetch = async () => {
  throw new Error("network forbidden");
};
const captured = await capture();
assert.deepEqual(await capture(), captured);
const output =
  JSON.stringify(
    {
      pin,
      node: process.version,
      sourceHashes,
      requester,
      boundaries: {
        implementation: "actual A1 curation list",
        context: "synthetic already-resolved human context",
        stores: "supplied snapshots; no filesystem or mutation",
        normalization: "none",
      },
      cases: captured.cases,
    },
    null,
    2,
  ) + "\n";
writeFileSync(new URL("golden/curation-list.json", import.meta.url), output);
writeFileSync(
  new URL("curation-list-native-exceptions.json", import.meta.url),
  JSON.stringify(
    {
      nodeGoldenSha256: sha(output),
      cases: captured.exceptions,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Recorded ${captured.cases.length} A1 curation lists twice; SHA-256 ${sha(output)}`);
