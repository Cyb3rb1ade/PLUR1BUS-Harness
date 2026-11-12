// Actual A1 list + latest C4 filesystem reader, composed without editing either source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";
const a1 = process.env.PLUR1BUS_ENGINE_SRC;
const c4 = process.env.PLUR1BUS_C4_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
assert(a1 && c4 && git && process.version === "v24.21.0");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const referenceBytes = readFileSync(new URL("golden/curation-list.json", import.meta.url));
const reference = JSON.parse(referenceBytes);
assert.equal(sha(referenceBytes), "c370515fdde1550bdc5a98dc1662d22a1e8cfd6437b04233cbc05c56a9fa78ee");
for (const entry of reference.sourceHashes) {
  const bytes = readFileSync(join(a1, entry.path));
  assert.equal(sha(bytes), entry.sha256);
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", git, "show", `${reference.pin}:${entry.path}`])));
}
const c4Pin = "af73288cf2a268213b6e8d4a8151772aa327e29b";
const verified = new Map();
function verify(relative) {
  if (verified.has(relative)) return;
  const bytes = readFileSync(join(c4, relative));
  assert.equal(
    sha(bytes),
    sha(execFileSync("git", ["-C", git, "show", `${c4Pin}:${relative}`], { maxBuffer: 16 * 1024 * 1024 })),
  );
  verified.set(relative, sha(bytes));
  for (const match of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const name = posix.normalize(posix.join(posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(name)) verify(name);
  }
}
verify("lib/neo-arch.js");
const { createNeoStore } = await import(pathToFileURL(join(c4, "lib/neo-arch.js")));
const { createMemoryCuration } = await import(pathToFileURL(join(a1, "engine/memory-ops/curation.js")));
globalThis.fetch = async () => {
  throw new Error("network forbidden");
};
const inputs = reference.cases.map((entry) => ({
  ...JSON.parse(entry.inputJson),
  workspace: reference.requester.workspaceIdentity,
}));
const base = JSON.parse(reference.cases[1].inputJson).candidates[0];
const row = (id, extra = {}) => ({ ...base, id, ...extra });
for (const [name, workspace, legacy, canonical] of [
  [
    "safe-legacy-newer",
    "curation",
    [row("one", { workspaceKey: "curation", updatedAt: "2026-11-08T11:00:00.000Z", statement: "new legacy" })],
    [row("one", { workspaceKey: "curation" })],
  ],
  [
    "safe-canonical-equal-time",
    "curation",
    [row("one", { workspaceKey: "curation", statement: "old legacy" })],
    [row("one", { workspaceKey: "curation" })],
  ],
  ["unsafe-legacy-never-read", reference.requester.workspaceIdentity, [row("foreign-legacy")], []],
  [
    "cross-stream-hidden-newest",
    reference.requester.workspaceIdentity,
    [],
    [row("one", { updatedAt: 1, createdAt: 1 })],
  ],
])
  inputs.push({
    name,
    workspace,
    candidates: canonical,
    behavior: name === "cross-stream-hidden-newest" ? [row("one", { status: "promoted" })] : [],
    legacy,
  });
inputs.push({
  name: "four-digit-year-sort",
  workspace: reference.requester.workspaceIdentity,
  candidates: [row("later-year", { createdAt: "2026" }), row("earlier-date", { createdAt: "2025-01-01" })],
  behavior: [],
});
async function invoke(input, authorizedOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "curation-store-oracle-"));
  try {
    const store = createNeoStore(root, input.workspace, { readOnly: true });
    for (const [file, rows] of [
      [store.paths.candidates, input.candidates],
      [store.paths.behavior, input.behavior],
      [store.legacyPaths.candidates, input.legacy || []],
    ]) {
      if (!rows.length) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
    }
    const ops = createMemoryCuration({
      opsContext: {
        resolve: async (_p, _a, options) => {
          assert.equal(options.destructive, true);
          return {
            agentId: reference.requester.agentId,
            workspaceDir: root,
            memoryCtx: { workspaceIdentity: input.workspace, userPrincipal: reference.requester.ownerUserId },
          };
        },
      },
      getNeoStore: () => (authorizedOnly ? { readCandidates: () => [], readBehaviorCards: () => [] } : store),
    });
    try {
      return { outputJson: JSON.stringify(await ops.list(input.query || {}, {}, {})) };
    } catch (error) {
      return { error: { code: error.code, message: error.message } };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
async function capture() {
  const cases = [],
    exceptions = [];
  for (const input of inputs) {
    cases.push({ inputJson: JSON.stringify(input), ...(await invoke(input)) });
    if (input.name === "foreign-owner-d130")
      exceptions.push({
        index: cases.length - 1,
        reason: "D130 rejects private foreign owner; actual Node rerun on authorized empty sources",
        ...(await invoke(input, true)),
      });
  }
  return { cases, exceptions };
}
const captured = await capture();
assert.deepEqual(await capture(), captured);
const output =
  JSON.stringify(
    {
      a1Pin: reference.pin,
      a1SourceManifestSha256: sha(referenceBytes),
      c4Pin,
      c4Sources: Object.fromEntries(verified),
      node: process.version,
      requester: reference.requester,
      boundaries: {
        context: "synthetic resolved human",
        store: "actual C4 files in isolated temporary roots",
        facade: "actual A1 list; two explicitly pinned source trees",
        normalization: "none",
      },
      cases: captured.cases,
    },
    null,
    2,
  ) + "\n";
writeFileSync(new URL("golden/curation-store.json", import.meta.url), output);
writeFileSync(
  new URL("curation-store-native-exceptions.json", import.meta.url),
  JSON.stringify({ nodeGoldenSha256: sha(output), cases: captured.exceptions }, null, 2) + "\n",
);
console.log(`Recorded ${captured.cases.length} actual A1+C4 lists twice; SHA-256 ${sha(output)}`);
